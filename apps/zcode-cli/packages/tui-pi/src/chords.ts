// Global single-key chords: copy last reply (ctrl+x), session info panel
// (ctrl+o), new session (ctrl+n), thought expansion (ctrl+t).
//
// 所有 chord 只走 matchesKey：它识别 kitty CSI-u 键码，keyEventFromInput
// 不识别——两键 leader（旧 Ctrl+X→B sidebar）在 kitty 协议下收不到 CSI-u
// 形式的 leader 键、永不 arm（后续普通键直接落进编辑器），已退役。

import { matchesKey } from "@earendil-works/pi-tui";
import type { TuiOptions } from "@zcode/tui/internals";

export const NEW_SESSION_BUSY_STATUS =
  "Finish the current turn before starting a new session.";
export const NEW_SESSION_COMMAND = "/new";
export const THINKING_EXPANDED_STATUS = "Thinking expanded.";
export const THINKING_COLLAPSED_STATUS = "Thinking collapsed.";
export const LAST_REPLY_COPIED_STATUS = "Copied last assistant reply.";
export const NO_REPLY_TO_COPY_STATUS = "No assistant reply to copy.";
export const COPY_REPLY_FAILED_STATUS = "Could not copy last assistant reply.";

export const copyLastReply = (input: {
  lastReply: () => string | undefined;
  setStatus: (status: string) => void;
  writeClipboardText: TuiOptions["writeClipboardText"];
}): void => {
  const { setStatus, writeClipboardText } = input;
  const lastReply = input.lastReply();
  if (!lastReply) {
    setStatus(NO_REPLY_TO_COPY_STATUS);
    return;
  }
  if (!writeClipboardText) {
    setStatus(COPY_REPLY_FAILED_STATUS);
    return;
  }
  void Promise.resolve(writeClipboardText(lastReply)).then(
    () => setStatus(LAST_REPLY_COPIED_STATUS),
    () => setStatus(COPY_REPLY_FAILED_STATUS),
  );
};

/** Returns true when `data` matched a chord (caller consumes the input). */
export const handleGlobalChord = (input: {
  /** busy || activeTurnId：与 quitChoice.turnBusy 同口径。 */
  busy: boolean;
  data: string;
  expandThoughts: boolean;
  invalidateThoughtRows: () => void;
  lastReply: () => string | undefined;
  setExpandThoughts: (expanded: boolean) => void;
  setStatus: (status: string) => void;
  submitNewSession: () => void;
  toggleInfoPanel: () => void;
  writeClipboardText: TuiOptions["writeClipboardText"];
}): boolean => {
  const { data } = input;

  if (matchesKey(data, "ctrl+x")) {
    copyLastReply(input);
    return true;
  }

  if (matchesKey(data, "ctrl+o")) {
    input.toggleInfoPanel();
    return true;
  }

  if (matchesKey(data, "ctrl+n")) {
    if (input.busy) input.setStatus(NEW_SESSION_BUSY_STATUS);
    else input.submitNewSession();
    return true;
  }

  if (matchesKey(data, "ctrl+t")) {
    const expanded = !input.expandThoughts;
    input.setExpandThoughts(expanded);
    // 行的 render 缓存按宽度命中；展开态变化后必须整体 invalidate 才会重排。
    input.invalidateThoughtRows();
    input.setStatus(expanded ? THINKING_EXPANDED_STATUS : THINKING_COLLAPSED_STATUS);
    return true;
  }

  return false;
};
