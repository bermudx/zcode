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
import type { AgentRuntimeConfig, BorrowedMcpAccess } from "../types.js";
import type { McpToolDescriptor, PluginReferenceCatalog } from "@zcode/contracts";

const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;

// [TEMPDIAG] client-MCP timeout diagnostics — revert before merge.
let tempDiagSeq = 0;
function tempDiagOpen(point: string, sessionId: unknown, extra = ""): number {
  const op = ++tempDiagSeq;
  tempDiagAt(point, op, sessionId, extra);
  return op;
}
function tempDiagAt(point: string, op: number, sessionId: unknown, extra = ""): void {
  process.stderr.write(
    `[TEMPDIAG] ${point} op=${op} sid=${String(sessionId)} t=${Date.now()}${extra}\n`,
  );
}

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

  // workflow/script 子会话借用父 MCP（评审 R3）：port/config 都不是自己的，
  // startup 唯一要做的是 await 父侧就绪快照。借用分支先于无 port/disabled
  // 早退——port 此刻还没有才是常态。
  if (this.borrowMcpAccess) {
    const borrowEpoch = this.mcpAttachEpoch;
    const borrow = this.borrowMcpAccess({
      signal: this.shutdownSignal,
      traceContext,
    })
      .then((access) => {
        // 等待期间 child 自己的 shutdown/detach/换代已发生：旧快照不得落地。
        if (
          this.mcpClosed ||
          !this.mcpClientAttached ||
          borrowEpoch !== this.mcpAttachEpoch
        ) {
          return { statuses: {}, tools: [] };
        }
        if (access.port) this.mcpPort = access.port;
        if (access.config !== undefined) {
          // 保留父 APPLIED 的 enabled/trust 元数据；servers 置空——子会话只做
          // discovery，绝不接管父连接生命周期。
          this.config.mcp = { ...access.config, servers: {} };
        }
        return access.snapshot;
      })
      .catch((error: unknown) => {
        this.logger?.warn("MCP borrow access failed", {
          ...traceContextToLogContext(traceContext),
          errorKind: mcpErrorKind(error),
          event: "mcp.borrow.failed",
          module: "core.runtime",
          status: "failed",
        });
        return { statuses: {}, tools: [] };
      });
    this.mcpStartupPromise = this.trackResidencyBlockingWork(borrow);
    return this.mcpStartupPromise;
  }

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
      ...(this.config.workspaceKey ? { workspaceKey: this.config.workspaceKey } : {}),
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
  if (!startup || (!this.mcpPort && !this.borrowMcpAccess)) {
    this.mcpToolsRegistered = true;
    return;
  }
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
    // 借用路径的 port 在 startup 完成后才装上（评审 R3）；仍然缺席即空工具面。
    const mcpPort = this.mcpPort;
    if (!mcpPort) {
      this.mcpToolsRegistered = true;
      return;
    }
    const serverCount = Object.keys(this.config.mcp?.servers ?? {}).length;
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
 * 子会话借用不直接走这里：borrowMcpAccess/prepareBorrowedMcp 返回同款 APPLIED
 * 快照（含代际栅栏，评审 R3）；本 getter 服务其余只读调用方。
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
  // 「相同声明」比对的是当前生效声明（staged desired，否则 create 时的
  // config.mcp.servers）——首次 identical resume 在 mcpDesiredServers 仍
  // undefined 时也必须识别为 unchanged，否则 retry 判定根本到不了（评审 R2-修复）。
  const currentDeclaration = this.mcpDesiredServers ?? this.config.mcp?.servers;
  const unchanged =
    currentDeclaration === undefined
      ? // 从未声明过的会话显式下发（含空集）：仍按「变更」暂存，保住
        // desired={} 的显式清空 provenance，不把首次下发吞成 no-op。
        false
      : mcpConfigFingerprint(currentDeclaration) === mcpConfigFingerprint(next);
  // 语义相等（含凭据、键序无关的对象）不等于活连接（评审 R2-修复）：port 上
  // 已 failed/disconnected/missing 的期望 server 需要显式 retry。读 status
  // 前后的 desired/epoch 都必须复核——迟到读不得覆盖更新的配置或复活 detach。
  if (unchanged && !this.mcpReconnectNeeded) {
    const epoch = this.mcpAttachEpoch;
    const desiredBefore = this.mcpDesiredServers;
    const desiredVersion = this.mcpDesiredVersion;
    const retryRequested = await detectMcpRetryNeeded(this, next);
    // status 读期间 desired 可能被并发 configure 替换——迟到的健康判定不得
    // 按旧声明立 retry，也不得覆盖更新的 desired（保留最新声明）。
    if (
      this.mcpClosed ||
      epoch !== this.mcpAttachEpoch ||
      this.mcpDesiredVersion !== desiredVersion ||
      this.mcpDesiredServers !== desiredBefore
    ) {
      return;
    }
    if (!retryRequested) return;
    // 声明没变、连接死了：不推进 desired 版本，只立补连旗标走既有边界路径。
    this.mcpReconnectNeeded = true;
  }
  if (!unchanged) {
    this.mcpDesiredServers = next;
    this.mcpDesiredVersion += 1;
  }
  // 有在跑 / 排队 / 预留的回合时只暂存——本轮继续用旧连接，回合边界再落地。
  if (this.hasActiveOrQueuedTurnWork()) return;
  await this.applyPendingMcpServers();
}

