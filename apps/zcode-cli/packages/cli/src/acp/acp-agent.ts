// ACP v1 的 agent 端实现：把 ACP 的会话/回合/交互语义翻译成 share-core 的
// session/*、v4 sendText 与 interaction/* 反向请求。业务事实全部留在 core，
// 这里只有「协议形状 + 在途回合」。
import {
  methods,
  PROTOCOL_VERSION,
  RequestError,
  agent as createApp,
  type AgentApp,
  type AgentContext,
  type ContentBlock,
  type NewSessionResponse,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type {
  PermissionBrokerRequest,
  PermissionBrokerResult,
} from "@zcode/contracts";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "@zcode/contracts";
import {
  ACP_MODEL_CONFIG_ID,
  ACP_THOUGHT_LEVEL_CONFIG_ID,
  AcpEventProjector,
  answersFromElicitationContent,
  buildConfigOptions,
  buildModeState,
  buildPlanApprovalForm,
  buildQuestionForm,
  coreModeToAcpMode,
  permissionOptionsForCore,
  permissionResultForAcpOption,
  planApprovalResult,
  promptBlocksToText,
  toolKindForName,
  type AcpPermissionResult,
} from "./acp-project.js";
import type { AcpCorePort, AcpSession } from "./acp-sessions.js";
import {
  localSlashCommandsUpdate,
  newGoalInputId,
  parseLocalSlashCommand,
  runDwfCommand,
  runGoalCommand,
  watchTurnSettlement,
  type AcpLocalCommand,
} from "./acp-commands.js";
import type { SendInputOptions } from "../attach/attach-steer.js";

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const MAX_QUEUED_UPDATES = 256;
const MAX_QUEUED_UPDATE_BYTES = 1024 * 1024;

export interface AcpAgentLogger {
  debug?: (message: string, context?: Record<string, unknown>) => void;
  warn?: (message: string, context?: Record<string, unknown>) => void;
}

export interface AcpAgentOptions {
  logger?: AcpAgentLogger;
  /** stdio 入口记录致命投影/输出失败，用于诊断与非零退出码。 */
  onConnectionError?: (error: Error) => void;
  sessions: AcpCorePort;
  version: string;
}

type ActiveTurn = {
  cancel: () => void;
  cancelled: boolean;
};

/**
 * 一个 ACP 连接一份 agent app。会话可以来自不同 cwd，但每个会话的
 * session/update 只投递给创建/恢复它的这条连接。
 */
export function createAcpAgentApp(options: AcpAgentOptions): AgentApp {
  const app = createApp({ name: "piz" });
  const projectors = new Map<string, AcpEventProjector>();
  const unsubscribers = new Map<string, () => void>();
  const activeTurns = new Map<string, ActiveTurn>();
  // 本连接自己发起的 set_config_option 在途计数：其结果由请求回包携带，不再重复推送。
  const ownConfigChanges = new Map<string, number>();
  const log = options.logger;
  const updates: Array<{ client: AgentContext; sessionId: string; update: SessionUpdate; bytes: number }> = [];
  let queuedBytes = 0;
  let writing = false;
  let pendingDrain: Promise<void> = Promise.resolve();
  let connectionFailure: Error | undefined;
  let closeConnection: ((error: Error) => void) | undefined;
  // abort 只清状态不置 connectionFailure（close ≠ 输出失败）；推迟的广告等
  // 宏任务级回调要另看它，否则会对已死连接再发 session/update。
  let connectionClosed = false;

  const failConnection = (error: Error): void => {
    if (connectionFailure) return;
    connectionFailure = error;
    updates.length = 0;
    queuedBytes = 0;
    log?.warn?.("acp connection failed", { error: error.message });
    options.onConnectionError?.(error);
    closeConnection?.(error);
  };

  app.onConnect((connection) => {
    closeConnection = (error) => connection.close(error);
    connection.signal.addEventListener("abort", () => {
      connectionClosed = true;
      updates.length = 0;
      queuedBytes = 0;
      for (const cancel of unsubscribers.values()) cancel();
      unsubscribers.clear();
      projectors.clear();
      for (const turn of activeTurns.values()) turn.cancel();
    }, { once: true });
  });

  const drainUpdates = async (): Promise<void> => {
    if (writing || connectionFailure) return;
    writing = true;
    try {
      while (updates.length > 0) {
        const next = updates[0]!;
        await next.client.notify(methods.client.session.update, {
          sessionId: next.sessionId, update: next.update,
        });
        // close/overload 会清空队列，不能再减去已经释放的计数。
        if (updates[0] !== next) return;
        updates.shift();
        queuedBytes -= next.bytes;
      }
    } catch (error) {
      // 输出是连接边界：写失败无法重放，终止整条连接而非丢更新后继续。
      failConnection(new Error("ACP session/update write failed", { cause: error }));
    } finally {
      writing = false;
    }
  };

  const notifyUpdate = (
    client: AgentContext,
    sessionId: string,
    update: SessionUpdate,
  ): void => {
    if (connectionFailure) return;
    const bytes = new TextEncoder().encode(JSON.stringify({ sessionId, update })).byteLength;
    if (updates.length >= MAX_QUEUED_UPDATES || queuedBytes + bytes > MAX_QUEUED_UPDATE_BYTES) {
      failConnection(new Error("ACP session/update queue overloaded (256 updates / 1 MiB limit)"));
      return;
    }
    updates.push({ bytes, client, sessionId, update });
    queuedBytes += bytes;
    if (!writing) pendingDrain = drainUpdates();
  };

  const configOptionsFor = (session: AcpSession): SessionConfigOption[] =>
    buildConfigOptions(
      session.handle.snapshot.settings.model,
      session.handle.snapshot.settings.thoughtLevel,
    );

  const emitterFor = (
    client: AgentContext,
    session: AcpSession,
  ): ((updates: readonly SessionUpdate[]) => void) => {
    return (updates) => {
      for (const update of updates) {
        notifyUpdate(client, session.handle.sessionId, update);
      }
    };
  };

  const bindSession = (client: AgentContext, session: AcpSession): void => {
    const sessionId = session.handle.sessionId;
    if (unsubscribers.has(sessionId)) return;
    const projector = new AcpEventProjector();
    projectors.set(sessionId, projector);
    const emit = emitterFor(client, session);
    const unsubscribe = session.handle.addSink((event) => {
      try {
        emit(projector.project(event));
        if (event.type === "model_selected" && !ownConfigChanges.get(sessionId)) {
          // 来自 core 的模型/档位变化（含其他客户端）；此刻重新读快照，不带过期值。
          emit([
            {
              configOptions: configOptionsFor(session),
              sessionUpdate: "config_option_update",
            },
          ]);
        }
      } catch (error) {
        // sink 不能向外抛错而阻断 handle 的 turn waiter；投影坏数据使连接失败。
        failConnection(new Error(`ACP projection failed for ${sessionId}`, { cause: error }));
      }
    });
    unsubscribers.set(sessionId, unsubscribe);
  };

  const releaseSession = (sessionId: string): void => {
    unsubscribers.get(sessionId)?.();
    unsubscribers.delete(sessionId);
    projectors.delete(sessionId);
  };

  const requireSession = (sessionId: string): AcpSession => {
    const session = options.sessions.get(sessionId);
    if (!session) {
      throw new RequestError(INVALID_PARAMS, `Unknown ACP session: ${sessionId}`);
    }
    return session;
  };

  const sharedOptions = (session: AcpSession): NewSessionResponse => ({
    configOptions: configOptionsFor(session),
    modes: buildModeState(session.handle.getMode()),
    sessionId: session.handle.sessionId,
  });

  /**
   * 会话建立后广播本地命令面。必须让 session/new|resume 的响应先落线再发这条
   * update（客户端此刻才认识 sessionId），故推迟一个宏任务；更新队列本身的写入
   * 是异步 drain，顺序由这里保证。
   */
  const advertiseLocalCommands = (client: AgentContext, session: AcpSession): void => {
    setTimeout(() => {
      if (connectionFailure || connectionClosed) return;
      notifyUpdate(client, session.handle.sessionId, localSlashCommandsUpdate());
    }, 0);
  };

  app.onRequest(methods.agent.initialize, () => {
    return {
      agentCapabilities: {
        // 不实现 session/load：ACP 的 resume 不重放历史，与 attach 语义一致。
        loadSession: false,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: { audio: false, embeddedContext: true, image: false },
        sessionCapabilities: { close: {}, resume: {} },
      },
      agentInfo: { name: "piz", version: options.version },
      // 稳定 ACP v1；客户端更高的版本由客户端决定是否继续。
      protocolVersion: PROTOCOL_VERSION,
    };
  });

  app.onRequest(methods.agent.session.new, async ({ client, params }) => {
    if (params.mcpServers.length > 0) {
      // core 的 MCP 由自己的 workspace 配置装配；T3 注入的 MCP 不转发。
      log?.warn?.("acp ignored client MCP servers", {
        count: params.mcpServers.length,
        cwd: params.cwd,
      });
    }
    const session = await options.sessions.open(params.cwd);
    bindSession(client, session);
    advertiseLocalCommands(client, session);
    return sharedOptions(session);
  });

  app.onRequest(methods.agent.session.resume, async ({ client, params }) => {
    const session = await options.sessions.resume({
      cwd: params.cwd,
      sessionId: params.sessionId,
    });
    bindSession(client, session);
    advertiseLocalCommands(client, session);
    const response: ResumeSessionResponse = {
      configOptions: configOptionsFor(session),
      modes: buildModeState(session.handle.getMode()),
    };
    return response;
  });

  app.onRequest(methods.agent.session.close, async ({ params }) => {
    activeTurns.get(params.sessionId)?.cancel();
    try {
      await options.sessions.closeSession(params.sessionId);
    } catch (error) {
      // ACP 请求边界：core 拒绝关闭时保留绑定，并回明确错误供客户端重试。
      const message = error instanceof Error ? error.message : String(error);
      log?.warn?.("acp session close failed", { error: message, sessionId: params.sessionId });
      throw new RequestError(INTERNAL_ERROR, `Could not close ACP session: ${message}`);
    }
    releaseSession(params.sessionId);
    ownConfigChanges.delete(params.sessionId);
    activeTurns.delete(params.sessionId);
    return {};
  });

  app.onRequest(methods.agent.session.setMode, async ({ params }) => {
    const session = requireSession(params.sessionId);
    if (params.modeId !== "plan" && params.modeId !== "build") {
      throw new RequestError(INVALID_PARAMS, `Unknown ACP mode: ${params.modeId}`);
    }
    await session.handle.setMode(params.modeId);
    return {};
  });

  const trackOwnConfigChange = async <T>(
    sessionId: string,
    change: () => Promise<T>,
  ): Promise<T> => {
    ownConfigChanges.set(sessionId, (ownConfigChanges.get(sessionId) ?? 0) + 1);
    try {
      return await change();
    } finally {
      const left = (ownConfigChanges.get(sessionId) ?? 1) - 1;
      if (left > 0) ownConfigChanges.set(sessionId, left);
      else ownConfigChanges.delete(sessionId);
    }
  };

  app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    const session = requireSession(params.sessionId);
    if (params.configId === ACP_MODEL_CONFIG_ID) {
      if (typeof params.value !== "string") {
        throw new RequestError(INVALID_PARAMS, "Model config option requires a string value");
      }
      const model = params.value;
      await trackOwnConfigChange(params.sessionId, () => session.handle.setModel(model));
      return { configOptions: configOptionsFor(session) };
    }
    if (params.configId === ACP_THOUGHT_LEVEL_CONFIG_ID) {
      const effort = configOptionsFor(session).find(
        (option) => option.id === ACP_THOUGHT_LEVEL_CONFIG_ID,
      );
      if (effort?.type !== "select") {
        throw new RequestError(
          INVALID_PARAMS,
          "Reasoning effort is not configurable for the current model",
        );
      }
      if (typeof params.value !== "string" || params.value.length === 0) {
        throw new RequestError(
          INVALID_PARAMS,
          "Reasoning effort config option requires a non-empty string value",
        );
      }
      const supported = new Set(
        effort.options.flatMap((entry) =>
          "value" in entry ? [entry.value] : entry.options.map((nested) => nested.value),
        ),
      );
      if (!supported.has(params.value)) {
        throw new RequestError(
          INVALID_PARAMS,
          "Unsupported reasoning effort for the current model",
        );
      }
      const level = params.value;
      await trackOwnConfigChange(params.sessionId, () => session.handle.setThoughtLevel(level));
      log?.debug?.("acp reasoning effort changed", {
        sessionId: params.sessionId,
        value: params.value,
      });
      return { configOptions: configOptionsFor(session) };
    }
    throw new RequestError(
      INVALID_PARAMS,
      `Unknown ACP config option: ${params.configId}`,
    );
  });

  app.onNotification(methods.agent.session.cancel, ({ params }) => {
    const turn = activeTurns.get(params.sessionId);
    if (turn) {
      turn.cancel();
      return;
    }
    // goal 续跑的后续轮（2..N）不占 in-flight 表——prompt 只等第一轮就返回了，
    // 此刻的 cancel 仍应到达 core 的 v4 stop（暂停目标 + 中止当前轮）。空闲时
    // stopActiveTurn 是 core 侧 no-op，ACK 即返，不误伤。
    const session = options.sessions.get(params.sessionId);
    if (session) void session.handle.stopActiveTurn();
  });

  /**
   * 本地命令回合（/goal、/dwf）：与普通 prompt 共用 in-flight 守卫、取消口与
   * 输出队列；差异只在「不进模型」——core op 的回包文案以一条 agent_message_chunk
   * 呈现，goal 的续跑轮由 awaitTurnSettlement 对齐（见 acp-commands.ts）。
   */
  const runLocalCommand = async (
    client: AgentContext,
    session: AcpSession,
    command: AcpLocalCommand,
  ): Promise<PromptResponse> => {
    const sessionId = session.handle.sessionId;
    const controller = new AbortController();
    // goal 续跑轮是 core 侧在跑的 turn，v4 stop 连带暂停/中止；dwf 只是 op 往返，
    // core 里没有「我们的」turn——stop 会误伤其它客户端正在跑的回合。
    const ownsCoreTurn = command.kind === "goal";
    const turn: ActiveTurn = {
      cancel: () => {
        turn.cancelled = true;
        controller.abort();
        if (ownsCoreTurn) void session.handle.stopActiveTurn();
      },
      cancelled: false,
    };
    activeTurns.set(sessionId, turn);
    session.cancel = turn.cancel;
    const emit = emitterFor(client, session);
    try {
      if (command.kind === "goal") {
        // settlement 订阅先于 session/goal 发出：续跑轮可能比 op 回包更早收口。
        const inputId = newGoalInputId();
        const watch = watchTurnSettlement(session.handle, inputId, controller.signal);
        try {
          const result = await runGoalCommand(session.handle, command.args, inputId);
          // pause 之类静默成功已在 runGoalCommand 补成用户可见文案；真正的空回包
          // 不伪造空消息气泡。
          if (result.response.length > 0) {
            emit([
              {
                content: { text: result.response, type: "text" },
                sessionUpdate: "agent_message_chunk",
              },
            ]);
          }
          if (result.startedTurn && (await watch.promise) === "aborted") {
            return { stopReason: "cancelled" } satisfies PromptResponse;
          }
        } finally {
          watch.dispose();
        }
      } else {
        const response = await runDwfCommand(session.handle, command.args);
        emit([
          {
            content: { text: response, type: "text" },
            sessionUpdate: "agent_message_chunk",
          },
        ]);
      }
      await pendingDrain;
      if (connectionFailure) throw connectionFailure;
      // 取消可能落在 op 已回包之后（dwf 无 watch 可依赖）：以回合标志收口，
      // 不把被取消的回合报告成完整结束。
      if (turn.cancelled) {
        return { stopReason: "cancelled" } satisfies PromptResponse;
      }
      return { stopReason: "end_turn" } satisfies PromptResponse;
    } catch (error) {
      if (turn.cancelled || isAbortError(error)) {
        return { stopReason: "cancelled" } satisfies PromptResponse;
      }
      const message = error instanceof Error ? error.message : String(error);
      log?.warn?.("acp local command failed", { command: command.kind, error: message, sessionId });
      throw new RequestError(INTERNAL_ERROR, message);
    } finally {
      activeTurns.delete(sessionId);
      if (session.cancel === turn.cancel) session.cancel = undefined;
    }
  };

  app.onRequest(methods.agent.session.prompt, async ({ client, params }) => {
    const session = requireSession(params.sessionId);
    if (activeTurns.has(params.sessionId)) {
      throw new RequestError(
        INVALID_PARAMS,
        "A prompt turn is already running for this ACP session",
      );
    }
    const text = promptBlocksToText(params.prompt);
    if (text.length === 0) {
      throw new RequestError(INVALID_PARAMS, "Prompt contains no usable content");
    }
    // /goal 与 /dwf 是前端本地命令（TUI 的 command-center 同款）：ACP 客户端没有
    // command-center，这里代为路由；其余 slash 输入维持 P005 的原文转发。
    const localCommand = parseLocalSlashCommand(text);
    if (localCommand) {
      return await runLocalCommand(client, session, localCommand);
    }
    const controller = new AbortController();
    const turn: ActiveTurn = {
      cancel: () => {
        turn.cancelled = true;
        controller.abort();
        void session.handle.stopActiveTurn();
      },
      cancelled: false,
    };
    activeTurns.set(params.sessionId, turn);
    session.cancel = turn.cancel;
    try {
      await session.handle.submitPrompt(
        text,
        {
          abortSignal: controller.signal,
          requestPermission: (request: PermissionBrokerRequest, extra?: { signal?: AbortSignal }) =>
            bridgeInteraction(client, session.handle.sessionId, request, extra?.signal),
        } as unknown as SendInputOptions,
      );
      await pendingDrain;
      if (connectionFailure) throw connectionFailure;
      return { stopReason: "end_turn" } satisfies PromptResponse;
    } catch (error) {
      if (turn.cancelled || isAbortError(error)) {
        return { stopReason: "cancelled" } satisfies PromptResponse;
      }
      const message = error instanceof Error ? error.message : String(error);
      log?.warn?.("acp prompt failed", { error: message, sessionId: params.sessionId });
      throw new RequestError(INTERNAL_ERROR, message);
    } finally {
      activeTurns.delete(params.sessionId);
      if (session.cancel === turn.cancel) session.cancel = undefined;
    }
  });

  return app;
}

