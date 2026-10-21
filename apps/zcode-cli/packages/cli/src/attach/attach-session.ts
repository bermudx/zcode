// attach 模式下的协议态会话句柄：实现 CommandCenterApp 的可选面，
// 业务状态全部留在共享 core；本文件只做 topic 映射与快照缓存。
// raw SessionEvent 的 timestamp 在线上为 ISO 串，由 runtime  revive 成 Date。
import type { SessionEvent } from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeSessionSubscribeResultSchema,
  zcodeSessionEventsResultSchema,
  zcodeSessionMessagesResultSchema,
  zcodeSessionRecallPreviousInputResultSchema,
  type ZCodeSessionRawEvent,
  type ZCodeSessionStateSnapshot,
  type ZCodeSessionSubagentsResult,
  type ModelSelection,
} from "@zcode/shared";
import type {
  TuiPromptInput,
  TuiSendInputResult,
  TuiSubmitPromptResult,
  TuiSubagentTranscriptSnapshot,
} from "@zcode/tui";
import type { TurnId } from "@zcode/contracts";
import type { AttachClient } from "./attach-client.js";
import type { CommandCenterApp } from "../command-center.js";

const TURN_STARTED = "turn_started";
const TURN_END_TYPES = new Set(["turn_complete", "turn_error"]);

const PROMPT_INPUT_ID_PREFIX = "attach-input";

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
  /** 当前等待中的 permission 回调；同一连接一次交互只挂一个。 */
  activeRequestPermission:
    | ((request: unknown, options?: unknown) => Promise<unknown>)
    | undefined;

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
    if (result.snapshot) this.snapshot = result.snapshot;
    if (result.eventSeq > this.lastSeq) this.lastSeq = result.eventSeq;
    for (const raw of result.rawEvents ?? []) this.ingestRawEvent(raw);
  }

  private routeTurnEvent(event: SessionEvent): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === TURN_STARTED) {
      const inputId = typeof payload.inputId === "string" ? payload.inputId : undefined;
      const pending = inputId ? this.pendingTurns.get(inputId) : undefined;
      if (pending) {
        pending.turnId = event.turnId;
        this.pendingByTurnId.set(String(event.turnId), pending);
      }
      return;
    }
    if (!TURN_END_TYPES.has(event.type)) return;
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
      return;
    }
    pending.resolve(this.buildTurnResult(event, pending));
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
      model: settings.model.current?.modelId,
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
    if (options?.onEvent) this.sinks.add((event) => void options.onEvent?.(event));
    if (options?.requestPermission) {
      this.activeRequestPermission = options.requestPermission as (
        request: unknown,
        requestOptions?: unknown,
      ) => Promise<unknown>;
    }
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
        attachments: typeof prompt === "string" ? undefined : prompt.attachments,
        content: text,
        inputId,
        modelSelection,
        sessionId: this.sessionId,
      });
    } catch (error) {
      this.pendingTurns.delete(inputId);
      this.activeRequestPermission = undefined;
      throw error;
    }
    try {
      return await turnPromise;
    } finally {
      this.activeRequestPermission = undefined;
    }
  }

  /** CommandCenterApp.sendInput：steer/queue 经同一 session/send 入口，core admission 裁决。 */
  async sendInput(
    input: TuiPromptInput,
    options?: {
      abortSignal?: AbortSignal;
      onEvent?: (event: SessionEvent) => void | Promise<void>;
      requestPermission?: (
        request: unknown,
        requestOptions?: unknown,
      ) => Promise<unknown>;
    },
  ): Promise<TuiSendInputResult> {
    const result = await this.submitPrompt(input, options);
    return { kind: "started_turn", result };
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

  getMode(): "build" | "plan" | undefined {
    return this.snapshot.settings.mode.current as "build" | "plan" | undefined;
  }

  getModel(): string | undefined {
    return this.snapshot.settings.model.current?.modelId;
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
    const snapshot = (result as { snapshot?: ZCodeSessionStateSnapshot }).snapshot;
    if (snapshot) this.snapshot = snapshot;
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
    const available = this.snapshot.settings.model.available as Array<{
      providerId?: string;
      modelId?: string;
      id?: string;
    }>;
    const match = available.find(
      (option) => option.modelId === input || option.id === input,
    );
    if (match?.providerId && match.modelId) {
      return { providerId: match.providerId, modelId: match.modelId };
    }
    const separatorIndex = input.indexOf("/");
    if (separatorIndex > 0) {
      return {
        providerId: input.slice(0, separatorIndex),
        modelId: input.slice(separatorIndex + 1),
      };
    }
    throw new Error(
      `Cannot resolve model "${input}" to a provider/model selection on the shared core`,
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

  async readSubagents(input?: {
    endedCursor?: string;
    endedLimit?: number;
  }): Promise<ZCodeSessionSubagentsResult> {
    return (await this.clientOf().request(zcodeProtocolMethods.sessionSubagents, {
      endedCursor: input?.endedCursor,
      endedLimit: input?.endedLimit,
      sessionId: this.sessionId,
    })) as ZCodeSessionSubagentsResult;
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
    return result.messages.map((message) => ({
      content: "",
      id: message.info.messageId,
      parts: message.parts as never,
      role: (message.info.role === "user" ? "user" : "agent") as "user" | "agent",
    }));
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
}

export function asCommandCenterApp(handle: AttachSessionHandle): CommandCenterApp {
  return handle as unknown as CommandCenterApp;
}

export type { TurnId };
