import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import { registerMcpTools, traceContextToLogContext } from "../deps.js";
import type {
  McpConnectionSnapshot,
  McpPort,
  McpServerConfig,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal, McpConnectOperation } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import type { McpToolDescriptor, PluginReferenceCatalog } from "@zcode/contracts";

const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;

export async function refreshWorkspaceTrustAdmission(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  try {
    await runtime.mcpPort?.refreshWorkspaceTrustAdmission?.();
  } catch (error) {
    // 提示发布失败不能阻断普通聊天；执行权限仍由 MCP gate 独立检查。
    runtime.logger?.warn("MCP trust admission publication failed", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.trust.admission.failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 只有同时携带 resolver 注入的官方 plugin id 和本进程私有 authority 的 server 才能共享
 * Computer Use 项目授权。server 名、tool 名和 manifest env 都可被第三方仿造，不能单独作为信任依据。
 */
export function computeOfficialCuaServerNames(
  servers: Record<string, McpServerConfig>,
  trustedServerNames: ReadonlySet<string>,
): Set<string> {
  const expectedAuthority = getCapturedZCodeCuaBrokerCredentials().pluginAuthority;
  const names = new Set<string>();
  if (!expectedAuthority) return names;

  for (const [name, config] of Object.entries(servers)) {
    if (!trustedServerNames.has(name)) continue;
    if (config.type !== "stdio") continue;
    if (
      config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() !==
        ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
      config.env?.[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim() !== expectedAuthority
    ) {
      continue;
    }
    names.add(name);
  }
  return names;
}

export function startMcpStartup(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<McpConnectionSnapshot> | undefined {
  if (this.mcpInitialized) return this.mcpStartupPromise;
  this.mcpInitialized = true;

  // client detach / 关闭期间不得借 startup 补连或复活 stdio（issue #31）；
  // attach 后 applyPendingMcpServers 走显式补连路径，不经过这里的 one-shot 门。
  if (!this.mcpPort || this.config.mcp?.enabled === false || !this.mcpClientAttached) {
    this.mcpToolsRegistered = true;
    return undefined;
  }

  const servers = this.config.mcp?.servers ?? {};
  if (Object.keys(servers).length === 0) {
    const startup = Promise.all([this.mcpPort.status(), this.mcpPort.listTools()])
      .then(([statuses, tools]) => ({ statuses, tools }))
      .catch((error) => {
        this.logger?.warn("MCP existing tool discovery failed", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.existing_tools.failed",
          module: "core.runtime",
          status: "failed",
        });
        return { statuses: {}, tools: [] };
      });
    this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
    return this.mcpStartupPromise;
  }

  const startedAt = Date.now();
  // startup connect 也走 client admission 闸门：detach 中止卡住的握手、epoch 挡住
  // 迟到完成（评审 S2）；shutdown 照常收口。不用 applySignal——startup 不属于 apply tail。
  const startupController = new AbortController();
  const abortFromShutdown = () => startupController.abort(this.shutdownSignal.reason);
  if (this.shutdownSignal.aborted) {
    startupController.abort(this.shutdownSignal.reason);
  } else {
    this.shutdownSignal.addEventListener("abort", abortFromShutdown, { once: true });
  }
  const startupEpoch = this.mcpAttachEpoch;
  // 在飞登记在 connect await 之前、finally 只删本条记录：constructor startup 与
  // 并发 apply 各有独立记录，互不覆盖（评审 F1）。
  const connectOp: McpConnectOperation = {
    servers,
    controller: startupController,
    epoch: startupEpoch,
  };
  this.mcpInFlightConnects.add(connectOp);
  const startup = this.mcpPort
    .connectConfiguredServers(servers, {
      // authorization_code MCP 无人完成浏览器授权时，session 启动过去会等默认 5 分钟，
      // 导致模型请求迟迟不发出；session 只等 15s，授权入口由设置页 mcp/list 展示。
      signal: startupController.signal,
      oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
      trace: traceContext,
      workingDirectory: this.workingDirectory,
      workspaceIdentity: this.config.workspaceIdentity?.toString(),
    })
    .then((snapshot) => {
      // detach/close/adopt 期间的迟到 startup 完成不算数：suspend 已接管
      // teardown，不得把旧 owner 的工具快照交给 initializeMcp 注册。
      if (
        this.mcpClosed ||
        startupEpoch !== this.mcpAttachEpoch ||
        !this.mcpClientAttached
      ) {
        return { statuses: {}, tools: [] };
      }
      const statusCounts = Object.values(snapshot.statuses).reduce<Record<string, number>>(
        (counts, status) => {
          counts[status.status] = (counts[status.status] ?? 0) + 1;
          return counts;
        },
        {},
      );
      this.logger?.info("MCP startup completed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        event: "mcp.startup.completed",
        module: "core.runtime",
        serverCount: Object.keys(servers).length,
        status: "completed",
        statusCounts,
        toolCount: snapshot.tools.length,
      });
      return snapshot;
    })
    .catch((error) => {
      this.logger?.warn("MCP startup failed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        // adapter 错误 message 可能含 command/env/header 凭据——只报类别（评审 R8）。
        errorKind: mcpErrorKind(error),
        event: "mcp.startup.failed",
        module: "core.runtime",
        status: "failed",
      });
      return { statuses: {}, tools: [] };
    })
    .finally(() => {
      this.shutdownSignal.removeEventListener("abort", abortFromShutdown);
      this.mcpInFlightConnects.delete(connectOp);
    });
  this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
  this.logger?.debug("MCP startup scheduled", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.startup.scheduled",
    module: "core.runtime",
    serverCount: Object.keys(servers).length,
    status: "started",
  });
  return this.mcpStartupPromise;
}

export async function initializeMcp(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (this.mcpToolsRegistered) return;

  const startup = this.startMcpStartup(traceContext);
  const mcpPort = this.mcpPort;
  if (!startup || !mcpPort) {
    this.mcpToolsRegistered = true;
    return;
  }
  const serverCount = Object.keys(this.config.mcp?.servers ?? {}).length;
  const initEpoch = this.mcpAttachEpoch;

  try {
    await refreshWorkspaceTrustAdmission(this, traceContext);
    const snapshot = await startup;
    this.shutdownSignal.throwIfAborted();
    // 等 snapshot 期间 boundary apply 可能已完成 connect+注册并把
    // mcpToolsRegistered 置位、mcpStartupPromise 换成自己的快照；detach/adopt
    // 亦换了 owner（epoch 变）。任一发生即丢弃这份旧 startup 结果——
    // 旧快照不得覆盖更新的注册（评审 F1）。
    if (
      this.mcpToolsRegistered ||
      this.mcpStartupPromise !== startup ||
      !this.mcpClientAttached ||
      initEpoch !== this.mcpAttachEpoch
    ) {
      this.mcpToolsRegistered = true;
      return;
    }
    const registered = registerMcpTools(this.registry, mcpPort, snapshot.tools, {
      allowedTools: this.config.toolAllowlist,
      disallowedTools: this.config.toolDisallowlist,
      officialCuaServerNames: computeOfficialCuaServerNames(
        this.config.mcp?.servers ?? {},
        new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
      ),
      // 插件 UI：display.ui 需要 server → pluginId 的归属；catalog 是 session 冻结的唯一权威。
      pluginIdByServerName: buildPluginIdByServerName(this.config.pluginReferenceCatalog),
    });
    if (registered.length > 0) {
      this.invalidateToolCache();
    }
    // A7：记住注册集合与签名，回合边界 refreshMcpToolsIfChanged 据此判断是否重注册。
    this.registeredMcpToolNames = registered;
    this.mcpToolsSignature = mcpToolsSignature(snapshot.tools);
    this.mcpToolListRevision = mcpPort.toolListRevision?.();
    this.logger?.info("MCP tools registered", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.tools.registered",
      module: "core.runtime",
      registeredToolCount: registered.length,
      serverCount,
      status: "completed",
    });
  } catch (error) {
    this.mcpToolsRegistered = true;
    this.logger?.warn("MCP initialization failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.initialization.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
  this.mcpToolsRegistered = true;
}

/**
 * server 名 → 插件稳定 id。catalog 里 disabled 插件的 mcpServerNames 为空，天然不参与；
 * 同名冲突插件的 server 名互不相同（带插件名前缀），不需要额外去重。
 */
function buildPluginIdByServerName(
  catalog: PluginReferenceCatalog | undefined,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const plugin of catalog?.plugins ?? []) {
    for (const serverName of plugin.mcpServerNames) map.set(serverName, plugin.pluginId);
  }
  return map;
}

function mcpToolsSignature(descriptors: readonly McpToolDescriptor[]): string {
  return descriptors
    .map((tool) => `${tool.serverName}\u0001${tool.toolName}\u0001${tool.description ?? ""}`)
    .sort()
    .join("\n");
}

/**
 * client 注入 MCP 声明的语义指纹（issue #31）：对象键递归排序（server 列表与
 * env/headers 的键序无关），数组保序（stdio argv 顺序有语义）。env/header 值参与
 * 比较——凭据轮换必须触发重连。
 */
function mcpConfigFingerprint(servers: Record<string, McpServerConfig>): string {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = sortValue(record[key]);
      return sorted;
    }
    return value;
  };
  return JSON.stringify(sortValue(servers));
}

