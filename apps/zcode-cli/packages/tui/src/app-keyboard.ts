import type { KeyEvent } from "@mbears/opentui-core";
import type { TuiWorkflowExpansionControls } from "./app-workflow-controller.js";
import { useKeyboard } from "@mbears/opentui-react";
import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { handleApprovalKey } from "./app-approval.js";
import { handleComposerEditKey, handleComposerEscapeKey } from "./app-composer-keyboard.js";
import { handleSelectionKey } from "./app-input.js";
import {
  completeEffortCommand,
  completeModeCommand,
  completeModelCommand,
  completeSlashCommand,
  consumeKeyEvent as consumeKey,
  createCtrlCExitGuard,
  createDoublePressGuard,
  type CtrlCExitGuard,
  isModeSwitchKey,
  resetCtrlCExitGuard,
  resetDoublePressGuard,
  shouldHandleInputHistoryNavigation,
  workflowExpansionActionFor,
} from "./app-keyboard-helpers.js";
import { handleSuggestionNavigationKey } from "./app-keyboard-suggestions.js";
import { useSelectionPaste } from "./app-selection-paste.js";
import { createSidebarShortcutState, type SidebarShortcutState } from "./app-sidebar-shortcut.js";
import { handleSidebarShortcutKey } from "./app-sidebar-keyboard.js";
import type {
  ApprovalPrompt,
  DraftAttachment,
  EffortCommandSelectionState,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  SelectionState,
  SubmitValueOptions,
  SlashCommand,
  SlashSelectionState,
} from "./app-model.js";
import type { SidebarSectionId } from "./app-sidebar-layout.js";
import type {
  TuiEffortOption,
  TuiModeOption,
  TuiModelOption,
  TuiSubmitPromptResult,
} from "./types.js";

export {
  CTRL_C_EXIT_CONFIRMATION_WINDOW_MS,
  ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS,
  ESCAPE_PAUSE_PROMPT,
  NO_SELECTABLE_MODEL_STATUS,
  ONLY_ONE_MODEL_STATUS,
  completeEffortCommand,
  completeModeCommand,
  completeModelCommand,
  completeSlashCommand,
  createCtrlCExitGuard,
  createDoublePressGuard,
  isModeSwitchKey,
  modelPickerIndex,
  nextSelectableModelOption,
  resetCtrlCExitGuard,
  resetDoublePressGuard,
  resolveCtrlCExitIntent,
  resolveDoublePressIntent,
  shouldHandleInputHistoryNavigation,
} from "./app-keyboard-helpers.js";

type UseTuiKeyboardControlsOptions = {
  readOnlyView?: { back(): void };
  abortControllerRef: MutableRefObject<AbortController | undefined>;
  approvalQueue: ApprovalPrompt[];
  busy: boolean;
  copyLastAssistantReply: () => void;
  currentModel: string;
  draftValue: string;
  workflowExpansion?: TuiWorkflowExpansionControls;
  filteredEffortOptions: readonly TuiEffortOption[];
  filteredModeOptions: readonly TuiModeOption[];
  filteredModelOptions: readonly TuiModelOption[];
  filteredSlashCommands: readonly SlashCommand[];
  handleFileMentionKey: (key: KeyEvent) => boolean;
  hasDraftAttachments: () => boolean;
  inputHistoryActive: boolean;
  modelOptions: readonly TuiModelOption[];
  effortSelection: EffortCommandSelectionState | undefined;
  modelSelection: ModelCommandSelectionState | undefined;
  modeSelection: ModeCommandSelectionState | undefined;
  onExit: (code: number) => void;
  pasteClipboardImage: () => Promise<void>;
  recallNextInput: () => Promise<void>;
  recallPreviousInput: () => Promise<void>;
  selection: SelectionState | undefined;
  setApprovalQueue: Dispatch<SetStateAction<ApprovalPrompt[]>>;
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setEffortSelection: Dispatch<SetStateAction<EffortCommandSelectionState | undefined>>;
  setModelSelection: Dispatch<SetStateAction<ModelCommandSelectionState | undefined>>;
  setModeSelection: Dispatch<SetStateAction<ModeCommandSelectionState | undefined>>;
  setSelection: Dispatch<SetStateAction<SelectionState | undefined>>;
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  setStatus: Dispatch<SetStateAction<string>>;
  slashSelection: SlashSelectionState | undefined;
  submitValue: (
    value: string,
    options?: SubmitValueOptions,
  ) => Promise<TuiSubmitPromptResult | undefined>;
  switchMode: () => void;
  toggleSidebar: () => boolean;
  toggleSidebarSection: (section: SidebarSectionId) => boolean;
};

