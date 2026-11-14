// ACP 前端的 core 会话层：cwd 是 per-session 的，因此每个 workspace 懒建一个
// share-core 连接（AttachRuntime + socket client），所有会话事实仍归 core。
// 这里只做 session/create、session/resume、session/close 的装配与句柄注册。
import { isAbsolute } from "node:path";
import {
  ZCODE_WORKSPACE_IDENTITY_ENV,
  resolveWorkspaceKey,
  zcodeProtocolMethods,
  zcodeSessionStateSnapshotSchema,
  type DynamicWorkflowMode,
  type ZCodeProtocolMcpServer,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import { ensureServer } from "../app-server-spawn.js";
import { connectAttachClient, type AttachClient } from "../attach/attach-client.js";
import { AttachSessionHandle } from "../attach/attach-session.js";
import { AttachRuntime } from "../attach/attach-tui-options.js";
import { listAttachCommandCatalog } from "../attach/attach-commands.js";
import { listAttachSkillCatalog } from "../attach/attach-skills.js";
import { toSkillCatalogEntries } from "../skill-suggestions.js";
import type { AcpSlashCatalog } from "./acp-commands.js";

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

/**
 * 内部绑定形态：对外仍是 AcpSession，多出的 clientMcpServers 是本进程唯一的
 * client MCP 状态——core 已确认声明的独立 replay 副本（不是第二份有效配置，
 * 有效配置/挂起替换/连接与回合排序全归 core）。core 重启后 AttachRuntime
 * 冷恢复把它带回 session/resume；undefined=从未确认声明，[]=显式清空。
 */
type BoundAcpSession = AcpSession & {
  clientMcpServers?: ZCodeProtocolMcpServer[];
};

export interface AcpCorePort {
  closeAll(): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  /**
   * 进程级协议 op（auth/*、catalog 等非会话方法）：经该会话所属 workspace lane
   * 的当前 client 直达共享 core；重连后自动跟随新连接。
   */
  coreRequest(sessionId: string, method: string, params?: unknown): Promise<unknown>;
  get(sessionId: string): AcpSession | undefined;
  /** client 注入 MCP（issue #31）：undefined=未声明；[]=显式清空。 */
  open(cwd: string, mcpServers?: ZCodeProtocolMcpServer[]): Promise<AcpSession>;
  resume(input: {
    cwd: string;
    sessionId: string;
    mcpServers?: ZCodeProtocolMcpServer[];
  }): Promise<AcpSession>;
  /** 会话的 `/` 目录：core 现扫的自定义命令 + 会话冻结快照里的技能。 */
  slashCatalog(sessionId: string): Promise<AcpSlashCatalog>;
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
  /**
   * 本进程 `--workflow-mode` 的解析结果（ACP 缺省 onDemand，issue #5）。必填：
   * 每条 session/create 与 session/resume 都显式携带灰度字段，缺席会让 core 按
   * 协议 fail-closed 关掉工具面——那正是本 issue 的故障形态。
   */
  workflowMode: DynamicWorkflowMode;
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
  private readonly sessions = new Map<string, BoundAcpSession>();
  /** 随每条 create/resume 显式下发的灰度门；进程级常量，构造时折叠一次。 */
  private readonly workflowGate: {
    dynamicWorkflowEnabled: boolean;
    dynamicWorkflowMode: DynamicWorkflowMode;
  };

  constructor(options: AcpCoreSessionsOptions) {
    this.options = options;
    this.workflowGate = {
      dynamicWorkflowEnabled: options.workflowMode !== "disabled",
      dynamicWorkflowMode: options.workflowMode,
    };
  }

  get(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  async open(cwd: string, mcpServers?: ZCodeProtocolMcpServer[]): Promise<AcpSession> {
    const lane = await this.laneFor(cwd);
    // 发送前先独立快照：调用方之后原地改声明不能影响已发与已确认的内容。
    const replay = mcpServers === undefined ? undefined : structuredClone(mcpServers);
    const created = await lane.runtime.currentClient().request(zcodeProtocolMethods.sessionCreate, {
      // 与 attach 启动同规：首发前的空会话是 deferred 草稿，不污染 session/list。
      persistence: "deferred",
      workspace: lane.ref,
      ...this.workflowGate,
      ...(replay !== undefined ? { mcpServers: replay } : {}),
    });
    return await this.bindSession(lane, asSnapshot(created), replay);
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
        const replay = structuredClone(input.mcpServers);
        await lane.runtime.currentClient().request(zcodeProtocolMethods.sessionResume, {
          sessionId: input.sessionId,
          workspace: lane.ref,
          // warm record 的工具面 core 不回收（已物化 runtime），字段照常下发与
          // create/cold-resume 同形，真消费只发生在冷物化那条。
          ...this.workflowGate,
          mcpServers: replay,
        });
        // 仅在 core 确认后替换 replay 快照：失败的 resume 保留上一份已确认声明。
        existing.clientMcpServers = replay;
      }
      return existing;
    }
    const lane = await this.laneFor(input.cwd);
    const replay = input.mcpServers === undefined ? undefined : structuredClone(input.mcpServers);
    const resumed = await lane.runtime.currentClient().request(zcodeProtocolMethods.sessionResume, {
      sessionId: input.sessionId,
      workspace: lane.ref,
      ...this.workflowGate,
      ...(replay !== undefined ? { mcpServers: replay } : {}),
    });
    return await this.bindSession(lane, asSnapshot(resumed), replay);
  }

  async slashCatalog(sessionId: string): Promise<AcpSlashCatalog> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown ACP session: ${sessionId}`);
    const lane = await this.laneFor(session.cwd);
    const request = <T>(method: string, params?: unknown) =>
      lane.runtime.currentClient().request<T>(method, params);
    const [commands, skills] = await Promise.all([
      listAttachCommandCatalog({ request, workspace: lane.ref }),
      listAttachSkillCatalog({ request, sessionId, workspace: lane.ref }),
    ]);
    return {
      // disableNonInteractive 透传不过滤：那是「仅交互式」标记，只为 app-server
      // /headless 目录服务；ACP 是交互式客户端，/name 原文转发后 core facade
      // 展开不查该标记。滤掉既漏报广告，又让同名技能借「无同名命令」裁定抢走
      // facade 展开（issue #22）。
      commands: commands.commands.map((entry) => ({
        description: entry.description,
        name: entry.name,
        ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
      })),
      // 裸名与 qualifiedName 都留住：路由裁定与 Skill 工具 resolver 同口径，
      // 按两者命中（issue #24）；展示名由 acp-commands 取 qualifiedName ?? name。
      skills: toSkillCatalogEntries(skills.skills),
    };
  }

  async coreRequest(sessionId: string, method: string, params?: unknown): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown ACP session: ${sessionId}`);
    const lane = await this.laneFor(session.cwd);
    return await lane.runtime.currentClient().request(method, params);
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
    clientMcpServers?: ZCodeProtocolMcpServer[],
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
    const session: BoundAcpSession = {
      cwd: lane.ref.workspacePath,
      handle,
      workspace: lane.ref,
      ...(clientMcpServers !== undefined ? { clientMcpServers } : {}),
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
      // 冷恢复回放源：只读绑定表里最后确认的声明副本；恢复在重连时刻发生，
      // 因此必须按 sessionId 动态查而非捕获某次 open/resume 的值。
      getSessionRecoveryMcpServers: (sessionId) => {
        const declared = this.sessions.get(sessionId)?.clientMcpServers;
        return declared === undefined ? undefined : structuredClone(declared);
      },
      // 冷恢复的 session/resume 会冷物化 record：不带灰度字段会让 core fail-closed，
      // core 重启后已激活的会话丢掉工作流工具面。
      recoveryDynamicWorkflow: this.workflowGate,
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
