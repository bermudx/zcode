// ACP 前端的 core 会话层：cwd 是 per-session 的，因此每个 workspace 懒建一个
// share-core 连接（AttachRuntime + socket client），所有会话事实仍归 core。
// 这里只做 session/create、session/resume、session/close 的装配与句柄注册。
import { isAbsolute } from "node:path";
import {
  ZCODE_WORKSPACE_IDENTITY_ENV,
  resolveWorkspaceKey,
  zcodeProtocolMethods,
  zcodeSessionStateSnapshotSchema,
  type ZCodeProtocolMcpServer,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import { ensureServer } from "../app-server-spawn.js";
import { connectAttachClient, type AttachClient } from "../attach/attach-client.js";
import { AttachSessionHandle } from "../attach/attach-session.js";
import { AttachRuntime } from "../attach/attach-tui-options.js";

export interface AcpWorkspaceRef {
  workspaceIdentity?: string;
  workspaceKey: string;
  workspacePath: string;
}

export interface AcpSession {
  cwd: string;
  handle: AttachSessionHandle;
  /** 本会话当前在途回合的取消口；无回合时为 undefined。 */
  cancel?: () => void;
  workspace: AcpWorkspaceRef;
}

export interface AcpCorePort {
  closeAll(): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  get(sessionId: string): AcpSession | undefined;
  /** client 注入 MCP（issue #31）：undefined=未声明；[]=显式清空。 */
  open(cwd: string, mcpServers?: ZCodeProtocolMcpServer[]): Promise<AcpSession>;
  resume(input: {
    cwd: string;
    sessionId: string;
    mcpServers?: ZCodeProtocolMcpServer[];
  }): Promise<AcpSession>;
}

export interface AcpCoreSessionsOptions {
  env: NodeJS.ProcessEnv;
  /** 测试注入点：替换 ensureServer/connect，测试可直连真实 socket。 */
  connect?: (socketPath: string) => Promise<AttachClient>;
  ensureConnected?: (workspace: AcpWorkspaceRef) => Promise<{ socketPath: string }>;
  logger?: {
    debug?: (message: string, context?: Record<string, unknown>) => void;
    warn?: (message: string, context?: Record<string, unknown>) => void;
  };
}

type WorkspaceLane = {
  ref: AcpWorkspaceRef;
  runtime: AttachRuntime;
};

/**
 * 一个 cwd 一条连接：per-cwd lane 是会话级 workspace 路由的载体，
 * 全部 lane 汇聚到同一个共享 core（core 进程不按 workspace 分）。
 */
export class AcpCoreSessions implements AcpCorePort {
  private readonly options: AcpCoreSessionsOptions;
  private readonly lanes = new Map<string, Promise<WorkspaceLane>>();
  private readonly sessions = new Map<string, AcpSession>();

  constructor(options: AcpCoreSessionsOptions) {
    this.options = options;
  }

  get(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  async open(cwd: string, mcpServers?: ZCodeProtocolMcpServer[]): Promise<AcpSession> {
    const lane = await this.laneFor(cwd);
    const created = await lane.runtime.currentClient().request(zcodeProtocolMethods.sessionCreate, {
      // 与 attach 启动同规：首发前的空会话是 deferred 草稿，不污染 session/list。
      persistence: "deferred",
      workspace: lane.ref,
      ...(mcpServers !== undefined ? { mcpServers } : {}),
    });
    return await this.bindSession(lane, asSnapshot(created));
  }

  async resume(input: {
    cwd: string;
    sessionId: string;
    mcpServers?: ZCodeProtocolMcpServer[];
  }): Promise<AcpSession> {
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      if (existing.cwd !== input.cwd) {
        throw new Error(`ACP session ${input.sessionId} is bound to a different cwd`);
      }
      // 原句柄持有在途回合的 waiter；重复 resume 不能换掉事件接收者。
      // 但 client 显式下发的 MCP 声明仍要转给 warm record（CMCP04-07）：
      // 同一 AttachSessionHandle 保留，仅协议层更新配置。省略时不发请求，
      // core 侧保留内存声明。
      if (input.mcpServers !== undefined) {
        const lane = await this.laneFor(input.cwd);
        await lane.runtime.currentClient().request(zcodeProtocolMethods.sessionResume, {
          sessionId: input.sessionId,
          workspace: lane.ref,
          mcpServers: input.mcpServers,
        });
      }
      return existing;
    }
    const lane = await this.laneFor(input.cwd);
    const resumed = await lane.runtime.currentClient().request(zcodeProtocolMethods.sessionResume, {
      sessionId: input.sessionId,
      workspace: lane.ref,
      ...(input.mcpServers !== undefined ? { mcpServers: input.mcpServers } : {}),
    });
    return await this.bindSession(lane, asSnapshot(resumed));
  }

  /** ACP close = 真停止：先停当前回合，再让 core 释放 runtime（历史仍留存）。 */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cancel?.();
    const lane = await this.laneFor(session.cwd);
    await lane.runtime.currentClient().request(zcodeProtocolMethods.sessionClose, { sessionId });
    lane.runtime.unregisterSession(session.handle);
    this.sessions.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    this.sessions.clear();
    const lanes = [...this.lanes.values()];
    this.lanes.clear();
    // 清理边界必须尝试所有 lane；失败仍向入口传播，不伪装成功。
    const results = await Promise.allSettled(lanes.map(async (pending) => {
      const lane = await pending;
      await lane.runtime.close();
    }));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length > 0) throw new AggregateError(failures, "ACP lane cleanup failed");
  }

  private async bindSession(
    lane: WorkspaceLane,
    snapshot: ZCodeSessionStateSnapshot,
  ): Promise<AcpSession> {
    const handle = new AttachSessionHandle({
      client: () => lane.runtime.currentClient(),
      sessionId: snapshot.session.sessionId,
      snapshot,
    });
    await handle.subscribe(undefined, false);
    // GLM 的 auto-compact 窗口上限跟随当前模型；create/resume 都要显式下发。
    await handle.syncCompactContextWindow();
    lane.runtime.registerSession(handle);
    const session: AcpSession = {
      cwd: lane.ref.workspacePath,
      handle,
      workspace: lane.ref,
    };
    this.sessions.set(handle.sessionId, session);
    return session;
  }

  private laneFor(cwd: string): Promise<WorkspaceLane> {
    if (!isAbsolute(cwd)) {
      return Promise.reject(new Error(`ACP session cwd must be an absolute path: ${cwd}`));
    }
    const existing = this.lanes.get(cwd);
    if (existing) return existing;
    const created = this.createLane(cwd).catch((error: unknown) => {
      // 失败的 lane 不能留在缓存里，否则该 workspace 永远连不上。
      this.lanes.delete(cwd);
      throw error;
    });
    this.lanes.set(cwd, created);
    return created;
  }

  private async createLane(cwd: string): Promise<WorkspaceLane> {
    const identity = this.options.env[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim() || undefined;
    const ref: AcpWorkspaceRef = {
      workspaceIdentity: identity,
      workspaceKey: resolveWorkspaceKey({ workspaceIdentity: identity, workspacePath: cwd }),
      workspacePath: cwd,
    };
    const { socketPath } = await this.ensureConnected(ref);
    const runtime = new AttachRuntime({
      connect: this.options.connect ?? connectAttachClient,
      ensureConnected: async () => await this.ensureConnected(ref),
      locale: "en-US",
      logger: this.options.logger,
      socketPath,
      workspace: ref,
    });
    await runtime.connect();
    this.options.logger?.debug?.("acp core lane connected", { cwd, socketPath });
    return { ref, runtime };
  }

  private async ensureConnected(ref: AcpWorkspaceRef): Promise<{ socketPath: string }> {
    if (this.options.ensureConnected) return await this.options.ensureConnected(ref);
    // 单一 core：传输选择不带 workspace；ref 仍随 session/create|resume|
    // list 进入每个请求，per-cwd lane 只是多条到同一 core 的连接。
    return await ensureServer({
      env: this.options.env,
      log: (line) => this.options.logger?.debug?.(line),
    });
  }
}

function asSnapshot(value: unknown): ZCodeSessionStateSnapshot {
  return zcodeSessionStateSnapshotSchema.parse(value);
}
