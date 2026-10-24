import {
  createRootTraceContext,
  createTraceId,
  type Logger,
  type LoggerFactory,
  type McpPort,
  type SessionEventStorePort,
  type SessionId,
  type SessionTaskType,
  type SessionStorePort,
  type TraceContext,
} from "@zcode/contracts";
import type { McpTelemetryTracker } from "@zcode/adapters";
import type { ProviderRuntimeHeadersPort, WorkspaceHookPolicyProvider } from "@zcode/core";
import type { AccountProviderConfigSnapshot } from "@zcode/provider";
import {
  zcodeProtocolErrorCodes,
  type AppToolSearchMode,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeDeliveryKind,
  type ZCodeSessionEventFormat,
  type ModelSelection,
  type ZCodeModelContextBudgetStrategy,
  type ZCodeProtocolMessage,
  type ZCodeProtocolMethod,
  type ZCodeProtocolNotification,
  type ZCodeProtocolRequest,
  type ZCodeProtocolRequestId,
  type ZCodeProtocolTrace,
  type ZCodeSessionMode,
  type ZCodeSessionPersistence,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeApp, ZCodeAppOptions } from "../app/types.js";
import type { V4InteractionRegistry } from "../zcode-protocol-v4/interaction-registry.js";
import type { ConversationV4Gateway } from "../zcode-protocol-v4/v4-gateway.js";
import type { SessionResidentPool, SessionResidentPoolOptions } from "./session-resident-pool.js";
import type { DynamicWorkflowMode } from "@zcode/shared";

export interface ParamsSchema<T> {
  parse(input: unknown): T;
}

export interface ZCodeProtocolAgentDependencies {
  createZCodeApp(options?: Omit<ZCodeAppOptions, "providerRegistry">): ZCodeApp | Promise<ZCodeApp>;
  /**
   * 每个 session record 的内存 event store 工厂。
   * 默认 turn 窗口保留策略；测试可注入 spy 或 unbounded 实现做对照。
   */
  createSessionEventStore?(sessionId: string): SessionEventStorePort;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  loggerFactory?: LoggerFactory;
  mcpPort?: McpPort;
  /** 资源管理器：`process/childProcesses` 读取 MCP 子进程 pid 与插件归属 */
  mcpTelemetry?: Pick<McpTelemetryTracker, "listProcesses">;
  platform?: NodeJS.Platform | string;
  /** 仅用于构造单个 CLI/app-server 的混合 resident 策略；生产默认值由 pool 定义。 */
  sessionResidentPoolOptions?: SessionResidentPoolOptions;
  /** 兼容旧测试/嵌入调用；新代码应通过 sessionResidentPoolOptions 设置 low-water。 */
  sessionResidentTargetCount?: number;
  sessionStore?: SessionStorePort;
  version?: string;
  /** 受信 Host 管理的 Hook policy；workspace/project 配置不得覆盖。 */
  workspaceHookPolicyProvider?: WorkspaceHookPolicyProvider;
  /** 把 Host 账号状态形成的第三层 Config Overlay 同步给进程 Registry。 */
  syncAccountProviderConfig?: (snapshot: AccountProviderConfigSnapshot) => Promise<boolean>;
  /**
   * 进程级 session 归属索引：定位仍常驻在某 detached（断线）连接 server 上的
   * session record，供 session/resume / requireSession 收养。attached 中的
   * owner 不返回——活的 owner 连接保持对会话的排他权。
   */
  locateSessionOwner?(sessionId: string): ZCodeProtocolDetachedSessionOwner | undefined;
  /**
   * 进程级凭据鉴权端口（standalone 账号面自带）。
   * 存在时优先于按 workspace 回环 Host 的默认端口；socket core 没有能应答
   * interactionRequestProviderRuntimeHeaders 的 Host，必须由它签名模型请求。
   */
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  /** 连接测试前主动重读当前进程的 Config Source 并等待 Registry 发布。 */
  refreshProviderRegistry?: (reason: string) => Promise<void>;
}