/** MCP 相关错误的脱敏类别：adapter/config 错误 message 可能回显 command/env/header/URL。 */
function mcpErrorKind(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

/**
 * 只返回 client 显式 override（克隆快照），undefined = 从未注入过——facade 据此回落
 * 默认完整清单（含 builtin），不能拿 undefined 当空集、也不能把内部 desired 裸引用给出。
 */
export function getConfiguredMcpServers(
  this: AgentRuntimeInternal,
): Record<string, McpServerConfig> | undefined {
  return this.mcpDesiredServers === undefined
    ? undefined
    : structuredClone(this.mcpDesiredServers);
}

export function getMcpPort(this: AgentRuntimeInternal): McpPort | undefined {
  return this.mcpPort;
}

/**
 * 已落地的生效 MCP 配置克隆——只读 config.mcp（APPLIED），绝不读 pending desired。
 * workflow/script 子会话借用父 port 时发现路径按它走（评审 S4）。
 */
export function getEffectiveMcpConfig(
  this: AgentRuntimeInternal,
): AgentRuntimeConfig["mcp"] {
  return this.config.mcp === undefined ? undefined : structuredClone(this.config.mcp);
}

export async function configureMcpServers(
  this: AgentRuntimeInternal,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  if (this.mcpClosed) return;
  const next = structuredClone(servers);
  const unchanged =
    this.mcpDesiredServers !== undefined &&
    mcpConfigFingerprint(this.mcpDesiredServers) === mcpConfigFingerprint(next);
  // 语义相等（含凭据、键序无关的对象）即 no-op——但欠着重连/欠账时必须照常落地，
  // detach 期间的同配置 resume 不能吞掉补连义务（issue #31 评审 R2）。
  if (unchanged && !this.mcpReconnectNeeded) return;
  if (!unchanged) {
    this.mcpDesiredServers = next;
    this.mcpDesiredVersion += 1;
  }
  // 有在跑 / 排队 / 预留的回合时只暂存——本轮继续用旧连接，回合边界再落地。
  if (this.hasActiveOrQueuedTurnWork()) return;
  await this.applyPendingMcpServers();
}

export async function setMcpClientAttached(
  this: AgentRuntimeInternal,
  attached: boolean,
): Promise<void> {
  if (this.mcpClosed || attached === this.mcpClientAttached) return;
  // detach：同步落下闸门——pending connect 的迟到结果与新准入都被挡在 applied 侧；
  // epoch 递增使在飞 apply 的迟到完成失效（old-owner 不能覆盖新 attachment）。
  this.mcpClientAttached = attached;
  this.mcpAttachEpoch += 1;
  if (attached) {
    // adoption：等挂起的 teardown 收尾（suspend 也排在 apply tail 上），回合边界补连。
    await this.mcpApplyTail;
    return;
  }
  // 连接即将断开：applied 快照不再等于活连接，先立 reconnect 旗标——
  // 否则 detach 与 attach 之间的一次 boundary apply 会看到「已应用」而永远不再补连。
  this.mcpReconnectNeeded = true;
  const port = this.mcpPort;
  // teardown 覆盖四张表的并集：已应用、desired、config 来源、全部在飞 connect
  // 登记——缺任何一张都会漏掉「被替换但仍在握手」的 server（评审 S2/F1）。
  // 先取完并集再逐个 abort controller，顺序与登记语义无关但保持快照先行。
  const suspendedNames = new Set<string>([
    ...Object.keys(this.mcpAppliedServers ?? {}),
    ...Object.keys(this.mcpDesiredServers ?? {}),
    ...Object.keys(this.config.mcp?.servers ?? {}),
  ]);
  const detachedReason = new Error("MCP client detached");
  for (const op of this.mcpInFlightConnects) {
    for (const name of Object.keys(op.servers)) suspendedNames.add(name);
  }
  // 取消在飞 client connect（不动整轮 abort）：卡在握手的 stdio 立即被拒绝，
  // 而不是留在池里等默认连接超时（评审 R3）。startup connect 走同一闸门。
  for (const op of this.mcpInFlightConnects) op.controller.abort(detachedReason);
  const suspend = this.mcpApplyTail.then(async () => {
    if (!port) return;
    const failed: string[] = [];
    for (const name of suspendedNames) {
      try {
        // 逐 server 断开而非 lease.close()：lease 保持可重连，session 隔离条目在
        // zero-grace session 池里立即收 stdio 子进程（issue #31 detach 语义）。
        await port.disconnectServer(name);
      } catch (error) {
        failed.push(name);
        this.logger?.warn("MCP client suspend disconnect failed", {
          errorKind: mcpErrorKind(error),
          event: "mcp.client_suspend.disconnect_failed",
          module: "core.runtime",
          serverName: name,
        });
      }
    }
    // 断连失败不能沉默成功：计数上报，调用方（detach 边界）拿到真实失败。
    if (failed.length > 0) {
      throw new Error(`MCP suspend disconnect failed for ${failed.length} server(s)`);
    }
  });
  this.mcpApplyTail = suspend.catch(() => undefined);
  this.trackResidencyBlockingWork(suspend);
  await suspend;
}

export async function applyPendingMcpServers(this: AgentRuntimeInternal): Promise<void> {
  const apply = this.mcpApplyTail.then(() => {
    // 每次 apply 独立 AbortController：detach 经在飞登记表取消 client connect，
    // 不扩散成整轮 shutdown abort（评审 R3）。shutdown 仍要收口在飞 connect。
    const controller = new AbortController();
    const abortFromShutdown = () => controller.abort(this.shutdownSignal.reason);
    if (this.shutdownSignal.aborted) {
      controller.abort(this.shutdownSignal.reason);
    } else {
      this.shutdownSignal.addEventListener("abort", abortFromShutdown, { once: true });
    }
    return performMcpApply.call(this, controller).finally(() => {
      this.shutdownSignal.removeEventListener("abort", abortFromShutdown);
    });
  });
  this.mcpApplyTail = apply.catch(() => undefined);
  this.trackResidencyBlockingWork(apply);
  await apply;
}

async function performMcpApply(
  this: AgentRuntimeInternal,
  applyController: AbortController,
): Promise<void> {
  const applySignal = applyController.signal;
  // 一次 tail 可以消化多轮 stage；每轮开始重读最新 desired，避免应用过期配置。
  while (!this.mcpClosed) {
    const desiredVersion = this.mcpDesiredVersion;
    if (
      desiredVersion === this.mcpAppliedVersion &&
      !this.mcpReconnectNeeded &&
      // 未注入过的会话没有欠账；注入过的会话 applied 快照必已落地。
      !(this.mcpDesiredServers !== undefined && this.mcpAppliedServers === undefined)
    ) {
      return;
    }
    if (!this.mcpClientAttached) {
      // detach 期间不补连；attach 会立 reconnect 旗标。
      this.mcpAppliedVersion = desiredVersion;
      return;
    }
    const desired =
      this.mcpDesiredServers !== undefined
        ? this.mcpDesiredServers
        : (this.config.mcp?.servers ?? {});
    const applied =
      this.mcpAppliedServers !== undefined
        ? this.mcpAppliedServers
        : (this.config.mcp?.servers ?? {});
    if (!this.mcpReconnectNeeded && mcpConfigFingerprint(desired) === mcpConfigFingerprint(applied)) {
      this.mcpAppliedServers = this.mcpDesiredServers;
      this.mcpAppliedVersion = desiredVersion;
      return;
    }
    let port = this.mcpPort;
    if (!port && Object.keys(desired).length > 0) {
      // 迟到注入：空会话首个非空声明在这里补建 session port；工厂缺席则报边界错。
      port = this.createMcpPort?.();
      this.mcpPort = port;
      if (!port) {
        throw new Error("Client MCP servers were provided but this session has no MCP port factory");
      }
    }
    if (!port) {
      if (this.mcpDesiredServers !== undefined && Object.keys(desired).length === 0) {
        // 无 port 的显式清空：旧工具名仍需注销。
        const previous = new Set(this.registeredMcpToolNames ?? []);
        for (const name of previous) this.registry.unregister(name);
        if (previous.size > 0) {
          this.registeredMcpToolNames = [];
          this.invalidateToolCache();
        }
      }
      this.mcpAppliedServers =
        this.mcpDesiredServers !== undefined ? structuredClone(desired) : this.mcpAppliedServers;
      this.mcpAppliedVersion = desiredVersion;
      this.mcpReconnectNeeded = false;
      return;
    }
    // 连接开始时的 attachment epoch：connect/注册期间的 detach/attach 使本轮结果
    // 过期——只有当前 attached owner 允许提交 apply / 清 reconnect 旗标（评审 R2）。
    const epoch = this.mcpAttachEpoch;
    // 在飞登记跟随本次 connect await、finally 只删本条：startup 与并发/后续
    // apply 的记录互不覆盖，detach 并集按全表补齐在飞 server（评审 S2/F1）。
    const connectOp: McpConnectOperation = {
      servers: desired,
      controller: applyController,
      epoch,
    };
    this.mcpInFlightConnects.add(connectOp);
    let snapshot: McpConnectionSnapshot;
    try {
      snapshot = await port.connectConfiguredServers(desired, {
        signal: applySignal,
        oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
        trace: this.rootTraceContext,
        workingDirectory: this.workingDirectory,
        workspaceIdentity: this.config.workspaceIdentity?.toString(),
      });
    } catch (error) {
      // 被 detach/shutdown 撤销的操作必须退出（评审 S1）：applySignal 是一次性的，
      // epoch 变了还继续 loop 只会用已撤销的 signal 反复拒绝，挂死 suspend/adopt。
      if (this.mcpClosed || epoch !== this.mcpAttachEpoch || applySignal.aborted) {
        return;
      }
      // 当前 owner 的失败：欠账保留（appliedVersion 不前移），下一边界重试；
      // 诊断只报类别与计数，不回显 adapter 错误 message（可能含凭据）。
      this.logger?.warn("MCP apply connect failed", {
        errorKind: mcpErrorKind(error),
        event: "mcp.apply.connect_failed",
        module: "core.runtime",
        serverCount: Object.keys(desired).length,
        status: "failed",
      });
      return;
    } finally {
      this.mcpInFlightConnects.delete(connectOp);
    }
    // 迟到完成不得覆盖更新状态：连接期间 desired 变了 / attachment 变了 / runtime 关了
    // 都丢弃本轮结果。同一 epoch 的 desired 更新可以续下一轮；attachment 撤销只能退出——
    // applySignal 已经作废，revoked operation 不得再发起新连接（评审 S1）。
    if (this.mcpClosed || epoch !== this.mcpAttachEpoch || !this.mcpClientAttached) {
      return;
    }
    if (desiredVersion !== this.mcpDesiredVersion) {
      continue;
    }
    // 显式重注册而非靠 toolListRevision 求和：清空/替换时旧的注册名必须先注销。
    const previous = new Set(this.registeredMcpToolNames ?? []);
    for (const name of previous) this.registry.unregister(name);
    const registered = registerMcpTools(this.registry, port, snapshot.tools, {
      allowedTools: this.config.toolAllowlist,
      disallowedTools: this.config.toolDisallowlist,
      officialCuaServerNames: computeOfficialCuaServerNames(
        desired,
        new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
      ),
      pluginIdByServerName: buildPluginIdByServerName(this.config.pluginReferenceCatalog),
    });
    this.registeredMcpToolNames = registered;
    this.mcpToolsSignature = mcpToolsSignature(snapshot.tools);
    this.mcpToolListRevision = port.toolListRevision?.();
    // one-shot 门也同步：空会话注入后 initializeMcp 不得再走「无 server 早退」旧分支。
    this.mcpInitialized = true;
    this.mcpToolsRegistered = true;
    this.mcpStartupPromise = Promise.resolve(snapshot);
    this.invalidateToolCache();
    // R5：生效配置只在整轮边界提交——subagent/startup 读 config.mcp 必须看到
    // 与连接一致的 servers/enabled；本回合已冻结的 admission 不受影响。
    if (this.mcpDesiredServers !== undefined) {
      this.config.mcp = {
        ...this.config.mcp,
        enabled: Object.keys(desired).length > 0,
        servers: structuredClone(desired),
      };
    }
    this.logger?.info("MCP configured servers applied", {
      ...traceContextToLogContext(this.rootTraceContext),
      event: "mcp.apply.completed",
      module: "core.runtime",
      registeredToolCount: registered.length,
      removedToolCount: previous.size,
      serverCount: Object.keys(desired).length,
      status: "completed",
    });
    if (this.mcpDesiredServers !== undefined && Object.keys(desired).length === 0) {
      // client 显式清空（[]）：释放 session 自有资源；工厂 memo 复位，再次注入拿全新 port。
      // 借用式 port（无 createMcpPort——注入方拥有）只断开连接，不代替注入方关资源（评审 R7）。
      if (this.createMcpPort) {
        await port.close();
        this.mcpPort = undefined;
      }
    }
    this.mcpAppliedServers =
      this.mcpDesiredServers !== undefined ? structuredClone(desired) : this.mcpAppliedServers;
    this.mcpAppliedVersion = desiredVersion;
    this.mcpReconnectNeeded = false;
    return;
  }
}

/**
 * 回合开始前刷新 MCP 工具表。只有端口报告 tools/list_changed 计数变化时才重新 listTools
 * （adapter 对收到通知的 server 重拉），再比较工具签名，变了就注销旧的、注册新的并失效工具缓存。
 * 不实现 toolListRevision 的端口（mock / 静态 server）永远不刷新；回合内也不刷新（已拍板）。
 */
export async function refreshMcpToolsIfChanged(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const mcpPort = this.mcpPort;
  if (!mcpPort || !this.mcpToolsRegistered) return;
  const revision = mcpPort.toolListRevision?.();
  if (revision === undefined || revision === this.mcpToolListRevision) return;
  let descriptors: McpToolDescriptor[];
  try {
    descriptors = await mcpPort.listTools();
  } catch {
    return;
  }
  this.mcpToolListRevision = revision;
  const signature = mcpToolsSignature(descriptors);
  if (this.mcpToolsSignature === signature) return;
  const previous = new Set(this.registeredMcpToolNames ?? []);
  for (const name of previous) this.registry.unregister(name);
  const registered = registerMcpTools(this.registry, mcpPort, descriptors, {
    allowedTools: this.config.toolAllowlist,
    disallowedTools: this.config.toolDisallowlist,
    officialCuaServerNames: computeOfficialCuaServerNames(
      this.config.mcp?.servers ?? {},
      new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
    ),
    pluginIdByServerName: buildPluginIdByServerName(this.config.pluginReferenceCatalog),
  });
  this.registeredMcpToolNames = registered;
  this.mcpToolsSignature = signature;
  this.invalidateToolCache();
  this.logger?.info("MCP tools re-registered after list_changed", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.tools.reregistered",
    module: "core.runtime",
    removedToolCount: previous.size,
    registeredToolCount: registered.length,
    status: "completed",
  });
}
