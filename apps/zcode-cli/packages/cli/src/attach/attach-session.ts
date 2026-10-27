// attach 模式下的协议态会话句柄：实现 CommandCenterApp 的可选面，
// 业务状态全部留在共享 core；本文件只做 topic 映射与快照缓存。
// raw SessionEvent 的 timestamp 在线上为 ISO 串，由 runtime  revive 成 Date。
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeSessionSubscribeResultSchema,
  zcodeSessionEventsResultSchema,
  zcodeSessionMessagesResultSchema,
  zcodeSessionRecallPreviousInputResultSchema,
  zcodeUsageQuotaSnapshotSchema,
  type ZCodeSessionRawEvent,
  type ZCodeSessionStateSnapshot,
  type ZCodeSessionSubagentsResult,
  type ModelSelection,
} from "@zcode/shared";
import type {
  TuiPromptInput,
  TuiRestoredTranscriptPart,
  TuiSendInputResult,
  TuiSubmitPromptResult,
  TuiSubagentTranscriptSnapshot,
} from "@zcode/tui";
import type { CollaborationMode, TurnId } from "@zcode/contracts";
import type { AttachClient } from "./attach-client.js";
import {
  discardPendingInputs as discardPendingInputsLane,
  localFollowUpDrainedPayload,
  queueFollowUpInput,
  steerActiveTurn,
  type QueuedLocalInput,
  type SendInputOptions,
  type SteerQueueContext,
} from "./attach-steer.js";
import { toProtocolAttachments } from "./attach-attachments.js";
import { PendingInteractions } from "./attach-interactions.js";
import { requestSessionStopBestEffort } from "./attach-session-stop.js";
import { mergeCatalog, modelOptionKey, thoughtLevelKey } from "./attach-catalog.js";
import type { CommandCenterApp } from "../command-center.js";
import { resolveTuiModelSelection } from "../command-center/handlers/model.js";

const TURN_STARTED = "turn_started";
const TURN_END_TYPES = new Set(["turn_complete", "turn_error"]);

const PROMPT_INPUT_ID_PREFIX = "attach-input";

/** 与本地 formatLegacyRuntimeModelValue 同形：providerId/modelId。
 * 状态行按 "/" 取尾段显示；Ctrl+P 轮换、/model 参数匹配都依赖完整 ref。 */
function formatModelRef(
  current: { providerId?: string; modelId?: string } | undefined,
): string | undefined {
  if (!current?.providerId || !current.modelId) return current?.modelId;
  return `${current.providerId}/${current.modelId}`;
}

/** wire part（zcodeMessagePartSchema）→ TuiRestoredTranscriptPart。
 * 与 bootstrap projectSessionTranscript 同语义；瘦客户端不引 bootstrap barrel。 */
function projectWirePart(part: unknown): TuiRestoredTranscriptPart | undefined {
  const record = part as Record<string, unknown> | undefined;
  if (record?.type === "text" && typeof record.text === "string") {
    return record.ignored === true ? undefined : { text: record.text, type: "text" };
  }
  if (record?.type === "reasoning" && typeof record.text === "string") {
    return { text: record.text, type: "thought" };
  }
  if (record?.type === "tool" && typeof record.tool === "string") {
    const state = (record.state ?? {}) as Record<string, unknown>;
    const base = {
      input: (state.input ?? {}) as Record<string, unknown>,
      ...(typeof state.title === "string" ? { title: state.title } : {}),
      toolCallId:
        (typeof record.callId === "string" && record.callId) ||
        (typeof record.callID === "string" ? record.callID : ""),
      toolName: record.tool,
      type: "tool" as const,
    };
    if (state.status === "completed") {
      return {
        ...base,
        ...(typeof state.output === "string" ? { output: state.output } : {}),
        status: "completed",
      };
    }
    if (state.status === "error") {
      return {
        ...base,
        ...(typeof state.error === "string" ? { error: state.error } : {}),
        status: "failed",
      };
    }
    return { ...base, status: "running" };
  }
  return undefined;
}

