// PiTuiApp: the pi-tui frontend controller. All projection semantics are
// delegated to @zcode/tui internals; this file owns component mounting,
// focus routing, chord dispatch, and the submit/permission/selection loop.

import {
  Container,
  Loader,
  Text,
  matchesKey,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import type { CollaborationMode, SessionEvent } from "@zcode/contracts";
import { getZCodeCopy, type TuiCopy } from "@zcode/i18n";
import type {
  DraftAttachment,
  SubmitValueOptions,
  TuiOptions,
  TuiPromptInput,
  TuiStartupOptions,
  TuiSubmitPromptResult,
} from "@zcode/tui/internals";
import {
  EMPTY_TUI_WORKFLOW_MIRROR,
  ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS,
  ESCAPE_PAUSE_PROMPT,
  NO_ACTIVE_OUTPUT_STATUS,
  SIDEBAR_HIDDEN_STATUS,
  SIDEBAR_LEADER_HINT,
  SIDEBAR_SHOWN_STATUS,
  applyMainSessionEvent,
  applyWorkflowProgressToMirror,
  appendAgentResult,
  appendWorkflowInterruptedNotices,
  createDoublePressGuard,
  createSelectionState,
  createSidebarShortcutState,
  createTuiPermissionRequester,
  interruptedWorkflowNotices,
  lastAgentReplyText,
  resolveDoublePressIntent,
  resetDoublePressGuard,
  resolveSidebarShortcut,
  seedWorkflowMirror,
  shouldExitOnCtrlD,
  submitDuringActiveTurn,
  submitIdleTurn,
  validContextUsage,
  workflowRunSeedFromSummary,
  type TuiWorkflowMirror,
} from "@zcode/tui/internals";
import { Composer } from "./composer.js";
import { appendFileMentions } from "./mentions.js";
import { openModelPicker, rotateModel } from "./model-chords.js";
import { createShellEscapeRunner, type ShellEscapeRunner } from "./shell-prompt.js";
import { isShellCommand } from "./shell.js";
import { createCtrlCIntentGuard, resetCtrlCExitGuard } from "./ctrl-c-intent.js";
import { BusyQuitChoice } from "./quit-choice.js";
import { SessionInfoPanel } from "./info-panel.js";
import { PiInputHistory } from "./input-history.js";
import { keyEventFromInput } from "./keys.js";
import { ApprovalPanel, QueuedInputsRow, SelectionPanel } from "./panels.js";
import { MessageRow, piMarkdownTheme, reconcileTranscript } from "./rows.js";
import { cycleCollaborationMode } from "./mode-switch.js";
import { formatStatusLine } from "./status-line.js";
import { AppStore } from "./store.js";
import { SubagentDirectory } from "./subagents.js";
import { UsageTotalsAccumulator } from "./usage-totals.js";
import type { PiTheme } from "./theme.js";
import { WorkflowCard } from "./workflow.js";

const COPY_DEFAULT_LOCALE = "en-US" as const;

// TuiPromptInput 允许 string 与 { text } 两种形态；pi 前端统一规整为
// 对象形式，下游只需按单一路径读取 input.text（附件、modelSelection 透传）。
const promptInputObject = (input: TuiPromptInput): TuiPromptInput =>
  typeof input === "string" ? { text: input } : input;

export type PiTuiAppDeps = {
  env?: NodeJS.ProcessEnv;
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
  private copy: TuiCopy;
  private readonly requestPermission;
  private readonly ctrlCGuard = createCtrlCIntentGuard();
  private readonly escGuard = createDoublePressGuard();
  /** busy 退出三选一（detach / stop&quit / stay）+ Ctrl-C 双击语义，见 quit-choice.ts。 */
  private readonly quitChoice = new BusyQuitChoice({
    ctrlCGuard: this.ctrlCGuard,
    turnBusy: () => this.store.state.busy || Boolean(this.store.state.activeTurnId),
    abortTurn: () => this.store.turnAbort.current?.abort(),
    clearDraft: () => this.history.setDraftValue(""),
    setStatus: (status) => this.store.set("status", status),
    exit: (code) => this.onExit(code),
    requestStopActiveTurn: () => this.options.requestStopActiveTurn?.(),
  });
  private readonly removeInputListener: () => void;
  private unsubscribeSession: (() => void) | undefined;
  private unsubscribeConnectionStatus: (() => void) | undefined;
  private approvalPanel: ApprovalPanel | undefined;
  private selectionPanel: SelectionPanel | undefined;
  private queuedRow: QueuedInputsRow | undefined;
  private workflowCard: WorkflowCard;
  private infoOverlay: OverlayHandle | undefined;
  private readonly sidebarShortcut = createSidebarShortcutState();
  private loaderMounted = false;
  private startupApplied = false;
  private readonly history: PiInputHistory;
  /** 子代理目录唯一 owner；组件只读 store。 */
  private readonly subagents: SubagentDirectory;
  /** 状态行 ↑↓R 的 session 累计用量 owner（turn 内 state.usage 是单请求口径）。 */
  private readonly usageTotals: UsageTotalsAccumulator;
  /** `!cmd` 执行器：本地跑命令、打印结果、把输出缓到下一条 prompt。 */
  private readonly shellEscape: ShellEscapeRunner;
  private attachmentSequence = 0;
  private submitPipelineCache: TuiOptions | undefined;
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
    this.shellEscape = createShellEscapeRunner({
      appendMessage: (message) =>
        this.store.setter("messages")((current) => [...current, message]),
      clearDraft: () => this.history.setDraftValue(""),
      cwd: () => this.options.workspaceDirectory ?? process.cwd(), env: deps.env,
      setStatus: (status) => this.store.set("status", status),
    });

    const store = this.store;
    store.set("mode", this.fallback.mode as string);
    store.set("model", this.fallback.model);
    store.set("thoughtLevel", this.options.initialThoughtLevel ?? "");
    store.set("loginRequired", this.fallback.loginRequired);
    store.set("modelOptions", [...(this.options.modelOptions ?? [])]);
    store.set("effortOptions", [...(this.options.effortOptions ?? [])]);

    this.statusLine = new Text("", 1, 0);
    this.loader = new Loader(this.tui, this.theme.accent, this.theme.muted, "");
    // pi-tui 的 Loader 在构造时经 setIndicator→start() 就启动常驻 setInterval，
    // 不挂载也会一直 tick 并阻止进程退出——先停掉，busy 挂载时由
    // syncBusyIndicator 调 start() 重新启动。
    this.loader.stop();

    this.editor = new Composer(this.tui, this.theme, {
      options: this.options,
      models: () => this.store.state.modelOptions,
      efforts: () => this.store.state.effortOptions,
    });
    this.editor.onSubmit = (text) => this.handleEditorSubmit(text);
    this.history = new PiInputHistory({
      copy: () => this.copy,
      draftAttachments: () => this.store.state.draftAttachments,
      editor: this.editor,
      recallPreviousInput: () => this.options.recallPreviousInput,
      setDraftAttachments: (attachments) => this.store.set("draftAttachments", attachments),
      setStatus: (status) => this.store.set("status", status),
      setStatusDetails: (details) => this.store.set("statusDetails", details),
    });
    // Editor.setText 与逐字输入都触发 onChange；历史恢复经 suppressReset
    // 压掉自身重置（见 input-history.ts）。
    this.editor.onChange = () => this.history.onEditorChange();

    this.composerBox.addChild(this.editor);
    this.statusBox.addChild(this.statusLine);

    this.tui.addChild(this.transcript);
    this.workflowCard = new WorkflowCard(this.workflowMirror, this.theme);
    this.tui.addChild(this.workflowCard);
    this.tui.addChild(this.interaction);
    this.tui.addChild(this.composerBox);
    this.tui.addChild(this.statusBox);

    this.requestPermission = createTuiPermissionRequester({
      setApprovalQueue: this.store.setter("approvalQueue"),
      setStatus: (status) => this.store.set("status", status),
    });

    // 事件消费者先于订阅构造：同步回放型端口注册即推事件时 handleEvent 不能空转。
    this.subagents = new SubagentDirectory(this.store, this.options);
    this.usageTotals = new UsageTotalsAccumulator(this.store, this.options);
    this.unsubscribeSession = this.options.subscribeSessionEvents?.((event) =>
      this.applyEvent(event),
    );
    // tui-attach : état de connexion au shared core affiché dans la ligne de status.
    this.unsubscribeConnectionStatus = this.options.subscribeConnectionStatus?.(
      (status) => {
        this.store.set("status", status);
        this.tui.requestRender();
      },
    );

    this.removeInputListener = this.tui.addInputListener((data) =>
      this.dispatchChord(data),
    );

    this.store.onChange((key) => this.onStateChanged(key));
    this.tui.setFocus(this.editor);
    this.subagents.refresh();
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
      this.copy = getZCodeCopy(startup.locale).tui;
    }
    if (startup.modelOptions) store.set("modelOptions", [...startup.modelOptions]);
    if (startup.effortOptions) store.set("effortOptions", [...startup.effortOptions]);
    if (startup.slashCommands) {
      this.options.slashCommands = startup.slashCommands;
      this.editor.refreshAutocomplete();
    }
    this.updateStatusLine();
    void this.seedWorkflowRuns();
  }

  /**
   * Cold workflow state: replay journal envelopes into the shared reducer first
   * (real node/actor state), then seed display labels and interrupted-run
   * notices from the summary list. Both queries failing must not block startup.
   */
  private async seedWorkflowRuns(): Promise<void> {
    const { listWorkflowRuns, replayWorkflowRuns } = this.options;
    if (replayWorkflowRuns) {
      try {
        const envelopes = await replayWorkflowRuns({
          excludeRunIds: new Set(this.workflowMirror.state.runs.map((run) => run.runId)),
        });
        for (const envelope of envelopes) {
          this.workflowMirror = applyWorkflowProgressToMirror(this.workflowMirror, envelope);
        }
        this.workflowCard.setMirror(this.workflowMirror);
      } catch {
        // 回放失败不该让 TUI 起不来。
      }
    }
    if (!listWorkflowRuns) return;
    let summaries: Awaited<ReturnType<NonNullable<typeof listWorkflowRuns>>>;
    try {
      summaries = await listWorkflowRuns();
    } catch {
      return;
    }
    if (summaries.length === 0) return;
    this.workflowMirror = seedWorkflowMirror(
      this.workflowMirror,
      summaries.map(workflowRunSeedFromSummary),
    );
    this.workflowCard.setMirror(this.workflowMirror);
    const resumable = interruptedWorkflowNotices(summaries);
    if (resumable.length > 0) {
      this.store.setter("messages")((current) =>
        appendWorkflowInterruptedNotices(current, resumable, this.copy),
      );
    }
    this.tui.requestRender();
  }

  /* ---------- event pipeline ---------- */

  applyEvent = (event: SessionEvent): void => {
    this.store.observeSessionEvent?.(event);
    const applied = applyMainSessionEvent(event, this.store.appliedEventIds, {
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
    // 用量只在 applyMainSessionEvent 采纳（主会话且未去重命中）后折叠：
    // 同一事件经 session sink 与 per-turn onEvent 双投递，applied 即恰好一次。
    // 目录则必须看全部事件（子会话 turn_complete 是子代理结束的信号之一），
    // 且 refresh 幂等，故不走 applied 门。
    if (applied) this.usageTotals.handleEvent(event);
    this.subagents.handleEvent(event);
  };

  private workflowMirrorSetter = (
    value: TuiWorkflowMirror | ((previous: TuiWorkflowMirror) => TuiWorkflowMirror),
  ): void => {
    this.workflowMirror =
      typeof value === "function" ? value(this.workflowMirror) : value;
    this.workflowCard.setMirror(this.workflowMirror);
    this.tui.requestRender();
  };
  private workflowMirror: TuiWorkflowMirror = EMPTY_TUI_WORKFLOW_MIRROR;

  /* ---------- result application (port of useTuiApplyResult) ---------- */

  applyResult = (result: TuiSubmitPromptResult, preserveTurnState = false): void => {
    const store = this.store;
    const resultCopy = getZCodeCopy(result.locale ?? this.fallback.locale).tui;
    if (result.mode) store.set("mode", result.mode);
    else store.set("mode", this.fallback.mode);
    store.set("model", result.model ?? this.fallback.model);
    if (result.locale) {
      this.fallback.locale = result.locale;
      this.copy = resultCopy;
    }
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
    // settle 回合不得回写 activeTurnId：socket 事件先清零，无条件回写会把已完成回合复活成 busy。
    if (result.turnId && store.state.activeTurnId === result.turnId) store.set("activeTurnId", undefined);
    // result.usage 是回合口径（同 turn_complete），不进 session 累计器。
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
      this.subagents.reset();
      this.usageTotals.reset();
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

  private submitPipeline(): TuiOptions {
    if (!this.submitPipelineCache) {
      const { sendInput, submitPrompt } = this.options;
      this.submitPipelineCache = {
        ...this.options,
        sendInput: sendInput
          ? (input, sendOptions) => sendInput(promptInputObject(input), sendOptions)
          : undefined,
        submitPrompt: (input, promptOptions) =>
          submitPrompt(promptInputObject(input), promptOptions),
      };
    }
    return this.submitPipelineCache;
  }

  submitValue = async (
    value: string,
    submitOptions?: SubmitValueOptions,
  ): Promise<TuiSubmitPromptResult | undefined> => {
    const store = this.store;
    const text = value.trim();
    if (!text) return undefined;
    // `@path` → 协议 file attachment（core 自己读文件）；`!cmd` 的输出随下一条 prompt 进上下文。
    const draftAttachments = this.draftAttachmentsFor(text);
    const promptText = this.shellEscape.consume(text);

    if (store.state.busy || store.state.activeTurnId) {
      return submitDuringActiveTurn({
        activeTurnId: store.state.activeTurnId,
        applyResult: this.applyResult,
        applySessionEvent: this.applyEvent,
        draftAttachments,
        messageInsertIndex: store.state.messages.length,
        options: this.submitPipeline(),
        requestPermission: this.requestPermission,
        setDraftValue: (v) => this.history.setDraftValue(v),
        setLastError: (m) => store.set("lastError", m),
        setMessages: store.setter("messages"),
        setQueuedInputs: store.setter("queuedInputs"),
        setStatus: (s) => store.set("status", s),
        submitOptions,
        text: promptText,
      });
    }

    return submitIdleTurn({
      applyResult: this.applyResult,
      applySessionEvent: this.applyEvent,
      draftAttachments,
      options: this.submitPipeline(),
      requestPermission: this.requestPermission,
      setBusy: (v) => {
        store.set("busy", v);
        this.syncBusyIndicator();
      },
      setDraftAttachments: store.setter("draftAttachments"),
      setDraftValue: (v) => this.history.setDraftValue(v),
      setLastError: (m) => store.set("lastError", m),
      setLiveModelText: (v) => store.set("liveModelText", v),
      setMessages: store.setter("messages"),
      setSelection: store.setter("selection"),
      setSlashSelection: store.setter("slashSelection"),
      setStatus: (s) => store.set("status", s),
      setStatusDetails: store.setter("statusDetails"),
      submitOptions,
      text: promptText,
      turnRef: this.store.turnAbort,
    });
  };

  /** `@path` tokens in the draft become file attachments the core reads. */
  private draftAttachmentsFor(text: string): DraftAttachment[] {
    // Slash commands are control messages; only real prompts carry attachments.
    if (text.startsWith("/")) return this.store.state.draftAttachments;
    return appendFileMentions({
      allocateId: () => (this.attachmentSequence += 1),
      existing: this.store.state.draftAttachments,
      text,
      workspaceDirectory: this.options.workspaceDirectory ?? process.cwd(),
    });
  }

  private handleEditorSubmit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.editor.addToHistory(trimmed);
    // `!cmd` 在客户端工作区执行，输出进 transcript 并缓冲到下一条 prompt；
    // 它不是一次模型回合（core 没有“追加本地消息”的协议面）。
    if (isShellCommand(trimmed)) {
      void this.shellEscape.run(trimmed);
      return;
    }
    void this.submitValue(trimmed);
  }

  /* ---------- chords ---------- */

  /**
   * Ctrl-C 意图：字节路径（raw 模式下的 0x03）与信号路径（SIGINT）共用同一条
   * guard 与同一份状态（见 ctrl-c-intent.ts）。busy 三选一/armed/双击语义全部
   * 收敛在 BusyQuitChoice（quit-choice.ts）。
   */
  handleCtrlCIntent(): void {
    this.quitChoice.onCtrlC(this.editor.getText());
  }

  private dispatchChord(data: string): { consume?: boolean } | undefined {
    const store = this.store;

    // 退出键先行：busy 三选一不能被面板/补全的键盘所有权挡住（SIGINT 一致性见 quit-choice.ts）。
    if (this.quitChoice.handleEarlyQuitKey(data, this.editor.getText())) return { consume: true };

    // Panels own the keyboard while visible.
    if (this.approvalPanel || this.selectionPanel) return undefined;

    // Autocomplete owns the keyboard while open.
    if (this.editor.isShowingAutocomplete()) return undefined;

    // Ctrl+X leader for the session-info overlay (same chord as the React
    // frontend's sidebar): Ctrl+X arms, B toggles.
    const shortcutKey = keyEventFromInput(data);
    if (shortcutKey) {
      const intent = resolveSidebarShortcut(this.sidebarShortcut, shortcutKey, Date.now());
      if (intent === "arm") {
        store.set("status", SIDEBAR_LEADER_HINT);
        return { consume: true };
      }
      if (intent === "toggle") {
        this.toggleInfoPanel();
        return { consume: true };
      }
    }

    if (matchesKey(data, "ctrl+c")) {
      this.handleCtrlCIntent();
      return { consume: true };
    }
    resetCtrlCExitGuard(this.ctrlCGuard);

    // Empty-draft Up/Down walks cross-session history via the CLI port
    // (Editor's own history handles non-empty drafts itself).
    if (matchesKey(data, "up") && this.history.navigable()) {
      void this.history.recallPrevious();
      return { consume: true };
    }
    if (matchesKey(data, "down") && this.history.navigable()) {
      void this.history.recallNext();
      return { consume: true };
    }

    if (matchesKey(data, "ctrl+d")) {
      if (
        shouldExitOnCtrlD({
          draftValue: this.editor.getText(),
          hasAttachments: store.state.draftAttachments.length > 0,
        })
      ) {
        // busy 中 Ctrl-D 不直接退出：先 arm 三选一，armed 内 Ctrl-D 才 detach。
        if (this.quitChoice.onCtrlD()) return { consume: true };
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
      rotateModel({
        currentModel: store.state.model,
        draft: this.editor.getText(),
        models: store.state.modelOptions,
        setStatus: (status) => store.set("status", status),
        submitValue: this.submitValue,
      });
      return { consume: true };
    }

    if (matchesKey(data, "ctrl+l")) {
      openModelPicker({
        currentModel: store.state.model,
        models: store.state.modelOptions,
        setSelection: (selection) => store.set("selection", selection),
        setStatus: (status) => store.set("status", status),
      });
      return { consume: true };
    }

    if (matchesKey(data, "shift+tab")) {
      this.cycleMode();
      return { consume: true };
    }

    if (matchesKey(data, "escape")) {
      if (this.infoOverlay) {
        this.closeInfoPanel();
        return { consume: true };
      }
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

    // Empty-draft "+"/"-" toggles workflow card expansion (spec parity).
    if (
      (data === "+" || data === "-") &&
      this.editor.getText() === "" &&
      this.workflowCard.runCount > 0
    ) {
      const expanded = this.workflowCard.toggleExpanded();
      store.set("status", expanded ? "Workflow cards expanded." : "Workflow cards collapsed.");
      this.tui.requestRender();
      return { consume: true };
    }

    return undefined;
  }

  private toggleInfoPanel(): void {
    if (this.infoOverlay) {
      this.closeInfoPanel();
      return;
    }
    const panel = new SessionInfoPanel(
      this.tui,
      this.store,
      this.theme,
      this.options,
      () => this.closeInfoPanel(),
      () => this.subagents.refresh(),
    );
    // nonCapturing：React sidebar 不抢 composer 焦点，开着信息面板时输入仍进
    // 编辑器；Esc 由 dispatchChord 的全局 chord 关闭。
    this.infoOverlay = this.tui.showOverlay(panel, {
      anchor: "right-center",
      maxHeight: "80%",
      nonCapturing: true,
      width: "45%",
    });
    this.store.set("status", SIDEBAR_SHOWN_STATUS);
  }

  private closeInfoPanel(): void {
    this.infoOverlay?.hide();
    this.infoOverlay = undefined;
    this.tui.setFocus(this.editor);
    this.store.set("status", SIDEBAR_HIDDEN_STATUS);
    this.tui.requestRender();
  }

  private cycleMode(): void {
    cycleCollaborationMode(this.store, this.options);
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
    this.statusLine.setText(` ${this.theme.muted(formatStatusLine(this.store.state))}`);
  }

  /* ---------- lifecycle ---------- */

  async stop(): Promise<void> {
    this.removeInputListener();
    this.unsubscribeSession?.();
    this.subagents.dispose();
    this.unsubscribeConnectionStatus?.();
    this.loader.stop();
    for (const approval of this.store.state.approvalQueue) {
      approval.cleanup();
      approval.reject(new Error("TUI closed"));
    }
    this.tui.stop();
  }
}