async function bridgeInteraction(
  client: AgentContext,
  sessionId: string,
  request: PermissionBrokerRequest,
  signal?: AbortSignal,
): Promise<PermissionBrokerResult> {
  if (request.toolName === ASK_USER_QUESTION_TOOL_NAME) {
    return await askUserQuestion(client, sessionId, request, signal);
  }
  if (request.toolName === EXIT_PLAN_MODE_TOOL_NAME) {
    return await approvePlan(client, sessionId, request, signal);
  }
  return await requestPermission(client, sessionId, request, signal);
}

async function requestPermission(
  client: AgentContext,
  sessionId: string,
  request: PermissionBrokerRequest,
  signal?: AbortSignal,
): Promise<PermissionBrokerResult> {
  const coreOptions = corePermissionOptions(request);
  const options = permissionOptionsForCore(coreOptions);
  const response = await client.request(
    methods.client.session.requestPermission,
    {
      options: options.map(stripCoreIndex),
      sessionId,
      toolCall: {
        kind: toolKindForName(request.toolName),
        rawInput: asRecord(request.input),
        status: "pending",
        title:
          request.reason !== undefined && request.reason.length > 0
            ? request.reason
            : request.toolName,
        toolCallId: String(request.toolCallId),
      },
    },
    signal ? { cancellationSignal: signal } : undefined,
  );
  return toBrokerResult(response, coreOptions);
}

