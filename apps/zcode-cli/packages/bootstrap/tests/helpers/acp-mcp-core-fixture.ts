// issue #31 / CMCP 矩阵共享基座：与生产 entrypoint 同构——每接受一条 socket
// 就起一个真实 ZCodeProtocolAgentServer（共享 disposable sessionStore /
// providerRegistry / apps map），每条连接把 notificationSink /
// post-response batch / markClientDetached 绑到自己的 server。
// locateSessionOwner 扫描其他已 detach 且仍常驻该 session 的 server，
// 走真实 claim/收养转移（context.adoptDetachedSession）。bootstrap 与 cli
// 测试共用；连接客户端由调用方用各自包的 transport 创建（socketPath 即可）。
// 全部状态落在独立 temp root：ZCODE_STORAGE_DIR 显式重定向，不写 operator HOME。
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import type { LoggerFactory, SessionStorePort } from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ZCodeApp } from "../../src/app/types.js";
import { ZCodeProtocolAgentServer } from "../../src/zcode-protocol/server.js";
import { ZCodeProtocolNdjsonConnection } from "../../src/zcode-protocol/transport.js";
import { listenProtocolSocket } from "../../src/zcode-protocol/socket-listener.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
  type RegistryBackedTestModelExecutor,
} from "./registry-backed-test-app.js";

export interface AcpMcpCoreFixtureOptions {
  modelExecutor?: RegistryBackedTestModelExecutor;
  /** ACP core 语义默认 true；需要 plugin 行为时显式关闭。 */
  noPlugins?: boolean;
  version?: string;
  /** 注入捕获式 loggerFactory（CMCP13 诊断/泄漏断言）；缺省走默认。 */
  loggerFactory?: LoggerFactory;
}

export interface AcpMcpCoreFixture {
  /** 全部临时状态的根（socket/workspace/storage/db 都在下面）。 */
  readonly rootDir: string;
  readonly workspace: string;
  readonly socketPath: string;
  readonly sessionStore: SessionStorePort;
  /** 协议 create 出来的真实 app（按 sessionId）；仅用于观测与闸门编排。 */
  readonly apps: Map<string, ZCodeApp>;
  /** 每条已接受 socket 一个 server（与生产 per-connection core 同构）。 */
  readonly servers: Set<ZCodeProtocolAgentServer>;
  /** 给定 sessionId 当前挂在哪个 server 的 resident 表上（owner 观测）。 */
  ownerOf(sessionId: string): ZCodeProtocolAgentServer | undefined;
  /**
   * 真实 socket 上的最小 NDJSON client（bootstrap 侧测试用；cli 侧走
   * connectAttachClient/AcpCoreSessions）。每行入站 JSON 都先 parse——
   * 非 JSON 输出会直接抛错，顺手守住「协议输出 JSON-only」。
   */
  connectRawClient(): Promise<AcpMcpRawClient>;
  close(): Promise<void>;
}

export interface AcpMcpRawClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (message: { method: string; params?: unknown }) => void): () => void;
  /** server→client 反向请求（permission 等）；注册后由 handler 应答。 */
  onRequest(
    handler: (message: { id: unknown; method: string; params?: unknown }) => unknown | Promise<unknown>,
  ): void;
  close(): void;
  readonly closed: Promise<void>;
}