export function useTuiKeyboardControls({
  readOnlyView,
  abortControllerRef,
  approvalQueue,
  busy,
  copyLastAssistantReply,
  currentModel,
  draftValue,
  workflowExpansion,
  filteredEffortOptions,
  filteredModeOptions,
  filteredModelOptions,
  filteredSlashCommands,
  handleFileMentionKey,
  hasDraftAttachments,
  inputHistoryActive,
  modelOptions,
  effortSelection,
  modelSelection,
  modeSelection,
  onExit,
  pasteClipboardImage,
  recallNextInput,
  recallPreviousInput,
  selection,
  setApprovalQueue,
  setDraftAttachments,
  setDraftValue,
  setEffortSelection,
  setModelSelection,
  setModeSelection,
  setSelection,
  setSlashSelection,
  setStatus,
  slashSelection,
  submitValue,
  switchMode,
  toggleSidebar,
  toggleSidebarSection,
}: UseTuiKeyboardControlsOptions): void {
  const ctrlCExitGuardRef = useRef<CtrlCExitGuard>(createCtrlCExitGuard());
  const escapePauseGuardRef = useRef(createDoublePressGuard());
  const modelPickerDraftRef = useRef<string | undefined>(undefined);
  const sidebarShortcutRef = useRef<SidebarShortcutState>(createSidebarShortcutState());

  // 选择器由提交路径关闭时 modelSelection 变回 undefined，此时旧草稿不应再被恢复。
  useEffect(() => {
    if (!modelSelection) modelPickerDraftRef.current = undefined;
  }, [modelSelection]);

  const rememberModelPickerDraft = useCallback((draft: string) => {
    modelPickerDraftRef.current = draft;
  }, []);
  const restoreModelPickerDraft = useCallback(() => {
    const draft = modelPickerDraftRef.current;
    modelPickerDraftRef.current = undefined;
    return draft;
  }, []);

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (key.eventType === "release") return;
        if (key.name !== "escape") resetDoublePressGuard(escapePauseGuardRef.current);

        if (readOnlyView) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          if (
            handleSidebarShortcutKey({
              consumeKey,
              key,
              nowMs: Date.now(),
              setStatus,
              shortcutState: sidebarShortcutRef.current,
              toggleSidebar,
              toggleSidebarSection,
            })
          )
            return;
          if (key.name === "escape") {
            consumeKey(key);
            readOnlyView.back();
          } else if (
            !["up", "down", "left", "right", "pageup", "pagedown", "home", "end"].includes(key.name)
          ) {
            consumeKey(key);
          }
          return;
        }

        const approval = approvalQueue[0];
        if (approval) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          consumeKey(key);
          handleApprovalKey(key, approval, setApprovalQueue, setStatus);
          return;
        }

        if (selection) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          consumeKey(key);
          handleSelectionKey(key, selection, setSelection, setStatus, submitValue, () => {
            abortControllerRef.current?.abort();
          });
          return;
        }

        if (
          handleSidebarShortcutKey({
            consumeKey,
            key,
            nowMs: Date.now(),
            setStatus,
            shortcutState: sidebarShortcutRef.current,
            toggleSidebar,
            toggleSidebarSection,
          })
        ) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          return;
        }

        const composerInput = {
          abortControllerRef,
          busy,
          copyLastAssistantReply,
          ctrlCExitGuard: ctrlCExitGuardRef.current,
          currentModel,
          draftValue,
          effortSelection,
          escapePauseGuard: escapePauseGuardRef.current,
          hasDraftAttachments,
          key,
          modelOptions,
          modelSelection,
          modeSelection,
          onExit,
          rememberModelPickerDraft,
          restoreModelPickerDraft,
          setDraftAttachments,
          setDraftValue,
          setEffortSelection,
          setModelSelection,
          setModeSelection,
          setSlashSelection,
          setStatus,
          slashSelection,
          submitValue,
        };

        if (handleComposerEditKey(composerInput)) return;

        // Mode switching belongs to the composer, including while @ suggestions
        // are open; file completion must only receive the remaining Tab keys.
        if (isModeSwitchKey(key)) {
          consumeKey(key);
          void switchMode();
          return;
        }

        if (handleFileMentionKey(key)) {
          consumeKey(key);
          return;
        }

        if (key.name === "tab") {
          consumeKey(key);
          if (completeModelCommand(filteredModelOptions, modelSelection, setDraftValue)) {
            setModelSelection(undefined);
            return;
          }
          if (completeEffortCommand(filteredEffortOptions, effortSelection, setDraftValue)) {
            setEffortSelection(undefined);
            return;
          }
          if (completeModeCommand(filteredModeOptions, modeSelection, setDraftValue)) {
            setModeSelection(undefined);
            return;
          }
          if (completeSlashCommand(filteredSlashCommands, slashSelection, setDraftValue)) {
            setSlashSelection(undefined);
          }
          return;
        }

        if (handleComposerEscapeKey(composerInput)) return;

        if (
          handleSuggestionNavigationKey({
            consumeKey,
            effortSelection,
            filteredEffortOptions,
            filteredModeOptions,
            filteredModelOptions,
            filteredSlashCommands,
            key,
            modelSelection,
            modeSelection,
            setEffortSelection,
            setModeSelection,
            setModelSelection,
            setSlashSelection,
            slashSelection,
          })
        ) {
          return;
        }

        if (
          key.name === "up" &&
          shouldHandleInputHistoryNavigation({ draftValue, inputHistoryActive })
        ) {
          consumeKey(key);
          void recallPreviousInput();
          return;
        }

        if (
          key.name === "down" &&
          shouldHandleInputHistoryNavigation({ draftValue, inputHistoryActive })
        ) {
          consumeKey(key);
          void recallNextInput();
          return;
        }

        // `+` / `-` 展开/收起全部 workflow 卡（spec 无卡片选择机制，只能作用于全体）。
        // 键位与两层闸门（草稿为空 + 至少一张卡）全部收在纯函数里，直接可测。
        const workflowExpansionKey = workflowExpansionActionFor({
          key,
          draftValue,
          hasCards: workflowExpansion?.hasCards ?? false,
        });
        if (workflowExpansionKey && workflowExpansion) {
          consumeKey(key);
          if (workflowExpansionKey === "expand") workflowExpansion.expandAll();
          else workflowExpansion.collapseAll();
          return;
        }

        if ((key.name === "v" && (key.ctrl || key.meta)) || key.raw === "\x16") {
          consumeKey(key);
          void pasteClipboardImage();
        }
      },
      [
        readOnlyView,
        abortControllerRef,
        approvalQueue,
        workflowExpansion,
        busy,
        copyLastAssistantReply,
        currentModel,
        draftValue,
        effortSelection,
        filteredEffortOptions,
        filteredModeOptions,
        filteredModelOptions,
        filteredSlashCommands,
        handleFileMentionKey,
        hasDraftAttachments,
        inputHistoryActive,
        modelOptions,
        modelSelection,
        modeSelection,
        onExit,
        pasteClipboardImage,
        recallNextInput,
        recallPreviousInput,
        selection,
        setApprovalQueue,
        setDraftAttachments,
        setDraftValue,
        setEffortSelection,
        setModelSelection,
        setModeSelection,
        setSelection,
        setSlashSelection,
        setStatus,
        slashSelection,
        submitValue,
        switchMode,
        toggleSidebar,
        toggleSidebarSection,
      ],
    ),
  );

  // 粘贴与键盘走两条通道：bracketed paste 是独立 paste 事件，须单独订阅，
  // 否则选择面板（composer 已被替换）打开时粘贴无人消费，长文本无法录入。
  useSelectionPaste({ approvalQueue, readOnlyView, selection, setSelection });
}
