// attach 运行时：持有 socket client、会话句柄注册表与断线重连状态机。
// TuiPromptHandler 与 CommandCenterApp 是同一层的两面——提交/输入走 commandCenter
// 的 slash 路由（client 侧），业务事实全部在 core。
import type { SessionEvent } from "@zcode/contracts";
import {
  zcodePermissionRequestParamsSchema,
  zcodeProtocolErrorCodes,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeSessionListResultSchema,
  zcodeUserInputRequestParamsSchema,
  type ZCodeSessionRawEvent,
} from "@zcode/shared";
import { getZCodeCopy, type TuiCopy } from "@zcode/i18n";
import type { PermissionBrokerResult } from "@zcode/contracts";
import {
  brokerResultToPermissionResponse,
  brokerResultToUserInputResponse,
  permissionParamsToBrokerRequest,
  userInputParamsToBrokerRequest,
} from "./attach-interactions.js";
import type {
  TuiPromptInput,
  TuiSubmitPromptResult,
} from "@zcode/tui";
import { connectAttachClient, AttachProtocolError, type AttachClient } from "./attach-client.js";
import { AttachSessionHandle, asCommandCenterApp } from "./attach-session.js";
import { listAttachSkillCatalog, toCommandCenterSkillList } from "./attach-skills.js";
import { listAttachCommandCatalog, toCommandCenterCustomCommandList } from "./attach-commands.js";
import type {
  CommandCenterApp,
  CommandCenterDeps,
  CommandCenterSession,
} from "../command-center.js";
import { createCommandCenter, parseSlashCommand } from "../command-center.js";
import type { TuiPromptHandler } from "../tui-command-state.js";

const RECONNECT_BACKOFF_START_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const CONNECTION_LOST_TYPE = "session_notice";
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const NO_INTERACTION_HANDLER_PERMISSION_RESPONSE = {
  decision: "deny",
  reason: "no interactive permission handler",
} as const;
const NO_INTERACTION_HANDLER_USER_INPUT_RESPONSE = {
  action: "decline",
  reason: "no interactive user-input handler",
} as const;

export type AttachRuntimeLogger = {
  warn?: (message: string, context?: Record<string, unknown>) => void;
  info?: (message: string, context?: Record<string, unknown>) => void;
};

/** interaction 面板状态端口（OSC 7501 reporter 等外部投影挂这里）：
 *  面板真正渲染给用户期间 blocked，settle（应答送达/面板被撤，含 abort
 *  与异常路径的 finally）后 resolved。无 handler 早退不触发——面板从未
 *  出现。blocked 的真相在 interaction 路由而非 permission_requested 事件：
 *  事件区分不了"服务端自动应答、从未渲染"。 */
export interface AttachInteractionStatusPort {
  interactionBlocked(kind: "permission" | "question", message?: string): void;
  interactionResolved(): void;
}

export interface AttachRuntimeOptions {
  /** interaction 面板状态端口（可选；piz 入口的 OSC 7501 reporter）。 */
  interactionStatus?: AttachInteractionStatusPort;
  /** 测试注入点：默认 connectAttachClient。 */
  connect?: (socketPath: string) => Promise<AttachClient>;
  /** 测试注入点：默认 ensureServer 结果里的 socketPath 直连。 */
  ensureConnected?: () => Promise<{ socketPath: string }>;
  socketPath: string;
  logger?: AttachRuntimeLogger;
  /** 状态行文案的解析 locale（经 getZCodeCopy 走 tui.connection.* 目录）。 */
  locale?: TuiSubmitPromptResult["locale"];
  runtimePreferences?: Record<string, unknown>;
  /** session/resume 冷恢复所需的 workspace ref（core 重启后 session/subscribe 找不到 record）。 */
  workspace?: { workspacePath: string; workspaceKey: string; workspaceIdentity?: string };
}

export class AttachProtocolVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachProtocolVersionError";
  }
}

