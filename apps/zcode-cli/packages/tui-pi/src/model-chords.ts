// Model chords (Ctrl+P rotate / Ctrl+L picker) for the pi frontend.
//
// Same semantics as the React frontend's composer shortcuts, but they drive the
// attach-side command path: a rotation is a `/model <provider/model>` submit, so
// the model change still travels through the core (state.updated) instead of a
// client-local guess.

import {
  NO_SELECTABLE_MODEL_STATUS,
  ONLY_ONE_MODEL_STATUS,
  createSelectionState,
  modelCommandQuery,
  modelCommandText,
  modelOptionValue,
  modelPickerIndex,
  nextSelectableModelOption,
} from "@zcode/tui/internals";
import type {
  SelectionState,
  SubmitValueOptions,
  TuiModelOption,
  TuiSelection,
  TuiSubmitPromptResult,
} from "@zcode/tui/internals";

type DisableableModel = TuiModelOption & { disabledReason?: string };

export const rotateModel = (input: {
  currentModel: string;
  draft: string;
  models: readonly TuiModelOption[];
  setStatus: (status: string) => void;
  submitValue: (
    value: string,
    options?: SubmitValueOptions,
  ) => Promise<TuiSubmitPromptResult | undefined>;
}): void => {
  const selectable = input.models.filter((model) => !(model as DisableableModel).disabledReason);
  if (selectable.length === 0) {
    input.setStatus(NO_SELECTABLE_MODEL_STATUS);
    return;
  }
  if (selectable.length === 1) {
    input.setStatus(ONLY_ONE_MODEL_STATUS);
    return;
  }
  const next = nextSelectableModelOption(input.models, input.currentModel);
  if (!next) {
    input.setStatus(ONLY_ONE_MODEL_STATUS);
    return;
  }
  // An in-progress `/model …` draft keeps its slot; any other draft is preserved
  // as text around the silent submit.
  const preserveDraft = modelCommandQuery(input.draft) === undefined;
  void input.submitValue(modelCommandText(next), { preserveDraft, silent: true }).then(
    (result) => {
      if (result?.response) input.setStatus(result.response);
    },
  );
};

export const openModelPicker = (input: {
  currentModel: string;
  models: readonly TuiModelOption[];
  setSelection: (selection: SelectionState | undefined) => void;
  setStatus: (status: string) => void;
}): void => {
  if (input.models.length === 0) {
    input.setStatus(NO_SELECTABLE_MODEL_STATUS);
    return;
  }
  const selection: TuiSelection = {
    emptyMessage: "No models available.",
    filterable: true,
    items: input.models.map((model) => ({
      command: modelCommandText(model),
      id: modelOptionValue(model),
      primary: model.label,
      secondary: modelOptionValue(model),
    })),
    prompt: "Select a model.",
    selectedIndex: modelPickerIndex(input.models, input.currentModel),
    title: "Switch model",
  };
  input.setSelection(createSelectionState(selection));
  input.setStatus("Select a model.");
};