/**
 * 显式 configure/resume 的 retry 判定（评审 R2-修复）：只看当前 port.status 的
 * 活事实——期望启用、不在在飞 connect、且 live 状态为 failed/disconnected/
 * missing 的 server 才算欠连；connecting/disabled/untrusted 一律不打扰。
 * 返回 false 时调用方保持原 no-op 语义（status 不可读时保守不判 retry）。
 */
async function detectMcpRetryNeeded(
  runtime: AgentRuntimeInternal,
  servers: Record<string, McpServerConfig>,
): Promise<boolean> {
  const desiredEnabled = Object.entries(servers)
    .filter(([, config]) => config.enabled !== false)
    .map(([name]) => name);
  if (desiredEnabled.length === 0) return false;
  // 有期望却没 port：资源缺失需重建（createMcpPort 在 apply 里补建）。
  const port = runtime.mcpPort;
  if (!port) return true;
  const inFlight = new Set<string>();
  for (const op of runtime.mcpInFlightConnects) {
    for (const name of Object.keys(op.servers)) inFlight.add(name);
  }
  const statuses = await port.status().catch(() => undefined);
  if (statuses === undefined) return false;
  for (const name of desiredEnabled) {
    if (inFlight.has(name)) continue;
    const status = statuses[name]?.status;
    if (status === undefined || status === "failed" || status === "disconnected") {
      return true;
    }
  }
  return false;
}

