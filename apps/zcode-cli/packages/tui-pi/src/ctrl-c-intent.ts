// Ctrl-C 意图的唯一 owner：字节路径（raw 模式下的 0x03 字节）与信号路径
// （SIGINT）共享同一条 guard 与同一份状态。
//
// 共享状态是有意的——多路复用器（herdr pane 等）把 Ctrl-C 递送为信号时，
// 不能因为"上一次按的是字节"就绕过双击确认；反过来也不能因为上一次是信号
// 就让字节路径直接退出。两条路径必须表现一致。
//
// 语义与主 CLI 一致：非空草稿时首个 Ctrl-C 只清草稿，空草稿时双击才退出。
import {
  CTRL_C_EXIT_PROMPT,
  PROMPT_DRAFT_CLEARED_STATUS,
  createCtrlCExitGuard,
  resolveCtrlCExitIntent,
  resetCtrlCExitGuard,
  shouldClearPromptDraftOnCtrlC,
  type CtrlCExitGuard,
} from "@zcode/tui/internals";

export type CtrlCIntentOutcome =
  | { kind: "draft_cleared" }
  | { kind: "exit_prompt" }
  | { kind: "exit_confirmed" };

/**
 * 解析一次 Ctrl-C 意图。guard 由调用方持有（同一 app 生命周期内共享）。
 *
 * @param guard 双击确认状态；调用方必须复用同一个实例
 * @param draft 当前输入框内容
 * @param nowMs 当前时间（双击窗口判定）
 */
export const resolveCtrlCIntent = (
  guard: CtrlCExitGuard,
  draft: string,
  nowMs: number = Date.now(),
): CtrlCIntentOutcome => {
  if (shouldClearPromptDraftOnCtrlC(draft)) {
    resetCtrlCExitGuard(guard);
    return { kind: "draft_cleared" };
  }
  if (resolveCtrlCExitIntent(guard, nowMs) === "confirm_exit") return { kind: "exit_confirmed" };
  return { kind: "exit_prompt" };
};

/** 状态行文案：与解析结果一一对应。 */
export const ctrlCIntentStatus = (outcome: CtrlCIntentOutcome): string => {
  if (outcome.kind === "draft_cleared") return PROMPT_DRAFT_CLEARED_STATUS;
  return CTRL_C_EXIT_PROMPT;
};

/**
 * 执行一次 Ctrl-C 意图。app.ts 只提供回调，决策全部在本模块——
 * 字节路径与信号路径因此必然一致。
 */
export const runCtrlCIntent = ({
  abortTurn,
  clearDraft,
  draft,
  exit,
  guard,
  setStatus,
}: {
  abortTurn: () => void;
  clearDraft: () => void;
  draft: string;
  exit: () => void;
  guard: CtrlCExitGuard;
  setStatus: (status: string) => void;
}): void => {
  const outcome = resolveCtrlCIntent(guard, draft);
  if (outcome.kind === "draft_cleared") {
    clearDraft();
    setStatus(ctrlCIntentStatus(outcome));
    return;
  }
  if (outcome.kind === "exit_confirmed") {
    abortTurn();
    exit();
    return;
  }
  setStatus(ctrlCIntentStatus(outcome));
};

/** 新建一份双击确认状态（每个 TUI 实例一份）。 */
export const createCtrlCIntentGuard = (): CtrlCExitGuard => createCtrlCExitGuard();

/** 其他按键按下时重置双击确认（“按了 Ctrl-C 又打了别的键”不算双击）。 */
export { resetCtrlCExitGuard };
