// per-workspace 的 core 连接池：一个 cwd 一个惰性客户端，N 个 ACP 会话共享。
//
// 为什么不复用 AttachRuntime：那个类带着 TUI 的重连横幅、sink 轮转与
// herdr 上报，ACP 的客户端（编辑器）自己持有会话事实，断线由它重发
// session/resume 就够了。这里只保留"发现/拉起 socket + 连接 + 反向请求路由"，
// 是 attach-command 里 ensureServer/connectAttachClient 那几行的最小集。
//
// workspaceIdentity 与 attach 同源（ZCODE_WORKSPACE_IDENTITY_ENV 优先），
// 否则同一个物理 workspace 会分裂成两个 socket、两份 core。
import {
  ZCODE_PROTOCOL_VERSION,
  ZCODE_WORKSPACE_IDENTITY_ENV,
  resolveWorkspaceKey,
  zcodeProtocolMethods,
  zcodeSessionStateSnapshotSchema,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import type { AttachClient } from "../attach/attach-client.js";
import { connectAttachClient } from "../attach/attach-client.js";
import { ensureServer } from "../app-server-spawn.js";
import { AttachSessionHandle } from "../attach/attach-session.js";
import { AcpSession, type AcpSessionDeps, type AcpSessionLogger } from "./acp-session.js";
import { AcpWireError } from "./acp-wire.js";
import type { AcpSessionUpdate } from "./acp-protocol.js";

/**
 * core 的 workspace ref。`workspaceKey` 不是装饰：`session/create` /
 * `session/resume` 的参数 schema 要求它（= workspaceIdentity || workspacePath），
 * 缺了会被 core 判为 invalid params。与 attach-command 用同一 helper 计算，
 * 否则同一个 workspace 会分裂成两个 key。
 */
export type AcpWorkspace = {
  workspaceIdentity?: string;
  workspaceKey: string;
  workspacePath: string;
};

export type AcpCoreDeps = {
  env: NodeJS.ProcessEnv;
  version: string;
  logger: AcpSessionLogger;
  /** 测试注入点：默认走 app-server-spawn 的 ensureServer。 */
  ensureCore?: (input: { env: NodeJS.ProcessEnv; version: string; workspace: AcpWorkspace }) => Promise<{
    socketPath: string;
  }>;
  connect?: (socketPath: string) => Promise<AttachClient>;
};

type Link = {
  client: AttachClient;
  socketPath: string;
  workspaceKey: string;
  sessions: Map<string, AcpSession>;
};

export class AcpProtocolVersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpProtocolVersionMismatchError";
  }
}

/**
 * core 连接池 + ACP 会话注册表。
 *
 * 反向请求（core → 前端）在这里按 sessionId 路由到具体 AcpSession；
 * 会话还没注册（resume 之前 core 就发来交互）时如实报 method not found，
 * 而不是随便挂到一个会话上。
 */
export class AcpCorePool {
  private readonly deps: AcpCoreDeps;
  private readonly links = new Map<string, Promise<Link>>();
  private sendUpdate: (sessionId: string, update: AcpSessionUpdate) => void = () => undefined;
  private sendRequestToClient: <T = unknown>(method: string, params: unknown) => Promise<T> =
    async () => {
      throw new Error("ACP client transport is not connected yet");
    };

  constructor(deps: AcpCoreDeps) {
    this.deps = deps;
  }

  /** 由 acp-agent 在握手后注入：会话的 update/请求都要经过同一条 wire。 */
  bindClientTransport(input: {
    notifyUpdate: (sessionId: string, update: AcpSessionUpdate) => void;
    request: <T = unknown>(method: string, params: unknown) => Promise<T>;
  }): void {
    this.sendUpdate = input.notifyUpdate;
    this.sendRequestToClient = input.request;
  }

  private readonly sessionList = new Set<AcpSession>();

  sessions(): IterableIterator<AcpSession> {
    return this.sessionList.values();
  }

