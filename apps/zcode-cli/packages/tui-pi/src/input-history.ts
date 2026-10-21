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
  editor: Pick<Composer, "getText" | "setText">;
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
