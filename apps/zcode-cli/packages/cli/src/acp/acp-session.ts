// 单个 ACP 会话：把一个 core session 包成 ACP 的一等对象。
//
// 关键约束：
// - ACP sessionId == core sessionId。resume 因此天然成立：编辑器重启后拿
//   同一 id 调 session/resume，core 侧仍是同一会话（消息/模型/模式都在）。
// - 一次只允许一个 in-flight prompt（ACP v1 的回合模型）。并发 prompt 直接
//   报错，而不是在 core 里排队等一个语义不明的响应。
// - cancel 与 close 都是"先收口再释放"：abort 本地提交信号（core 侧 v4 stop
//   由 AttachSessionHandle 的 abort 路径发出），把挂着的反向交互按 deny 收掉，
//   再让 prompt 的 response 以停因 cancelled 返回。ACP 明确要求 cancel 后
//   必须应答所有 pending 的 request_permission——不能让 core 等到超时。
import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { ZCodeSessionStateSnapshot } from "@zcode/shared";
import type { AttachSessionHandle } from "../attach/attach-session.js";
import { AcpUpdateProjector, buildUsageUpdate } from "./acp-updates.js";
import {
  acpOutcomeToCoreResponse,
  acpResultToCoreUserInput,
  permissionRequestToAcp,
  userInputRequestToAcp,
} from "./acp-interactions.js";
import {
  acpElicitationResultSchema,
  acpMethods,
  acpPermissionResponseSchema,
  acpStopReasons,
  type AcpContentBlock,
  type AcpPermissionOutcome,
  type AcpSessionConfigOption,
  type AcpSessionModeState,
  type AcpSessionUpdate,
  type AcpStopReason,
} from "./acp-protocol.js";

/** core 的协作模式里，编辑器能安全表达的两个。其余（yolo/auto/guarded/edit）
 *  是 core 的权限档，不是交互模式，暴露出去等于让编辑器静默关掉审批。 */
const ACP_MODE_PLAN = "plan";
const ACP_MODE_BUILD = "build";

export type AcpTurnUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
};

export type AcpPromptOutcome = {
  stopReason: AcpStopReason;
  usage?: AcpTurnUsage;
};

export type AcpSessionLogger = {
  warn: (message: string, context?: Record<string, unknown>) => void;
};

export type AcpSessionDeps = {
  /** 向 ACP client 发请求（session/request_permission、elicitation/create）。 */
  sendRequest: <T = unknown>(method: string, params: unknown) => Promise<T>;
  /** 向 ACP client 发 session/update 通知。 */
  emitUpdate: (update: AcpSessionUpdate) => void;
  /** core 侧释放会话 runtime（会话行保留，仍可 resume）。 */
  closeRemoteSession: () => Promise<void>;
  logger: AcpSessionLogger;
};

