import { createNodePluginAdapter } from "@zcode/adapters/plugins";
import { createOfficialPluginPreparation } from "./app/bundled-plugins.js";
import { resolveZCodePlugins } from "./plugins.js";
import { createMcpTransportFetch } from "@zcode/adapters";
import { createSharedZCodeCredentialStore } from "@zcode/adapters/auth";
import { createCredentialCipherBridge } from "@zcode/shared/credential-security";
import { credentialCipherReplySchema, zcodeProtocolMethods } from "@zcode/shared";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { createNodeModelSelectionFacade } from "@zcode/provider-node";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import { writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import type { Socket } from "node:net";
import {
  createSkillCatalogSourceRegistry,
  type SkillCatalogSourceRegistry,
} from "@zcode/adapters/skills/catalog";
import {
  createInMemoryMcpToolCatalog,
  createMcpAdapterConnectionPool,
  createMcpConfigSourceRegistry,
  createMcpTelemetryTracker,
  type McpConfigSourceRegistry,
  type McpConnectionPool,
  type McpTelemetryTracker,
} from "@zcode/adapters/mcp";
import {
  zcodeProtocolNotifications,
  type ZCodeMcpResourceSample,
  type ZCodeMcpTelemetryEvent,
} from "@zcode/shared";
import { createNodeSessionDataFiles, type SqliteSessionStore } from "@zcode/adapters/storage";
import { traceContextToLogContext, createRootTraceContext } from "@zcode/contracts";
import type { McpPort, McpToolCatalogPort, ModelSelection } from "@zcode/contracts";
import type { PresentationSurface } from "@zcode/core";
import type { RunZCodeProtocolAgentOptions, ZCodeAppOptions } from "./app/types.js";
import { createZCodeApp } from "./app/create-app.js";
import {
  createNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./app/node-repl-browser-broker.js";
import {
  openProtocolStartupStorage,
  prepareProtocolStartupStorage,
} from "./zcode-protocol/storage-startup.js";
import { closeSessionStore, getSessionDbPath } from "./app/session-store.js";
import { resolveMcpNodeFallbackProvider } from "./app/mcp-node-fallback.js";
import { getCliStorageRoot, getPluginStorageRoot, getProjectMemoryRoot } from "./app/paths.js";
import { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
import { scheduleStartupLogRetentionCleanup } from "./log-retention.js";
import { resolveProcessProviderEndpointRoutingPort } from "./provider-endpoint-routing.js";
import { StartupTimer, startupNow } from "./startup-logging.js";
import { installZCodeProtocolAiSdkWarningLogger } from "./zcode-protocol/ai-sdk-warning-logger.js";
import {
  createOfficialCommandAuthHeadersPort,
  createOfficialMcpAuthHeadersPort,
  type OfficialMcpAuthRequestContext,
} from "./zcode-protocol/official-mcp-auth-port.js";
import {
  createOfficialCommandEndpoint,
  type OfficialCommandEndpoint,
} from "./official-command-endpoint/index.js";
import {
  appServerInfoSchema,
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
  ZCODE_WORKSPACE_IDENTITY_ENV,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "./zcode-protocol/server.js";
import { ZCodeProtocolNdjsonConnection } from "./zcode-protocol/transport.js";
import { cleanupProtocolRuntime } from "./zcode-protocol/runtime-cleanup.js";
import { startProtocolResourceSampler } from "./zcode-protocol/resource-sampler.js";
import { acquireProtocolStartupResource } from "./zcode-protocol/startup-resource.js";
import {
  listenProtocolSocket,
  type ProtocolSocketListener,
} from "./zcode-protocol/socket-listener.js";
import { NO_PLUGINS_CONFIG_OVERRIDES } from "./app/app-config-options.js";
import { prepareZCodeTelemetryEnv, shutdownZCodeTelemetry } from "./telemetry-bootstrap.js";
import type { ZCodeProcessResourceSampler } from "./process-resource-sampler.js";

export function applyProtocolPresentationSurface(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  presentationSurface: PresentationSurface,
): Omit<ZCodeAppOptions, "providerRegistry"> {
  return {
    ...options,
    runtimeConfig: {
      ...options.runtimeConfig,
      presentationSurface,
    },
  };
}

/**
 * 进程级 Registry 已就绪后，它就是当前 Environment 的模型事实源。
 *
 * 旧 workspace snapshot 不再参与 Provider 和 Model 执行。
 */
export function applyProtocolProviderRegistry(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  providerRegistry: ZCodeAppOptions["providerRegistry"],
  configuredDefaultModelSelection?: ModelSelection,
): ZCodeAppOptions {
  return {
    ...options,
    providerRegistry,
    ...(configuredDefaultModelSelection ? { configuredDefaultModelSelection } : {}),
  };
}

/** 断线 server 兜底回收的扫描节拍；判定条件（无活 turn、无 pending 反向请求）在 server.isReapable。 */
const DETACHED_SERVER_SWEEP_INTERVAL_MS = 30_000;

/** socket 监听模式下一条已接入连接的全部归属物：协议 server 是该连接的会话 owner。 */
interface AttachedProtocolConnection {
  broker?: NodeReplBrowserBroker;
  connection: ZCodeProtocolNdjsonConnection;
  sampler?: ZCodeProcessResourceSampler;
  server: ZCodeProtocolAgentServer;
}

export async function runZCodeProtocolAgent(
  options: RunZCodeProtocolAgentOptions = {},
): Promise<void> {
  const socketPath = options.socketPath?.trim() || undefined;
  if (options.prepareStorageOnly) {
    if (socketPath) {
      throw new Error("--socket cannot be used with --prepare-storage.");
    }
    const config = createConfig({ env: options.env });
    await prepareProtocolStartupStorage({
      dbPath: getSessionDbPath(config, options.cwd),
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
    });
    return;
  }
  const startupStartedAt = startupNow();
  const presentationSurface = options.presentationSurface ?? "terminal";
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  // socket 模式下启动时还没有任何客户端；存储迁移进度帧只落日志，不向 stdout 写协议帧。
  const storageStartupOutput = socketPath
    ? new Writable({ write: (_chunk, _encoding, callback) => callback() })
    : output;
  const loggerFactory = createNodeLoggerFactory({ env: options.env });
  const traceContext = createRootTraceContext({
    attributes: {
      entrypoint: "zcode_protocol",
    },
  });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap.zcode_protocol",
  });
  installZCodeProtocolAiSdkWarningLogger(logger);
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap.zcode_protocol",
      startupKind: "zcode_protocol_agent",
    },
    startupStartedAt,
  );
  startupTimer.start("ZCode Protocol agent startup started", {
    context: { version: options.version },
    event: "zcode_protocol.startup.started",
    stage: "start",
  });

  // 修复原因：原先给 seed+discovery 共 3 秒预算，超时后整个进程到重启前都不加载插件。
  // Windows 实测冷启动 seed 官方插件约 3.0~3.1 秒，插件版本升级后的首次启动必然超时。
  // 先停用启动预算：seed 等锁仍由 15 秒共享锁预算兜住，超时按单插件降级回退旧缓存。
  const pluginPreparation = createOfficialPluginPreparation();
  let pluginDiscovery: ReturnType<typeof createNodePluginAdapter> | undefined;
  let pluginPrewarm: Promise<void> | undefined;
  let sessionStore: SqliteSessionStore | undefined;
  // 每条接入连接一个协议 server；该集合保留尚未 teardown 的 owner，供退出清理兜底。
  const ownedServers = new Set<ZCodeProtocolAgentServer>();
  const ownedBrokers = new Set<NodeReplBrowserBroker>();
  const attachedConnections = new Set<AttachedProtocolConnection>();
  /**
   * 传输已断但 owner server 未 shutdown 的连接：sessions/反向请求继续存活，
   * 等新连接经 locateSessionOwner + session/resume 把 record 收养走；全空闲后
   * 由 orphan sweep 兜底 shutdown，防止孤儿 server 无限驻留。
   */
  const detachedConnections = new Set<AttachedProtocolConnection>();
  let detachedSweepTimer: ReturnType<typeof setInterval> | undefined;
  // 进程级 MCP pool 的反向请求（elicitation / 官方 auth）归最近接入的协议会话 owner。
  let latestProtocolServer: ZCodeProtocolAgentServer | undefined;
  let socketListener: ProtocolSocketListener | undefined;
  let officialCommandEndpoint: OfficialCommandEndpoint | undefined;
  let mcpConnectionPool: McpConnectionPool | undefined;
  let credentialCipherBridge: ReturnType<typeof createProtocolCredentialCipher> | undefined;
  let mcpPort: McpPort | undefined;
  let mcpToolCatalogPort: McpToolCatalogPort | undefined;
  let mcpConfigSourceRegistry: McpConfigSourceRegistry | undefined;
  let skillCatalogSourceRegistry: SkillCatalogSourceRegistry | undefined;
  let mcpTelemetryTracker: McpTelemetryTracker | undefined;
  let mcpResourceSink: ((samples: ZCodeMcpResourceSample[]) => void) | undefined;
  let mcpTelemetrySink: ((event: ZCodeMcpTelemetryEvent) => void) | undefined;
  let providerRegistryRuntime:
    | Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>>
    | undefined;
  try {
    // 数据库准备先于账号、Registry 和遥测，不把远端材料等待混进迁移门禁。
    // --no-plugins 经既有 cliOverrides（最高优先级）关闭 plugins.enabled 与 features.mcp，
    // 下面依赖这两个开关的连接池/遥测/broker 分支随之全部短路。
    const configResult = createConfig({
      env: options.env,
      ...(options.noPlugins === true ? { cliOverrides: NO_PLUGINS_CONFIG_OVERRIDES } : {}),
    });
    sessionStore = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: (store) => closeSessionStore(store),
      create: () =>
        openProtocolStartupStorage({
          dbPath: getSessionDbPath(configResult),
          output: storageStartupOutput,
          onProgress: (progress) =>
            logger.info("SQLite startup state", {
              event: "zcode_protocol.startup.storage_state",
              ...progress,
            }),
        }),
    });
    pluginDiscovery = createNodePluginAdapter({
      storageRoot: getPluginStorageRoot(
        getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
      ),
    });
    pluginPrewarm = resolveZCodePlugins({
      pluginDiscovery,
      workspaceIdentity: (options.env ?? process.env)[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim(),
      env: options.env,
      logger,
      workingDirectory: options.cwd,
      pluginPreparation,
    }).then(
      () => undefined,
      (error: unknown) => {
        if (!pluginPreparation.signal.aborted)
          logger.warn("Plugin startup preparation failed", {
            event: "zcode_protocol.plugins.prewarm.failed",
            errorType: error instanceof Error ? error.name : typeof error,
          });
      },
    );
    const runtimeEnv = options.env ?? process.env;
    options.lifecycle?.signal.throwIfAborted();
    providerRegistryRuntime = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      create: () =>
        startProcessProviderRegistryRuntime(
          runtimeEnv,
          // socket 共享 core 只服务 CLI attach 客户端，没有能推送
          // provider/updateAccountConfig 的 Desktop Host；非 standalone 时
          // accountSource 永远为空 → Registry 0 provider →
          // settings.model.available=[]。socket 模式固定启用 standalone
          // 账号面：直接读本机 credentials.json + personal provider config。
          socketPath ? { standalone: {} } : undefined,
        ),
      disposeLate: (runtime) => runtime.dispose(),
    });
    options.lifecycle?.signal.throwIfAborted();
    logger.info("Worker Provider Registry 已就绪", {
      accountRevision: providerRegistryRuntime.snapshot.sourceRevisions.account,
      configRevision: providerRegistryRuntime.snapshot.sourceRevisions.config,
      event: "zcode_protocol.provider_registry.ready",
      module: "bootstrap.zcode_protocol",
      providerCount: providerRegistryRuntime.snapshot.registry.providers.length,
    });
    const runtimeSurface = resolveProtocolRuntimeSurface(runtimeEnv);
    const telemetryEnv = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: () => shutdownZCodeTelemetry(),
      create: () =>
        prepareZCodeTelemetryEnv(runtimeEnv, {
          cliVersion: options.version,
          productVersion: options.env?.ZCODE_APP_VERSION,
          runtimeSurface,
        }),
    });
    const telemetryDeviceMid = telemetryEnv.ZCODE_TELEMETRY_DEVICE_MID;
    mcpTelemetryTracker =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpTelemetryTracker({
            idSalt: telemetryDeviceMid ?? traceContext.traceId,
            onEvent: (event) => mcpTelemetrySink?.(event),
            onResourceSamples: (samples) => mcpResourceSink?.(samples),
          });
    // 官方 MCP 身份头端口（spec §7.1/§7.2）：连接池构造早于 server，故用惰性 holder 回填。
    // server 就绪前该端口返回 official_auth_unavailable；HTTP tools/call 会匿名交给服务端
    // 返回结构化权限错误，stdio 则把 reason 下发给插件。连接与工具发现都不受影响。
    // 多连接 socket 模式：cipher 上下文与下方 auth 端口同一来源——最近接入的协议会话 owner。
    credentialCipherBridge = createProtocolCredentialCipher(
      () => latestProtocolServer?.officialMcpAuthRequestContext,
    );
    const mcpCredentialStore = createSharedZCodeCredentialStore({
      env: options.env,
      cipher: credentialCipherBridge.cipher,
    });
    const providerEndpointRoutingPort =
      options.providerEndpointRoutingPort ??
      resolveProcessProviderEndpointRoutingPort({
        credentialStore: mcpCredentialStore,
        appVersion: options.version,
        env: options.env,
        logger,
        network: configResult.config.network,
        sourceTitle: "electron",
      });
    // 官方 MCP 身份头端口（spec §7.1/§7.2）：连接池构造早于 server，故用惰性 holder 回填。
    // 多连接 socket 模式下归最近接入的协议会话 owner；server 就绪前该端口返回
    // official_auth_unavailable；HTTP tools/call 会匿名交给服务端返回结构化权限错误，
    // stdio 则把 reason 下发给插件。连接与工具发现都不受影响。
    const resolveContext = (): OfficialMcpAuthRequestContext | undefined =>
      latestProtocolServer?.officialMcpAuthRequestContext;
    // stdio 官方 MCP 没有 url 可供校验，targetOrigin 只能由宿主给出。
    // 与下面 trustedOrigins 的 resolveZCodeApiOrigin 必须是同一个表达式，否则两侧判定分叉。
    const resolveZCodeApiOrigin = (): string =>
      resolveRuntimeZCodeEndpointOrigin(options.env ?? process.env);
    const workspaceIdentity = (options.env ?? process.env)[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim();
    const officialMcpAuth = {
      authHeadersPort: createOfficialMcpAuthHeadersPort({
        resolveContext,
        // workspaceKey 必须遵守仓库约定 `workspaceIdentity?.trim() || workspacePath`，
        // 否则同路径不同 identity 的远端 workspace 在审计上下文里无法区分。
        // 注意：agent 进程当前没有 identity 来源，因此实际多为 undefined，key 退化为 path；
        // 详见 official-mcp-auth-port.ts 的"剩余缺口"说明。
        // 修复原因：本地会话曾按 MCP 工作目录重算 key，受管 worktree 会话得到 worktree 路径，
        // Host 按 key 路由时找不到所属项目，官方 MCP 授权头请求被拒（docs/git/worktree.md §9.3）。
        // 会话带有协议入口给出的 key 时直接使用。
        resolveWorkspace: ({ workspaceIdentity, workspacePath, workspaceKey }) => {
          const path = workspacePath ?? options.cwd;
          if (!path) return undefined;
          const identity = workspaceIdentity?.trim();
          return {
            ...(identity ? { workspaceIdentity: identity } : {}),
            workspaceKey: workspaceKey || identity || path,
            workspacePath: path,
          };
        },
      }),
      resolveZCodeApiOrigin,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      // 信任判定只看一条：目标 origin 等于当前 ZCode API origin（https）。pluginId 不参与。
      // origin 运行时解析（跟随 production/test 与自建环境），不硬编码域名。
      trustedOrigins: createOfficialMcpTrustedOriginRegistry({
        devTrustedOriginsRaw: (options.env ?? process.env)[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
        resolveZCodeApiOrigin,
      }),
    };
    // 官方插件命令进程的代理端点（技术方案 5.8）：CLI 不持有凭证，端点每个请求向 host 现取
    // 身份头后转发给 zcode-server。和官方 MCP 用同一个 origin 表达式与网络配置。
    const endpointEnv = options.env ?? process.env;
    officialCommandEndpoint = createOfficialCommandEndpoint({
      resolveHeaders: createOfficialCommandAuthHeadersPort({
        // 多连接 socket 模式与官方 MCP auth 端口同一归属：最近接入的协议
        // server 的会话上下文；无 owner 时端点按 official_auth_unavailable 拒绝。
        resolveContext,
        logger,
      }).resolveHeaders,
      resolveZCodeApiOrigin,
      appVersion: endpointEnv.ZCODE_APP_VERSION?.trim() || options.version,
      fetch: createMcpTransportFetch({ env: endpointEnv, network: configResult.config.network }),
      logger,
    });
    const activeOfficialCommandEndpoint = officialCommandEndpoint;
    // MCP elicitation 归属到协议 server 的会话；pool 先于 server 创建，端口延迟绑定。
    // socket 多连接下归最近接入的 owner；--no-plugins 时本分支整体不构造。
    mcpConnectionPool =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpAdapterConnectionPool({
            mcpOAuth: { credentialStore: mcpCredentialStore },
            elicitation: {
              requestElicitation: (request, elicitationOptions) =>
                latestProtocolServer
                  ? latestProtocolServer.requestMcpElicitation(request, elicitationOptions)
                  : Promise.resolve({ action: "decline" as const }),
            },
            // server 通知同样延迟绑定到协议 server。
            notifications: {
              onNotification: (notification) =>
                latestProtocolServer?.handleMcpNotification(notification),
            },
            clientVersion: options.version ?? "0.0.0",
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            nodeFallback: resolveMcpNodeFallbackProvider({
              cliStorageRoot: getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
              logger,
            }),
            officialMcpAuth,
            telemetry: mcpTelemetryTracker,
            workingDirectory: options.cwd,
          });
    mcpPort = mcpConnectionPool?.acquireLease({ leaseId: "protocol-settings" });
    mcpToolCatalogPort = mcpConnectionPool
      ? createInMemoryMcpToolCatalog({ platform: process.platform })
      : undefined;
    // 同一 CLI 进程内的会话共用 MCP 配置 watcher 与读盘结果；修复前每个会话各建一份。
    mcpConfigSourceRegistry = createMcpConfigSourceRegistry({ logger });
    // 同一 CLI 进程内同一 workspace 的会话共用 skill 目录 watcher 与读盘结果，规则与 MCP 配置源相同。
    skillCatalogSourceRegistry = createSkillCatalogSourceRegistry({ logger });
    const activeProviderRegistryRuntime = providerRegistryRuntime;
    const protocolCliStorageRoot = getCliStorageRoot(resolvePath(configResult.config.storage.dir));
    // 无状态端口（纯路径计算 + fs 操作），进程级一份，所有 per-connection server 共享。
    const protocolSessionDataFiles = createNodeSessionDataFiles({
      cliStorageRoot: protocolCliStorageRoot,
      // 与会话运行时的记忆解析同一函数，删除的正是 CLI 读写的那个目录。
      memoryRoot: ({ workspacePath, workspaceIdentity }) =>
        getProjectMemoryRoot(protocolCliStorageRoot, workspacePath, workspaceIdentity),
    });
    const modelSelectionFacade = createNodeModelSelectionFacade(
      activeProviderRegistryRuntime.runtime.registryService,
    );
    options.lifecycle?.signal.throwIfAborted();

    const detachConnection = async (
      entry: AttachedProtocolConnection,
      detachOptions: { orphan: boolean } = { orphan: true },
    ): Promise<void> => {
      if (!attachedConnections.delete(entry) && !detachedConnections.delete(entry)) return;
      entry.sampler?.stop();
      if (latestProtocolServer === entry.server) {
        latestProtocolServer = [...attachedConnections].at(-1)?.server;
      }
      if (detachOptions.orphan) {
        // 建链期早夭等路径可能没走 onTransportClosed；幂等补标记，否则
        // clientDetached=false 的孤儿永远不满足 isReapable，reaper 回收不掉。
        entry.server.markClientDetached(new Error("ZCode Protocol client detached"));
        // 孤儿化：不 shutdown、不释放投影，server 与其 sessions 迁入 detached 池
        // 等收养；broker（connection 级 MCP 资源）也随 entry 保留。
        detachedConnections.add(entry);
        return;
      }
      try {
        entry.server.disposeProjections();
      } catch (error) {
        logger.warn("ZCode Protocol projection dispose failed", {
          errorType: error instanceof Error ? error.name : typeof error,
          event: "zcode_protocol.connection.projection_dispose.failed",
          module: "bootstrap.zcode_protocol",
        });
      }
      try {
        await entry.server.shutdown();
      } catch (error) {
        logger.warn("ZCode Protocol connection server shutdown failed", {
          errorType: error instanceof Error ? error.name : typeof error,
          event: "zcode_protocol.connection.shutdown.failed",
          module: "bootstrap.zcode_protocol",
        });
      }
      ownedServers.delete(entry.server);
      if (entry.broker) {
        ownedBrokers.delete(entry.broker);
        try {
          await entry.broker.close();
        } catch (error) {
          logger.warn("ZCode Protocol connection broker close failed", {
            errorType: error instanceof Error ? error.name : typeof error,
            event: "zcode_protocol.connection.broker_close.failed",
            module: "bootstrap.zcode_protocol",
          });
        }
      }
    };

    /** 进程级 session 归属索引：只检索 detached owner；活连接上的 session 不参与收养。
     *  onTransportClosed 先 markClientDetached、entry 要等 waitForClose 排水才迁
     *  detached 池——窗口内 owner 还挂在 attachedConnections，两边都得扫，
     *  否则窗口内的 resume 会冷物化出第二个 runtime。 */
    const findDetachedSessionOwner = (sessionId: string) => {
      for (const entry of [...detachedConnections, ...attachedConnections]) {
        if (entry.server.isDetached() && entry.server.hasResidentSession(sessionId)) {
          return entry.server;
        }
      }
      return undefined;
    };

    /**
     * 建链在途计数：socket accepted 但尚未进 attachedConnections 的连接。
     * 排空退出判定必须把它算上，否则握手途中被 empty-exit 连监听一起拆掉。
     */
    let attachInFlight = 0;
    /**
     * 连接全排空时 core 只剩空壳监听——旧实现没有这条退出路径，socket core
     * 从此常驻成僵尸（每 workspace 一个，实测堆出 ~2GB RSS）。走 lifecycle
     * 正常关闭；下一个客户端由 ensureServer 探测死 socket → 原子 reclaim 重拉。
     */
    const exitWhenDrained = (): void => {
      if (attachInFlight > 0) return;
      if (attachedConnections.size > 0 || detachedConnections.size > 0) return;
      if (options.lifecycle) options.lifecycle.requestShutdown();
      else void socketListener?.close().catch(() => undefined);
    };
    /** 全空闲孤儿 server 的兜底回收；reaper 判定（无活 turn/无 pending/收养窗口）在 server.isReapable。 */
    const reapDetachedConnections = (): void => {
      for (const entry of detachedConnections) {
        if (!entry.server.isReapable()) continue;
        void detachConnection(entry, { orphan: false }).catch(() => undefined);
      }
      exitWhenDrained();
    };

    // 每接入一条传输连接就建一套独立的协议会话 owner（server+connection），
    // 复用同一份进程级 Host 资源；socket 与 stdio 共用这条装配路径。
    const attachConnection = async (
      connectionInput: NodeJS.ReadableStream,
      connectionOutput: NodeJS.WritableStream,
    ): Promise<AttachedProtocolConnection> => {
      // connection/broker 迟于 server 构造；createZCodeApp 闭包惰性读这两个绑定。
      let connection!: ZCodeProtocolNdjsonConnection;
      let connectionBroker: NodeReplBrowserBroker | undefined;
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (appOptions = {}) =>
          createZCodeApp({
            ...applyProtocolProviderRegistry(
              applyProtocolPresentationSurface(appOptions, presentationSurface),
              activeProviderRegistryRuntime.runtime.registryService,
              activeProviderRegistryRuntime.configuredDefaultModelSelection,
            ),
            // 只读同进程已应用快照；不为子任务另发 Host RPC，也不在 ModelFactory 偷换模型。
            resolveEffectiveModelSelection: (selection) => {
              const view = modelSelectionFacade.getView(undefined, undefined, { selection });
              return {
                effectiveSelection: view.effectiveSelection ?? null,
                selectionIssue: view.selectionIssue,
              };
            },
            env: {
              ...telemetryEnv,
              ...appOptions.env,
              ...(telemetryDeviceMid ? { ZCODE_TELEMETRY_DEVICE_MID: telemetryDeviceMid } : {}),
            },
            ...(connectionBroker ? { nodeReplBrowserBroker: connectionBroker } : {}),
            ...(mcpConnectionPool
              ? {
                  mcpPortFactory: () =>
                    mcpConnectionPool!.acquireLease({
                      leaseId: appOptions.sessionId,
                      sessionId: appOptions.sessionId,
                    }),
                }
              : {}),
            mcpToolCatalogPort,
            mcpConfigSourceRegistry,
            skillCatalogSourceRegistry,
            // 桌面交互入口：首个请求不等全部 MCP server，自动任务轮次仍由 runtime 改为等待。
            // attach 共享 core（noPlugins）的 MCP 只有 client 声明：首轮必须等到它连上
            // （issue #31），保持默认 blocking。
            ...(options.noPlugins === true
              ? { noPlugins: true }
              : { mcpStartupPolicy: "background" as const }),
            providerEndpointRoutingPort,
            officialCommandEnv: (sessionId, workspace, observer) =>
              activeOfficialCommandEndpoint.envForSession(sessionId, workspace, observer),
            sourceTitle: "electron",
            onToolExecResource: (params) =>
              connection.send({ method: zcodeProtocolNotifications.toolExecResource, params }),
          }),
        pluginPreparation,
        pluginDiscovery,
        cwd: options.cwd,
        noPlugins: options.noPlugins,
        env: options.env,
        loggerFactory,
        mcpPort,
        mcpTelemetry: mcpTelemetryTracker,
        sessionStore,
        sessionDataFiles: protocolSessionDataFiles,
        // 断线重连/新客户端 resume 的收养入口：只找 detached owner，活连接
        // 上的 session 保持对原 client 的排他权。
        locateSessionOwner: (sessionId) => findDetachedSessionOwner(sessionId),
        syncAccountProviderConfig: activeProviderRegistryRuntime.syncAccountProviderConfig,
        // standalone 账号面自带凭据鉴权端口（createStandaloneProviderRuntimeHeadersPort）。
        // socket core 没有 Host 可应答 interactionRequestProviderRuntimeHeaders，
        // createWorkspaceZCodeApp 按 deps 优先注入它，模型请求才能拿到签名头。
        ...(activeProviderRegistryRuntime.providerRuntimeHeadersPort
          ? {
              providerRuntimeHeadersPort:
                activeProviderRegistryRuntime.providerRuntimeHeadersPort,
            }
          : {}),
        refreshProviderRegistry: async (reason) => {
          await activeProviderRegistryRuntime.runtime.registryService.refresh(reason);
        },
        version: options.version,
      });
      ownedServers.add(server);
      latestProtocolServer = server;
      try {
        if (configResult.config.features.mcp !== false) {
          connectionBroker = await acquireProtocolStartupResource({
            signal: options.lifecycle?.signal,
            logger,
            create: async () => {
              const broker = createNodeReplBrowserBroker({
                browserControlPort: server.browserControlPort,
                logger,
                platform: process.platform,
              });
              await broker.ready;
              return broker;
            },
            disposeLate: (broker) => broker.close(),
          });
          ownedBrokers.add(connectionBroker);
        }
        connection = new ZCodeProtocolNdjsonConnection({
          signal: options.lifecycle?.signal,
          clearPostResponseMessages: () => server.clearPostResponseMessages(),
          handleMessage: (message) => server.handleMessage(message),
          input: connectionInput,
          logger,
          onTransportClosed: (error) => server.markClientDetached(error),
          output: connectionOutput,
          takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
        });
        server.setNotificationSink((notification) => connection.send(notification));
      } catch (error) {
        ownedServers.delete(server);
        if (connectionBroker) ownedBrokers.delete(connectionBroker);
        if (latestProtocolServer === server) {
          latestProtocolServer = [...attachedConnections].at(-1)?.server;
        }
        try {
          server.disposeProjections();
        } catch {
          /* 装配失败路径的清理异常不能掩盖原始错误 */
        }
        try {
          await server.shutdown();
        } catch {
          /* 同上 */
        }
        await connectionBroker?.close().catch(() => undefined);
        throw error;
      }
      const entry: AttachedProtocolConnection = {
        ...(connectionBroker ? { broker: connectionBroker } : {}),
        connection,
        server,
      };
      attachedConnections.add(entry);
      // 传输关闭（客户端断开 / abort）→ 该连接的协议会话 owner 孤儿化：turn 与
      // pending 交互随 record 存活，等新连接收养；真正终止边界只剩进程 shutdown。
      void connection.waitForClose().then(
        () => detachConnection(entry),
        () => detachConnection(entry),
      );
      entry.sampler = startProtocolResourceSampler(
        server,
        (message) => connection.send(message),
        logger,
      );
      connection.start();
      return entry;
    };

    mcpResourceSink = (samples) => {
      for (const entry of attachedConnections) {
        entry.connection.send({
          method: zcodeProtocolNotifications.mcpResourceSamples,
          params: samples,
        });
      }
    };
    mcpTelemetrySink = (event) => {
      // 五分钟资源通知取代旧内存通知；tracker 内部孤儿事实仍保留原判据。
      if (event.kind === "memory") return;
      for (const entry of attachedConnections) {
        entry.connection.send({
          method: zcodeProtocolNotifications.mcpTelemetry,
          params: event,
        });
      }
    };

    if (socketPath) {
      // socket 模式客户端随后才 attach；这里启动 tracker，让后续采样到达晚接入的连接。
      mcpTelemetryTracker?.start();
      const attachSocket = (socket: Socket): void => {
        if (socket.destroyed || socket.closed) return;
        attachInFlight += 1;
        void attachConnection(socket, socket)
          .then(
            (entry) => {
              // 建链期间客户端已断开：transport 不会重播已发射的 close，直接走 teardown。
              if (socket.destroyed || socket.closed) void detachConnection(entry);
            },
            (error) => {
              logger.warn("ZCode Protocol socket client attach failed", {
                errorType: error instanceof Error ? error.name : typeof error,
                event: "zcode_protocol.socket.client_attach.failed",
                module: "bootstrap.zcode_protocol",
              });
              socket.destroy();
            },
          )
          .finally(() => {
            attachInFlight -= 1;
          });
      };
      socketListener = await acquireProtocolStartupResource({
        signal: options.lifecycle?.signal,
        logger,
        create: () =>
          listenProtocolSocket({
            socketPath,
            signal: options.lifecycle?.signal,
            logger,
            onConnection: attachSocket,
          }),
        disposeLate: (listener) => listener.close(),
      });
      // 自登记：bind 成功的进程才是 socket 的唯一 owner，.pid/.info 只能由它在
      // listen 后写入；客户端侧写入在并发恢复/双 spawn 竞争下会把死进程登记成
      // owner（实测踩坑：.pid 指向已退出进程，真 listener 无登记）。单一 core
      // 下无条件登记：任何 socket 模式 bind（服务管理器拉起或手动
      // `zcode app-server --socket`）都写 scope:"user"——它只记录数据/共享
      // 范围（一个 core 服务整个用户），不断言监督关系；进程归谁管只能由
      // cgroup/service manager 事实证明，操作者读登记文件时同理对待。
      // workspace 身份只在会话级协议参数里，不再从 spawn env 取（env 里本来也没有）。
      try {
        await writeFile(`${socketPath}.pid`, `${process.pid}\n`, "utf8");
        await writeFile(
          `${socketPath}.info`,
          `${JSON.stringify(
            appServerInfoSchema.parse({
              version: options.version ?? "0.0.0",
              scope: "user",
              socketPath,
              startedAt: new Date().toISOString(),
            }),
          )}\n`,
          "utf8",
        );
      } catch (error) {
        logger.warn("ZCode Protocol socket self-registration failed", {
          errorType: error instanceof Error ? error.name : typeof error,
          event: "zcode_protocol.socket.self_register.failed",
          module: "bootstrap.zcode_protocol",
        });
      }
      startupTimer.complete("ZCode Protocol agent startup completed", {
        context: { socketPath },
        event: "zcode_protocol.startup.completed",
        stage: "total",
      });
      scheduleStartupLogRetentionCleanup(loggerFactory, logger);
      logger.info("ZCode Protocol socket server listening", {
        event: "zcode_protocol.socket.listening",
        module: "bootstrap.zcode_protocol",
        socketPath,
      });
      // 孤儿 server 的兜底回收：detached 且无活 turn、无 pending 反向请求才 shutdown；
      // 挂着 turn 或等交互的孤儿不动，等收养或 detached 超时自行落地。
      detachedSweepTimer = setInterval(reapDetachedConnections, DETACHED_SERVER_SWEEP_INTERVAL_MS);
      detachedSweepTimer.unref?.();
      // 关闭信号只有两个来源：lifecycle abort（信号/调用方）或 listener 自身失败。
      const abort = options.lifecycle?.signal;
      await Promise.race([
        socketListener.closed,
        new Promise<void>((resolve) => {
          if (!abort) return;
          if (abort.aborted) return resolve();
          abort.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      await socketListener.close();
      await Promise.allSettled(
        [...attachedConnections, ...detachedConnections].map((entry) =>
          detachConnection(entry, { orphan: false }),
        ),
      );
    } else {
      const entry = await attachConnection(input, output);
      // stdio 的 tracker 必须等连接 attached 再启动：首发采样只发给 attachedConnections，
      // 先启动会把首批 mcpResourceSamples 丢进空集合（上游顺序即 connection.start 先于 tracker）。
      mcpTelemetryTracker?.start();
      startupTimer.complete("ZCode Protocol agent startup completed", {
        event: "zcode_protocol.startup.completed",
        stage: "total",
      });
      scheduleStartupLogRetentionCleanup(loggerFactory, logger);
      await entry.connection.waitForClose();
    }
  } catch (error) {
    options.lifecycle?.requestShutdown(
      error instanceof Error ? error : new Error("Protocol runtime failed", { cause: error }),
    );
    startupTimer.fail("ZCode Protocol agent startup failed", error, {
      event: "zcode_protocol.startup.failed",
      stage: "total",
    });
    throw error;
  } finally {
    credentialCipherBridge?.dispose();
    options.lifecycle?.requestShutdown();
    if (detachedSweepTimer) clearInterval(detachedSweepTimer);
    await socketListener?.close().catch(() => undefined);
    await officialCommandEndpoint?.close().catch((error: unknown) => {
      logger.warn("Official command endpoint close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.official_command_endpoint.close_failed",
      });
    });
    await cleanupProtocolRuntime({
      logger,
      deadlineAt: options.lifecycle?.deadlineAt,
      server: {
        disposeProjections: () => {
          for (const server of ownedServers) {
            try {
              server.disposeProjections();
            } catch {
              /* 清理兜底：单个 owner 的投影释放失败不阻塞其余资源回收 */
            }
          }
        },
        shutdown: async () => {
          await Promise.allSettled([...ownedServers].map((server) => server.shutdown()));
        },
      },
      pluginPreparation: {
        dispose: async () => {
          pluginDiscovery?.dispose();
          await pluginPreparation.dispose();
          await pluginPrewarm;
        },
      },
      processResourceSampler: {
        stop: () => {
          for (const entry of attachedConnections) entry.sampler?.stop();
        },
      },
      mcpTelemetryTracker,
      nodeReplBrowserBroker: {
        close: async () => {
          await Promise.allSettled([...ownedBrokers].map((broker) => broker.close()));
        },
      },
      mcpPort,
      mcpConnectionPool,
      sessionStore,
      providerRegistryRuntime,
    });
    // 会话关闭步骤有时限，未关完的会话不会释放配置 view；在清理之后强制关闭，watcher 句柄不阻止进程退出。
    mcpConfigSourceRegistry?.close();
    skillCatalogSourceRegistry?.close();
    logger.info("ZCode Protocol agent shutdown completed", {
      ...traceContextToLogContext(traceContext),
      event: "zcode_protocol.shutdown.completed",
      module: "bootstrap.zcode_protocol",
      status: "completed",
    });
  }
}

function resolveProtocolRuntimeSurface(
  env: NodeJS.ProcessEnv,
): "desktop_local_host" | "remote_workspace_host" {
  // Bug 根因：入口曾无条件覆盖 Host 注入值，远程 SSH/WSL/容器 Trace 被归入本地 Desktop。
  return env.ZCODE_TELEMETRY_RUNTIME_SURFACE?.trim() === "remote_workspace_host"
    ? "remote_workspace_host"
    : "desktop_local_host";
}

/** 内置 CLI 的凭据加解密只委托已连接 Host，禁止失败后改为本机系统库读取。 */
function createProtocolCredentialCipher(
  resolveContext: () => OfficialMcpAuthRequestContext | undefined,
) {
  const bridge = createCredentialCipherBridge((request) => {
    const context = resolveContext();
    if (!context) throw new Error("Credential cipher host is unavailable");
    void context
      .requestClient(
        zcodeProtocolMethods.interactionRequestCredentialCipher,
        request,
        credentialCipherReplySchema,
        {},
      )
      .then(
        (reply) => bridge.receive(reply),
        () =>
          bridge.receive({
            requestId: request.requestId,
            result: {
              ok: false,
              error: {
                code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
                message: "Credential cipher host is unavailable",
              },
            },
          }),
      );
  });
  return bridge;
}
