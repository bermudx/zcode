// PiInputHistory: cross-session draft history (port of @zcode/tui
// app-input-history / useInputHistory). Up walks the CLI recallPreviousInput
// port while the draft is empty or recall is active; Down steps back and
// restores the stashed pre-navigation draft (and its attachments) at the
// bottom. Editor.onChange must be routed through onEditorChange so user
// edits reset navigation; restoreDraft suppresses that reset for its own
// programmatic setText.

import type { TuiCopy } from "@zcode/i18n";
import type {
  DraftAttachment,
  TuiOptions,
  TuiPromptAttachment,
} from "@zcode/tui/internals";
import { shouldHandleInputHistoryNavigation, toDraftAttachments } from "@zcode/tui/internals";
import type { Composer } from "./composer.js";

export type PiInputHistoryDeps = {
  copy: () => TuiCopy;
  draftAttachments: () => DraftAttachment[];
  editor: Pick<Composer, "getExpandedText" | "getText" | "setText">;
  recallPreviousInput: () => TuiOptions["recallPreviousInput"];
  setDraftAttachments: (attachments: DraftAttachment[]) => void;
  setStatus: (status: string) => void;
  setStatusDetails: (details: string[]) => void;
};

export class PiInputHistory {
  private index = 0;
  private stashedDraft: string | undefined;
  private stashedAttachments: DraftAttachment[] | undefined;
  private nextAttachmentId = 0;
  private suppressReset = false;

  constructor(private readonly deps: PiInputHistoryDeps) {}

  get active(): boolean {
    return this.stashedDraft !== undefined;
  }

  navigable(): boolean {
    return shouldHandleInputHistoryNavigation({
      draftValue: this.deps.editor.getText(),
      inputHistoryActive: this.active,
    });
  }

  onEditorChange(): void {
    // 手动删掉占位符（@file、[image #N]）即解绑附件：提交只发仍被引用的，
    // 否则已删除的 @提及/[image] 占位文本仍会带着附件进协议（与 React 端
    // setInput reconcile 同语义）。按展开文本核对，粘贴大段的 marker 形态
    // 也能命中占位符。
    //
    // 必须延迟到 microtask：pi Editor.submitValue() 先清文本再 onChange(""),
    // 最后才回调 onSubmit——同步 reconcile 会在 submitValue 捕获附件前把
    // draftAttachments 清空（图片提交变裸文本的实测 bug）。推迟一轮后提交
    // 路径已同步读完草稿，此处再按最新文本收敛即可；普通编辑只是晚一拍生效。
    queueMicrotask(() => {
      const expanded = this.deps.editor.getExpandedText();
      const current = this.deps.draftAttachments();
      const kept = current.filter((a) => expanded.includes(a.placeholder));
      if (kept.length !== current.length) this.deps.setDraftAttachments(kept);
    });
    if (!this.suppressReset) this.reset();
  }

  // 草稿语义清空/重写：删除不再被引用的附件并重置历史导航。供 Ctrl+C
  // 清稿、submit 回写与 recallNext 触底恢复共用。
  setDraftValue(value: string): void {
    this.deps.editor.setText(value);
    this.deps.setDraftAttachments(
      this.deps.draftAttachments().filter((a) => value.includes(a.placeholder)),
    );
    this.reset();
  }

  async recallPrevious(): Promise<void> {
    const deps = this.deps;
    const recall = deps.recallPreviousInput();
    if (!recall) {
      deps.setStatus(deps.copy().input.noHistorySource);
      return;
    }
    if (this.stashedDraft === undefined) {
      this.stashedDraft = deps.editor.getText();
      this.stashedAttachments = deps.draftAttachments();
    }
    try {
      const skip = this.index;
      const previous = await recall(skip);
      if (!previous?.text) {
        deps.setStatus(deps.copy().input.noPreviousInput);
        return;
      }
      this.index = skip + 1;
      this.restoreDraft(previous.text, previous.attachments);
      deps.setStatus(
        previous.attachments?.length
          ? deps.copy().input.restoredPreviousInputWithAttachments(previous.attachments.length)
          : deps.copy().input.restoredPreviousInput,
      );
    } catch (error) {
      deps.setStatus(deps.copy().input.restorePreviousInputFailed);
      deps.setStatusDetails([error instanceof Error ? error.message : String(error)]);
    }
  }

  async recallNext(): Promise<void> {
    const deps = this.deps;
    if (this.stashedDraft === undefined) return;
    if (this.index <= 1) {
      const stashedAttachments = this.stashedAttachments;
      this.setDraftValue(this.stashedDraft);
      deps.setDraftAttachments(stashedAttachments ?? []);
      this.reset();
      deps.setStatus(deps.copy().status.ready);
      return;
    }
    this.index -= 1;
    try {
      const previous = await deps.recallPreviousInput()?.(this.index - 1);
      if (previous?.text) this.restoreDraft(previous.text, previous.attachments);
    } catch {
      // 历史导航 best-effort，失败不回退已前进的下标（与 React 端一致）。
    }
  }

  private reset(): void {
    this.index = 0;
    this.stashedDraft = undefined;
    this.stashedAttachments = undefined;
  }

  private restoreDraft(value: string, attachments?: TuiPromptAttachment[]): void {
    const restored = toDraftAttachments(attachments, () => this.nextAttachmentId++);
    for (const attachment of restored) {
      this.nextAttachmentId = Math.max(this.nextAttachmentId, attachment.id + 1);
    }
    // 恢复历史草稿不算用户改稿：压住 setText 触发的 onChange 历史重置，
    // 保留 index / stash 供继续 Up/Down 遍历。
    this.suppressReset = true;
    try {
      this.deps.editor.setText(value);
    } finally {
      this.suppressReset = false;
    }
    this.deps.setDraftAttachments(restored);
  }
}