  findSession(sessionId: string): AcpSession | undefined {
    for (const session of this.sessionList) {
      if (session.sessionId === sessionId) return session;
    }
    return undefined;
  }

  /** session/new：core session/create（deferred 草稿，首发时提升为 immediate）。 */
  async createSession(input: { cwd: string }): Promise<AcpSession> {
    const link = await this.link(input.cwd);
    const workspace = this.workspaceOf(input.cwd);
    const created = await link.client.request(zcodeProtocolMethods.sessionCreate, {
      persistence: "deferred",
      workspace,
    });
    const snapshot = this.parseSnapshot(created, link.socketPath);
    return this.registerSession({
      client: link.client,
      cwd: input.cwd,
      link,
      sessionId: snapshot.session.sessionId,
      snapshot,
    });
  }

  /**
   * session/resume：ACP sessionId 就是 core sessionId。恢复失败必须显式报错——
   * 静默开新会话会把"继续上一次对话"变成丢历史。
   */
  async resumeSession(input: { cwd: string; sessionId: string }): Promise<AcpSession> {
    const existing = this.findSession(input.sessionId);
    if (existing && !existing.isClosed) return existing;
    const link = await this.link(input.cwd);
    const workspace = this.workspaceOf(input.cwd);
    const resumed = await link.client.request(zcodeProtocolMethods.sessionResume, {
      sessionId: input.sessionId,
      workspace,
    });
    const snapshot = this.parseSnapshot(resumed, link.socketPath);
    return this.registerSession({
      client: link.client,
      cwd: input.cwd,
      link,
      sessionId: snapshot.session.sessionId,
      snapshot,
    });
  }

  private registerSession(input: {
    client: AttachClient;
    cwd: string;
    link: Link;
    sessionId: string;
    snapshot: ZCodeSessionStateSnapshot;
  }): AcpSession {
    const deps: AcpSessionDeps = {
      closeRemoteSession: async () => {
        await input.link.client.request(zcodeProtocolMethods.sessionClose, {
          sessionId: input.sessionId,
        });
        input.link.sessions.delete(input.sessionId);
      },
      emitUpdate: (update) => this.sendUpdate(input.sessionId, update),
      logger: this.deps.logger,
      sendRequest: (method, params) => this.sendRequestToClient(method, params),
    };
    const handle = new AttachSessionHandle({
      client: () => input.link.client,
      sessionId: input.sessionId,
      snapshot: input.snapshot,
    });
    const session = new AcpSession({
      cwd: input.cwd,
      deps,
      handle,
      sessionId: input.sessionId,
    });
    input.link.sessions.set(input.sessionId, session);
    this.sessionList.add(session);
    return session;
  }

  /**
   * 订阅 live 事件。afterSeq 取快照的 eventSeq：ACP 没有 session/load 的"重放
   * 历史"语义，从 0 重放会把整段对话当成新的流式输出再发一遍给编辑器。
   */
  async subscribeSession(session: AcpSession): Promise<void> {
    const eventSeq = Number(
      (session.snapshot.runtime as { eventSeq?: unknown }).eventSeq ?? 0,
    );
    await session.handle.subscribe(Number.isFinite(eventSeq) ? eventSeq : 0, false);
    session.attachEventStream();
  }

  async disposeAll(): Promise<void> {
    for (const session of this.sessionList) {
      // 断开 = detach：不 session/close，core 侧会话照常存活（与 attach 一致）。
      session.detachEventStream();
    }
    this.sessionList.clear();
    for (const pending of this.links.values()) {
      try {
        const link = await pending;
        link.client.close();
      } catch {
        // 连不上的链接无需再关。
      }
    }
    this.links.clear();
  }