export type ZCodeProtocolAgentResolvedDependencies = ZCodeProtocolAgentDependencies & {
  createSessionEventStore(sessionId: string): SessionEventStorePort;
  workspaceHookPolicyProvider: WorkspaceHookPolicyProvider;
};

export interface ZCodeProtocolEventSequenceState {
  lastSeq: number;
  seqBySourceEventKey: Map<string, number>;
}

export interface ZCodeProtocolToolInputTransmissionState {
  streamedToolCallIdsWithInput: Set<string>;
}

export interface ZCodeProtocolSessionRecord {
  app: ZCodeApp;
  /**
   * 会话的当前协议 owner context：物化时指向创建方 context；客户端断线后由
   * 新连接收养（session/resume / requireSession 路径）时改挂新 owner。
   * onSessionEvent 等事件扇出必须经它取 context，不能用物化闭包里的旧 context，
   * 否则收养后事件仍落在死连接上。
   */
  ownerContext?: ZCodeProtocolAgentServerContext;
  subagentRuntimeConfigEnabled?: boolean;
  memoryEnabled: boolean;
  nativeSearchEnhancementsEnabled: boolean;
  toolSearchMode: AppToolSearchMode;
  modelContextBudgetStrategy: ZCodeModelContextBudgetStrategy;
  createdAt: number;
  deliveryKind?: ZCodeDeliveryKind;
  /**
   * 订阅事件格式（session/subscribe eventFormat）："mapped" 走既有折叠映射，
   * "raw" 把 contracts SessionEvent 原样下投给 session/rawEvent（tui-attach 瘦客户端）。
   * record 级与 deliveryKind 同一语义：同 record 只持一种格式，后写覆盖。
   */
  eventFormat?: ZCodeSessionEventFormat;
  /**
   * 旧 session/subscribe 没有 unsubscribe RPC；只在真正 subscribe 时置位，不能用
   * 会被 session/read 写入的 deliveryKind 代替。连接结束会销毁整个 CLI 进程。
   */
  legacyStreamSubscribed?: boolean;
  eventStore: SessionEventStorePort;
  parentSessionId?: SessionId;
  persistence: ZCodeSessionPersistence;
  protocolEventSequences: Map<string, ZCodeProtocolEventSequenceState>;
  protocolToolInputTransmissions: Map<string, ZCodeProtocolToolInputTransmissionState>;
  stateRevision: number;
  taskType?: SessionTaskType;
  traceContext: TraceContext;
  unsubscribe?: () => void;
  updatedAt: number;
  lastOutcome?: "completed" | "interrupted" | "error";
  workspace: ZCodeWorkspaceRef;
  activeAbortController?: AbortController;
  /** background runner 释放 ready lock 后，持久化/snapshot/broadcast 尚未完成的引用计数。 */
  residencyFinalizationCount?: number;
  /** 当前正在执行的 automation 派发 turn；只在 turn 运行期间存在，禁止递归 CronCreate。 */
  activeAutomationId?: string;
  /** 当前正在执行的闲时派发 turn；只在 turn 运行期间存在，禁止递归 OffPeakCreate。 */
  activeOffPeakTaskId?: string;
  /** 当前 Bot 入站 turn 的稳定回推地址；只允许 CronCreate 在本轮读取。 */
  activeBotDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  restoreWarning?: { message: string; type: string };
  /** 冷恢复候选只供初始投影；新的选模事件立即清除，不能替代 Runtime 执行绑定。 */
  restoredModelSelection?: ModelSelection;
}

export interface ZCodeProtocolClientRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  trace?: ZCodeProtocolTrace;
  reannounceIntervalMs?: number;
  /**
   * owner 客户端已断开、无 sink 可投递时的挂起上限；超时按 timedOut 拒绝，
   * 让孤儿会话上的交互请求最终如实失败，而不是永久挂住一次 turn。
   * 缺省用 server 的 DETACHED_CLIENT_REQUEST_TIMEOUT_MS。
   */
  detachedTimeoutMs?: number;
}

