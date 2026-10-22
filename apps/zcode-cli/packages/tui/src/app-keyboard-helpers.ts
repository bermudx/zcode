import type { KeyEvent } from "@mbears/opentui-core";
import { clampIndex } from "./app-input.js";
import { modelCommandText, modelOptionValue } from "./app-model-ref.js";
import type {
  EffortCommandSelectionState,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  SlashCommand,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiEffortOption, TuiModeOption, TuiModelOption } from "./types.js";

export function completeSlashCommand(
  commands: readonly SlashCommand[],
  slashSelection: SlashSelectionState | undefined,
  setDraftValue: (value: string) => void,
): boolean {
  if (!slashSelection || commands.length === 0) return false;
  const command = commands[clampIndex(slashSelection.selectedIndex, commands.length)];
  if (!command) return false;
  setDraftValue(`/${command.name} `);
  return true;
}

export function completeModelCommand(
  models: readonly TuiModelOption[],
  modelSelection: ModelCommandSelectionState | undefined,
  setDraftValue: (value: string) => void,
): boolean {
  if (!modelSelection || models.length === 0) return false;
  const model = models[clampIndex(modelSelection.selectedIndex, models.length)];
  if (!model) return false;
  setDraftValue(modelCommandText(model));
  return true;
}

export function completeEffortCommand(
  efforts: readonly TuiEffortOption[],
  effortSelection: EffortCommandSelectionState | undefined,
  setDraftValue: (value: string) => void,
): boolean {
  if (!effortSelection || efforts.length === 0) return false;
  const effort = efforts[clampIndex(effortSelection.selectedIndex, efforts.length)];
  if (!effort) return false;
  setDraftValue(`/effort ${effort.id}`);
  return true;
}

export function completeModeCommand(
  modes: readonly TuiModeOption[],
  modeSelection: ModeCommandSelectionState | undefined,
  setDraftValue: (value: string) => void,
): boolean {
  if (!modeSelection || modes.length === 0) return false;
  const mode = modes[clampIndex(modeSelection.selectedIndex, modes.length)];
  if (!mode) return false;
  setDraftValue(`/mode ${mode.id}`);
  return true;
}

export function shouldHandleInputHistoryNavigation({
  draftValue,
  inputHistoryActive,
}: {
  draftValue: string;
  inputHistoryActive: boolean;
}): boolean {
  // model streaming output still leaves the composer editable; blocking
  // on busy made history recall unavailable exactly when users queue followups.
  return inputHistoryActive || draftValue.length === 0;
}

export function isModeSwitchKey(key: KeyEvent): boolean {
  return key.name === "tab" && key.shift;
}

/**
 * `+` / `-` 展开/收起全部 workflow 卡的**完整**判定（键位 + 两层闸门），导出为纯函数以便直接测试。
 * 键位：无修饰键的裸 `+` / `-`；Ctrl/Meta 组合另有归属，一律不认。
 * 闸门：草稿必须为空，且至少有一张 workflow 卡——否则这两个键必须照常打进草稿
 * （粘一段 diff 时第一个字符就是 +/-，吃掉它就是把输入弄坏）。
 */
export function workflowExpansionActionFor({
  key,
  draftValue,
  hasCards,
}: {
  key: KeyEvent;
  draftValue: string;
  hasCards: boolean;
}): "expand" | "collapse" | undefined {
  if (key.ctrl || key.meta) return undefined;
  if (draftValue.length > 0 || !hasCards) return undefined;
  const char = key.name ?? key.raw;
  if (char === "+") return "expand";
  if (char === "-") return "collapse";
  return undefined;
}

export const PROMPT_DRAFT_CLEARED_STATUS = "Ready.";
export const CTRL_C_EXIT_PROMPT = "Press Ctrl-C again to exit.";
export const ESCAPE_PAUSE_PROMPT = "Press Esc again to pause output.";
export const NO_ACTIVE_OUTPUT_STATUS = "No active output to pause. Press Ctrl-C twice to exit.";
export const ONLY_ONE_MODEL_STATUS = "Only one model available.";
export const NO_SELECTABLE_MODEL_STATUS = "No selectable models are available.";
export const LAST_REPLY_COPIED_STATUS = "Copied last assistant reply.";
export const LAST_REPLY_COPY_FAILED_STATUS = "Could not copy last assistant reply.";
export const NO_ASSISTANT_REPLY_STATUS = "No assistant reply to copy.";
export const CTRL_C_EXIT_CONFIRMATION_WINDOW_MS = 2_000;
export const ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS = 2_000;

