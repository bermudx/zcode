// TUI 附件形状 → v4 AttachmentRef（sendText 的 attachments 命令面）。
//
// ref 的两形态与 core 侧 mapAttachmentRefsToTurnAttachments 对偶：
// 1. 本地路径 ref（非 URI）——`@file` 提及的磁盘路径直接透传，无需上传；mime 固定
//    application/octet-stream，core 按普通 file 路径附件读取（与旧 session/send 的
//    localPath 分支同语义，读取阈值与降级都在 core 内建）。
// 2. URI ref——草稿占位附件（剪贴板图片/PDF 的 data URL、内联文本内容）经
//    begin/chunk/commit 寄存为 session artifact，core 在模型请求阶段读回。
// 旧协议里没有 url 分支，那类附件维持直接丢弃。
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { TuiPromptAttachment } from "@zcode/tui";
import type { AttachClient } from "./attach-client.js";
import { uploadAttachment } from "./attach-v4-attachments.js";

/** data URL → 裸 base64 与 mime（image/pdf 占位附件的内容形态）。 */
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/su;

const INLINE_TEXT_ATTACHMENT_MIME = "text/plain";
const PATH_ATTACHMENT_MIME = "application/octet-stream";

/** 协议 filename 展示名：草稿占位符（@x.png）剥掉 @ 前缀；空值回退 attachment。 */
const attachmentFileName = (path: string | undefined): string => {
  const declared = path?.replace(/^@/u, "").trim();
  return declared && declared.length > 0 ? declared : "attachment";
};

export type ToV4AttachmentRefsInput = {
  sessionId: string;
  connectionId: string;
  attachments: readonly TuiPromptAttachment[];
};

/**
 * 逐个映射；单个附件不合法（如图形附件缺 data URL）时丢弃该附件、其余照发——
 * 与旧 toProtocolAttachments 的过滤语义一致，不让一个坏占位符拖垮整次提交。
 */
export async function toV4AttachmentRefs(
  client: AttachClient,
  input: ToV4AttachmentRefsInput,
): Promise<AttachmentRef[] | undefined> {
  const refs: AttachmentRef[] = [];
  for (const attachment of input.attachments) {
    const fileName = attachmentFileName(attachment.path);
    if (attachment.type === "image" || attachment.type === "pdf") {
      // 图片/PDF 的 path 是草稿占位符，不是磁盘路径；内容在 data URL 里，必须寄存。
      const match = DATA_URL_PATTERN.exec(attachment.content ?? "");
      if (!match) continue;
      const mime = match[1];
      const ref = await uploadAttachment(client, {
        bytes: Buffer.from(match[2], "base64"),
        connectionId: input.connectionId,
        fileName,
        mime,
        sessionId: input.sessionId,
      });
      refs.push(ref);
      continue;
    }
    if (attachment.type !== "file") continue;
    if (attachment.path && attachment.path.trim().length > 0) {
      // 磁盘路径：core 端零拷贝读取，不需要寄存内容。
      refs.push({
        bytes: 0,
        fileName,
        mime: PATH_ATTACHMENT_MIME,
        ref: attachment.path,
      });
      continue;
    }
    if (attachment.content !== undefined) {
      // 内联文本：寄存后按 URI ref 走 core 的文本解码（≤64KiB 保留正文，超限只留展示元信息）。
      const ref = await uploadAttachment(client, {
        bytes: Buffer.from(attachment.content, "utf8"),
        connectionId: input.connectionId,
        fileName,
        mime: INLINE_TEXT_ATTACHMENT_MIME,
        sessionId: input.sessionId,
      });
      refs.push(ref);
    }
  }
  return refs.length > 0 ? refs : undefined;
}
