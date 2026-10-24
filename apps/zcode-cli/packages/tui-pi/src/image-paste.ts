// ctrl+v / alt+v 图片粘贴：剪贴板图片 → `[image #N]` 草稿占位符 + DraftAttachment。
// 语义与 React 前端 app-clipboard-image.ts 逐条对齐（busy 拒绝、状态文案、
// 占位符即唯一绑定）；pi Editor 原生支持光标处插入（insertTextAtCursor 的
// docstring 就拿 clipboard image markers 当例子），不需要 React 端 ref 兜底。

import type { DraftAttachment, TuiOptions } from "@zcode/tui/internals";
import { isValidClipboardImage } from "@zcode/tui/internals";
import type { Composer } from "./composer.js";

export type PiImagePasteDeps = {
  abortSignal: () => AbortSignal | undefined;
  allocateId: () => number;
  busy: () => boolean;
  draftAttachments: () => readonly DraftAttachment[];
  editor: Pick<
    Composer,
    "getCursor" | "getLines" | "insertTextAtCursor"
  >;
  readClipboardImage: TuiOptions["readClipboardImage"];
  setDraftAttachments: (attachments: DraftAttachment[]) => void;
  setStatus: (status: string) => void;
  setStatusDetails: (details: string[]) => void;
};

export class PiImagePaste {
  /** 串行化剪贴板读：连按 ctrl+v 不并发跑外部剪贴板命令。 */
  private inFlight: Promise<void> | undefined;

  constructor(private readonly deps: PiImagePasteDeps) {}

  paste(): Promise<void> {
    this.inFlight ??= this.pasteOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async pasteOnce(): Promise<void> {
    const deps = this.deps;
    if (deps.busy()) {
      deps.setStatus("Image paste is available when the prompt is idle.");
      return;
    }
    if (!deps.readClipboardImage) {
      deps.setStatus("Image paste is not available in this terminal.");
      return;
    }

    try {
      deps.setStatus("Reading image from clipboard...");
      const image = await deps.readClipboardImage({ abortSignal: deps.abortSignal() });
      if (!image) {
        deps.setStatus("No image found in clipboard.");
        return;
      }
      if (!isValidClipboardImage(image)) {
        deps.setStatus("Clipboard image is not a supported image format.");
        return;
      }

      const id = deps.allocateId();
      const placeholder = `[image #${id}]`;
      // 先登记附件再插入占位符：onChange 触发的 reconcile 以文本为准，
      // 反序会让新附件在占位符落文前被误删。
      deps.setDraftAttachments([
        ...deps.draftAttachments(),
        {
          dataUrl: image.dataUrl,
          id,
          mediaType: image.mediaType,
          placeholder,
          sizeBytes: image.sizeBytes,
          type: "image",
        },
      ]);
      deps.editor.insertTextAtCursor(this.placeholderInsertion(placeholder));
      deps.setStatus(`Attached ${placeholder}.`);
    } catch (error) {
      deps.setStatus("Could not read image from clipboard.");
      deps.setStatusDetails([error instanceof Error ? error.message : String(error)]);
    }
  }

  /** 光标前是词中位置时补前导空格，避免占位符粘连进前一个 token。 */
  private placeholderInsertion(placeholder: string): string {
    const { line, col } = this.deps.editor.getCursor();
    const before = (this.deps.editor.getLines()[line] ?? "").slice(0, col);
    return before.length > 0 && !/\s$/u.test(before) ? ` ${placeholder}` : placeholder;
  }
}