  private workspaceOf(cwd: string): AcpWorkspace {
    const workspaceIdentity = this.deps.env[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim() || undefined;
    return {
      workspaceIdentity,
      workspaceKey: resolveWorkspaceKey({ workspaceIdentity, workspacePath: cwd }),
      workspacePath: cwd,
    };
  }

  private link(cwd: string): Promise<Link> {
    const key = cwd;
    const existing = this.links.get(key);
    if (existing) return existing;
    const pending = this.openLink(cwd);
    this.links.set(key, pending);
    // 打开失败不缓存：下一次请求要能重新拉起 core。
    void pending.catch(() => this.links.delete(key));
    return pending;
  }

  private async openLink(cwd: string): Promise<Link> {
    const workspace = this.workspaceOf(cwd);
    const ensureCore = this.deps.ensureCore ?? ensureServer;
    const { socketPath } = await ensureCore({
      env: this.deps.env,
      version: this.deps.version,
      workspace,
    });
    const connect = this.deps.connect ?? ((path: string) => connectAttachClient(path));
    const client = await connect(socketPath);
    const link: Link = { client, sessions: new Map(), socketPath, workspaceKey: workspace.workspaceKey };
    client.setRequestHandler(async (method, params) =>
      this.routeReverseRequest(link, method, params),
    );
    client.onNotification((method, params) => this.routeNotification(link, method, params));
    void client.closed.then(() => {
      this.deps.logger.warn("acp core connection closed", { socketPath });
      // 连接断了：所有会话的 in-flight 请求会各自失败；这里只清会话注册，
      // 不清会话对象（编辑器仍可能再 resume 同一 id，届时重建连接）。
    });
    return link;
  }

  private routeNotification(link: Link, method: string, params: unknown): void {
    if (method === "state.updated") {
      const notification = params as { patch?: unknown; sessionId?: string };
      const session = this.findSession(String(notification.sessionId ?? ""));
      if (!session) return;
      session.handle.applyStatePatch(notification.patch);
      const patch = notification.patch as Record<string, unknown> | undefined;
      if (patch && ("model" in patch || "thoughtLevel" in patch || "mode" in patch)) {
        session.emitConfigOptions();
      }
      return;
    }
    if (method !== "session/rawEvent") return;
    const raw = params as { sessionId?: unknown };
    const session = this.findSession(String(raw.sessionId ?? ""));
    // 事件分发走 AttachSessionHandle 的常驻 sinks（含事件序号推进）。
    session?.handle.ingestRawEvent(params as never);
  }

  private async routeReverseRequest(
    link: Link,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
      return { nativeSearchEnhancementsEnabled: false };
    }
    const sessionId = String((params as { sessionId?: unknown })?.sessionId ?? "");
    const session = link.sessions.get(sessionId) ?? this.findSession(sessionId);
    if (method === zcodeProtocolMethods.interactionRequestPermission) {
      if (!session) throw methodNotFound(method);
      return await session.handlePermissionRequest(params);
    }
    if (method === zcodeProtocolMethods.interactionRequestUserInput) {
      if (!session) throw methodNotFound(method);
      return await session.handleUserInputRequest(params);
    }
    // provider runtime headers / official mcp auth headers 等：ACP 前端不做
    // 客户端侧凭据注入，也不假装能应答——如实报未实现，由 core 走既有降级。
    throw methodNotFound(method);
  }

  private parseSnapshot(raw: unknown, socketPath: string): ZCodeSessionStateSnapshot {
    const advertisedVersion = (raw as { protocol?: { version?: unknown } } | undefined)?.protocol
      ?.version;
    if (advertisedVersion !== ZCODE_PROTOCOL_VERSION) {
      throw new AcpProtocolVersionMismatchError(
        `Shared core protocol v${String(advertisedVersion)} but this client expects v${String(ZCODE_PROTOCOL_VERSION)}. ` +
          `Restart the core: kill $(cat '${socketPath}.pid')`,
      );
    }
    return zcodeSessionStateSnapshotSchema.parse(raw);
  }
}

function methodNotFound(method: string): AcpWireError {
  return new AcpWireError(-32601, `method not found: ${method}`);
}
