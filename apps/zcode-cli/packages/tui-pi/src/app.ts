// PiTuiApp: the pi-tui frontend controller. All projection semantics are
// delegated to @zcode/tui internals; this file owns component mounting,
// focus routing, chord dispatch, and the submit/permission/selection loop.

import {
  Container,
  Loader,
  Text,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import type { CollaborationMode, SessionEvent, TurnId } from "@zcode/contracts";
import { getZCodeCopy, type TuiCopy } from "@zcode/i18n";
import type {
  SubmitValueOptions,
  TuiModelOption,
  TuiOptions,
  TuiSelection,
  TuiStartupOptions,
  TuiSubmitPromptResult,
  TuiSwitchableMode,
} from "@zcode/tui/internals";
import {
  CTRL_C_EXIT_PROMPT,
  ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS,
  ESCAPE_PAUSE_PROMPT,
  NO_ACTIVE_OUTPUT_STATUS,
  NO_SELECTABLE_MODEL_STATUS,
  ONLY_ONE_MODEL_STATUS,
  PROMPT_DRAFT_CLEARED_STATUS,
  TUI_SWITCHABLE_MODES,
  applyMainSessionEvent,
  appendAgentResult,
  createCtrlCExitGuard,
  createDoublePressGuard,
  createSelectionState,
  createTuiPermissionRequester,
  lastAgentReplyText,
  modelCommandQuery,
  modelCommandText,
  modelOptionValue,
  modelPickerIndex,
  nextSelectableModelOption,
  resolveCtrlCExitIntent,
  resolveDoublePressIntent,
  resetCtrlCExitGuard,
  resetDoublePressGuard,
  shouldClearPromptDraftOnCtrlC,
  shouldExitOnCtrlD,
  submitDuringActiveTurn,
  submitIdleTurn,
  validContextUsage,
} from "@zcode/tui/internals";
import { Composer } from "./composer.js";
import { ApprovalPanel, QueuedInputsRow, SelectionPanel } from "./panels.js";
import { MessageRow, piMarkdownTheme, reconcileTranscript } from "./rows.js";
import { AppStore } from "./store.js";
import type { PiTheme } from "./theme.js";

const COPY_DEFAULT_LOCALE = "en-US" as const;

export type PiTuiAppDeps = {
  options: TuiOptions;
  tui: TUI;
  theme: PiTheme;
  onExit: (code: number) => void;
};

export class PiTuiApp {
  private readonly options: TuiOptions;
  private readonly tui: TUI;
  private readonly theme: PiTheme;
  private readonly onExit: (code: number) => void;
  private readonly store = new AppStore();
  private readonly transcript = new Container();
  private readonly interaction = new Container();
  private readonly composerBox = new Container();
  private readonly statusBox = new Container();
  private readonly statusLine: Text;
  private readonly loader: Loader;
  private readonly editor: Composer;
  private readonly rows: MessageRow[] = [];
  private readonly mdTheme;
  private readonly copy: TuiCopy;
  private readonly requestPermission;
  private readonly ctrlCGuard = createCtrlCExitGuard();
  private readonly escGuard = createDoublePressGuard();
  private readonly removeInputListener: () => void;
  private unsubscribeSession: (() => void) | undefined;
  private approvalPanel: ApprovalPanel | undefined;
  private selectionPanel: SelectionPanel | undefined;
  private queuedRow: QueuedInputsRow | undefined;
  private loaderMounted = false;
  private startupApplied = false;
  private readonly fallback: {
    locale: NonNullable<TuiOptions["locale"]>;
    loginRequired: boolean;
    mode: CollaborationMode;
    model: string;
  };

  constructor(deps: PiTuiAppDeps) {
    this.options = deps.options;
    this.tui = deps.tui;
    this.theme = deps.theme;
    this.onExit = deps.onExit;
    this.copy = getZCodeCopy(this.options.locale ?? COPY_DEFAULT_LOCALE).tui;
    this.mdTheme = piMarkdownTheme(this.theme);
    this.fallback = {
      locale: this.options.locale ?? COPY_DEFAULT_LOCALE,
      loginRequired: this.options.loginRequired ?? false,
      mode: (this.options.initialMode ?? "yolo") as CollaborationMode,
      model: this.options.initialModel ?? "",
    };

    const store = this.store;
    store.set("mode", this.fallback.mode as string);
    store.set("model", this.fallback.model);
    store.set("thoughtLevel", this.options.initialThoughtLevel ?? "");
    store.set("loginRequired", this.fallback.loginRequired);
    store.set("modelOptions", [...(this.options.modelOptions ?? [])]);
    store.set("effortOptions", [...(this.options.effortOptions ?? [])]);

    this.statusLine = new Text("", 1, 0);
    this.loader = new Loader(this.tui, this.theme.accent, this.theme.muted, "");

    this.editor = new Composer(this.tui, this.theme, {
      options: this.options,
      models: () => this.store.state.modelOptions,
      efforts: () => this.store.state.effortOptions,
    });
    this.editor.onSubmit = (text) => this.handleEditorSubmit(text);
    this.editor.onChange = () => {
      /* draft tracking happens via getText() at chord time */
    };

    this.composerBox.addChild(this.editor);
    this.statusBox.addChild(this.statusLine);

    this.tui.addChild(this.transcript);
    this.tui.addChild(this.interaction);
    this.tui.addChild(this.composerBox);
    this.tui.addChild(this.statusBox);

    this.requestPermission = createTuiPermissionRequester({
      setApprovalQueue: this.store.setter("approvalQueue"),
      setStatus: (status) => this.store.set("status", status),
    });

    this.unsubscribeSession = this.options.subscribeSessionEvents?.((event) =>
      this.applyEvent(event),
    );

    this.removeInputListener = this.tui.addInputListener((data) =>
      this.dispatchChord(data),
    );

    this.store.onChange((key) => this.onStateChanged(key));
    this.tui.setFocus(this.editor);
    this.refreshPanels();
    this.updateStatusLine();
  }

  /* ---------- startup ---------- */

  async applyStartupOptions(startup: TuiStartupOptions): Promise<void> {
    if (this.startupApplied) return;
    this.startupApplied = true;
    const store = this.store;
    if (startup.initialMode) {
      store.set("mode", startup.initialMode);
      this.fallback.mode = startup.initialMode;
    }
    if (startup.initialModel) {
      store.set("model", startup.initialModel);
      this.fallback.model = startup.initialModel;
    }
    if (startup.initialThoughtLevel !== undefined)
      store.set("thoughtLevel", startup.initialThoughtLevel);
    if (startup.loginRequired !== undefined) {
      store.set("loginRequired", startup.loginRequired);
      this.fallback.loginRequired = startup.loginRequired;
    }
    if (startup.locale) {
      this.fallback.locale = startup.locale;
    }
    if (startup.modelOptions) store.set("modelOptions", [...startup.modelOptions]);
    if (startup.effortOptions) store.set("effortOptions", [...startup.effortOptions]);
    if (startup.slashCommands) {
      this.options.slashCommands = startup.slashCommands;
      this.editor.refreshAutocomplete();
    }
    this.updateStatusLine();
  }

  /* ---------- event pipeline ---------- */

  applyEvent = (event: SessionEvent): void => {
    this.store.observeSessionEvent?.(event);
    applyMainSessionEvent(event, this.store.appliedEventIds, {
      assistantMessageIdsByToolCallId: this.store.assistantMessageIdsByToolCallId,
      copy: this.copy,
      getMainSessionId: this.options.getMainSessionId,
      modifiedFileToolCallIds: this.store.modifiedFileToolCallIds,
      observeSessionEvent: this.store.observeSessionEvent,
      setActiveTurnId: (turnId) => this.store.set("activeTurnId", turnId),
      setCacheStats: this.store.setter("cacheStats"),
      setContextUsage: this.store.setter("contextUsage"),
      setLastError: (message) => this.store.set("lastError", message),
      setLastEvent: (eventLabel) => this.store.set("lastEvent", eventLabel),
      setLiveModelText: this.store.setter("liveModelText"),
      setMessages: this.store.setter("messages"),
      setModel: (model) => this.store.set("model", model),
      setModifiedFiles: this.store.setter("modifiedFiles"),
      setNetworkRequests: this.store.setter("networkRequests"),
      setQueuedInputs: this.store.setter("queuedInputs"),
      setStatus: (status) => this.store.set("status", status),
      setThoughtLevel: (level) => this.store.set("thoughtLevel", level),
      setTodos: this.store.setter("todos"),
      setUsage: this.store.setter("usage"),
      setWorkflowMirror: this.workflowMirrorSetter,
      toolNamesById: this.store.toolNamesById,
      workspaceDirectory: this.options.workspaceDirectory,
    });
  };

  private workflowMirrorSetter = (
    value: unknown,
  ): void => {
    // Mirror kept only for workflow card rendering (moon feature); for now we
    // retain it so reducers that read it back stay consistent.
    if (typeof value === "function") {
      this.workflowMirror = (value as (prev: unknown) => unknown)(this.workflowMirror);
    } else {
      this.workflowMirror = value;
    }
  };
  private workflowMirror: unknown;

  /* ---------- result application (port of useTuiApplyResult) ---------- */

  applyResult = (result: TuiSubmitPromptResult, preserveTurnState = false): void => {
    const store = this.store;
    const resultCopy = getZCodeCopy(result.locale ?? this.fallback.locale).tui;
    if (result.mode) store.set("mode", result.mode);
    else store.set("mode", this.fallback.mode);
    store.set("model", result.model ?? this.fallback.model);
    if (result.locale) this.fallback.locale = result.locale;
    if (result.loginRequired !== undefined) {
      store.set("loginRequired", result.loginRequired);
      this.fallback.loginRequired = result.loginRequired;
    }
    if (result.effortOptions) store.set("effortOptions", [...result.effortOptions]);
    if (result.modelOptions) store.set("modelOptions", [...result.modelOptions]);
    if ("thoughtLevel" in result) store.set("thoughtLevel", result.thoughtLevel ?? "");
    store.setter("messages")((current) =>
      appendAgentResult(current, result, {
        workspaceDirectory: this.options.workspaceDirectory,
      }),
    );
    if (preserveTurnState) {
      store.set("status", "Agent is still responding.");
      return;
    }
    store.set("traceId", result.traceId);
    store.set("liveModelText", "");
    if (result.turnId) store.set("activeTurnId", result.turnId as TurnId);
    if (result.usage) store.set("usage", result.usage);
    if (result.projection) {
      store.setter("contextUsage")((current) => ({
        ...current,
        ...validContextUsage(result.projection ?? {}),
      }));
    }
    if (result.resetSessionProjection) {
      store.set("usage", undefined);
      store.set("contextUsage", {});
      store.set("cacheStats", undefined);
      store.set("todos", []);
      store.set("networkRequests", []);
      store.set("modifiedFiles", []);
      store.modifiedFileToolCallIds.clear();
    }
    store.set("selection", createSelectionState(result.selection));
    store.set("queuedInputs", []);
    const activeLoginRequired = result.loginRequired ?? this.fallback.loginRequired;
    store.set(
      "status",
      result.selection
        ? result.selection.prompt
        : activeLoginRequired
          ? resultCopy.loginRequired.status
          : resultCopy.status.ready,
    );
    store.set("lastEvent", result.turnId ? `turn ${result.turnId}` : "complete");
  };

  /* ---------- submit ---------- */

  submitValue = async (
    value: string,
    submitOptions?: SubmitValueOptions,
  ): Promise<TuiSubmitPromptResult | undefined> => {
    const store = this.store;
    const text = value.trim();
    if (!text) return undefined;

    if (store.state.busy || store.state.activeTurnId) {
      return submitDuringActiveTurn({
        activeTurnId: store.state.activeTurnId,
        applyResult: this.applyResult,
        applySessionEvent: this.applyEvent,
        draftAttachments: store.state.draftAttachments,
        messageInsertIndex: store.state.messages.length,
        options: this.options,
        requestPermission: this.requestPermission,
        setDraftValue: (v) => this.editor.setText(v),
        setLastError: (m) => store.set("lastError", m),
        setMessages: store.setter("messages"),
        setQueuedInputs: store.setter("queuedInputs"),
        setStatus: (s) => store.set("status", s),
        submitOptions,
        text,
      });
    }

    return submitIdleTurn({
      applyResult: this.applyResult,
      applySessionEvent: this.applyEvent,
      draftAttachments: store.state.draftAttachments,
      options: this.options,
      requestPermission: this.requestPermission,
      setBusy: (v) => {
        store.set("busy", v);
        this.syncBusyIndicator();
      },
      setDraftAttachments: store.setter("draftAttachments"),
      setDraftValue: (v) => this.editor.setText(v),
      setLastError: (m) => store.set("lastError", m),
      setLiveModelText: (v) => store.set("liveModelText", v),
      setMessages: store.setter("messages"),
      setSelection: store.setter("selection"),
      setSlashSelection: store.setter("slashSelection"),
      setStatus: (s) => store.set("status", s),
      setStatusDetails: store.setter("statusDetails"),
      submitOptions,
      text,
      turnRef: this.store.turnAbort,
    });
  };

  private handleEditorSubmit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.editor.addToHistory(trimmed);
    void this.submitValue(trimmed);
  }

  /* ---------- chords ---------- */

  private dispatchChord(data: string): { consume?: boolean } | undefined {
    const store = this.store;

    // Panels own the keyboard while visible.
    if (this.approvalPanel || this.selectionPanel) return undefined;

    // Autocomplete owns the keyboard while open.
    if (this.editor.isShowingAutocomplete()) return undefined;

    if (matchesKey(data, "ctrl+c")) {
      const draft = this.editor.getText();
      if (shouldClearPromptDraftOnCtrlC(draft)) {
        resetCtrlCExitGuard(this.ctrlCGuard);
        this.editor.setText("");
        store.set("draftAttachments", []);
        store.set("status", PROMPT_DRAFT_CLEARED_STATUS);
        return { consume: true };
      }
      if (resolveCtrlCExitIntent(this.ctrlCGuard, Date.now()) === "confirm_exit") {
        this.store.turnAbort.current?.abort();
        this.onExit(0);
        return { consume: true };
      }
      store.set("status", CTRL_C_EXIT_PROMPT);
      return { consume: true };
    }
    resetCtrlCExitGuard(this.ctrlCGuard);

    if (matchesKey(data, "ctrl+d")) {
      if (
        shouldExitOnCtrlD({
          draftValue: this.editor.getText(),
          hasAttachments: store.state.draftAttachments.length > 0,
        })
      ) {
        this.store.turnAbort.current?.abort();
        this.onExit(0);
        return { consume: true };
      }
      return undefined; // non-empty draft: let editor delete char forward
    }

    if (matchesKey(data, "ctrl+y")) {
      const reply = lastAgentReplyText(store.state.messages);
      if (!reply) {
        store.set("status", "No assistant reply to copy.");
        return { consume: true };
      }
      const writer = this.options.writeClipboardText;
      if (!writer) {
        store.set("status", "Could not copy last assistant reply.");
        return { consume: true };
      }
      void Promise.resolve(writer(reply)).then(
        () => store.set("status", "Copied last assistant reply."),
        () => store.set("status", "Could not copy last assistant reply."),
      );
      return { consume: true };
    }

    if (matchesKey(data, "ctrl+p")) {
      const models = store.state.modelOptions as TuiModelOption[];
      const selectable = models.filter((model) => !(model as { disabledReason?: string }).disabledReason);
      if (selectable.length === 0) {
        store.set("status", NO_SELECTABLE_MODEL_STATUS);
        return { consume: true };
      }
      if (selectable.length === 1) {
        store.set("status", ONLY_ONE_MODEL_STATUS);
        return { consume: true };
      }
      const next = nextSelectableModelOption(models, store.state.model);
      if (!next) {
        store.set("status", ONLY_ONE_MODEL_STATUS);
        return { consume: true };
      }
      const preserveDraft = modelCommandQuery(this.editor.getText()) === undefined;
      void this.submitValue(modelCommandText(next), { preserveDraft, silent: true }).then(
        (result) => {
          if (result?.response) store.set("status", result.response);
        },
      );
      return { consume: true };
    }

    if (matchesKey(data, "ctrl+l")) {
      const models = store.state.modelOptions;
      if (models.length === 0) {
        store.set("status", NO_SELECTABLE_MODEL_STATUS);
        return { consume: true };
      }
      const selection: TuiSelection = {
        emptyMessage: "No models available.",
        filterable: true,
        items: models.map((model) => ({
          command: modelCommandText(model),
          id: modelOptionValue(model),
          primary: model.label,
          secondary: modelOptionValue(model),
        })),
        prompt: "Select a model.",
        selectedIndex: modelPickerIndex(models, store.state.model),
        title: "Switch model",
      };
      store.set("selection", createSelectionState(selection));
      store.set("status", "Select a model.");
      return { consume: true };
    }

    if (matchesKey(data, "shift+tab")) {
      this.cycleMode();
      return { consume: true };
    }

    if (matchesKey(data, "escape")) {
      if (store.state.busy) {
        if (
          resolveDoublePressIntent(this.escGuard, Date.now(), ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS) ===
          "confirm"
        ) {
          this.store.turnAbort.current?.abort();
          store.set("status", "Pausing current output...");
        } else {
          store.set("status", ESCAPE_PAUSE_PROMPT);
        }
        return { consume: true };
      }
      resetDoublePressGuard(this.escGuard);
      store.set("status", NO_ACTIVE_OUTPUT_STATUS);
      return { consume: true };
    }

    return undefined;
  }

  private cycleMode(): void {
    const store = this.store;
    const setModeHandler = this.options.setMode;
    if (!setModeHandler) {
      store.set("status", "Mode switching is not available in this client.");
      return;
    }
    const previousMode = store.state.mode;
    const index = TUI_SWITCHABLE_MODES.findIndex((mode) => mode === previousMode);
    const nextMode = TUI_SWITCHABLE_MODES[(index < 0 ? 0 : index + 1) % TUI_SWITCHABLE_MODES.length];
    store.set("mode", nextMode);
    void Promise.resolve(setModeHandler(nextMode as TuiSwitchableMode)).then(
      (result) => {
        store.set("mode", result.mode);
        store.set(
          "status",
          result.response ??
            `Mode switched to ${`${result.mode}`.slice(0, 1).toUpperCase()}${`${result.mode}`.slice(1)}.`,
        );
      },
      (error: unknown) => {
        store.set("mode", previousMode);
        const message = error instanceof Error ? error.message : String(error);
        store.set("status", `Mode switch failed: ${message}`);
      },
    );
  }

  /* ---------- render pipeline ---------- */

  private onStateChanged(key: keyof AppStore["state"]): void {
    if (key === "messages") this.syncTranscript();
    if (key === "approvalQueue" || key === "selection" || key === "queuedInputs")
      this.refreshPanels();
    this.updateStatusLine();
    this.tui.requestRender();
  }

  private syncTranscript(): void {
    reconcileTranscript({
      container: this.transcript,
      markdownTheme: this.mdTheme,
      messages: this.store.state.messages,
      rows: this.rows,
      theme: this.theme,
    });
  }

  private refreshPanels(): void {
    const store = this.store;
    this.interaction.clear();
    this.approvalPanel = undefined;
    this.selectionPanel = undefined;
    this.queuedRow = undefined;

    const approval = store.state.approvalQueue[0];
    const selection = store.state.selection;
    const queued = store.state.queuedInputs;

    if (queued.length > 0) {
      this.queuedRow = new QueuedInputsRow(queued, this.theme);
      this.interaction.addChild(this.queuedRow);
    }

    if (approval) {
      this.approvalPanel = new ApprovalPanel(approval, store, this.theme);
      this.interaction.addChild(this.approvalPanel);
      this.tui.setFocus(this.approvalPanel);
    } else if (selection) {
      this.selectionPanel = new SelectionPanel(
        selection,
        store,
        this.theme,
        this.submitValue,
        () => this.store.turnAbort.current?.abort(),
      );
      this.interaction.addChild(this.selectionPanel);
      this.tui.setFocus(this.selectionPanel);
    } else {
      this.tui.setFocus(this.editor);
    }
  }

  private syncBusyIndicator(): void {
    if (this.store.state.busy && !this.loaderMounted) {
      this.composerBox.addChild(this.loader);
      this.loader.start();
      this.loaderMounted = true;
    } else if (!this.store.state.busy && this.loaderMounted) {
      this.loader.stop();
      this.composerBox.removeChild(this.loader);
      this.loaderMounted = false;
    }
  }

  private updateStatusLine(): void {
    const s = this.store.state;
    const parts: string[] = [];
    if (s.mode) parts.push(`mode:${s.mode}`);
    if (s.model) parts.push(s.model.split("/").pop() ?? s.model);
    if (s.thoughtLevel) parts.push(`thought:${s.thoughtLevel}`);
    if (s.busy) parts.push("busy");
    if (s.status) parts.push(s.status);
    const ctx = s.contextUsage.contextUsed;
    const window = s.contextUsage.contextWindow;
    if (ctx !== undefined && window) {
      parts.push(`ctx ${Math.round((ctx / window) * 100)}%`);
    }
    this.statusLine.setText(` ${this.theme.muted(parts.join("  |  "))}`);
  }

  /* ---------- lifecycle ---------- */

  async stop(): Promise<void> {
    this.removeInputListener();
    this.unsubscribeSession?.();
    for (const approval of this.store.state.approvalQueue) {
      approval.cleanup();
      approval.reject(new Error("TUI closed"));
    }
    this.tui.stop();
  }
}