export async function setMcpClientAttached(
  this: AgentRuntimeInternal,
  attached: boolean,
): Promise<void> {
  if (this.mcpClosed || attached === this.mcpClientAttached) return;
  const diagOp = tempDiagOpen("mcp.setAttached.enter", this.sessionId, ` attached=${attached}`);
  // detach：同步落下闸门——pending connect 的迟到结果与新准入都被挡在 applied 侧；
  // epoch 递增使在飞 apply 的迟到完成失效（old-owner 不能覆盖新 attachment）。
  this.mcpClientAttached = attached;
  this.mcpAttachEpoch += 1;
  if (attached) {
    // adoption：等挂起的 teardown 收尾（suspend 也排在 apply tail 上），回合边界补连。
    await this.mcpApplyTail;
    tempDiagAt("mcp.setAttached.tailSettled", diagOp, this.sessionId);
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
  tempDiagAt("mcp.setAttached.suspended", diagOp, this.sessionId);
}

export async function applyPendingMcpServers(this: AgentRuntimeInternal): Promise<void> {
  const apply = this.mcpApplyTail.then(() => {
    const diagOp = tempDiagOpen("mcpApply.enter", this.sessionId);
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
      tempDiagAt("mcpApply.exit", diagOp, this.sessionId);
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
    // reconnect/显式 retry 触发的全量 connect 必须让池复用层重校验缓存条目：
    // failed 的就地重连、live 的 ping 保活复用（评审 R2-修复）。
    const revalidate = this.mcpReconnectNeeded;
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
        revalidate,
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

const EMPTY_BORROWED_MCP: BorrowedMcpAccess = {
  snapshot: { statuses: {}, tools: [] },
};

/**
 * 子会话借用入口（评审 R3）：等本 runtime 已排队的 apply tail 与 startup
 * 落定，再按当前 port/status/tools 读一份快照。只等独立的 MCP 工作，从不
 * 等父 turn 本身，也绝不替父落地 staged desired——active 回合内的 pending
 * 配置对借用方不可见（保持 APPLIED 快照语义）。调用方 signal + 本 runtime
 * shutdown 只取消「等待」，不取消父侧 connect。
 */
export async function prepareBorrowedMcp(
  this: AgentRuntimeInternal,
  input: { traceContext: TraceContext; signal: AbortSignal },
): Promise<BorrowedMcpAccess> {
  const diagOp = tempDiagOpen("mcp.borrow.enter", this.sessionId);
  const ABORTED = Symbol("mcp.borrow.aborted");
  // 等待/发现统一走这条：调用方 signal + 本 runtime shutdown 只取消「等」，
  // 不取消父侧 connect/status 本身。
  const raceAbort = async <T>(work: Promise<T>): Promise<T | typeof ABORTED> => {
    const combined = AbortSignal.any([input.signal, this.shutdownSignal]);
    if (combined.aborted) return ABORTED;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race<T | typeof ABORTED>([
        work,
        new Promise<never>((_, reject) => {
          abort = () => reject(combined.reason);
          combined.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } catch {
      return ABORTED;
    } finally {
      if (abort) combined.removeEventListener("abort", abort);
    }
  };
  // work 失败不等于 abort：tail/startup 落定（含失败）都继续走栅栏重读；
  // 只有调用方/父 shutdown 信号才算取消。
  const waitFor = async (work: Promise<unknown>): Promise<boolean> =>
    (await raceAbort(work.then(
      () => true as const,
      () => true as const,
    ))) === true;
  // tail/startup 在等待期间可能被新一轮工作替换——重读身份直到两次捕获一致。
  // 发现读（status/listTools）也必须在同一栅栏内：读期间发生 queued apply、
  // detach+adopt 或 port 换代会让 config/port/status 混代——任何身份变化都
  // 丢弃本轮并重读稳定的 applied 面（评审 R3-返工）。
  try {
    for (;;) {
    const tail = this.mcpApplyTail;
    const startup = this.mcpStartupPromise;
    tempDiagAt("mcp.borrow.waitTail", diagOp, this.sessionId);
    if (!(await waitFor(tail))) return EMPTY_BORROWED_MCP;
    tempDiagAt("mcp.borrow.tailSettled", diagOp, this.sessionId);
    tempDiagAt("mcp.borrow.waitStartup", diagOp, this.sessionId);
    if (!(await waitFor(startup ?? Promise.resolve()))) return EMPTY_BORROWED_MCP;
    tempDiagAt("mcp.borrow.startupSettled", diagOp, this.sessionId);
    if (tail !== this.mcpApplyTail || startup !== this.mcpStartupPromise) continue;
    // owner 在等待期间变了（detach/shutdown）：detached 的正确答案是空；
    // 旧快照不得交还给借用方。
    if (this.mcpClosed || !this.mcpClientAttached) return EMPTY_BORROWED_MCP;
    const epoch = this.mcpAttachEpoch;
    const appliedVersion = this.mcpAppliedVersion;
    const configRef = this.config.mcp;
    const config = configRef === undefined ? undefined : structuredClone(configRef);
    const port = this.mcpPort;
    if (!port || config?.enabled === false) {
      return { ...EMPTY_BORROWED_MCP, ...(config !== undefined ? { config } : {}) };
    }
    const statuses = await raceAbort(port.status().catch(() => ({})));
    if (statuses === ABORTED) return EMPTY_BORROWED_MCP;
    const tools = await raceAbort(port.listTools().catch(() => []));
    if (tools === ABORTED) return EMPTY_BORROWED_MCP;
    if (this.mcpClosed || !this.mcpClientAttached || input.signal.aborted) {
      return EMPTY_BORROWED_MCP;
    }
    if (
      epoch !== this.mcpAttachEpoch ||
      appliedVersion !== this.mcpAppliedVersion ||
      tail !== this.mcpApplyTail ||
      startup !== this.mcpStartupPromise ||
      port !== this.mcpPort ||
      configRef !== this.config.mcp
    ) {
      continue;
    }
    return {
      ...(config !== undefined ? { config } : {}),
      port,
      snapshot: { statuses, tools },
    };
    }
  } finally {
    tempDiagAt("mcp.borrow.exit", diagOp, this.sessionId);
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
