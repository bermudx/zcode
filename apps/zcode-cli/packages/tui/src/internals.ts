// Internal shared surface for alternate frontends (e.g. @zcode/tui-pi).
// Only modules whose runtime imports avoid @mbears/opentui-* belong here;
// `import type` on React/opentui is erased and safe. Adding a module that
// pulls opentui at runtime would load the native renderer into the pi
// frontend and break packaging — keep that invariant.

export * from "./state.js";
export * from "./app-model.js";
export * from "./app-locale.js";
export * from "./app-model-ref.js";
export * from "./app-terminal-width.js";
export * from "./app-event-data.js";
export * from "./app-transcript-stream.js";
export * from "./app-transcript-errors.js";
export * from "./app-model-streaming.js";
export * from "./app-events.js";
export * from "./app-session-event-handler.js";
export * from "./app-subagent-events.js";
export * from "./app-modified-files.js";
export * from "./app-network-events.js";
export * from "./app-compact-timeline.js";
export * from "./app-turn-complete.js";
export * from "./app-tool-transcript.js";
export * from "./app-tool-diff-display.js";
export * from "./app-tool-path-display.js";
export * from "./app-submit.js";
export * from "./app-submit-resolver.js";
export * from "./app-input.js";
export * from "./app-selection-keyboard.js";
export * from "./app-selection-state.js";
export * from "./app-question-state.js";
export * from "./app-approval.js";
export * from "./app-permission.js";
export * from "./app-keyboard-helpers.js";
export * from "./app-keyboard-suggestions.js";
export * from "./app-queued-inputs.js";
// types.js already exports TuiSwitchableMode; pull only the constants.
export { TUI_SWITCHABLE_MODES } from "./app-mode.js";
export * from "./app-workflow-mirror.js";
export * from "./app-workflow-events.js";
export * from "./types.js";
export * from "./theme/index.js";