/** 快照/存储里的 wire messages → TuiSubmitPromptResult.restoredMessages。 */
export function projectAttachTranscriptMessages(
  messages: ReadonlyArray<{
    info?: { messageId?: string; role?: string };
    parts?: unknown[];
  }>,
): NonNullable<TuiSubmitPromptResult["restoredMessages"]> {
  return messages.map((message) => {
    const parts = (message.parts ?? [])
      .map(projectWirePart)
      .filter((part): part is TuiRestoredTranscriptPart => part !== undefined);
    return {
      content: "",
      ...(message.info?.messageId ? { id: message.info.messageId } : {}),
      ...(parts.length > 0 ? { parts } : {}),
      role: (message.info?.role === "user" ? "user" : "agent") as
        | "user"
        | "agent",
    };
  });
}

export type AttachSessionEvent = SessionEvent;

type PendingTurn = {
  inputId: string;
  resolve: (result: TuiSubmitPromptResult) => void;
  reject: (error: Error) => void;
  turnId?: string;
};

/**
 * 会话级 raw 事件分发点：AttachRuntime 每条连接一份，按 sessionId 注册。
 * 事件先 feed 常驻 sinks（TUI 投影），再喂 pending turn 等待器。
 */
export class AttachSessionHandle {
  readonly sessionId: string;
  readonly traceId: string;
  /** 最新权威快照：set-mode/model 与 goal/send 的 afterStateMutation 回包持续刷新。 */
  snapshot: ZCodeSessionStateSnapshot;

  /** 断线重连会换 client：句柄不能绑死连接，统一经 resolver 拿当前连接。 */
  private readonly clientOf: () => AttachClient;
  private readonly sinks = new Set<(event: SessionEvent) => void>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly pendingByTurnId = new Map<string, PendingTurn>();
  private lastSeq = 0;
  private inputCounter = 0;
  private locale: TuiSubmitPromptResult["locale"];
  /** core 的 session/send 忙时直接拒绝；busy 输入停本地队列，settle 后自动 flush。 */
  private readonly queuedInputs: QueuedLocalInput[] = [];
  private queueCounter = 0;
  private localEventCounter = 0;
  private lastActiveTurnId: string | undefined;
  private flushingQueue = false;
  /** 当前等待中的 permission 回调；同一连接一次交互只挂一个。 */
  activeRequestPermission:
    | ((request: unknown, options?: unknown) => Promise<unknown>)
    | undefined;
  /** 当前回合的 abortSignal：Ctrl-C/本地 abort 要同步撤下等待中的审批面板。 */
  private activeTurnAbortSignal: AbortSignal | undefined;
  /** 按业务 requestId 去重的在途交互（permission/userInput 反向请求）。 */
  private readonly interactions = new PendingInteractions();

  constructor(input: {
    client: AttachClient | (() => AttachClient);
    sessionId: string;
    snapshot: ZCodeSessionStateSnapshot;
    locale?: TuiSubmitPromptResult["locale"];
  }) {
    this.clientOf =
      typeof input.client === "function" ? input.client : () => input.client as AttachClient;
    this.sessionId = input.sessionId;
    this.snapshot = input.snapshot;
    this.traceId = input.snapshot.session.traceId ?? input.sessionId;
    this.locale = input.locale;
  }

  get eventSeq(): number {
    return this.lastSeq;
  }

