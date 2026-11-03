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
import type { AttachClient, AttachClientLogger } from "./attach-client.js";

export type UploadInput = {
  bytes: Uint8Array;
  fileName: string;
  mime: string;
  sessionId: string;
  /** 暂存表的命名空间键之一；attach 客户端不调 connectionFlow，逐上传随机即可。 */
  connectionId: string;
  /** 用户取消（Ctrl-C/turn abort）：begin 前与各 chunk/commit 前检查，命中即中止并清理暂存。 */
  abortSignal?: AbortSignal;
  /** abort 清理失败的诊断出口；缺省直写 stderr（诊断绝不上 stdout）。 */
  logger?: AttachClientLogger;
};

/** 取消约定与 attach 现有路径一致：普通 Error("aborted")（不走 AbortError/DOMException）。 */
function throwIfUploadAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("aborted");
}

/** 把一份本地字节上传为 v4 附件引用。失败时 abort 暂存并原样上抛。 */
export async function uploadAttachment(
  client: AttachClient,
  input: UploadInput,
): Promise<AttachmentRef> {
  throwIfUploadAborted(input.abortSignal);
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
  // uploadId 每次上传全新随机：不复用、不重试，因此 begin 不可能命中 core 的
  // committed 幂等桶（该分支只服务“同 uploadId 重发 begin”的调用方）。
  const uploadId = `attach-up-${randomUUID()}`;
  const checksum = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`;
  const base = {
    connectionId: input.connectionId,
    sessionId: input.sessionId,
    uploadId,
  };

  // begin 也进 try：core 侧拒绝路径（冲突/容量检查）在 staged.set 之前不暂存，
  // 但「core 已成功暂存、回执丢在传输/schema 校验」同样表现为 begin 请求失败——
  // 此时必须照常 abort 同一 uploadId，否则暂存预算被孤儿占用到 TTL 到期。
  try {
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
    // 新 uploadId 下 begin 只能回 staging；committed 意味着 core 状态异常，如实抛错。
    if (begun.state !== "staging") {
      throw new Error(`unexpected attachment begin state: ${begun.state}`);
    }
    for (let index = 0; index < totalChunks; index += 1) {
      throwIfUploadAborted(input.abortSignal);
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
    throwIfUploadAborted(input.abortSignal);
    const committed = v4AttachmentPutResultSchema.parse(
      await client.request(V4_METHODS.attachmentCommit, base),
    );
    return attachmentRefOf(input, committed.ref);
  } catch (error) {
    // 清理失败不能静默（暂存分片占 core 预算），但主失败优先上抛：
    // 诊断走注入 logger，缺省 stderr，绝不污染协议 stdout；
    // logger 自身抛错也只降级为 stderr，不得顶掉原始上传错误。
    await client.request(V4_METHODS.attachmentAbort, base).catch((abortError: unknown) => {
      const detail = abortError instanceof Error ? abortError.message : String(abortError);
      const message = `attach v4 upload abort cleanup failed (uploadId ${uploadId}): ${detail}`;
      try {
        if (input.logger?.warn) {
          input.logger.warn(message);
          return;
        }
      } catch {
        // fall through to stderr
      }
      process.stderr.write(`${message}\n`);
    });
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