/**
 * 解析 resume 目标（入口 -c/--resume 与 TUI 内 /resume <id> 共用同一裁决；
 * TUI 裸 /resume 由 commandCenter 的 session picker 承担，不走这里）：
 *   - 无 resume 意图 → undefined（调用方走 session/create，开新会话）
 *   - --resume <id>   → 完整 id；或本 workspace 内唯一匹配的 id 前缀
 *   - -c/--continue   → 本 workspace 最近一次会话
 *
 * “最近”按 updatedAt（退化 createdAt）显式取最大：server 的 session/list 返回
 * 顺序不保证（实测创建序/任意序混排），取末位会恢复到陈旧会话。
 *
 * 显式意图不静默降级：--resume 解析出多个候选、-c 列不出会话、或
 * session/list 本身失败，都直接抛错（stderr + exit 1），不再无声开新会话
 * ——操作者截断 id 恢复时曾因此进到空会话而毫无提示。
 */
interface ListedResumeSession {
  createdAt?: number;
  sessionId?: string;
  id?: string;
  updatedAt?: number;
}

const toListedResumeSessions = (listed: unknown): ListedResumeSession[] => {
  const wrapped = (listed ?? {}) as { sessions?: unknown };
  return Array.isArray(wrapped.sessions) ? (wrapped.sessions as ListedResumeSession[]) : [];
};

const listedResumeSessionId = (session: ListedResumeSession): string | undefined =>
  session.sessionId ?? session.id;

const listWorkspaceSessionsForResume = async (
  client: AttachClient,
  workspace: { workspacePath: string; workspaceIdentity?: string; workspaceKey: string },
): Promise<ListedResumeSession[]> => {
  const listed = await client.request(zcodeProtocolMethods.sessionList, { workspace });
  return toListedResumeSessions(listed);
};

/** “最近会话”裁决（入口 -c 与 resumeApp 的 continue 兜底共用；TUI 裸
 *  /resume 已改走 picker，不再猜最新）：按 updatedAt（退化 createdAt）
 *  显式取最大；空列表 / 首名无 id 抛显式错误，不静默降级。 */
export function pickMostRecentResumeSessionId(
  sessions: ListedResumeSession[],
  workspacePath: string,
): string {
  const byRecency = [...sessions].sort(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
  );
  const last = byRecency[0];
  const lastId = last === undefined ? undefined : listedResumeSessionId(last);
  if (lastId === undefined) {
    throw new Error(`No resumable session found for ${workspacePath}`);
  }
  return lastId;
}

