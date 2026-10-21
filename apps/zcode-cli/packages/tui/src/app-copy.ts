import type { TuiWriteClipboardText } from "./types.js";
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import {
  LAST_REPLY_COPIED_STATUS,
  LAST_REPLY_COPY_FAILED_STATUS,
  NO_ASSISTANT_REPLY_STATUS,
} from "./app-keyboard-helpers.js";
import type { Message } from "./app-model.js";
import { lastAgentReplyText } from "./app-transcript-stream.js";

export type SelectionCopyResult =
  | {
      characterCount: number;
      kind: "copied";
    }
  | {
      kind: "empty";
    }
  | {
      kind: "unavailable";
    }
  | {
      kind: "failed";
      message: string;
    };

type SelectionCopyHandlerOptions = {
  clearSelection: () => void;
  getSelectionText: () => string | null | undefined;
  writeClipboardText?: TuiWriteClipboardText;
};

export function createSelectionCopyHandler({
  clearSelection,
  getSelectionText,
  writeClipboardText,
}: SelectionCopyHandlerOptions): () => Promise<SelectionCopyResult> {
  return async () => {
    const text = getSelectionText();
    if (!hasCopyableSelectionText(text)) {
      clearSelection();
      return { kind: "empty" };
    }
    if (!writeClipboardText) {
      clearSelection();
      return { kind: "unavailable" };
    }

    try {
      await writeClipboardText(text);
      return {
        characterCount: text.length,
        kind: "copied",
      };
    } catch (error) {
      return {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearSelection();
    }
  };
}

export function hasCopyableSelectionText(text: string | null | undefined): text is string {
  return typeof text === "string" && text.trim().length > 0;
}

export type LastReplyCopyOptions = {
  liveModelText: string;
  messages: readonly Message[];
  setStatus: (status: string) => void;
  setStatusDetails: (details: string[]) => void;
  unavailableStatus: string;
  writeClipboardText?: TuiWriteClipboardText;
};

/**
 * `Ctrl+Y` 的复制目标与 AppView 渲染的"最近回复"一致：liveModelText 尚未落进
 * messages，按同样方式补一条尾部 agent 消息再取最后一条回复文本。
 */
export function copyLastAssistantReply(input: LastReplyCopyOptions): void {
  const transcript = input.liveModelText
    ? [...input.messages, { content: input.liveModelText, role: "agent" as const, streaming: true }]
    : input.messages;
  const text = lastAgentReplyText(transcript);
  if (!text) {
    input.setStatus(NO_ASSISTANT_REPLY_STATUS);
    return;
  }
  if (!input.writeClipboardText) {
    input.setStatus(input.unavailableStatus);
    return;
  }
  void Promise.resolve(input.writeClipboardText(text)).then(
    () => input.setStatus(LAST_REPLY_COPIED_STATUS),
    (error: unknown) => {
      input.setStatus(LAST_REPLY_COPY_FAILED_STATUS);
      input.setStatusDetails([error instanceof Error ? error.message : String(error)]);
    },
  );
}

export function useTuiCopyActions({
  copy,
  copySelection,
  hasCopyableSelection,
  liveModelText,
  messages,
  options,
  setStatus,
  setStatusDetails,
}: {
  copy: TuiCopy["copy"];
  copySelection: () => Promise<SelectionCopyResult>;
  hasCopyableSelection: () => boolean;
  liveModelText: string;
  messages: readonly Message[];
  options: { writeClipboardText?: TuiWriteClipboardText };
  setStatus: (status: string) => void;
  setStatusDetails: (details: string[]) => void;
}): {
  copyCurrentSelection: () => boolean;
  copyLastReply: () => void;
} {
  const copyCurrentSelection = React.useCallback((): boolean => {
    if (!hasCopyableSelection()) return false;
    void copySelection().then((result) => {
      const copyStatus = selectionCopyStatus(result, copy);
      if (copyStatus.status) setStatus(copyStatus.status);
      if (copyStatus.details) setStatusDetails(copyStatus.details);
    });
    return true;
  }, [copy, copySelection, hasCopyableSelection, setStatus, setStatusDetails]);
  const copyLastReply = React.useCallback(() => {
    copyLastAssistantReply({
      liveModelText,
      messages,
      setStatus,
      setStatusDetails,
      unavailableStatus: copy.unavailable,
      writeClipboardText: options.writeClipboardText,
    });
  }, [copy, liveModelText, messages, options.writeClipboardText, setStatus, setStatusDetails]);

  return { copyCurrentSelection, copyLastReply };
}

export function selectionCopyStatus(
  result: SelectionCopyResult,
  copy: TuiCopy["copy"],
): {
  details?: string[];
  status?: string;
} {
  if (result.kind === "copied") {
    return {
      details: [],
      status: copy.copied,
    };
  }
  if (result.kind === "unavailable") {
    return {
      details: [],
      status: copy.unavailable,
    };
  }
  if (result.kind === "failed") {
    return {
      details: [result.message],
      status: copy.failed,
    };
  }
  return {};
}