export async function createAcpMcpCoreFixture(
  options: AcpMcpCoreFixtureOptions = {},
): Promise<AcpMcpCoreFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), "acp-mcp-core-"));
  const workspace = join(rootDir, "workspace");
  const storageDir = join(rootDir, "storage");
  await mkdir(workspace, { recursive: true });
  const socketPath = join(rootDir, "core.sock");
  const sessionStore = await createSqliteSessionStore({
    dbPath: join(rootDir, "sessions.sqlite"),
  });
  const providerRegistry = createTestProviderRegistry();
  const noPlugins = options.noPlugins ?? true;
  // app 侧 env 只带显式 fixture 变量：storage 重定向到 temp root，不读 operator 环境。
  const appEnv = { ZCODE_STORAGE_DIR: storageDir };
  const apps = new Map<string, ZCodeApp>();
  const servers = new Set<ZCodeProtocolAgentServer>();
  const connections = new Set<ZCodeProtocolNdjsonConnection>();
  const version = options.version ?? "0.0.0-test";

  const listener = await listenProtocolSocket({
    socketPath,
    onConnection: (socket: Socket) => {
      // 每连接一个 server：sink/detach 标记只绑本连接，另一 socket 断开
      // 不会误伤这里的 sessions；收养由 locateSessionOwner 跨 server 完成。
      const server: ZCodeProtocolAgentServer = new ZCodeProtocolAgentServer({
        cwd: workspace,
        env: appEnv,
        noPlugins,
        sessionStore,
        ...(options.loggerFactory ? { loggerFactory: options.loggerFactory } : {}),
        createZCodeApp: (appOptions) => {
          const created = createRegistryBackedTestApp({
            ...appOptions,
            env: appEnv,
            // runtime 也拿到同一 store：persistSession/目标续跑需要真实 session 行。
            sessionStore,
            skipUserConfig: true,
            noPlugins,
            providerRegistry,
            ...(options.loggerFactory ? { loggerFactory: options.loggerFactory } : {}),
            ...(options.modelExecutor ? { modelExecutor: options.modelExecutor } : {}),
          });
          return Promise.resolve(created).then((app) => {
            apps.set(String(app.sessionId), app);
            return app;
          });
        },
        // 与生产 entrypoint 同语义：只把「其他」detached 且仍 resident 的
        // session 交收养；绝不返回自己（finishDetachedSessionAdoption 也会挡）。
        locateSessionOwner: (sessionId): ZCodeProtocolAgentServer | undefined => {
          for (const candidate of servers) {
            if (
              candidate !== server &&
              candidate.isDetached() &&
              candidate.hasResidentSession(sessionId)
            ) {
              return candidate;
            }
          }
          return undefined;
        },
        version,
      });
      servers.add(server);
      const connection = new ZCodeProtocolNdjsonConnection({
        clearPostResponseMessages: () => server.clearPostResponseMessages(),
        handleMessage: (message) => server.handleMessage(message),
        input: socket,
        onTransportClosed: (error) => server.markClientDetached(error),
        output: socket,
        takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
      });
      connections.add(connection);
      connection.start();
      server.setNotificationSink(
        (
          notification: Parameters<
            Parameters<typeof server.setNotificationSink>[0]
          >[0],
        ) => connection.send(notification),
      );
    },
  });

  const rawClients = new Set<Socket>();

  const fixture: AcpMcpCoreFixture = {
    rootDir,
    workspace,
    socketPath,
    sessionStore,
    apps,
    servers,
    ownerOf(sessionId) {
      for (const candidate of servers) {
        if (candidate.hasResidentSession(sessionId)) return candidate;
      }
      return undefined;
    },
    async connectRawClient() {
      const socket = connect(socketPath);
      rawClients.add(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      let nextId = 1;
      const pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: unknown) => void }
      >();
      const notificationHandlers = new Set<
        (message: { method: string; params?: unknown }) => void
      >();
      let requestHandler:
        | ((message: { id: unknown; method: string; params?: unknown }) => unknown | Promise<unknown>)
        | undefined;
      let buffer = "";
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index < 0) break;
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          // 协议输出必须逐行是合法 JSON——fixture 不吞解析错，守住 JSON-only。
          const message = JSON.parse(line) as {
            id?: unknown;
            method?: string;
            params?: unknown;
            result?: unknown;
            error?: unknown;
          };
          if (message.id !== undefined && message.method === undefined) {
            const entry = pending.get(Number(message.id));
            if (!entry) continue;
            pending.delete(Number(message.id));
            if (message.error !== undefined) entry.reject(message.error);
            else entry.resolve(message.result);
            continue;
          }
          if (message.id !== undefined && message.method !== undefined) {
            const id = message.id;
            Promise.resolve(requestHandler?.(message as never) ?? null)
              .then((result) => socket.write(`${JSON.stringify({ id, result })}\n`))
              .catch((error) =>
                socket.write(
                  `${JSON.stringify({
                    id,
                    error: { code: -32603, message: String(error) },
                  })}\n`,
                ),
              );
            continue;
          }
          for (const handler of notificationHandlers) {
            handler({ method: String(message.method), params: message.params });
          }
        }
      });
      socket.once("close", () => {
        rawClients.delete(socket);
        for (const entry of pending.values()) entry.reject(new Error("socket closed"));
        pending.clear();
        resolveClosed();
      });
      return {
        closed,
        close: () => socket.destroy(),
        notify: (method, params) =>
          socket.write(`${JSON.stringify({ method, params })}\n`),
        onNotification: (handler) => {
          notificationHandlers.add(handler);
          return () => notificationHandlers.delete(handler);
        },
        onRequest: (handler) => {
          requestHandler = handler;
        },
        request: <T,>(method: string, params?: unknown) => {
          const id = nextId;
          nextId += 1;
          return new Promise<T>((resolve, reject) => {
            pending.set(id, {
              resolve: resolve as (value: unknown) => void,
              reject,
            });
            socket.write(`${JSON.stringify({ id, method, params })}\n`);
          });
        },
      };
    },
    async close() {
      for (const socket of rawClients) socket.destroy();
      // listener.close 先毁掉已接受的 socket——transport 关闭会触发各自
      // server 的 markClientDetached 软 detach，再逐个 shutdown 收 server。
      // 清理失败必须让 teardown 显式失败，不能用 catch 吞掉泄漏。
      const cleanupErrors: unknown[] = [];
      try {
        await listener.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const server of servers) {
        try {
          await server.shutdown();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        sessionStore.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await rm(rootDir, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "acp-mcp core fixture teardown failed");
      }
    },
  };
  return fixture;
}
