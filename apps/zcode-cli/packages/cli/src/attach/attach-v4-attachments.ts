// attach 瘦客户端的附件上传：v4 begin → chunk* → commit，得到已寄存内容的
// AttachmentRef（URI ref）。协议上限取共享 PROTOCOL_V4_LIMITS（单片 ≤512KiB 解码
// 字节、总量 ≤20MiB、≤64 片）；方法名与回执形状都用 @zcode/shared/zcode-protocol-v4，
// 客户端不私有定义线上形状。任一步失败都 abort，避免 core 上留下占用暂存预算的半成品。
import { createHash, randomUUID } from "node:crypto";
import {
  PROTOCOL_V4_LIMITS,
  V4_METHODS,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentPutResultSchema,
  type AttachmentRef,
} from "@zcode/shared/zcode-protocol-v4";
import type { AttachClient } from "./attach-client.js";

export type UploadInput = {
  bytes: Uint8Array;
  fileName: string;
  mime: string;
  sessionId: string;
  /** 暂存表的命名空间键之一；attach 客户端不调 connectionFlow，逐上传随机即可。 */
  connectionId: string;
};

/** 把一份本地字节上传为 v4 附件引用。失败时 abort 暂存并原样上抛。 */
export async function uploadAttachment(
  client: AttachClient,
  input: UploadInput,
): Promise<AttachmentRef> {
  if (input.bytes.byteLength > PROTOCOL_V4_LIMITS.attachmentMaxBytes) {
    throw new Error(
      `attachment exceeds ${PROTOCOL_V4_LIMITS.attachmentMaxBytes} bytes: ${input.fileName}`,
    );
  }
  const totalChunks = Math.ceil(
    input.bytes.byteLength / PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
  );
  if (totalChunks > PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks) {
    throw new Error(`attachment needs ${totalChunks} chunks, limit is upload chunk cap`);
  }
  const uploadId = `attach-up-${randomUUID()}`;
  const checksum = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`;
  const base = {
    connectionId: input.connectionId,
    sessionId: input.sessionId,
    uploadId,
  };

  const begun = v4AttachmentBeginResultSchema.parse(
    await client.request(V4_METHODS.attachmentBegin, {
      checksum,
      fileName: input.fileName,
      mime: input.mime,
      totalBytes: input.bytes.byteLength,
      totalChunks,
      ...base,
    }),
  );
  // 幂等重放：同 key 已 commit 过（回执丢失后重发）直接拿 ref，不能再走 chunk。
  if (begun.state === "committed") {
    return attachmentRefOf(input, begun.ref);
  }
  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes;
      const slice = input.bytes.subarray(start, start + PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes);
      v4AttachmentChunkResultSchema.parse(
        await client.request(V4_METHODS.attachmentChunk, {
          chunkIndex: index,
          dataBase64: Buffer.from(slice).toString("base64"),
          ...base,
        }),
      );
    }
    const committed = v4AttachmentPutResultSchema.parse(
      await client.request(V4_METHODS.attachmentCommit, base),
    );
    return attachmentRefOf(input, committed.ref);
  } catch (error) {
    await client.request(V4_METHODS.attachmentAbort, base).catch(() => undefined);
    throw error;
  }
}

function attachmentRefOf(input: UploadInput, ref: string): AttachmentRef {
  return {
    bytes: input.bytes.byteLength,
    fileName: input.fileName,
    mime: input.mime,
    ref,
  };
}

export function newUploadConnectionId(): string {
  return `attach-conn-${randomUUID()}`;
}