/**
 * server → client 反向请求的在途条目。owner 可变：会话被新连接收养时，
 * 该 session 的 pending 请求整体迁移到新 server，由新 sink 续发。
 */
export interface ZCodeProtocolPendingClientRequest<T = unknown> {
  active: boolean;
  method: string;
  owner: ZCodeProtocolSessionMigrationTarget;
  params: unknown;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
  resultSchema: ParamsSchema<T>;
  requestKeys: Set<string>;
  /** 收养迁移时的会话过滤键；非会话请求恒为 undefined，只随 owner 存活/超时。 */
  sessionId?: string;
  signal?: AbortSignal;
  detachedTimeoutMs?: number;
  detachedTimer?: ReturnType<typeof setTimeout>;
  timeout?: ReturnType<typeof setTimeout>;
  reannounceTimer?: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
  trace?: ZCodeProtocolTrace;
}

/**
 * 迁出方对收养方暴露的最小面：接手 pending 反向请求、会话 redirect、app 资源登记。
 * 具体实现就是 ZCodeProtocolAgentServer；接口独立出来让 server-operations/context
 * 不依赖 server 类本身。
 */
export interface ZCodeProtocolSessionMigrationTarget {
  /** 在 owner sink 上投递（或重新登记）一条 pending 反向请求；无 sink 时转 park。 */
  deliverPendingClientRequest(pending: ZCodeProtocolPendingClientRequest): void;
  /** 反向请求入口（含自身的 owner redirect 判定）；迁出方把迟到的请求重定向到这里。 */
  requestClient<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T>;
  /** 按 pending.owner 归属清理 keys/parked 登记与计时器。 */
  discardPendingClientRequest(pending: ZCodeProtocolPendingClientRequest): void;
}

/**
 * 断线（detached）owner server 对收养流程暴露的最小面。
 * locateSessionOwner 只返回 detached owner；仍连着 client 的 owner 不可被抢。
 */
export interface ZCodeProtocolDetachedSessionOwner {
  /** 等该 session 在旧 owner resident pool 上的 in-flight 去激活收尾。 */
  awaitSessionDeactivation(sessionId: string): Promise<void>;
  /**
   * 原子转出：摘除 record、登记 redirect、迁移该 session 的 pending 反向请求、
   * 释放 app 资源登记。deactivation in-flight 或无 record 时返回 undefined。
   */
  claimSessionRecord(
    sessionId: string,
    newOwner: ZCodeProtocolSessionMigrationTarget,
  ): ZCodeProtocolSessionRecord | undefined;
}

