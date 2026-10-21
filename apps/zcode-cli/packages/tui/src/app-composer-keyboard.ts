import type { KeyEvent } from "@mbears/opentui-core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { MODEL_COMMAND_DRAFT, modelCommandQuery } from "./app-input.js";
import {
  CTRL_C_EXIT_PROMPT,
  ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS,
  ESCAPE_PAUSE_PROMPT,
  NO_ACTIVE_OUTPUT_STATUS,
  NO_SELECTABLE_MODEL_STATUS,
  ONLY_ONE_MODEL_STATUS,
  PROMPT_DRAFT_CLEARED_STATUS,
  type CtrlCExitGuard,
  type DoublePressGuard,
  consumeKeyEvent,
  modelPickerIndex,
  nextSelectableModelOption,
  resetCtrlCExitGuard,
  resetDoublePressGuard,
  resolveCtrlCExitIntent,
  resolveDoublePressIntent,
  shouldClearPromptDraftOnCtrlC,
  shouldExitOnCtrlD,
} from "./app-keyboard-helpers.js";
import { modelCommandText } from "./app-model-ref.js";
import type {
  DraftAttachment,
  EffortCommandSelectionState,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  SlashSelectionState,
  SubmitValueOptions,
} from "./app-model.js";
import type { TuiModelOption, TuiSubmitPromptResult } from "./types.js";

type ComposerShortcutInput = {
  abortControllerRef: MutableRefObject<AbortController | undefined>;
  busy: boolean;
  copyLastAssistantReply: () => void;
  ctrlCExitGuard: CtrlCExitGuard;
  currentModel: string;
  draftValue: string;
  effortSelection: EffortCommandSelectionState | undefined;
  escapePauseGuard: DoublePressGuard;
  hasDraftAttachments: () => boolean;
  key: KeyEvent;
  modelOptions: readonly TuiModelOption[];
  modelSelection: ModelCommandSelectionState | undefined;
  modeSelection: ModeCommandSelectionState | undefined;
  onExit: (code: number) => void;
  rememberModelPickerDraft: (draft: string) => void;
  restoreModelPickerDraft: () => string | undefined;
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setEffortSelection: Dispatch<SetStateAction<EffortCommandSelectionState | undefined>>;
  setModelSelection: Dispatch<SetStateAction<ModelCommandSelectionState | undefined>>;
  setModeSelection: Dispatch<SetStateAction<ModeCommandSelectionState | undefined>>;
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  setStatus: Dispatch<SetStateAction<string>>;
  slashSelection: SlashSelectionState | undefined;
  submitValue: (
    value: string,
    options?: SubmitValueOptions,
  ) => Promise<TuiSubmitPromptResult | undefined>;
};

export function handleComposerEditKey(input: ComposerShortcutInput): boolean {
  const { key } = input;

  if (key.name === "c" && key.ctrl) {
    consumeKeyEvent(key);
    if (shouldClearPromptDraftOnCtrlC(input.draftValue)) {
      resetCtrlCExitGuard(input.ctrlCExitGuard);
      input.setDraftValue("");
      input.setDraftAttachments([]);
      input.setStatus(PROMPT_DRAFT_CLEARED_STATUS);
      return true;
    }

    // A single Ctrl-C used to exit immediately, which made long sessions easy to lose.
    if (resolveCtrlCExitIntent(input.ctrlCExitGuard, Date.now()) === "confirm_exit") {
      input.abortControllerRef.current?.abort();
      input.onExit(0);
      return true;
    }

    input.setStatus(CTRL_C_EXIT_PROMPT);
    return true;
  }

  resetCtrlCExitGuard(input.ctrlCExitGuard);

  if (
    key.name === "d" &&
    key.ctrl &&
    shouldExitOnCtrlD({
      draftValue: input.draftValue,
      hasAttachments: input.hasDraftAttachments(),
    })
  ) {
    consumeKeyEvent(key);
    input.abortControllerRef.current?.abort();
    input.onExit(0);
    return true;
  }

  if (key.name === "y" && key.ctrl) {
    consumeKeyEvent(key);
    input.copyLastAssistantReply();
    return true;
  }

  if (key.name === "p" && key.ctrl) {
    consumeKeyEvent(key);
    const selectableCount = input.modelOptions.filter((model) => !model.disabledReason).length;
    if (selectableCount === 0) {
      input.setStatus(NO_SELECTABLE_MODEL_STATUS);
      return true;
    }
    if (selectableCount === 1) {
      input.setStatus(ONLY_ONE_MODEL_STATUS);
      return true;
    }
    const nextModel = nextSelectableModelOption(input.modelOptions, input.currentModel);
    if (!nextModel) {
      input.setStatus(ONLY_ONE_MODEL_STATUS);
      return true;
    }
    const preserveDraft = modelCommandQuery(input.draftValue) === undefined;
    void input
      .submitValue(modelCommandText(nextModel), { preserveDraft, silent: true })
      .then((result) => {
        if (result?.response) input.setStatus(result.response);
      });
    return true;
  }

  if (key.name === "l" && key.ctrl) {
    consumeKeyEvent(key);
    if (modelCommandQuery(input.draftValue) === undefined) {
      input.rememberModelPickerDraft(input.draftValue);
    }
    input.setDraftValue(MODEL_COMMAND_DRAFT);
    input.setModelSelection({
      selectedIndex: modelPickerIndex(input.modelOptions, input.currentModel),
    });
    return true;
  }

  return false;
}

export function handleComposerEscapeKey(input: ComposerShortcutInput): boolean {
  const { key } = input;
  if (key.name !== "escape") return false;

  consumeKeyEvent(key);
  if (input.modelSelection) {
    input.setModelSelection(undefined);
    const savedDraft = input.restoreModelPickerDraft();
    if (savedDraft !== undefined) input.setDraftValue(savedDraft);
    input.setStatus("Model suggestions dismissed.");
    return true;
  }
  if (input.effortSelection) {
    input.setEffortSelection(undefined);
    input.setStatus("Effort suggestions dismissed.");
    return true;
  }
  if (input.modeSelection) {
    input.setModeSelection(undefined);
    input.setStatus("Mode suggestions dismissed.");
    return true;
  }
  if (input.slashSelection) {
    input.setSlashSelection(undefined);
    input.setStatus("Slash suggestions dismissed.");
    return true;
  }
  if (input.busy) {
    if (
      resolveDoublePressIntent(
        input.escapePauseGuard,
        Date.now(),
        ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS,
      ) === "confirm"
    ) {
      input.abortControllerRef.current?.abort();
      input.setStatus("Pausing current output...");
    } else {
      input.setStatus(ESCAPE_PAUSE_PROMPT);
    }
    return true;
  }
  resetDoublePressGuard(input.escapePauseGuard);
  input.setStatus(NO_ACTIVE_OUTPUT_STATUS);
  return true;
}
