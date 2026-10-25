// Global single-key chords: copy last reply (ctrl+x), session info panel
// (ctrl+o), new session (ctrl+n), thought expansion (ctrl+t), follow-up queue
// (ctrl+q), queued-input restore (alt+up).
//
// 所有 chord 只走 matchesKey：它识别 kitty CSI-u 键码，keyEventFromInput
// 不识别——两键 leader（旧 Ctrl+X→B sidebar）在 kitty 协议下收不到 CSI-u
// 形式的 leader 键、永不 arm（后续普通键直接落进编辑器），已退役。

import { matchesKey } from "@earendil-works/pi-tui";
import type { QueuedInput, TuiOptions } from "@zcode/tui/internals";
import type { AppStore } from "./store.js";

export const NEW_SESSION_BUSY_STATUS =
  "Finish the current turn before starting a new session.";
export const NEW_SESSION_COMMAND = "/new";
export const THINKING_EXPANDED_STATUS = "Thinking expanded.";
export const THINKING_COLLAPSED_STATUS = "Thinking collapsed.";
export const LAST_REPLY_COPIED_STATUS = "Copied last assistant reply.";
export const NO_REPLY_TO_COPY_STATUS = "No assistant reply to copy.";
export const COPY_REPLY_FAILED_STATUS = "Could not copy last assistant reply.";
export const NO_QUEUED_TO_RESTORE_STATUS = "No queued messages to restore.";
export const QUEUED_RESTORE_FAILED_STATUS = "Could not remove queued messages.";

/** pi-mono 对齐（app.message.dequeue）：`Restored N queued message(s) to editor.` */
export const restoredQueuedStatus = (count: number): string =>
  `Restored ${count} queued message${count > 1 ? "s" : ""} to editor.`;

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

/**
 * Ctrl+V / Alt+V：剪贴板图片粘贴（Windows 终端常吃掉 ctrl+v，alt+v 兜底）。
 */
export const matchesImagePasteChord = (data: string): boolean =>
  matchesKey(data, "ctrl+v") || matchesKey(data, "alt+v");

/**
 * Ctrl+Q（pi-mono app.message.followUp）与 Alt+Up（app.message.dequeue）的
 * chord 分派：Ctrl+Q busy 时显式 follow-up 排队（`delivery:"queue"`，attach
 * 模式本地 FIFO，settle 后重放）、空闲时与 Enter 完全同路（`!cmd` 与 Enter
 * 同样立即本地执行，不排队）；Alt+Up 把排队输入拼回输入框并撤回。
 * 返回 true 表示命中（调用方消费输入）。
 */
export const handleSteerQueueChord = (input: {
  data: string;
  editor: { getText(): string };
  history: { setDraftValue(value: string): void };
  options: TuiOptions;
  store: AppStore;
  /** 走 app 的编辑器提交路径（addToHistory / `!cmd` / submitValue）。 */
  submit: (text: string, submitOptions?: { delivery?: "queue" }) => void;
}): boolean => {
  const { data, store } = input;
  const busy = () => store.state.busy || Boolean(store.state.activeTurnId);

  if (matchesKey(data, "ctrl+q")) {
    const trimmed = input.editor.getText().trim();
    if (!trimmed) return true;
    input.submit(trimmed, busy() ? { delivery: "queue" } : undefined);
    return true;
  }

  // matchesKey 按 modifier 精确匹配，与空草稿裸 Up 的历史分支不冲突。
  if (matchesKey(data, "alt+up")) {
    void restoreQueuedToEditor({
      currentDraft: () => input.editor.getText(),
      queuedInputs: () => store.state.queuedInputs,
      removeQueuedInputs: input.options.removeQueuedInputs,
      setDraft: (value) => input.history.setDraftValue(value),
      setStatus: (status) => store.set("status", status),
    });
    return true;
  }

  return false;
};

/**
 * Alt+Up（pi-mono app.message.dequeue）：把排队输入（steer pending + follow-up）
 * 按 `\n\n` 拼回输入框（当前草稿非空时保留在末尾），再让各队列 owner 摘除。
 * 撤回按实际移除计数——已被消费的项（竞态）由 discarded/drained 事件自行
 * 清行，不重复计数。附件只随文本恢复语义丢弃（pi-mono 同为纯文本恢复）。
 */
export const restoreQueuedToEditor = async (input: {
  currentDraft: () => string;
  queuedInputs: () => readonly QueuedInput[];
  removeQueuedInputs: TuiOptions["removeQueuedInputs"];
  setDraft: (value: string) => void;
  setStatus: (status: string) => void;
}): Promise<void> => {
  const queued = input.queuedInputs();
  if (queued.length === 0) {
    input.setStatus(NO_QUEUED_TO_RESTORE_STATUS);
    return;
  }
  const currentDraft = input.currentDraft().trim();
  const combined = [...queued.map((item) => item.text), ...(currentDraft ? [currentDraft] : [])]
    .filter((text) => text.length > 0)
    .join("\n\n");
  input.setDraft(combined);
  if (!input.removeQueuedInputs) {
    // 端口缺席（未接线的前端宿主）：文本仍恢复，队列行留给事件投影收敛。
    input.setStatus(restoredQueuedStatus(queued.length));
    return;
  }
  try {
    const removed = await input.removeQueuedInputs(queued.map((item) => item.id));
    input.setStatus(
      removed.length > 0
        ? restoredQueuedStatus(removed.length)
        : NO_QUEUED_TO_RESTORE_STATUS,
    );
  } catch {
    // 撤回失败不回滚已恢复的文本（输入不丢优先）；行由事件纠正。
    input.setStatus(QUEUED_RESTORE_FAILED_STATUS);
  }
};
