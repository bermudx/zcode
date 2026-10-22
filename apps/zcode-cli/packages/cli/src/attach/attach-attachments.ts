// TUI 附件形状 → `session/send` 的协议形状。
//
// server 的 mapProtocolPromptAttachment 只认 `kind`/`localPath`（GUI 传输格式），
// 直接把 TUI 形状 {type,path,content} 发过去会在协议边界被静默丢弃——`@file`
// 提及看起来提交成功，模型却什么都没收到（2026-10-22 piz 实测）。
import type { TuiPromptAttachment } from "@zcode/tui";

/** data URL → 协议 image/pdf 附件所需的裸 base64。 */
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/su;

const protocolFilename = (path: string | undefined): string => {
  const declared = path?.replace(/^@/u, "").trim();
  return declared && declared.length > 0 ? declared : "attachment";
};

export const toProtocolAttachment = (
  attachment: TuiPromptAttachment,
): Record<string, unknown> | undefined => {
  const filename = protocolFilename(attachment.path);
  if (attachment.type === "image" || attachment.type === "pdf") {
    // 图片/PDF 的 path 是草稿占位符（@x.png），不是磁盘路径；内容在 data URL 里。
    const match = DATA_URL_PATTERN.exec(attachment.content ?? "");
    if (!match) return undefined;
    return { dataBase64: match[2], filename, kind: attachment.type, mimeType: match[1] };
  }
  if (attachment.type !== "file") return undefined;
  if (attachment.path && attachment.path.trim().length > 0) {
    return { filename, kind: "file", localPath: attachment.path };
  }
  if (attachment.content !== undefined) {
    return { filename, kind: "file", textContent: attachment.content };
  }
  return undefined;
};

/** 协议里没有 url 分支，那类附件直接丢弃；其余按形状映射。 */
export const toProtocolAttachments = (
  attachments: readonly TuiPromptAttachment[] | undefined,
): unknown[] | undefined => {
  const mapped = (attachments ?? [])
    .map(toProtocolAttachment)
    .filter((attachment): attachment is Record<string, unknown> => attachment !== undefined);
  return mapped.length > 0 ? mapped : undefined;
};