export class AcpSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly handle: AttachSessionHandle;
  private readonly deps: AcpSessionDeps;
  private readonly projector: AcpUpdateProjector;
  private activeTurn: { controller: AbortController } | undefined;
  private closed = false;
  private lastTurnUsage: AcpTurnUsage | undefined;
  private readonly pendingInteractions = new Map<string, () => void>();
  private unsubscribeSink: (() => void) | undefined;

  constructor(input: {
    cwd: string;
    deps: AcpSessionDeps;
    handle: AttachSessionHandle;
    sessionId: string;
  }) {
    this.cwd = input.cwd;
    this.deps = input.deps;
    this.handle = input.handle;
    this.sessionId = input.sessionId;
    this.projector = new AcpUpdateProjector((update) => this.deps.emitUpdate(update));
  }

  /** 常驻订阅：core 事件 → ACP session/update。 */
  attachEventStream(): void {
    this.unsubscribeSink ??= this.handle.addSink((event) => this.ingestEvent(event));
  }

  /** detach 时摘掉 sink，避免会话已关闭还在投影事件。 */
  detachEventStream(): void {
    this.unsubscribeSink?.();
    this.unsubscribeSink = undefined;
  }

  get snapshot(): ZCodeSessionStateSnapshot {
    return this.handle.snapshot;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isBusy(): boolean {
    return this.activeTurn !== undefined;
  }

  // -------------------------------------------------------------------------
  // 模式 / 模型 / 配置项
  // -------------------------------------------------------------------------

  modeState(): AcpSessionModeState {
    const current = this.handle.getMode();
    return {
      availableModes: [
        {
          description:
            "Plan before acting. Tools that change files stay blocked until approval.",
          id: ACP_MODE_PLAN,
          name: "Plan",
        },
        { description: "Execute the task with tools.", id: ACP_MODE_BUILD, name: "Build" },
      ],
      currentModeId: current === ACP_MODE_PLAN ? ACP_MODE_PLAN : ACP_MODE_BUILD,
    };
  }

  configOptions(): AcpSessionConfigOption[] {
    const options: AcpSessionConfigOption[] = [];
    const settings = this.handle.snapshot.settings;
    const models = settings.model.available as Array<{
      description?: string;
      label: string;
      providerLabel?: string;
      ref: { modelId: string; providerId: string };
    }>;
    if (models.length > 0) {
      const compactCap = this.handle.getCompactContextWindow();
      const current = this.handle.getModel() ?? modelRefOf(models[0]);
      options.push({
        category: "model",
        currentValue: current,
        description: "Model used for this session.",
        id: "model",
        name: "Model",
        options: models.map((model) => ({
          description: model.description ?? model.providerLabel ?? model.ref.providerId,
          name: model.label || model.ref.modelId,
          value: modelRefOf(model),
        })),
        type: "select",
        // 压缩上限不是 v1 的概念，塞进 _meta 是可逆扩展：编辑器忽略它也不影响语义。
        ...(models.length === 0 || compactCap === undefined
          ? {}
          : { _meta: { piz: { compactContextWindow: compactCap } } }),
      });
    }
    const thoughtLevels = settings.thoughtLevel.available as Array<{
      id?: string;
      label?: string;
      value?: string;
    }>;
    const levelValues = thoughtLevels
      .map((level) => level.id ?? level.value)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (settings.thoughtLevel.enabled && levelValues.length > 0) {
      options.push({
        category: "thought_level",
        currentValue: this.handle.getThoughtLevel() ?? levelValues[0],
        description: "Reasoning effort for this session.",
        id: "thought_level",
        name: "Reasoning effort",
        options: levelValues.map((value, index) => ({
          name: thoughtLevels[index]?.label ?? value,
          value,
        })),
        type: "select",
      });
    }
    return options;
  }

  emitConfigOptions(): void {
    this.deps.emitUpdate({
      configOptions: this.configOptions(),
      sessionUpdate: "config_option_update",
    });
  }

  async setMode(modeId: string): Promise<void> {
    const target = modeId === ACP_MODE_PLAN ? ACP_MODE_PLAN : ACP_MODE_BUILD;
    if (this.modeState().currentModeId !== target) {
      await this.handle.setMode(target);
    }
    this.deps.emitUpdate({ currentModeId: target, sessionUpdate: "current_mode_update" });
  }

  async setModel(modelId: string): Promise<void> {
    if (modelId.trim().length === 0) throw new Error("model id is required");
    await this.handle.setModel(modelId);
    // 压缩上限跟随模型（core 侧 syncCompactContextWindow 在同一链路里跑），
    // 因此切换后重发 configOptions，_meta 里的上限才是新的。
    this.emitConfigOptions();
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    if (typeof value !== "string") {
      throw new Error(`config option ${configId} only accepts string values`);
    }
    if (configId === "model") {
      await this.setModel(value);
      return;
    }
    if (configId === "thought_level") {
      await this.handle.setThoughtLevel(value);
      this.emitConfigOptions();
      return;
    }
    throw new Error(`unknown config option: ${configId}`);
  }

  // -------------------------------------------------------------------------
  // 回合
  // -------------------------------------------------------------------------

  async prompt(prompt: readonly AcpContentBlock[]): Promise<AcpPromptOutcome> {
    if (this.closed) throw new Error("session is closed");
    if (this.activeTurn !== undefined) {
      throw new Error("a prompt turn is already in progress for this session");
    }
    const text = promptText(prompt);
    if (text.trim().length === 0) throw new Error("prompt contains no text content");
    const controller = new AbortController();
    this.activeTurn = { controller };
    this.lastTurnUsage = undefined;
    this.projector.reset();
    try {
      await this.handle.submitPrompt({ text }, { abortSignal: controller.signal });
      return { stopReason: acpStopReasons.endTurn, ...this.turnUsageField() };
    } catch (error) {
      if (controller.signal.aborted) {
        return { stopReason: acpStopReasons.cancelled, ...this.turnUsageField() };
      }
      throw error;
    } finally {
      this.activeTurn = undefined;
      const usageUpdate = buildUsageUpdate(this.snapshot);
      if (usageUpdate) this.deps.emitUpdate(usageUpdate);
    }
  }

  /** session/cancel：不等待结果，prompt 的 response 会带 cancelled 停因。 */
  cancel(reason = "cancelled by client"): void {
    const turn = this.activeTurn;
    this.settlePendingInteractions();
    if (!turn) return;
    this.deps.logger.warn("acp cancel requested", { reason, sessionId: this.sessionId });
    turn.controller.abort();
  }

  /**
   * session/close：按 ACP 语义"先取消在跑的工作，再释放资源"。
   * core 侧发 session/close 释放 runtime 记录（会话行本身保留，可再 resume）。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.cancel("session closed");
    this.closed = true;
    this.settlePendingInteractions();
    try {
      await this.deps.closeRemoteSession();
    } catch (error) {
      this.deps.logger.warn("acp session close failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: this.sessionId,
      });
    } finally {
      this.unsubscribeSink?.();
      this.unsubscribeSink = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // core 反向交互
  // -------------------------------------------------------------------------

  /** interaction/requestPermission → session/request_permission，应答回 option.response 原文。 */
  async handlePermissionRequest(params: unknown): Promise<unknown> {
    const translated = permissionRequestToAcp(
      params as Parameters<typeof permissionRequestToAcp>[0],
      this.sessionId,
    );
    const requestId = String(
      (params as { requestId?: unknown }).requestId ?? translated.params.toolCall.toolCallId,
    );
    const cancelled = (): AcpPermissionOutcome => ({ outcome: "cancelled" });
    const result = await this.serveInteraction(requestId, async () => {
      const raw = await this.deps.sendRequest(
        acpMethods.sessionRequestPermission,
        translated.params,
      );
      const parsed = acpPermissionResponseSchema.safeParse(raw);
      return acpOutcomeToCoreResponse(parsed.success ? parsed.data.outcome : cancelled(), translated);
    });
    return result ?? acpOutcomeToCoreResponse(cancelled(), translated);
  }

  /** interaction/requestUserInput → elicitation/create form（问题 + 计划批准）。 */
  async handleUserInputRequest(params: unknown): Promise<unknown> {
    const translated = userInputRequestToAcp(
      params as Parameters<typeof userInputRequestToAcp>[0],
      this.sessionId,
    );
    if (!translated) {
      // 无法渲染的 kind（MCP elicitation、未知 schema）：如实 decline。
      return { action: "decline", reason: "Unsupported interaction in ACP frontend" };
    }
    const requestId = String(
      (params as { requestId?: unknown }).requestId ?? `${this.sessionId}-user-input`,
    );
    const result = await this.serveInteraction(requestId, async () => {
      const raw = await this.deps.sendRequest(
        acpMethods.elicitationCreate,
        translated.params,
      );
      const parsed = acpElicitationResultSchema.safeParse(raw);
      return parsed.success
        ? acpResultToCoreUserInput(parsed.data, translated)
        : { action: "decline" };
    });
    return result ?? { action: "decline" };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private ingestEvent(event: SessionEvent): void {
    if (event.type === SessionEventType.TurnComplete) {
      this.lastTurnUsage = usageFromTurnPayload(event.payload);
    }
    this.projector.ingest(event);
  }

  private turnUsageField(): { usage?: AcpTurnUsage } {
    return this.lastTurnUsage ? { usage: this.lastTurnUsage } : {};
  }

  /**
   * 同一业务 requestId 的重发只驱动一次请求、共享同一个应答（core 的恢复链路
   * 会周期 reannounce）。cancel/close 时把挂着的交互收口成 undefined，
   * 调用方回落到 deny/cancel。
   */
  private serveInteraction<T>(
    requestId: string,
    invoke: () => Promise<T>,
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      this.pendingInteractions.set(requestId, () => resolve(undefined));
      void invoke()
        .then((value) => {
          this.pendingInteractions.delete(requestId);
          resolve(value);
        })
        .catch((error: unknown) => {
          this.pendingInteractions.delete(requestId);
          this.deps.logger.warn("acp interaction failed", {
            error: error instanceof Error ? error.message : String(error),
            requestId,
          });
          resolve(undefined);
        });
    });
  }

  private settlePendingInteractions(): void {
    for (const settle of this.pendingInteractions.values()) settle();
    this.pendingInteractions.clear();
  }
}

function modelRefOf(model: { ref: { modelId: string; providerId: string } }): string {
  return `${model.ref.providerId}/${model.ref.modelId}`;
}

/** ACP 的 prompt 是 ContentBlock[]；v1 只会用到 text，resource_link 折成文本引用。 */
export function promptText(prompt: readonly AcpContentBlock[]): string {
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "resource_link") parts.push(`[${block.name}](${block.uri})`);
  }
  return parts.join("\n\n");
}

function usageFromTurnPayload(payload: unknown): AcpTurnUsage | undefined {
  const usage = (payload as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage) return undefined;
  const number = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const total = number("totalTokens");
  const input = number("inputTokens");
  const output = number("outputTokens");
  if (total === 0 && input === 0 && output === 0) return undefined;
  const result: AcpTurnUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total || input + output,
  };
  const thought = number("reasoningTokens");
  if (thought > 0) result.thoughtTokens = thought;
  const cachedRead = number("cacheReadTokens");
  if (cachedRead > 0) result.cachedReadTokens = cachedRead;
  const cachedWrite = number("cacheWriteTokens");
  if (cachedWrite > 0) result.cachedWriteTokens = cachedWrite;
  return result;
}