export const resolveAttachResumeTarget = async ({
  client,
  continueSession,
  resumeSessionId,
  workspace,
}: {
  client: AttachClient;
  continueSession: boolean;
  resumeSessionId?: string;
  workspace: { workspacePath: string; workspaceIdentity?: string; workspaceKey: string };
}): Promise<string | undefined> => {
  if (!continueSession && !resumeSessionId) return undefined;
  if (resumeSessionId) {
    // --resume 支持本 workspace 内唯一匹配的 id 前缀（截断 id 是真实使用形
    // 态：sess_99f180d5 这样的短前缀曾被静默换成新会话）。列表失败不阻断：
    // 原样透传，由 session/resume 的错误浮出真相（可能是跨 workspace 完整 id）。
    const sessions = await listWorkspaceSessionsForResume(client, workspace).catch(
      () => undefined,
    );
    if (sessions !== undefined) {
      const ids = sessions
        .map(listedResumeSessionId)
        .filter((id): id is string => typeof id === "string");
      if (ids.includes(resumeSessionId)) return resumeSessionId;
      const prefixed = ids.filter((id) => id.startsWith(resumeSessionId));
      if (prefixed.length === 1) return prefixed[0];
      if (prefixed.length > 1) {
        throw new Error(
          `--resume "${resumeSessionId}" is ambiguous: matches ${prefixed.length} sessions (${prefixed
            .slice(0, 5)
            .join(", ")}${prefixed.length > 5 ? ", …" : ""}). Use a longer prefix or the full id.`,
        );
      }
    }
    return resumeSessionId;
  }
  // -c：显式继续意图。列表失败或空列表都报错，与主 CLI 的
  // “No resumable session found” 同语义，不再静默开新会话。
  const sessions = await listWorkspaceSessionsForResume(client, workspace).catch(
    (error: unknown) => {
      throw new Error(
        `--continue could not list sessions for ${workspace.workspacePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  );
  return pickMostRecentResumeSessionId(sessions, workspace.workspacePath);
};

/** 断线横幅：投影能容忍未知 type（跳过），但仍造一条 SessionEvent 形态的通知行。 */
function connectionNoticeEvent(sessionId: string, text: string): SessionEvent {
  return {
    id: `attach-conn-${Date.now()}`,
    payload: { message: text, role: "system" },
    sequenceNumber: 0,
    sessionId,
    timestamp: new Date(),
    traceId: "attach",
    type: CONNECTION_LOST_TYPE,
  } as unknown as SessionEvent;
}

export class AttachRuntime {
  client: AttachClient | undefined;
  private readonly options: AttachRuntimeOptions;
  private readonly sessions = new Map<string, AttachSessionHandle>();
  private current: AttachSessionHandle | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay = RECONNECT_BACKOFF_START_MS;
  private connecting: Promise<AttachClient> | undefined;
  private stopped = false;
  private readonly statusListeners = new Set<(status: string) => void>();
  private readonly sessionBoundListeners = new Set<
    (handle: AttachSessionHandle) => void
  >();
  /** 断线状态行文案：构造时按 options.locale 解析（曾硬编码法语、无视 locale）。 */
  private readonly connectionCopy: TuiCopy["connection"];

  /** 订阅连接状态（TuiOptions.subscribeConnectionStatus 端口）。 */
  onConnectionStatus(listener: (status: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** 会话绑定/换绑的统一观察口（初始 attach、/new、/resume、/fork、重连换句柄）；
   *  herdr reporter 等外部状态投影经此跟随当前句柄。 */
  onSessionBound(listener: (handle: AttachSessionHandle) => void): () => void {
    this.sessionBoundListeners.add(listener);
    return () => this.sessionBoundListeners.delete(listener);
  }

  private emitStatus(status: string): void {
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  constructor(options: AttachRuntimeOptions) {
    this.options = options;
    this.connectionCopy = getZCodeCopy(options.locale).tui.connection;
  }

  async connect(): Promise<AttachClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const socketPath =
        this.options.socketPath ??
        (await this.options.ensureConnected?.())?.socketPath;
      if (!socketPath) throw new Error("attach socket path unavailable");
      const client = await (
        this.options.connect ?? ((path: string) => connectAttachClient(path))
      )(socketPath);
      this.installClient(client);
      this.reconnectDelay = RECONNECT_BACKOFF_START_MS;
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private installClient(client: AttachClient): void {
    this.client = client;
    client.onNotification((method, params) => this.routeNotification(method, params));
    client.setRequestHandler(async (method, params) =>
      this.routeReverseRequest(method, params),
    );
    void client.closed.then(() => this.onDisconnected());
  }

  private routeNotification(method: string, params: unknown): void {
    if (method === "state.updated") {
      // legacy mutation（session/setModel 等）只走 state.updated settings patch，不发 raw 事件；
      // 不合并会让已挂 TUI 的状态行停在旧模型（Ctrl+P 后看似切模失败）。
      const notification = params as { sessionId?: string; patch?: unknown };
      const handle = notification.sessionId
        ? this.sessions.get(String(notification.sessionId))
        : this.current;
      handle?.applyStatePatch(notification.patch);
      return;
    }
    if (method !== zcodeProtocolNotifications.sessionRawEvent) return;
    const raw = params as ZCodeSessionRawEvent;
    this.sessions.get(String(raw.sessionId))?.ingestRawEvent(raw);
  }

  private async routeReverseRequest(method: string, params: unknown): Promise<unknown> {
    if (method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
      return { nativeSearchEnhancementsEnabled: false, ...this.options.runtimePreferences };
    }
    if (method === zcodeProtocolMethods.interactionRequestPermission) {
      return await this.routePermissionInteraction(params);
    }
    if (method === zcodeProtocolMethods.interactionRequestUserInput) {
      return await this.routeUserInputInteraction(params);
    }
    const error = new Error(`method not found: ${method}`) as Error & { code: number };
    error.code = METHOD_NOT_FOUND;
    throw error;
  }

  /** 普通审批：线上 params → PermissionBrokerRequest → TUI requester → option.response 原文。 */
  private async routePermissionInteraction(params: unknown): Promise<unknown> {
    const parsed = zcodePermissionRequestParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new AttachProtocolError(
        INVALID_PARAMS,
        "Invalid permission request params",
        parsed.error.flatten(),
      );
    }
    const handle = this.sessions.get(parsed.data.sessionId);
    const callback = handle?.activeRequestPermission;
    if (!handle || !callback) {
      return NO_INTERACTION_HANDLER_PERMISSION_RESPONSE;
    }
    const request = permissionParamsToBrokerRequest(
      parsed.data,
      handle.getMode() ?? "build",
    );
    this.options.interactionStatus?.interactionBlocked(
      "permission",
      `permission: ${parsed.data.toolName}`,
    );
    try {
      return await handle.serveInteraction(
        parsed.data.requestId,
        async (signal) =>
          brokerResultToPermissionResponse(
            (await callback(request, { signal })) as PermissionBrokerResult,
            parsed.data.options,
          ),
      );
    } finally {
      this.options.interactionStatus?.interactionResolved();
    }
  }

  /** AskUserQuestion/ExitPlanMode：elicitation 走 requestUserInput，不是 requestPermission。
   *  翻译失败（无可渲染 kind）或无 handler 一律如实 decline，不伪装成 deny。 */
  private async routeUserInputInteraction(params: unknown): Promise<unknown> {
    const parsed = zcodeUserInputRequestParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new AttachProtocolError(
        INVALID_PARAMS,
        "Invalid user input request params",
        parsed.error.flatten(),
      );
    }
    const handle = this.sessions.get(parsed.data.sessionId);
    const callback = handle?.activeRequestPermission;
    const translated = userInputParamsToBrokerRequest(
      parsed.data,
      handle?.getMode() ?? "build",
    );
    if (!handle || !callback || !translated) {
      return NO_INTERACTION_HANDLER_USER_INPUT_RESPONSE;
    }
    // AskUserQuestion 是提问（question wizard）；plan_approval/ExitPlanMode
    // 走普通审批面板，语义是 permission。
    if (translated.kind === "ask_user_question") {
      this.options.interactionStatus?.interactionBlocked(
        "question",
        parsed.data.prompt,
      );
    } else {
      this.options.interactionStatus?.interactionBlocked(
        "permission",
        "plan approval",
      );
    }
    try {
      return await handle.serveInteraction(
        parsed.data.requestId,
        async (signal) =>
          brokerResultToUserInputResponse(
            (await callback(translated.request, { signal })) as PermissionBrokerResult,
            translated,
          ),
      );
    } finally {
      this.options.interactionStatus?.interactionResolved();
    }
  }

  private onDisconnected(): void {
    if (this.stopped) return;
    this.client = undefined;
    this.emitStatus(this.connectionCopy.lost);
    for (const handle of this.sessions.values()) {
      handle.ingestRawEvent(
        connectionNoticeEvent(
          handle.sessionId,
          "Connection to shared core lost — reconnecting…",
        ) as unknown as ZCodeSessionRawEvent,
      );
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_BACKOFF_MAX_MS);
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.options.ensureConnected) await this.options.ensureConnected();
      await this.connect();
    } catch {
      this.scheduleReconnect();
      return;
    }
    let recovered = 0;
    const total = this.sessions.size;
    for (const handle of this.sessions.values()) {
      if (await this.recoverSession(handle)) {
        recovered++;
        handle.ingestRawEvent(
          connectionNoticeEvent(
            handle.sessionId,
            "Reconnected to shared core.",
          ) as unknown as ZCodeSessionRawEvent,
        );
      } else {
        this.options.logger?.warn?.("attach resubscribe failed", {
          sessionId: handle.sessionId,
        });
      }
    }
    if (total === 0 || recovered === total) {
      this.emitStatus(this.connectionCopy.reconnected);
    } else {
      // core 重连但会话不可恢复（新 core registry 无 record、store 未持久化）——
      // 如实显示并继续退避：core 若在下一轮可恢复（异步物化），仍会补上。
      this.emitStatus(this.connectionCopy.reconnectedSessionUnavailable);
      this.scheduleReconnect();
    }
  }

  /** subscribe 失败若是 sessionUnavailable，先经 session/resume 冷物化再重试一次。 */
  private async recoverSession(handle: AttachSessionHandle): Promise<boolean> {
    try {
      await handle.resubscribe();
      return true;
    } catch (error) {
      if (
        !(error instanceof AttachProtocolError) ||
        error.code !== zcodeProtocolErrorCodes.sessionUnavailable ||
        !this.client ||
        !this.options.workspace
      ) {
        return false;
      }
      try {
        const compactContextWindow = handle.getCompactContextWindow();
        await this.client.request(zcodeProtocolMethods.sessionResume, {
          sessionId: handle.sessionId,
          workspace: this.options.workspace,
          // core 重启/空闲回收后冷恢复会丢掉内存里的上限，随 resume 带回当前模型对应的值。
          ...(compactContextWindow !== undefined ? { compactContextWindow } : {}),
        });
        await handle.resubscribe();
        return true;
      } catch {
        return false;
      }
    }
  }

  registerSession(handle: AttachSessionHandle): void {
    this.sessions.set(handle.sessionId, handle);
    this.current = handle;
    for (const listener of this.sessionBoundListeners) listener(handle);
  }

  /** core 确认释放后撤销恢复资格，避免重连重新打开已关闭的会话。 */
  unregisterSession(handle: AttachSessionHandle): void {
    if (this.sessions.get(handle.sessionId) !== handle) return;
    this.sessions.delete(handle.sessionId);
    if (this.current === handle) this.current = undefined;
  }

  get currentSession(): AttachSessionHandle | undefined {
    return this.current;
  }

  /** 会话句柄经此拿当前连接；重连换 client 后旧句柄自动跟随。 */
  currentClient(): AttachClient {
    if (!this.client) throw new Error("attach client is not connected");
    return this.client;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.client?.close();
    this.client = undefined;
  }
}

export interface CreateAttachHandlerOptions {
  runtime: AttachRuntime;
  client: AttachClient;
  /** create 结果快照（含 protocol.version 已由入口校验）。 */
  initialHandle: AttachSessionHandle;
  workspace: { workspacePath: string; workspaceKey: string; workspaceIdentity?: string };
  deps?: Partial<CommandCenterDeps>;
  logger?: AttachRuntimeLogger;
}

/**
 * 与 createTuiSubmitPrompt 同形的协议版：内部 createCommandCenter 复用 slash 路由，
 * app 面由 AttachSessionHandle 提供；/new /resume /fork 经 session/* 建新句柄。
 */
export function createAttachPromptHandler(
  options: CreateAttachHandlerOptions,
): TuiPromptHandler {
  const { runtime } = options;
  let current = options.initialHandle;
  runtime.registerSession(current);
  // 常驻 session sink 随会话换绑迁移（monolith sessionEventRelay 同语义）：
  // subscribeSessionEvents 订阅的是「当前会话」不是某个句柄——/new /resume
  // /fork 换 current 后，旧句柄上的 sink 会永久失聪新会话的出回合事件
  // （per-turn onEvent 仍走句柄本地 sinks，自己的回合不受影响，故障静默）。
  const durableSinks = new Map<
    (event: SessionEvent) => void,
    () => void
  >();
  runtime.onSessionBound((handle) => {
    for (const [sink, unsubscribe] of durableSinks) {
      unsubscribe();
      durableSinks.set(sink, handle.addSink(sink));
    }
  });
  // 重连会换 client：会话级 request 一律经 runtime 拿当前连接，不能用捕获的旧 client。
  const request = <T = unknown>(method: string, params?: unknown): Promise<T> =>
    runtime.currentClient().request<T>(method, params);

  const toHandle = async (sessionId: string): Promise<AttachSessionHandle> => {
    const handle = new AttachSessionHandle({
      client: () => runtime.currentClient(),
      locale: options.initialHandle.getLocale(),
      sessionId,
      // 用当前句柄的快照做种子：subscribe 回来的 available 是“仅当前模型”投影，
      // 从上一个（已持有完整 catalog 的）句柄继承，/new 后 Ctrl+P 才不会只剩一个模型。
      snapshot: current.snapshot,
    });
    runtime.registerSession(handle);
    await handle.subscribe(undefined, true);
    // /new /resume /fork 换会话：新绑定的 core session 也要按其当前模型设置压缩上限。
    await handle.syncCompactContextWindow();
    return handle;
  };

  const getApp = async (): Promise<CommandCenterApp> => asCommandCenterApp(current);

  const newApp = async (): Promise<CommandCenterApp> => {
    const created = (await request(zcodeProtocolMethods.sessionCreate, {
      // /new 与启动同规：首发前的空会话是 deferred 草稿，不进 session/list、
      // 不被 picker / -c 选中；首条 prompt 被 accepted 时 core 提升为 immediate。
      persistence: "deferred",
      workspace: options.workspace,
    })) as { session: { sessionId: string } };
    current = await toHandle(created.session.sessionId);
    return asCommandCenterApp(current);
  };

  const resumeApp = async (sessionId?: string): Promise<CommandCenterApp> => {
    // 与入口共用同一目标裁决：/resume <id|前缀> 直通/唯一前缀展开/多候选报错；
    // 显式 id 的列表失败原样透传（可能是跨 workspace 完整 id），continue 的
    // 列表失败、空列表与恢复失败一律抛错，绝不静默开新会话。sessionId 缺席
    // （正常路径已由 picker 拦截，只作 deps 裁剪下的兜底）走 -c 同语义。
    const target = await resolveAttachResumeTarget({
      client: runtime.currentClient(),
      continueSession: !sessionId,
      resumeSessionId: sessionId,
      workspace: options.workspace,
    });
    if (target === undefined) {
      throw new Error(`No resumable session found for ${options.workspace.workspacePath}`);
    }
    const resumed = (await request(zcodeProtocolMethods.sessionResume, {
      sessionId: target,
      // 冷物化判定需要 workspace ref，与入口 resume 请求同形。
      workspace: options.workspace,
    })) as { sessionId?: string };
    current = await toHandle(resumed.sessionId ?? target);
    return asCommandCenterApp(current);
  };

  const commandCenter = createCommandCenter({
    forkApp: async (targetCheckpointId) => {
      const active = current;
      const result = (await request(zcodeProtocolMethods.sessionFork, {
        sessionId: active.sessionId,
        target: targetCheckpointId
          ? { checkpointId: targetCheckpointId, kind: "checkpoint" }
          : { kind: "latestCheckpoint" },
      })) as { forkedSessionId: string; response: string };
      current = await toHandle(result.forkedSessionId);
      return {
        forkedSessionId: result.forkedSessionId,
        response: result.response,
      } as never;
    },
    // 交互式客户端：解析不出来的 `/...` 文本按普通 prompt 提交（粘贴的绝对路径发得出去）。
    forwardUnknownSlashAsPrompt: true,
    getApp,
    getLocale: () => current.getLocale(),
    getMode: () => current.getMode() ?? "build",
    // 裸 `/skill` 列举走 core 的 skills/referenceCatalog（session 权威快照），
    // 不在瘦客户端本地重扫；`current` 跟随 /new /resume /fork 换会话。
    listSkills: async () =>
      toCommandCenterSkillList(
        await listAttachSkillCatalog({
          request,
          sessionId: current.sessionId,
          workspace: options.workspace,
        }),
      ),
    // `/help` 列举自定义命令走 core 的 commands/referenceCatalog（workspace 现扫）。
    // 刻意不接 loadCustomCommand：展开留在 core 的 input facade —— 客户端侧展开
    // 会砍掉 !`cmd` 动态语法，且需要第二份命令事实。未知 /name 照 P005 原文转发。
    listCustomCommands: async () =>
      toCommandCenterCustomCommandList(
        await listAttachCommandCatalog({
          request,
          workspace: options.workspace,
        }),
      ),
    // 裸 /resume 的 composer picker 数据源：core 的 session/list 是本
    // workspace 已持久化会话的唯一事实（deferred 草稿由 core 既有规则
    // 过滤）。请求失败或载荷畸形原样抛给调用方——attach 缺这层时裸
    // /resume 落到 resumeApp 猜"最近会话"，可能选中刚绑定的当前会话；
    // 剔除 current.sessionId 避免 picker 出现"恢复自己"的条目。
    listSessions: async (): Promise<CommandCenterSession[]> => {
      const listed = zcodeSessionListResultSchema.parse(
        await request(zcodeProtocolMethods.sessionList, {
          workspace: options.workspace,
        }),
      );
      return listed.sessions
        .filter((session) => session.sessionId !== current.sessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(
          (session): CommandCenterSession => ({
            directory: session.workspace.workspacePath,
            id: session.sessionId,
            parentId: session.parentSessionId,
            title: session.title,
            updatedAt: session.updatedAt,
          }),
        );
    },
    newApp,
    recordInputHistory: async (input) => {
      await current.recordInputHistory(input);
    },
    resumeApp,
    setMode: async (mode) => {
      const result = await current.setMode(mode as string);
      return (result.mode as never) ?? mode;
    },
    ...options.deps,
  });

  const submitPrompt: TuiPromptHandler = async (input, submitOptions) => {
    if (submitOptions?.requestPermission) {
      current.activeRequestPermission = submitOptions.requestPermission as never;
    }
    return await commandCenter(input, submitOptions);
  };

  submitPrompt.getMainSessionId = () => current.sessionId;
  submitPrompt.listMcpServers = async () => ({});
  submitPrompt.readSubagents = (input) => current.readSubagents(input);
  submitPrompt.readUsageQuota = () => current.readUsageQuota();
  submitPrompt.readSubagentTranscript = (childSessionId) =>
    current.readSubagentTranscript(childSessionId);
  submitPrompt.recallPreviousInput = (skip) => current.recallPreviousInputHistory(skip);
  submitPrompt.sendInput = async (input: TuiPromptInput, sendOptions) => {
    // /model /effort 是客户端侧命令（Ctrl+P 轮换、Ctrl+L 选择器都走 sendInput），
    // 必须经 commandCenter → handle.setModel/setThoughtLevel；直接 sendText
    // 会把命令文本当 prompt 发给模型（曾导致"轮换"只是模型聊了一句命令名）。
    const command = parseSlashCommand(
      typeof input === "string" ? input : input.text,
    );
    if (
      command?.type === "known" &&
      (command.name === "model" || command.name === "effort")
    ) {
      return {
        kind: "command_result",
        result: await submitPrompt(input, {
          ...sendOptions,
          abortSignal: sendOptions?.abortSignal ?? new AbortController().signal,
        }),
      };
    }
    return current.sendInput(input, sendOptions as never);
  };
  // Alt+Up 撤回端口：本地队列项客户端摘除，core pendingInputs 项走协议
  // （session/discardPendingInputs）；随 current 跟随 /new /resume /fork。
  submitPrompt.removeQueuedInputs = (pendingInputIds) =>
    current.discardPendingInputs(pendingInputIds);
  submitPrompt.setMode = async (mode) => {
    const result = await current.setMode(mode as string);
    return { mode: result.mode as never };
  };
  submitPrompt.listModelOptions = async () =>
    current.snapshot.settings.model.available as never;
  submitPrompt.subscribeSessionEvents = (sink) => {
    const handle = runtime.currentSession ?? current;
    durableSinks.set(sink, handle.addSink(sink));
    return () => {
      durableSinks.get(sink)?.();
      durableSinks.delete(sink);
    };
  };
  // "stop & quit"：对当前会话发 session/stop 并等有界回执；随 current 跟随 /new /resume。
  submitPrompt.requestStopActiveTurn = () => current.stopActiveTurn();
  submitPrompt.close = async () => {
    await runtime.close();
  };

  return submitPrompt;
}