export function shouldClearPromptDraftOnCtrlC(draftValue: string): boolean {
  return draftValue.length > 0;
}

/**
 * `Ctrl-D` 只在 composer 完全为空时退出：草稿文本和草稿附件都计入"空"的判定，
 * 否则已经贴好的图片/文件附件会被一次按键悄悄丢掉。
 */
export function shouldExitOnCtrlD({
  draftValue,
  hasAttachments,
}: {
  draftValue: string;
  hasAttachments: boolean;
}): boolean {
  return draftValue.length === 0 && !hasAttachments;
}

export function consumeKeyEvent(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}

export type DoublePressGuard = {
  lastPressAtMs: number | undefined;
};

type DoublePressIntent = "confirm" | "arm";

export function createDoublePressGuard(): DoublePressGuard {
  return { lastPressAtMs: undefined };
}

export function resolveDoublePressIntent(
  guard: DoublePressGuard,
  nowMs: number,
  windowMs: number,
): DoublePressIntent {
  const lastPressAtMs = guard.lastPressAtMs;
  const elapsedMs = lastPressAtMs === undefined ? undefined : nowMs - lastPressAtMs;
  if (elapsedMs !== undefined && elapsedMs >= 0 && elapsedMs <= windowMs) {
    guard.lastPressAtMs = undefined;
    return "confirm";
  }

  guard.lastPressAtMs = nowMs;
  return "arm";
}

export function resetDoublePressGuard(guard: DoublePressGuard): void {
  guard.lastPressAtMs = undefined;
}

export type CtrlCExitGuard = DoublePressGuard;

type CtrlCExitIntent = "confirm_exit" | "show_prompt";

export function createCtrlCExitGuard(): CtrlCExitGuard {
  return createDoublePressGuard();
}

export function resolveCtrlCExitIntent(
  guard: CtrlCExitGuard,
  nowMs: number,
  windowMs = CTRL_C_EXIT_CONFIRMATION_WINDOW_MS,
): CtrlCExitIntent {
  return resolveDoublePressIntent(guard, nowMs, windowMs) === "confirm"
    ? "confirm_exit"
    : "show_prompt";
}

export function resetCtrlCExitGuard(guard: CtrlCExitGuard): void {
  resetDoublePressGuard(guard);
}

/**
 * 当前模型 → option 下标。providerId 存在不同命名空间（快照/事件可能写
 * registry provider，选项 ref 用 account: 前缀 face），精确 ref 失配时
 * 退到尾部 modelId 匹配，避免 Ctrl+P/选择器永远钉在 selectable[0]。
 */
function findModelOptionIndex(
  models: readonly TuiModelOption[],
  currentModel: string,
): number {
  const value = currentModel.trim();
  const exact = models.findIndex((model) => modelOptionValue(model) === value);
  if (exact >= 0) return exact;
  const modelId = value.split("/").pop();
  if (!modelId) return -1;
  return models.findIndex((model) => model.ref.modelId === modelId);
}

export function modelPickerIndex(models: readonly TuiModelOption[], currentModel: string): number {
  const index = findModelOptionIndex(models, currentModel);
  return index < 0 ? 0 : index;
}

/** Next enabled model for `Ctrl+P`; `undefined` when there is nothing to cycle. */
export function nextSelectableModelOption(
  models: readonly TuiModelOption[],
  currentModel: string,
): TuiModelOption | undefined {
  const selectable = models.filter((model) => !model.disabledReason);
  if (selectable.length <= 1) return undefined;
  const currentIndex = findModelOptionIndex(selectable, currentModel);
  return selectable[(currentIndex + 1) % selectable.length];
}