function stripCoreIndex(
  option: PermissionOption & { _coreIndex: number },
): PermissionOption {
  return { kind: option.kind, name: option.name, optionId: option.optionId };
}

/** broker 请求只带 suggestedPermissionUpdates；据此还原 allow_always 选项。 */
function corePermissionOptions(request: PermissionBrokerRequest) {
  return [
    { kind: "allow_once" },
    ...(request.suggestedPermissionUpdates !== undefined
      ? [
          {
            kind: "allow_always",
            response: { permissionUpdates: request.suggestedPermissionUpdates },
          },
        ]
      : []),
    { kind: "deny" },
  ];
}

function toBrokerResult(
  response: RequestPermissionResponse,
  coreOptions: ReturnType<typeof corePermissionOptions>,
): PermissionBrokerResult {
  if (response.outcome.outcome === "cancelled") {
    return { decision: "deny", reason: "Permission request was cancelled" };
  }
  const result: AcpPermissionResult = permissionResultForAcpOption(
    coreOptions,
    response.outcome.optionId,
  );
  return result as PermissionBrokerResult;
}

async function askUserQuestion(
  client: AgentContext,
  sessionId: string,
  request: PermissionBrokerRequest,
  signal?: AbortSignal,
): Promise<PermissionBrokerResult> {
  const form = buildQuestionForm(request.input);
  if (form.questions.length === 0) {
    return { decision: "deny", reason: "AskUserQuestion input had no questions" };
  }
  const response = await client.request(
    methods.client.elicitation.create,
    {
      message: form.message,
      mode: "form",
      requestedSchema: form.requestedSchema,
      sessionId,
      ...(request.toolCallId ? { toolCallId: String(request.toolCallId) } : {}),
    },
    signal ? { cancellationSignal: signal } : undefined,
  );
  if (response.action === "accept") {
    return {
      decision: "modify",
      modifiedInput: {
        answers: answersFromElicitationContent(form.questions, asRecord(response.content)),
      },
    };
  }
  return {
    decision: "deny",
    reason: response.action === "cancel" ? "Question cancelled by user" : "Declined by user",
  };
}

async function approvePlan(
  client: AgentContext,
  sessionId: string,
  request: PermissionBrokerRequest,
  signal?: AbortSignal,
): Promise<PermissionBrokerResult> {
  const form = buildPlanApprovalForm(request.reason ?? "");
  const response = await client.request(
    methods.client.elicitation.create,
    {
      message: form.message,
      mode: "form",
      requestedSchema: form.requestedSchema,
      sessionId,
      ...(request.toolCallId ? { toolCallId: String(request.toolCallId) } : {}),
    },
    signal ? { cancellationSignal: signal } : undefined,
  );
  if (response.action === "accept") {
    return planApprovalResult(asRecord(response.content)) as PermissionBrokerResult;
  }
  return {
    decision: "deny",
    reason: response.action === "cancel" ? "Plan approval cancelled" : "Plan rejected by user",
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "aborted" || error.name === "AbortError";
}

export { coreModeToAcpMode };
export type { ContentBlock };
