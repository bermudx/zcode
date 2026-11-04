// `piz acp` 的 ACP v1 Agent 实现：把 ACP 会话/回合/权限/elicitation 全部映射到
// 共享 core 的 attach 协议（session/*、v4/command、interaction/* 反向请求）。
// 本进程不持有业务状态——会话事实在 core，这里只有 ACP↔wire 的纯映射。
//
// 形状约束（docs/design/v2/acp-frontend.md）：
// - session/new、session/resume、session/close（真实 stop）；不实现 session/load。
// - session/prompt、session/cancel、session/update（core raw 事件投影）。
// - cwd 是 per-session 的 → 每个 workspace 一条惰性 core 连接（AcpCoreBridge）。
// - 权限走 session/request_permission，应答 = core option.response 原文。
// - AskUserQuestion 走 form elicitation（string enum；multiSelect 降级为键入文本）；
//   ExitPlanMode 走 approve/reject elicitation——Auto/Full 不能静默批准计划。
// - 暴露 plan 模式、模型选项与 GLM 压缩上限。
// - 客户端给的 MCP servers 由 core 承载，这里忽略并记录日志。
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "@zcode/contracts";
import {
  zcodePermissionRequestParamsSchema,
  zcodeProtocolMethods,
  zcodeUserInputRequestParamsSchema,
  type ZCodePermissionRequestParams,
  type ZCodeSessionRawEvent,
  type ZCodeUserInputRequestParams,
} from "@zcode/shared";
import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { newCommandId, sendTextCommand, stopCommand } from "../attach-v4-command.js";
import { resolveCompactContextWindowForModel } from "../attach-compact-cap.js";
import {
  AcpCoreBridge,
  toCoreWorkspaceRef,
  type AcpLogger,
  type CoreWorkspaceRef,
} from "./acp-core-bridge.js";

const PLAN_MODE_ID = "plan";
const BUILD_MODE_ID = "build";
const AVAILABLE_MODES = [
  { id: PLAN_MODE_ID, name: "Plan", description: "Research and plan without editing files" },
  { id: BUILD_MODE_ID, name: "Build", description: "Full access with per-action approval" },
];

const TURN_END = new Set(["turn_complete", "turn_error"]);

type ModelSelectionLike = { providerId?: string; modelId?: string };

interface AcpSessionState {
  acpSessionId: string;
  coreSessionId: string;
  workspace: CoreWorkspaceRef;
  client: import("../attach-client.js").AttachClient;
  currentMode: string;
  currentModel: ModelSelectionLike | undefined;
  availableModels: Array<{ ref?: ModelSelectionLike; name?: string }>;
  /** 当前回合的取消控制：session/cancel 与 session/close 共用。 */
  turnAbort: AbortController | undefined;
  turnWaiters: Set<{ resolve: (stopReason: string) => void }>;
  closed: boolean;
}

const modelRefOf = (current: ModelSelectionLike | undefined): string => {
  if (!current) return "";
  return current.providerId && current.modelId
    ? `${current.providerId}/${current.modelId}`
    : (current.modelId ?? "");
};

export interface AcpAgentOptions {
  bridge: AcpCoreBridge;
  connection: AgentSideConnection;
  version: string;
  env?: NodeJS.ProcessEnv;
  logger?: AcpLogger;
}

