// 草稿附件域：`[image #N]` 占位符 id 命名空间 + @path 提及合并。
// 与 app.ts 分离的原因不是行数机械拆分，而是这段逻辑自己成立——占位符↔附件
// 的绑定不变量（id 不得撞名、提交只发仍被引用的）由这里一处收口，image-paste
// 和 history 恢复都依赖它。

import type { DraftAttachment } from "@zcode/tui/internals";
import { appendFileMentions } from "./mentions.js";

export type PiDraftAttachmentsDeps = {
  draftAttachments: () => readonly DraftAttachment[];
  workspaceDirectory: () => string | undefined;
};

export class PiDraftAttachments {
  private sequence = 0;

  constructor(private readonly deps: PiDraftAttachmentsDeps) {}

  /**
   * 附件 id 是 `[image #N]` 占位符命名空间：history 恢复会把占位符里的 #N
   * 还原成附件 id（toDraftAttachments），若各管各的计数器，恢复 [image #1]
   * 后再粘贴会再发一个 [image #1]——同名占位符让两张图被同一处文本引用。
   * 所以分配永远跳过当前草稿已占用的 id。
   */
  allocateId(): number {
    this.sequence =
      Math.max(this.sequence, ...this.deps.draftAttachments().map((a) => a.id)) +
      1;
    return this.sequence;
  }

  /**
   * 提交用附件集：Slash commands are control messages; only real prompts
   * carry attachments. `@path` tokens in the draft become file attachments
   * the core reads.
   */
  forSubmit(text: string): DraftAttachment[] {
    const existing = this.deps.draftAttachments();
    if (text.startsWith("/")) return [...existing];
    return appendFileMentions({
      allocateId: () => this.allocateId(),
      existing,
      text,
      workspaceDirectory: this.deps.workspaceDirectory() ?? process.cwd(),
    });
  }
}
