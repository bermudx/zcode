// ACP 适配器的共享 core 桥：按 workspace 惰性持有一条 AttachClient（ACP 的 cwd
// 是 per-session 的，不能进程级单例），集中路由 core 的反向请求
// （interaction/requestPermission、interaction/requestUserInput）与
// session/rawEvent 通知到各 ACP session。
// 本文件只做传输与分发，业务状态（会话/回合）全部留在 core。
import {
  ZCODE_WORKSPACE_IDENTITY_ENV,
  resolveWorkspaceKey,
  zcodeProtocolNotifications,
  type ZCodeSessionRawEvent,
} from "@zcode/shared";
import { ensureServer } from "../../app-server-spawn.js";
import { connectAttachClient, type AttachClient } from "../attach-client.js";

export type AcpLogger = {
  warn?: (message: string, context?: Record<string, unknown>) => void;
  info?: (message: string, context?: Record<string, unknown>) => void;
};

export type ReverseRequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type RawEventHandler = (raw: ZCodeSessionRawEvent) => void;

export interface CoreWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
}

export const toCoreWorkspaceRef = (cwd: string, env: NodeJS.ProcessEnv): CoreWorkspaceRef => {
  const workspaceIdentity = env[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim() || undefined;
  return {
    workspacePath: cwd,
    workspaceIdentity,
    workspaceKey: resolveWorkspaceKey({ workspacePath: cwd, workspaceIdentity }),
  };
};

interface WorkspaceEntry {
  client: AttachClient;
  reverseHandler: ReverseRequestHandler | undefined;
  eventHandlers: Map<string, Set<RawEventHandler>>;
}

export interface AcpCoreBridgeOptions {
  version: string;
  env?: NodeJS.ProcessEnv;
  /** 测试注入点：默认 ensureServer 拉起/复用共享 core。 */
  ensureConnected?: (workspace: CoreWorkspaceRef) => Promise<{ socketPath: string }>;
  /** 测试注入点：默认 connectAttachClient。 */
  connect?: (socketPath: string) => Promise<AttachClient>;
  logger?: AcpLogger;
}

/**
 * 一个 workspace 一条 socket：首个 session/new（或 resume）时才 ensureServer +
 * 握手，之后同 workspace 的 session 全部复用。断线时整条 entry 摘除，下次请求重连。
 */
export class AcpCoreBridge {
  private readonly options: AcpCoreBridgeOptions;
  private readonly entries = new Map<string, WorkspaceEntry>();
  private readonly connecting = new Map<string, Promise<AttachClient>>();

  constructor(options: AcpCoreBridgeOptions) {
    this.options = options;
  }

  /** 确保某 workspace 的 core 连接存在并返回 client（惰性、可复用）。 */
  async ensureClient(workspace: CoreWorkspaceRef): Promise<AttachClient> {
    const existing = this.entries.get(workspace.workspaceKey);
    if (existing) return existing.client;
    const inflight = this.connecting.get(workspace.workspaceKey);
    if (inflight) return inflight;
    const connecting = (async () => {
      const { socketPath } = await (this.options.ensureConnected
        ? this.options.ensureConnected(workspace)
        : ensureServer({
            env: this.options.env ?? process.env,
            version: this.options.version,
            workspace,
          }));
      const client = await (this.options.connect ?? connectAttachClient)(socketPath);
      const entry: WorkspaceEntry = {
        client,
        reverseHandler: undefined,
        eventHandlers: new Map(),
      };
      client.setRequestHandler(async (method, params) => {
        if (!entry.reverseHandler) {
          const error = new Error(`method not found: ${method}`) as Error & { code: number };
          error.code = -32601;
          throw error;
        }
        return entry.reverseHandler(method, params);
      });
      client.onNotification((method, params) => {
        if (method !== zcodeProtocolNotifications.sessionRawEvent) return;
        const raw = params as ZCodeSessionRawEvent;
        const handlers = entry.eventHandlers.get(String(raw.sessionId));
        if (!handlers) return;
        for (const handler of handlers) {
          try {
            handler(raw);
          } catch (error) {
            this.options.logger?.warn?.("acp raw event handler failed", {
              error: error instanceof Error ? error.message : String(error),
              sessionId: raw.sessionId,
              type: raw.type,
            });
          }
        }
      });
      void client.closed.then(() => {
        // socket 断开：摘除缓存，下个请求整条重连。
        if (this.entries.get(workspace.workspaceKey)?.client === client) {
          this.entries.delete(workspace.workspaceKey);
        }
      });
      this.entries.set(workspace.workspaceKey, entry);
      return client;
    })().finally(() => {
      this.connecting.delete(workspace.workspaceKey);
    });
    this.connecting.set(workspace.workspaceKey, connecting);
    return connecting;
  }

  /** 为某个 core session 绑定反向请求与 raw 事件处理口（须先 ensureClient）。 */
  bindSession(
    workspace: CoreWorkspaceRef,
    sessionId: string,
    handlers: { onReverseRequest: ReverseRequestHandler; onRawEvent: RawEventHandler },
  ): void {
    const entry = this.entries.get(workspace.workspaceKey);
    if (!entry) throw new Error("core workspace client not connected");
    entry.reverseHandler = handlers.onReverseRequest;
    let set = entry.eventHandlers.get(sessionId);
    if (!set) {
      set = new Set();
      entry.eventHandlers.set(sessionId, set);
    }
    set.add(handlers.onRawEvent);
  }

  detachSession(workspaceKey: string, sessionId: string): void {
    this.entries.get(workspaceKey)?.eventHandlers.delete(sessionId);
  }

  /** 关闭进程时断开全部 workspace 连接（detach 语义：core 端 session 照常存活）。 */
  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.client.close();
  }
}