export interface ZCodeProtocolAgentServerContext {
  /** 进程退出期间，迟到的异步物化不能重新登记 session。 */
  assertServing?: () => void;
  deps: ZCodeProtocolAgentResolvedDependencies;
  logger?: Logger;
  appRuntimePreferences: {
    askUserQuestionAutoResolutionEnabled: boolean;
    modelIoFullRetentionEnabled: boolean;
    /** host 同步的 Off-Peak 工具面门禁；缺省 false（fail-closed），供 v4 冷恢复等无 host 参数的路径读取。 */
    offPeakToolEnabled: boolean;
    /**
     * host 同步的动态工作流灰度门。
     * 缺省 false（fail-closed）：不认识该方法的旧 Host 或还没来得及同步的启动窗口里，
     * 工作流工具面、`/workflow` 与 dynamic-workflows 技能一律不露出。
     */
    dynamicWorkflowEnabled: boolean;
    /**
     * 与 dynamicWorkflowEnabled 同行到达的灰度 mode（launch.md「On demand: activation」）。
     * 缺席（旧 Host 只发布尔）= alwaysOn；`onDemand` 让 createRecord 写 runtimeConfig.dynamicWorkflowToolsOnDemand。
     */
    dynamicWorkflowMode?: DynamicWorkflowMode;
  };
  // 竖切：v4 conversation 通道（订阅/帧/命令），与旧 session/* 方法并存。
  // 构造顺序问题（gateway 闭包持有 context）用可选字段收口，server 构造完立即赋值。
  v4Gateway?: ConversationV4Gateway;
  // v4 前向命令 resolveInteraction 与反向请求（permission/AskUserQuestion）的汇合点。
  // broker 注册 deferred、v4 命令面投递应答（同一实例经 binder 注入 V4CommandCoreHost）。
  v4Interactions: V4InteractionRegistry;
  // 单 CLI resident session 池。冷恢复入口经 waitForDeactivation 等待旧 app.close 收尾，
  // 协议请求则持有 operation lease，禁止异步 handler 与容量回收交错。
  sessionResidentPool?: SessionResidentPool;
  sessions: Map<string, ZCodeProtocolSessionRecord>;
  /**
   * 已转出（被收养）的 session record 只读回查：claimSessionRecord 摘除后
   * record 对象仍存在于新 owner——browser/elicitation 等端口的反向请求构造
   * 只需 workspace/trace 事实，不应因本地 sessions miss 而 -32009/decline。
   */
  claimedSessionRecords?: Map<string, ZCodeProtocolSessionRecord>;
  /**
   * 同步收养尝试：session 常驻在某 detached owner 时转出到本 context。
   * 旧 owner 上 deactivation in-flight 的会话直接放弃（requireSession 等同步路径
   * 不能 await，调用方应回落到 adoptDetachedSession）。
   */
  claimDetachedSession?(sessionId: string): boolean;
  /**
   * 异步收养：先等旧 owner 的去激活收尾再转出。session/resume 等异步入口
   * 必须走这条，避免把正在 app.close 的半死 record 挂给新 owner。
   */
  adoptDetachedSession?(sessionId: string): Promise<boolean>;
  /** 仅覆盖异步创建窗口，结束即释放；输入命令仍由 CommandInbox 排队。 */
  sessionCreationIds?: Set<string>;
  notify(notification: ZCodeProtocolNotification): void;
  requestClient<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T>;
}

/** server → client 请求失败的协议错误码；server.ts 抛出，适配层按码翻译，不在业务逻辑中散落字面量。 */
export const PROTOCOL_CLIENT_REQUEST_ERROR_CODES = {
  /** 没有 ZCode Protocol client 挂载，无法投递请求。 */
  noClientAttached: -32020,
  /** 请求在收到应答前被取消。 */
  cancelled: -32021,
  /** 请求等待应答超时。 */
  timedOut: -32022,
} as const;

export class ProtocolRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ProtocolRequestError";
  }
}

export function isRequest(message: ZCodeProtocolMessage): message is ZCodeProtocolRequest {
  return "method" in message && "id" in message;
}

export function isNotification(
  message: ZCodeProtocolMessage,
): message is ZCodeProtocolNotification {
  return "method" in message && !("id" in message);
}

export function isResponse(
  message: ZCodeProtocolMessage,
): message is { id: ZCodeProtocolRequestId; result: unknown } {
  return "id" in message && "result" in message;
}

export function isErrorResponse(message: ZCodeProtocolMessage): message is {
  id: ZCodeProtocolRequestId;
  error: { code: number; message: string; data?: unknown };
} {
  return "id" in message && "error" in message;
}

/**
 * 从 zod（或类 zod）校验错误里提炼可读的字段级摘要，附到 "Invalid params" 消息里。
 * 原来只回 "Invalid params" 不说哪个字段错，模型（如 browser evaluate 误传函数、
 * 坐标为 NaN 等）无从自纠、会反复瞎试。这里用鸭子类型读 ZodError.issues（不引 zod 依赖），
 * 拼成 `expression: Expected string, received function` 这类可操作提示。
 */