  /** 常驻订阅（TuiSubscribeSessionEvents）。返回 unsubscribe。 */
  addSink(sink: (event: SessionEvent) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /** raw wire event → revive timestamp → 分发。 */
  ingestRawEvent(raw: ZCodeSessionRawEvent): void {
    const event = {
      ...raw,
      timestamp: new Date(raw.timestamp),
    } as unknown as SessionEvent;
    if (typeof raw.sequenceNumber === "number" && raw.sequenceNumber > this.lastSeq) {
      this.lastSeq = raw.sequenceNumber;
    }
    for (const sink of this.sinks) sink(event);
    this.routeTurnEvent(event);
  }

  /** subscribe/续订：raw 格式 afterSeq 用 SessionEvent.sequenceNumber。 */
  async subscribe(afterSeq?: number, includeSnapshot = false): Promise<void> {
    const result = zcodeSessionSubscribeResultSchema.parse(
      await this.clientOf().request(zcodeProtocolMethods.sessionSubscribe, {
        afterSeq,
        deliveryKind: "desktop-continuous",
        eventFormat: "raw",
        includeSnapshot,
        sessionId: this.sessionId,
      }),
    );
    if (result.snapshot) this.snapshot = this.adoptSnapshot(result.snapshot);
    if (result.eventSeq > this.lastSeq) this.lastSeq = result.eventSeq;
    for (const raw of result.rawEvents ?? []) this.ingestRawEvent(raw);
  }

  private routeTurnEvent(event: SessionEvent): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    // 服务端先 settle（自动应答、v4 竞速、turn abort）时 emitPermissionResolved
    // 仍带原 requestId——据此撤下本端还在等待的面板，避免残留僵尸审批。
    if (event.type === SessionEventType.PermissionResolved) {
      const requestId =
        typeof payload.requestId === "string" ? payload.requestId : undefined;
      if (requestId) this.interactions.drop(requestId);
    }
    if (event.type === TURN_STARTED) {
      this.lastActiveTurnId = String(event.turnId);
      const inputId = typeof payload.inputId === "string" ? payload.inputId : undefined;
      const pending = inputId ? this.pendingTurns.get(inputId) : undefined;
      if (pending) {
        pending.turnId = event.turnId;
        this.pendingByTurnId.set(String(event.turnId), pending);
      }
      return;
    }
    if (!TURN_END_TYPES.has(event.type)) return;
    // 回合结束时 broker 请求必然已 settle/cancel；仍挂着的交互都是孤儿。
    this.interactions.drop();
    const pending =
      (event.turnId ? this.pendingByTurnId.get(String(event.turnId)) : undefined) ??
      this.findPendingByInputId(payload.inputId) ??
      this.firstPending();
    if (!pending) return;
    this.pendingTurns.delete(pending.inputId);
    if (pending.turnId) this.pendingByTurnId.delete(pending.turnId);
    if (event.type === "turn_error") {
      const errorPayload = payload.error as { message?: string } | undefined;
      pending.reject(
        new Error(errorPayload?.message ?? "Turn failed on the shared core"),
      );
      this.scheduleQueuedFlush();
      return;
    }
    pending.resolve(this.buildTurnResult(event, pending));
    this.scheduleQueuedFlush();
  }