export function createAcpAgent(options: AcpAgentOptions): Agent {
  const { bridge, connection } = options;
  const sessions = new Map<string, AcpSessionState>();

  const sendUpdate = (sessionId: string, update: SessionNotification["update"]): Promise<void> =>
    connection.sessionUpdate({ sessionId, update });

  /** core raw 事件 → ACP session/update 投影（只映射 ACP v1 稳定更新子集）。 */
  const projectRawEvent = (state: AcpSessionState, raw: ZCodeSessionRawEvent): void => {
    const payload = (raw.payload ?? {}) as Record<string, unknown>;
    if (raw.type === "model.streaming") {
      const kind = payload.kind;
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if (kind === "text_delta" && delta) {
        void sendUpdate(state.acpSessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: delta },
        });
      } else if (kind === "reasoning_delta" && delta) {
        void sendUpdate(state.acpSessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: delta },
        });
      }
      return;
    }
    if (raw.type === "tool.updated") {
      const kind = payload.kind;
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
      if (!toolCallId) return;
      const title =
        typeof payload.description === "string"
          ? payload.description
          : typeof payload.toolName === "string"
            ? payload.toolName
            : "Tool call";
      if (kind === "scheduled") {
        void sendUpdate(state.acpSessionId, {
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          status: "pending",
          rawInput: payload.input,
        });
      } else if (kind === "started") {
        void sendUpdate(state.acpSessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
        });
      } else if (kind === "result") {
        const result = payload.result as Record<string, unknown> | undefined;
        const output =
          typeof result?.output === "string" ? result.output : JSON.stringify(result ?? {});
        void sendUpdate(state.acpSessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: output } }],
          rawOutput: result,
        });
      } else if (kind === "error") {
        void sendUpdate(state.acpSessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
        });
      }
      return;
    }
    if (raw.type === "session_mode_changed") {
      const mode = payload.mode;
      if (typeof mode === "string") {
        state.currentMode = mode;
        void sendUpdate(state.acpSessionId, {
          sessionUpdate: "current_mode_update",
          currentModeId: mode,
        });
      }
      return;
    }
    if (TURN_END.has(raw.type)) {
      const cancelled = state.turnAbort?.signal.aborted === true;
      for (const waiter of state.turnWaiters) {
        state.turnWaiters.delete(waiter);
        waiter.resolve(
          raw.type === "turn_error" ? (cancelled ? "cancelled" : "refusal") : cancelled ? "cancelled" : "end_turn",
        );
      }
    }
  };

  /** interaction/requestPermission → ACP session/request_permission；应答回 core option.response 原文。 */
  const handlePermissionReverseRequest = async (
    state: AcpSessionState,
    params: ZCodePermissionRequestParams,
  ): Promise<unknown> => {
    const outcome = await connection.requestPermission({
      sessionId: state.acpSessionId,
      toolCall: {
        toolCallId: params.toolCallId,
        title: params.toolName,
        status: "pending",
        rawInput: params.input,
      },
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind:
          option.kind === "allow_always"
            ? "allow_always"
            : option.kind === "deny"
              ? "reject_once"
              : "allow_once",
      })),
    });
    const decision = outcome.outcome;
    if (decision.outcome === "cancelled") {
      const deny = params.options.find((option) => option.kind === "deny");
      return deny?.response ?? { decision: "deny", reason: "cancelled by client" };
    }
    const selected = params.options.find(
      (option) => option.optionId === (decision as { optionId: string }).optionId,
    );
    // core 的 option.response 是权威应答（含服务端算好的 permissionUpdates），原样回传。
    return selected?.response ?? { decision: "deny", reason: "unknown permission option" };
  };

  /** AskUserQuestion → form elicitation（string enum；multiSelect 降级为键入文本）。 */
  const handleAskUserQuestion = async (
    state: AcpSessionState,
    params: ZCodeUserInputRequestParams,
  ): Promise<unknown> => {
    const questions = params.questions ?? [];
    if (questions.length === 0) return { action: "decline", reason: "no questions" };
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [index, question] of questions.entries()) {
      const key = question.header || `question_${index}`;
      properties[key] = {
        type: "string",
        description: question.question,
        // multiSelect 在 ACP form 里没有数组枚举形态，统一按键入文本收集。
        ...(question.multiSelect !== true
          ? { enum: question.options.map((option) => option.value) }
          : {}),
      };
      required.push(key);
    }
    const response = await connection.unstable_createElicitation({
      mode: "form",
      sessionId: state.acpSessionId,
      message: params.prompt ?? "The agent needs your input",
      requestedSchema: { type: "object", properties: properties as never, required },
    });
    if (response.action !== "accept") {
      return { action: "decline", reason: `elicitation ${response.action}` };
    }
    const content = (response as { content?: Record<string, unknown> }).content ?? {};
    return { action: "accept", content: { answers: content } };
  };

  /** ExitPlanMode → approve/reject elicitation；批准才 accept，拒绝 decline。 */
  const handlePlanApproval = async (
    state: AcpSessionState,
    params: ZCodeUserInputRequestParams,
  ): Promise<unknown> => {
    const response = await connection.unstable_createElicitation({
      mode: "form",
      sessionId: state.acpSessionId,
      message: params.prompt ?? "Approve the plan?",
      requestedSchema: {
        type: "object",
        properties: { decision: { type: "string", enum: ["approve", "reject"] } },
        required: ["decision"],
      },
    });
    if (response.action !== "accept") return { action: "decline" };
    const content = (response as { content?: Record<string, unknown> }).content ?? {};
    if (content.decision === "approve") {
      return { action: "accept", content: { answer: "approve" } };
    }
    return { action: "decline", reason: "plan rejected" };
  };

  const handleUserInputReverseRequest = async (
    state: AcpSessionState,
    params: ZCodeUserInputRequestParams,
  ): Promise<unknown> => {
    const schema = (params.schema ?? {}) as Record<string, unknown>;
    const toolName =
      params.toolName ??
      (typeof schema.toolName === "string" ? (schema.toolName as string) : undefined);
    if (toolName === ASK_USER_QUESTION_TOOL_NAME || Array.isArray(params.questions)) {
      return handleAskUserQuestion(state, params);
    }
    if (toolName === EXIT_PLAN_MODE_TOOL_NAME || schema.interaction === "plan_approval") {
      return handlePlanApproval(state, params);
    }
    // 未知 elicitation 种类（如 MCP elicitation）如实 decline，不冒充用户输入。
    return { action: "decline", reason: `unsupported elicitation: ${toolName ?? "unknown"}` };
  };

  const onReverseRequest = async (
    sessionId: string,
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    const state = sessions.get(sessionId);
    if (!state) throw new Error(`unknown session: ${sessionId}`);
    if (method === zcodeProtocolMethods.interactionRequestPermission) {
      const parsed = zcodePermissionRequestParamsSchema.safeParse(params);
      if (!parsed.success) throw new Error("invalid permission request params");
      return handlePermissionReverseRequest(state, parsed.data);
    }
    if (method === zcodeProtocolMethods.interactionRequestUserInput) {
      const parsed = zcodeUserInputRequestParamsSchema.safeParse(params);
      if (!parsed.success) throw new Error("invalid user input request params");
      return handleUserInputReverseRequest(state, parsed.data);
    }
    const error = new Error(`method not found: ${method}`) as Error & { code: number };
    error.code = -32601;
    throw error;
  };

  /** 建立 core session → ACP session 的状态并绑定桥上的处理口。 */
  const openCoreSession = async (
    workspace: CoreWorkspaceRef,
    coreSessionId: string,
    snapshot: unknown,
  ): Promise<AcpSessionState> => {
    const client = await bridge.ensureClient(workspace);
    // 快照按 settings 子树宽松读取：core 协议新增字段不应让 ACP 面整体降级。
    const root = (snapshot ?? {}) as { settings?: Record<string, unknown> };
    const settings = (root.settings ?? {}) as {
      model?: { current?: ModelSelectionLike; available?: AcpSessionState["availableModels"] };
      mode?: { current?: string };
    };
    const state: AcpSessionState = {
      acpSessionId: coreSessionId,
      coreSessionId,
      workspace,
      client,
      currentMode: settings.mode?.current ?? BUILD_MODE_ID,
      currentModel: settings.model?.current,
      availableModels: settings.model?.available ?? [],
      turnAbort: undefined,
      turnWaiters: new Set(),
      closed: false,
    };
    sessions.set(coreSessionId, state);
    bridge.bindSession(workspace, coreSessionId, {
      onReverseRequest: (method, params) => onReverseRequest(coreSessionId, method, params),
      onRawEvent: (raw) => {
        const current = sessions.get(coreSessionId);
        if (current) projectRawEvent(current, raw);
      },
    });
    await client.request(zcodeProtocolMethods.sessionSubscribe, {
      deliveryKind: "desktop-continuous",
      eventFormat: "raw",
      includeSnapshot: true,
      sessionId: coreSessionId,
    });
    await syncCompactCap(state);
    return state;
  };

  /** GLM 模型的压缩窗口上限随会话/模型下发到 core（262K），其余清除。 */
  const syncCompactCap = async (state: AcpSessionState): Promise<void> => {
    try {
      await state.client.request(zcodeProtocolMethods.sessionSetCompactContextWindow, {
        compactContextWindow:
          resolveCompactContextWindowForModel(state.currentModel?.modelId) ?? null,
        sessionId: state.coreSessionId,
      });
    } catch {
      // 旧 core 没有该方法时静默跳过；ACP 面不阻断。
    }
  };

  const modesState = (state: AcpSessionState) => ({
    availableModes: AVAILABLE_MODES,
    currentModeId: state.currentMode,
  });

  const modelsState = (state: AcpSessionState) => ({
    availableModels: state.availableModels
      .map((option) => {
        const ref = modelRefOf(option.ref);
        return ref ? { modelId: ref, name: option.name ?? ref } : undefined;
      })
      .filter((model): model is { modelId: string; name: string } => model !== undefined),
    currentModelId: modelRefOf(state.currentModel),
  });

  return {
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "piz", title: "piz (ZCode attach)", version: options.version },
        agentCapabilities: {
          loadSession: false,
          mcpCapabilities: {},
          promptCapabilities: { audio: false, embeddedContext: false, image: false },
          sessionCapabilities: { close: {}, resume: {} },
        },
      };
    },

    async authenticate() {
      // 认证不在 ACP 内完成：沿用既有 piz login（进程外），这里直接放行。
      return {};
    },

    async newSession(params) {
      const workspace = toCoreWorkspaceRef(params.cwd, options.env ?? process.env);
      if (params.mcpServers.length > 0) {
        // MCP 由共享 core 承载；客户端列出的 server 在此忽略并留痕。
        options.logger?.info?.("acp: ignoring client-provided MCP servers (core-owned)", {
          count: params.mcpServers.length,
          cwd: params.cwd,
        });
      }
      const client = await bridge.ensureClient(workspace);
      const created = (await client.request(zcodeProtocolMethods.sessionCreate, {
        persistence: "immediate",
        workspace,
      })) as { session: { sessionId: string }; snapshot?: unknown };
      const state = await openCoreSession(workspace, created.session.sessionId, created.snapshot);
      return {
        sessionId: state.acpSessionId,
        modes: modesState(state),
        models: modelsState(state),
      };
    },

    async resumeSession(params) {
      const workspace = toCoreWorkspaceRef(params.cwd, options.env ?? process.env);
      const client = await bridge.ensureClient(workspace);
      const resumed = (await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId: params.sessionId,
        workspace,
      })) as { sessionId?: string; snapshot?: unknown };
      const coreSessionId = resumed.sessionId ?? params.sessionId;
      const state = await openCoreSession(workspace, coreSessionId, resumed.snapshot);
      return {
        sessionId: state.acpSessionId,
        modes: modesState(state),
        models: modelsState(state),
      };
    },

    async closeSession(params) {
      const state = sessions.get(params.sessionId);
      if (!state || state.closed) return {};
      state.closed = true;
      // close = 真实 stop：先停前台回合，再关 core session。
      state.turnAbort?.abort();
      try {
        await stopCommand(state.client, { sessionId: state.coreSessionId });
      } catch {
        // 尽力而为：core 已掉线时 close 不能被 stop 阻塞。
      }
      try {
        await state.client.request(zcodeProtocolMethods.sessionClose, {
          sessionId: state.coreSessionId,
        });
      } finally {
        sessions.delete(params.sessionId);
        bridge.detachSession(state.workspace.workspaceKey, state.coreSessionId);
      }
      return {};
    },

    async setSessionMode(params) {
      const state = sessions.get(params.sessionId);
      if (!state) throw new Error(`unknown session: ${params.sessionId}`);
      const result = (await state.client.request(zcodeProtocolMethods.sessionSetMode, {
        mode: params.modeId,
        sessionId: state.coreSessionId,
      })) as { mode?: string; snapshot?: { settings?: { mode?: { current?: string } } } };
      const mode = result.snapshot?.settings?.mode?.current ?? result.mode ?? params.modeId;
      state.currentMode = mode;
      await sendUpdate(params.sessionId, {
        sessionUpdate: "current_mode_update",
        currentModeId: mode,
      });
      return {};
    },

    async unstable_setSessionModel(params) {
      const state = sessions.get(params.sessionId);
      if (!state) throw new Error(`unknown session: ${params.sessionId}`);
      const match = state.availableModels.find(
        (option) => modelRefOf(option.ref) === params.modelId,
      );
      const selection = (match?.ref ?? { modelId: params.modelId }) as ModelSelectionLike;
      await state.client.request(zcodeProtocolMethods.sessionSetModel, {
        model: selection,
        sessionId: state.coreSessionId,
      });
      state.currentModel = selection;
      // GLM 压缩上限跟随当前模型。
      await syncCompactCap(state);
      return {};
    },

    async prompt(params) {
      const state = sessions.get(params.sessionId);
      if (!state) throw new Error(`unknown session: ${params.sessionId}`);
      if (state.closed) throw new Error(`session closed: ${params.sessionId}`);
      const text = params.prompt
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter((part) => part.length > 0)
        .join("\n");
      if (!text.trim()) throw new Error("prompt has no text content");
      state.turnAbort?.abort();
      const abort = new AbortController();
      state.turnAbort = abort;
      const turnDone = new Promise<string>((resolve) => {
        state.turnWaiters.add({ resolve });
      });
      await sendTextCommand(state.client, {
        commandId: newCommandId(),
        payload: { heldQueueDisposition: "keepQueueAndSend", text },
        sessionId: state.coreSessionId,
      });
      try {
        const stopReason = await turnDone;
        return { stopReason: stopReason as never };
      } finally {
        for (const waiter of state.turnWaiters) state.turnWaiters.delete(waiter);
        if (state.turnAbort === abort) state.turnAbort = undefined;
      }
    },

    async cancel(params) {
      const state = sessions.get(params.sessionId);
      if (!state) return;
      state.turnAbort?.abort();
      try {
        await stopCommand(state.client, { sessionId: state.coreSessionId });
      } catch {
        // core 已不可达时 cancel 仍要让本地 prompt 以 cancelled 收口。
      }
    },
  };
}