function summarizeParamsError(error: unknown): string | undefined {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return undefined;
  }
  const parts = issues.slice(0, 5).map((issue) => {
    const path =
      Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message ?? "invalid"}`;
  });
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : "";
  return parts.join("; ") + more;
}

export function parseParams<T>(schema: ParamsSchema<T>, params: unknown): T {
  try {
    return schema.parse(params);
  } catch (error) {
    const detail = summarizeParamsError(error);
    throw new ProtocolRequestError(
      -32602,
      detail ? `Invalid params — ${detail}` : "Invalid params",
      error,
    );
  }
}

export function assertExpectedRevision(
  record: ZCodeProtocolSessionRecord,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision !== undefined && expectedRevision !== record.stateRevision) {
    throw new ProtocolRequestError(-32009, "Session state revision mismatch", {
      actualRevision: record.stateRevision,
      expectedRevision,
    });
  }
}

export function toProtocolError(error: unknown): {
  code: number;
  data?: unknown;
  message: string;
} {
  if (error instanceof ProtocolRequestError) {
    return { code: error.code, data: error.data, message: error.message };
  }
  if (error instanceof Error) {
    const businessCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return {
      code: -32603,
      // ModelProtocolError 等业务错误的 code 需要跨 JSON-RPC 保留给 UI。
      // 外层仍是 JSON-RPC internal error，稳定业务 code 放在 data.code 供横幅本地化。
      // 不透传 error.context：上游上下文不保证 JSON-safe，错误响应不能因诊断信息二次失败。
      data: {
        name: error.name,
        stack: error.stack,
        ...(businessCode ? { code: businessCode } : {}),
      },
      message: error.message,
    };
  }
  return {
    code: -32603,
    message: String(error),
  };
}

export function createProtocolTraceId(_sessionId: SessionId): TraceContext["traceId"] {
  // Bugfix: traceId 是 session 之上的观测链路，不应由 sessionId 拼出来。
  // 这里复用 agent/contracts 的 UUID 算法，保证 app 和 agent 两端 trace 格式一致。
  return createTraceId();
}

export function createProtocolRootTraceContext(
  sessionId: SessionId,
  trace?: ZCodeProtocolTrace,
): TraceContext {
  const context = createRootTraceContext({
    sessionId,
    traceId: (trace?.traceId ?? createProtocolTraceId(sessionId)) as TraceContext["traceId"],
  });
  if (trace?.spanId) {
    context.spanId = trace.spanId;
  }
  if (trace?.parentId) {
    context.parentId = trace.parentId;
    context.parentSpanId = trace.parentId;
  }
  return context;
}

export function protocolTraceFromTraceContext(context: TraceContext): ZCodeProtocolTrace {
  return {
    traceId: context.traceId,
    ...(context.spanId ? { spanId: context.spanId } : {}),
    ...((context.parentId ?? context.parentSpanId)
      ? { parentId: context.parentId ?? context.parentSpanId }
      : {}),
  };
}

export function requireSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  options: { deliveryKind?: ZCodeDeliveryKind; operation?: string } = {},
): ZCodeProtocolSessionRecord {
  let record = context.sessions.get(sessionId);
  if (!record && context.claimDetachedSession?.(sessionId)) {
    record = context.sessions.get(sessionId);
  }
  if (!record) {
    // 诊断：readSession 只读取活跃 runtime；记录缺失时要区分“冷会话尚未恢复”和“ID 已失效”，
    // 不能只留下相同的错误文本，否则无法判断 UI 是读早了还是 task index 带来了脏引用。
    context.logger?.warn("ZCode Protocol session runtime missing", {
      activeSessionCount: context.sessions.size,
      event: "zcode_protocol.session.require_missing",
      hasSessionStore: Boolean(context.deps.sessionStore),
      module: "bootstrap.zcode_protocol",
      operation: options.operation ?? "unknown",
      ...(options.deliveryKind ? { deliveryKind: options.deliveryKind } : {}),
      sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session is not active: ${sessionId}`,
    );
  }
  return record;
}

export function createProtocolLogger(deps: ZCodeProtocolAgentDependencies): Logger | undefined {
  return deps.loggerFactory?.createLogger("zcode").child({
    module: "bootstrap.zcode_protocol",
  });
}