  /**
   * interaction/* 反向请求的执行口：去重/abort/grace 语义集中在
   * PendingInteractions（attach-interactions.ts）；这里只把当前回合的
   * abortSignal 传下去，使本地 Ctrl-C 一并撤下面板。
   */
  serveInteraction(
    requestId: string,
    invoke: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> {
    return this.interactions.serve(requestId, invoke, this.activeTurnAbortSignal);
  }

  /** 本地合成的投影事件（queued/drained/notice）：只走 sinks，不进 routeTurnEvent。 */
  private emitSinkEvent(type: string, payload: Record<string, unknown>): void {
    const event = {
      id: `attach-local-${++this.localEventCounter}`,
      payload,
      sequenceNumber: 0,
      sessionId: this.sessionId,
      timestamp: new Date(),
      traceId: this.traceId,
      type,
    } as unknown as SessionEvent;
    for (const sink of this.sinks) sink(event);
  }

  private findPendingByInputId(inputId: unknown): PendingTurn | undefined {
    return typeof inputId === "string" ? this.pendingTurns.get(inputId) : undefined;
  }

  private firstPending(): PendingTurn | undefined {
    return this.pendingTurns.values().next().value as PendingTurn | undefined;
  }

  private buildTurnResult(event: SessionEvent, pending: PendingTurn): TuiSubmitPromptResult {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const settings = this.snapshot.settings;
    return {
      locale: this.locale,
      mode: settings.mode.current as TuiSubmitPromptResult["mode"],
      model: formatModelRef(settings.model.current),
      response: typeof payload.response === "string" ? payload.response : "",
      sessionId: this.sessionId,
      thoughtLevel: settings.thoughtLevel.current,
      traceId: this.traceId,
      turnId: pending.turnId ?? event.turnId,
      usage: payload.usage as TuiSubmitPromptResult["usage"],
    };
  }

  private nextInputId(): string {
    return `${PROMPT_INPUT_ID_PREFIX}-${++this.inputCounter}`;
  }

  /** CommandCenterApp.submitPrompt：普通 prompt（slash 已由 commandCenter 路由走）。 */
  async submitPrompt(
    prompt: TuiPromptInput,
    options?: {
      abortSignal?: AbortSignal;
      onEvent?: (event: SessionEvent) => void | Promise<void>;
      requestPermission?: (
        request: unknown,
        requestOptions?: unknown,
      ) => Promise<unknown>;
    },
  ): Promise<TuiSubmitPromptResult> {
    const inputId = this.nextInputId();
    const text = typeof prompt === "string" ? prompt : prompt.text;
    const modelSelection =
      typeof prompt === "string" ? undefined : prompt.modelSelection;
    // per-turn onEvent 挂上就要摘：回合 settle / 发送失败时摘除（与 monolith
    // prompt-command 的 finally 语义对齐）。曾只挂不摘——TUI 每次提交都带
    // onEvent，sinks 每回合净增一个闭包，后续每条事件扇出到全部陈旧回调。
    const unsubscribeOnEvent = options?.onEvent
      ? this.addSink((event) => void options.onEvent?.(event))
      : undefined;
    if (options?.requestPermission) {
      this.activeRequestPermission = options.requestPermission as (
        request: unknown,
        requestOptions?: unknown,
      ) => Promise<unknown>;
    }
    this.activeTurnAbortSignal = options?.abortSignal;
    const turnPromise = new Promise<TuiSubmitPromptResult>((resolve, reject) => {
      this.pendingTurns.set(inputId, { inputId, resolve, reject });
      options?.abortSignal?.addEventListener(
        "abort",
        () => {
          void this.clientOf()
            .request(zcodeProtocolMethods.sessionStop, { sessionId: this.sessionId })
            .catch(() => undefined);
          this.pendingTurns.delete(inputId);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
    try {
      await this.clientOf().request(zcodeProtocolMethods.sessionSend, {
        attachments: typeof prompt === "string" ? undefined : toProtocolAttachments(prompt.attachments),
        content: text,
        inputId,
        modelSelection,
        sessionId: this.sessionId,
      });
    } catch (error) {
      this.pendingTurns.delete(inputId);
      unsubscribeOnEvent?.();
      this.activeRequestPermission = undefined;
      this.activeTurnAbortSignal = undefined;
      throw error;
    }
    try {
      return await turnPromise;
    } finally {
      unsubscribeOnEvent?.();
      this.activeRequestPermission = undefined;
      this.activeTurnAbortSignal = undefined;
    }
  }

  /**
   * CommandCenterApp.sendInput：busy 时按 delivery 分 lane（pi-mono 对齐）：
   * - `delivery:"steer"`（Enter）：经 `session/send delivery:"steer"` 直驱 core
   *   steerTurn 注入 active turn pendingInputs；真实 turn_steer_queued 事件驱动
   *   UI。拒绝（settle 竞态 / turn 不可 steer / 附件）回退本地 follow-up 队列。
   * - 缺省与 `delivery:"queue"`（Ctrl+Q）：本地排队，settle 后
   *   flushQueuedInputs 逐条重放为新回合（core 的 session/send 只收一个并发
   *   prompt，排队语义在客户端）。
   */
  async sendInput(
    input: TuiPromptInput,
    options?: SendInputOptions,
  ): Promise<TuiSendInputResult> {
    if (this.pendingTurns.size > 0) {
      const activeTurnId =
        this.lastActiveTurnId ??
        (options?.expectedTurnId ? String(options.expectedTurnId) : undefined);
      const expected = options?.expectedTurnId
        ? String(options.expectedTurnId)
        : undefined;
      if (expected && activeTurnId && expected !== activeTurnId) {
        return {
          activeTurnId: activeTurnId as TurnId,
          kind: "rejected",
          reason: "expected_turn_mismatch",
        };
      }
      const text = typeof input === "string" ? input : input.text;
      const hasAttachments =
        typeof input !== "string" && (input.attachments?.length ?? 0) > 0;
      const ctx = this.steerQueueContext();
      if (options?.delivery === "steer" && !hasAttachments) {
        return steerActiveTurn(ctx, text, options, activeTurnId);
      }
      return queueFollowUpInput(ctx, input, options, text, activeTurnId);
    }
    const result = await this.submitPrompt(input, options);
    return { kind: "started_turn", result };
  }

  /** steer/queue lane 的上下文：lane 实现在 attach-steer.ts（800 行门）。 */
  private steerQueueContext(): SteerQueueContext {
    return {
      clientOf: () => this.clientOf(),
      emitSinkEvent: (type, payload) => this.emitSinkEvent(type, payload),
      nextInputId: () => this.nextInputId(),
      nextQueueCounter: () => ++this.queueCounter,
      queuedInputs: this.queuedInputs,
      sessionId: this.sessionId,
    };
  }

  /** Alt+Up 撤回（TuiRemoveQueuedInputs 端口）；实现见 attach-steer.ts。 */
  async discardPendingInputs(pendingInputIds: readonly string[]): Promise<string[]> {
    return discardPendingInputsLane(this.steerQueueContext(), pendingInputIds);
  }

  private scheduleQueuedFlush(): void {
    if (this.flushingQueue || this.queuedInputs.length === 0) return;
    queueMicrotask(() => {
      void this.flushQueuedInputs();
    });
  }

  /** 每次只放一条：submitPrompt 会让 pendingTurns 重新非空，余下条目等下一轮 settle。 */
  private async flushQueuedInputs(): Promise<void> {
    if (this.flushingQueue || this.pendingTurns.size > 0) return;
    const item = this.queuedInputs.shift();
    if (!item) return;
    this.flushingQueue = true;
    try {
      // drained 事件把该条从 UI 队列区摘除，并按 drainedInputs 给 transcript
      // 补 user 行（重放的新回合没有本地乐观 user row）。
      this.emitSinkEvent("turn_steer_drained", localFollowUpDrainedPayload(item));
      await this.submitPrompt(item.input, item.options);
      // 该条结束后 routeTurnEvent 会再次 scheduleQueuedFlush 接力下一条。
    } catch (error) {
      this.emitSinkEvent("session_notice", {
        message: `Queued input failed: ${error instanceof Error ? error.message : String(error)}`,
        role: "system",
      });
      this.scheduleQueuedFlush();
    } finally {
      this.flushingQueue = false;
    }
  }

  async resume(): Promise<{
    appliedMessageCount: number;
    directory: string;
    interruptedToolCount: number;
    messageCount: number;
    partCount: number;
    traceId?: string;
  }> {
    // resume 语义 = 从 store 重建 runtime。attach 下等价于重新订阅拿全量快照。
    await this.subscribe(undefined, true);
    const messages = this.snapshot.messages;
    return {
      appliedMessageCount: messages.length,
      directory: this.snapshot.session.workspace.workspacePath ?? "",
      interruptedToolCount: 0,
      messageCount: messages.length,
      partCount: messages.reduce(
        (count, message) => count + (message.parts?.length ?? 0),
        0,
      ),
      traceId: this.traceId,
    };
  }

  getMode(): CollaborationMode | undefined {
    return this.snapshot.settings.mode.current;
  }

  getModel(): string | undefined {
    return formatModelRef(this.snapshot.settings.model.current);
  }

  getThoughtLevel(): string | undefined {
    return this.snapshot.settings.thoughtLevel.current;
  }

  getLocale(): TuiSubmitPromptResult["locale"] {
    return this.locale;
  }

  setLocale(locale: TuiSubmitPromptResult["locale"]): { locale: TuiSubmitPromptResult["locale"] } {
    // UI 偏好属客户端本地状态；core 只承载会话事实，locale 不下发。
    this.locale = locale;
    return { locale };
  }

  private applyMutationSnapshot(result: unknown): void {
    // session/setModel 等 mutation 直接返回快照本体（afterStateMutation 返回 stateSnapshot），
    // 只认 {snapshot} 包装会漏掉全部更新——getModel() 永远返回旧模型，Ctrl+P 轮换原地打转。
    const snapshot =
      (result as { snapshot?: ZCodeSessionStateSnapshot }).snapshot ??
      ((result as ZCodeSessionStateSnapshot).settings
        ? (result as ZCodeSessionStateSnapshot)
        : undefined);
    if (!snapshot?.settings) return;
    this.mergeSettings(snapshot.settings);
  }

  /** state/updated settings patch 合并：legacy setModel 链路只发通知、不发 raw 事件，
   *  不合并会让已挂 TUI（含其他 pane）的模型状态行停在旧模型。 */
  applyStatePatch(patch: unknown): void {
    const settings = patch as ZCodeSessionStateSnapshot["settings"] | undefined;
    if (!settings || typeof settings !== "object") return;
    this.mergeSettings(settings);
  }

  /** subscribe 的整包快照只在设置层面替换，模型/思考档目录走只增不减的合并。 */
  private adoptSnapshot(
    snapshot: ZCodeSessionStateSnapshot,
  ): ZCodeSessionStateSnapshot {
    const previous = this.snapshot.settings;
    return {
      ...snapshot,
      settings: {
        ...snapshot.settings,
        model: {
          ...snapshot.settings.model,
          available: mergeCatalog(
            previous.model.available,
            snapshot.settings.model.available,
            modelOptionKey,
          ),
        },
        thoughtLevel: {
          ...snapshot.settings.thoughtLevel,
          available: mergeCatalog(
            previous.thoughtLevel?.available,
            snapshot.settings.thoughtLevel.available,
            thoughtLevelKey,
          ),
        },
      },
    };
  }

  /** mutation 回包（setModel 等）与 state/updated patch 同属“当前模型”投影：
   *  只合并、不让 available 缩水，否则 Ctrl+P/Ctrl+L 的可选列表会被回包反噬。 */
  private mergeSettings(next: ZCodeSessionStateSnapshot["settings"]): void {
    const prev = this.snapshot.settings;
    const patch = { ...next };
    if (patch.model) {
      patch.model = {
        ...patch.model,
        available: mergeCatalog(prev.model.available, patch.model.available, modelOptionKey),
      };
    }
    if (patch.thoughtLevel) {
      patch.thoughtLevel = {
        ...patch.thoughtLevel,
        available: mergeCatalog(
          prev.thoughtLevel?.available,
          patch.thoughtLevel.available,
          thoughtLevelKey,
        ),
      };
    }
    const previousModel = JSON.stringify(prev.model.current);
    this.snapshot = { ...this.snapshot, settings: { ...prev, ...patch } };
    const current = this.snapshot.settings.model.current;
    if (JSON.stringify(current) === previousModel) return;
    const event = {
      id: `attach-local-${++this.localEventCounter}`,
      timestamp: new Date(),
      type: SessionEventType.ModelSelected,
      payload: { modelSelection: current },
    } as unknown as SessionEvent;
    for (const sink of this.sinks) sink(event);
  }

  async setModel(modelId: string | ModelSelection): Promise<{ model: string }> {
    const selection = this.toModelSelection(modelId);
    const result = await this.clientOf().request(zcodeProtocolMethods.sessionSetModel, {
      model: selection,
      sessionId: this.sessionId,
    });
    this.applyMutationSnapshot(result);
    return { model: this.getModel() ?? "" };
  }

  private toModelSelection(input: string | ModelSelection): ModelSelection {
    if (typeof input !== "string") return input;
    // 目录项形状是 {ref:{providerId,modelId}}，且 setModel 必须带 reasoningLevel——
    // 手写解析会漏掉 ref 匹配、也补不出档位，统一复用 CLI 的解析器。
    return resolveTuiModelSelection(
      input,
      this.snapshot.settings.model.available,
      undefined,
    );
  }

  async setThoughtLevel(level: string): Promise<{ thoughtLevel: string }> {
    const result = await this.clientOf().request(
      zcodeProtocolMethods.sessionSetThoughtLevel,
      { sessionId: this.sessionId, thoughtLevel: level },
    );
    this.applyMutationSnapshot(result);
    return { thoughtLevel: this.getThoughtLevel() ?? level };
  }

  async setMode(mode: string): Promise<{ mode: string }> {
    const result = await this.clientOf().request(zcodeProtocolMethods.sessionSetMode, {
      mode,
      sessionId: this.sessionId,
    });
    this.applyMutationSnapshot(result);
    return { mode: this.getMode() ?? mode };
  }

  async listModels(): Promise<unknown[]> {
    return this.snapshot.settings.model.available;
  }

  async listThoughtLevels(): Promise<string[]> {
    return (this.snapshot.settings.thoughtLevel.available as Array<{ id?: string }>)
      .map((option) => option.id)
      .filter((id): id is string => typeof id === "string");
  }

  async listCheckpoints(): Promise<unknown[]> {
    const checkpoints = (this.snapshot.runtime as { checkpoints?: unknown[] })
      .checkpoints;
    return checkpoints ?? [];
  }

  async recallPreviousInputHistory(
    skip?: number,
  ): Promise<{ text: string } | null> {
    const result = zcodeSessionRecallPreviousInputResultSchema.parse(
      await this.clientOf().request(zcodeProtocolMethods.sessionRecallPreviousInput, {
        sessionId: this.sessionId,
        skip,
      }),
    );
    return result.entry;
  }

  async recordInputHistory(input: TuiPromptInput): Promise<void> {
    await this.clientOf().request(zcodeProtocolMethods.sessionRecordInputHistory, {
      kind: "slash_command",
      sessionId: this.sessionId,
      text: typeof input === "string" ? input : input.text,
    });
  }

  async readSubagents(input?: { endedCursor?: string; endedLimit?: number }): Promise<ZCodeSessionSubagentsResult> {
    const params = { endedCursor: input?.endedCursor, endedLimit: input?.endedLimit, sessionId: this.sessionId };
    return (await this.clientOf().request(zcodeProtocolMethods.sessionSubagents, params)) as ZCodeSessionSubagentsResult;
  }

  async readUsageQuota(): Promise<import("@zcode/shared").UsageQuotaSnapshot> {
    // 协议面严格收（与相邻 read* 同模式）；外部 wire 的容错规整在 core 侧完成。
    return zcodeUsageQuotaSnapshotSchema.parse(await this.clientOf().request(zcodeProtocolMethods.usageCodingPlanQuota, { sessionId: this.sessionId }));
  }

  async readSubagentTranscript(
    childSessionId: string,
  ): Promise<TuiSubagentTranscriptSnapshot> {
    // 子会话 record 由父 session 的同一 core 承载；直接用 childSessionId 读
    // messages + raw events，客户端拼 TuiSubagentTranscriptSnapshot。
    const [messagesResult, eventsResult] = await Promise.all([
      this.clientOf().request(zcodeProtocolMethods.sessionMessages, {
        sessionId: childSessionId,
      }),
      this.clientOf().request(zcodeProtocolMethods.sessionEvents, {
        eventFormat: "raw",
        sessionId: childSessionId,
      }),
    ]);
    const messages = zcodeSessionMessagesResultSchema.parse(messagesResult).messages;
    const rawEvents =
      zcodeSessionEventsResultSchema.parse(eventsResult).rawEvents ?? [];
    const events = rawEvents.map(
      (raw) => ({ ...raw, timestamp: new Date(raw.timestamp) }) as unknown as SessionEvent,
    );
    return {
      events,
      messages: messages.map((message) => ({
        content: "",
        id: message.info.messageId,
        parts: message.parts as never,
        role: (message.info.role === "user" ? "user" : "agent") as "user" | "agent",
      })),
      replayMessageIds: [],
      sequenceNumber: rawEvents.at(-1)?.sequenceNumber ?? 0,
      sessionId: childSessionId,
    };
  }

  async cancelBackgroundTask(taskId: string): Promise<unknown> {
    return await this.clientOf().request(zcodeProtocolMethods.sessionCancelBackgroundTask, {
      backgroundTaskId: taskId,
      sessionId: this.sessionId,
    });
  }

  async readTarget(): Promise<{ objective?: string; status?: string } | null> {
    const result = (await this.clientOf().request(zcodeProtocolMethods.sessionGoal, {
      action: "show",
      sessionId: this.sessionId,
    })) as { snapshot?: ZCodeSessionStateSnapshot };
    this.applyMutationSnapshot(result);
    const target = (result.snapshot?.goalStats as { target?: unknown } | undefined)
      ?.target;
    return (target as { objective?: string; status?: string } | null) ?? null;
  }

  async setTarget(input: { objective: string }): Promise<{ objective: string }> {
    const result = (await this.clientOf().request(zcodeProtocolMethods.sessionGoal, {
      action: "set",
      objective: input.objective,
      sessionId: this.sessionId,
    })) as { snapshot?: ZCodeSessionStateSnapshot };
    this.applyMutationSnapshot(result);
    return { objective: input.objective };
  }

  async updateTargetStatus(status: string): Promise<unknown> {
    const action = status === "paused" ? "pause" : "resume";
    const result = (await this.clientOf().request(zcodeProtocolMethods.sessionGoal, {
      action,
      sessionId: this.sessionId,
    })) as { snapshot?: ZCodeSessionStateSnapshot };
    this.applyMutationSnapshot(result);
    return result;
  }

  async clearTarget(): Promise<boolean> {
    const result = (await this.clientOf().request(zcodeProtocolMethods.sessionGoal, {
      action: "clear",
      sessionId: this.sessionId,
    })) as { snapshot?: ZCodeSessionStateSnapshot };
    this.applyMutationSnapshot(result);
    return true;
  }

  async loadSessionTranscript(): Promise<
    NonNullable<TuiSubmitPromptResult["restoredMessages"]>
  > {
    const result = zcodeSessionMessagesResultSchema.parse(
      await this.clientOf().request(zcodeProtocolMethods.sessionMessages, {
        sessionId: this.sessionId,
      }),
    );
    return projectAttachTranscriptMessages(result.messages);
  }

  async forkFromCheckpoint(): Promise<{
    forkedSessionId: string;
    response: string;
  }> {
    const result = (await this.clientOf().request(zcodeProtocolMethods.sessionFork, {
      sessionId: this.sessionId,
      target: { kind: "latestCheckpoint" },
    })) as { forkedSessionId: string; response: string };
    return result;
  }

  /** 常驻 sink 续订（重连后）：用已见 sequenceNumber 补放缺口。 */
  async resubscribe(): Promise<void> {
    await this.subscribe(this.lastSeq, false);
  }

  /**
   * "stop & quit" 路径的 server 端停止：turnAbort.abort() 只触发 fire-and-forget
   * 的 sessionStop，socket 若先关停不掉。这里显式再发一次并等有界回执——
   * sessionStop 幂等，重复无害；超时按尽力而为返回，退出不被阻塞
   * （实现见 attach-session-stop.ts）。
   */
  async stopActiveTurn(): Promise<void> {
    await requestSessionStopBestEffort(this.clientOf, this.sessionId);
  }
}

export function asCommandCenterApp(handle: AttachSessionHandle): CommandCenterApp {
  return handle as unknown as CommandCenterApp;
}

export type { TurnId };
