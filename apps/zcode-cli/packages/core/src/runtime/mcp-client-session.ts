import type {
  McpConfigurationSnapshot,
  McpConfigurationSource,
  McpConnectOptions,
  McpPort,
  McpServerConfig,
} from "@zcode/contracts";
import { mcpConfigKey } from "@zcode/contracts";
import {
  createMcpSession,
  type McpSession,
  type McpSessionConfigurationSource,
} from "../mcp/runtime/session.js";
import { isBorrowedMcpPort } from "../subagent/borrowed-mcp-port.js";
import type { AgentRuntimeInternal } from "./internal.js";
import type { AgentRuntimeConfig } from "./types.js";
import { traceContextToLogContext } from "./deps.js";
import { initializeMcp } from "./methods/mcp.js";

type Configuration = Partial<McpConfigurationSnapshot>;

/** session 启动时本 caller 等待 OAuth 授权的上限；授权事务本身继续存活。 */
const MCP_SESSION_OAUTH_WAIT_MS = 15_000;

/**
 * client detach 期间的配置快照：连接全部收敛到空集。client 的声明仍留在 override 里，
 * adoption 后恢复它。
 */
const MCP_CLIENT_SUSPENDED: Configuration = Object.freeze({ enabled: false, servers: {} });

/**
 * client 声明 MCP（issue #31）的配置源。上游的 McpSession 只认配置源：快照一变就自己收敛
 * 连接、登记与撤销工具。fork 的 client 声明、detach、adoption 因此都只是「发布一份新快照」，
 * 不再各自连接或断开：
 * - 没有 client 声明时透传 base（磁盘 / plugin 配置源），上游的热更新行为不变；
 * - 没有 base（noPlugins 会话不读磁盘配置）时透传 create 时的 config.mcp：它就是客户端在
 *   session/create 里的声明，上游 McpSession 的初始 configuration 也是这一份；
 * - 有 client 声明时快照就是声明本身——它是完整的会话 override，不与 base 合并；
 * - detach 把快照换成空集，adoption 换回声明。
 */
export interface McpClientConfigSource {
  /**
   * 交给 McpSession 的配置源 view。session.close() 只释放这个 view；override 状态留给
   * 显式清空之后迟到补建的下一个 session。
   */
  view(): McpSessionConfigurationSource;
  /**
   * 落挂起标志与 client 声明，并同步通知订阅者。快照身份没变时不通知，返回 false。
   * override 省略 = 沿用当前声明；undefined = 从未声明，继续透传 base。
   */
  update(next: { suspended: boolean; override?: Configuration }): boolean;
  /**
   * runtime 关闭：解除 base 订阅并关闭 base。上游由 session.close() 关 base；这里 session
   * 只拿到 view，base 的 owner 是 runtime。
   */
  close(): void;
}

/** 快照身份：开关、逐 server 配置（键序无关、忽略 undefined）与官方 CUA 信任名单。 */
function configurationKey(configuration: Configuration): string {
  return mcpConfigKey({
    enabled: configuration.enabled !== false,
    servers: configuration.servers,
    trustedOfficialCuaServerNames: configuration.trustedOfficialCuaServerNames ?? [],
  });
}

export function createMcpClientConfigSource(
  base: McpConfigurationSource | undefined,
  initial: Configuration = {},
): McpClientConfigSource {
  let override: Configuration | undefined;
  let suspended = false;
  let closed = false;
  const listeners = new Set<() => void>();
  const snapshot = (): Configuration =>
    suspended ? MCP_CLIENT_SUSPENDED : (override ?? base?.getSnapshot() ?? initial);
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const unsubscribeBase = base?.subscribe(() => {
    // client 声明或 detach 生效期间，base 的变化不改变本会话的快照：声明是完整 override。
    if (!closed && !suspended && override === undefined) notify();
  });
  return {
    view() {
      const own = new Set<() => void>();
      return {
        getSnapshot: () => snapshot(),
        subscribe(listener) {
          own.add(listener);
          listeners.add(listener);
          return () => {
            own.delete(listener);
            listeners.delete(listener);
          };
        },
        close() {
          for (const listener of own) listeners.delete(listener);
          own.clear();
        },
      };
    },
    update(next) {
      const previous = configurationKey(snapshot());
      suspended = next.suspended;
      override = next.override ?? override;
      if (closed || configurationKey(snapshot()) === previous) return false;
      notify();
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      unsubscribeBase?.();
      base?.close();
    },
  };
}

function clientMcpConnectOptions(runtime: AgentRuntimeInternal): McpConnectOptions {
  const { config } = runtime;
  return {
    // 会话关闭只取消本会话的 MCP 等待与调用，共享连接仍由 pool 与其余 lease 持有。
    signal: runtime.shutdownSignal,
    oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_WAIT_MS,
    trace: runtime.rootTraceContext,
    workingDirectory: runtime.workingDirectory,
    workspaceIdentity: config.workspaceIdentity?.toString(),
    ...(config.workspaceKey ? { workspaceKey: config.workspaceKey } : {}),
  };
}

function clientMcpConnectSignal(runtime: AgentRuntimeInternal): AbortSignal {
  // 挂起的空快照必须能排队收口，不能继承被取消的旧 attachment。
  return runtime.mcpClientAttached
    ? AbortSignal.any([runtime.shutdownSignal, runtime.mcpClientConnectAbort.signal])
    : runtime.shutdownSignal;
}

/**
 * 本 runtime 的 McpSession（上游构造期内联的装配）。配置源是 client override 源的 view，
 * 构造期与迟到注入补建走同一份装配。
 */
export function createRuntimeMcpSession(runtime: AgentRuntimeInternal, port: McpPort): McpSession {
  return createMcpSession({
    port,
    borrowed: isBorrowedMcpPort(port),
    configuration: runtime.config.mcp,
    source: runtime.mcpClientSource?.view(),
    catalog: runtime.isRemoteWorkspace() ? undefined : runtime.mcpToolCatalogPort,
    connectOptions: clientMcpConnectOptions(runtime),
    resolveConnectSignal: () => clientMcpConnectSignal(runtime),
    logger: runtime.logger,
    trackStartup: (promise) => runtime.trackResidencyBlockingWork(promise),
  });
}

/** client 声明的配置快照：非空即启用。client server 不共享官方 Computer Use 项目授权，不带信任名单。 */
function clientMcpConfiguration(servers: Record<string, McpServerConfig>): Configuration {
  return { enabled: Object.keys(servers).length > 0, servers };
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
 * 本 getter 服务只读调用方；子会话借用走 createChildMcpAccess，它读 session 视图。
 */
export function getEffectiveMcpConfig(
  this: AgentRuntimeInternal,
): AgentRuntimeConfig["mcp"] {
  return this.config.mcp === undefined ? undefined : structuredClone(this.config.mcp);
}

/** client 注入 MCP 声明的语义指纹：对象键递归排序，数组保序（stdio argv 顺序有语义），值参与比较。 */
function sameMcpDeclaration(
  left: Record<string, McpServerConfig>,
  right: Record<string, McpServerConfig>,
): boolean {
  return mcpConfigKey(left) === mcpConfigKey(right);
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
      : sameMcpDeclaration(currentDeclaration, next);
  // 语义相等（含凭据、键序无关的对象）不等于活连接（评审 R2-修复）：port 上
  // 已 failed/disconnected/missing 的期望 server 需要显式 retry。读 status
  // 前后的 desired 都必须复核——迟到读不得覆盖更新的配置。
  if (unchanged && !this.mcpReconnectNeeded) {
    const desiredBefore = this.mcpDesiredServers;
    const epoch = this.mcpAttachEpoch;
    const retryRequested = await detectMcpRetryNeeded(this, next);
    // status 读期间 desired 可能被并发 configure 替换、attachment 可能翻转——迟到的健康
    // 判定不得按旧声明立 retry，也不得覆盖更新的 desired 或复活 detach（attach/detach
    // 自己立补连旗标）。
    if (
      this.mcpClosed ||
      epoch !== this.mcpAttachEpoch ||
      this.mcpDesiredServers !== desiredBefore
    ) {
      return;
    }
    if (!retryRequested) return;
    // 声明没变、连接死了：不换 desired，只立补连旗标走既有边界路径。
    this.mcpReconnectNeeded = true;
  }
  if (!unchanged) this.mcpDesiredServers = next;
  // 有在跑 / 排队 / 预留的回合时只暂存——本轮继续用旧连接，回合边界再落地。
  if (this.hasActiveOrQueuedTurnWork()) return;
  await this.applyPendingMcpServers();
}

/**
 * 显式 configure/resume 的 retry 判定（评审 R2-修复）：只看当前 port 的活事实——
 * 期望启用、且 live 状态为 failed/disconnected/missing 的 server 才算欠连；
 * connecting/disabled/untrusted 一律不打扰。返回 false 时调用方保持原 no-op 语义
 * （status 不可读时保守不判 retry）。
 */
async function detectMcpRetryNeeded(
  runtime: AgentRuntimeInternal,
  servers: Record<string, McpServerConfig>,
): Promise<boolean> {
  const desiredEnabled = Object.entries(servers)
    .filter(([, config]) => config.enabled !== false)
    .map(([name]) => name);
  if (desiredEnabled.length === 0) return false;
  // 有期望却没 port：资源缺失需重建（apply 里补建）。
  const port = runtime.mcpPort;
  if (!port) return true;
  const statuses = await port.status().catch(() => undefined);
  if (statuses === undefined) return false;
  for (const name of desiredEnabled) {
    const status = statuses[name]?.status;
    if (status === undefined || status === "failed" || status === "disconnected") return true;
  }
  return false;
}

export async function setMcpClientAttached(
  this: AgentRuntimeInternal,
  attached: boolean,
): Promise<void> {
  if (this.mcpClosed || attached === this.mcpClientAttached) return;
  // 同步落下闸门：detach 之后迟到的连接结果与新声明都不能落到连接上。
  // 连接即将断开：applied 快照不再等于活连接，先立补连旗标——否则 detach 与
  // attach 之间的一次 boundary apply 会看到「已应用」而永远不再补连。
  this.mcpClientAttached = attached;
  this.mcpReconnectNeeded = true;
  this.mcpAttachEpoch += 1;
  if (attached) {
    this.mcpClientConnectAbort = new AbortController();
    // adoption：等挂起的 teardown 收尾（suspend 排在 apply tail 上），回合边界补连。
    await this.mcpApplyTail;
    return;
  }
  // 信任层串行处理配置；先取消旧 attachment 的握手等待，否则空快照排在它后面。
  // 连接仍由 session/port 按空快照释放，不中止整轮或其他租约。
  this.mcpClientConnectAbort.abort(new Error("MCP client detached"));
  this.mcpClientSource?.update({ suspended: true });
  const suspend = this.mcpApplyTail.then(async () => {
    // 等 owner 收敛完成：session 隔离的 stdio 子进程在 pool 里等到真实退出才返回。
    await this.mcpSession?.startup;
  });
  this.mcpApplyTail = suspend.catch(() => undefined);
  void this.trackResidencyBlockingWork(suspend).catch(() => undefined);
  await suspend;
}

export async function applyPendingMcpServers(this: AgentRuntimeInternal): Promise<void> {
  // 所有 configure/attach/detach 串行在 apply tail 上：迟到的完成不得覆盖新配置。
  const apply = this.mcpApplyTail.then(() => performClientMcpApply.call(this));
  this.mcpApplyTail = apply.catch(() => undefined);
  // 常驻计数与 apply 同一同步片登记；派生 promise 的拒绝由 await apply 的调用方处理。
  void this.trackResidencyBlockingWork(apply).catch(() => undefined);
  await apply;
}

/**
 * 迟到注入：空会话首个非空 client 声明在这里补建 session port 与 session。
 * 工厂缺席则报边界错；注入方拥有的 port 不配工厂，所以不会走到这里。
 */
function ensureClientMcpSession(runtime: AgentRuntimeInternal): void {
  if (runtime.mcpSession) return;
  const port = runtime.mcpPort ?? runtime.createMcpPort?.();
  if (!port) {
    throw new Error("Client MCP servers were provided but this session has no MCP port factory");
  }
  runtime.mcpPort = port;
  runtime.mcpSession = createRuntimeMcpSession(runtime, port);
  void runtime.startMcpStartup(runtime.rootTraceContext);
}

/** 声明没变、连接已死时的显式补连：让 pool 重校验缓存条目（failed 的就地重连、live 的 ping 保活）。 */
async function retryClientMcpConnections(
  runtime: AgentRuntimeInternal,
  desired: Record<string, McpServerConfig>,
): Promise<boolean> {
  const port = runtime.mcpPort;
  if (!port) return false;
  try {
    await port.connectConfiguredServers(desired, {
      ...clientMcpConnectOptions(runtime),
      revalidate: true,
      signal: clientMcpConnectSignal(runtime),
    });
    return true;
  } catch (error) {
    // 当前 owner 的失败：欠账保留，下一边界重试；诊断只报类别与计数，不回显
    // adapter 错误 message（可能含凭据）。
    runtime.logger?.warn("MCP reconnect failed", {
      ...traceContextToLogContext(runtime.rootTraceContext),
      errorKind: mcpErrorKind(error),
      event: "mcp.client_reconnect.failed",
      module: "core.runtime",
      serverCount: Object.keys(desired).length,
      status: "failed",
    });
    return false;
  }
}

async function performClientMcpApply(this: AgentRuntimeInternal): Promise<void> {
  if (this.mcpClosed) return;
  const source = this.mcpClientSource;
  if (!source) return;
  // 每轮开始重读最新 desired，避免应用过期配置。staged 声明（回合中）对子会话不可见。
  const declared = this.mcpDesiredServers;
  // 回合边界的 no-op：没有暂存的声明、也没有补连欠账时不碰 session——initializeMcp 会等
  // startup，整轮边界不能替上游的 background 启动策略等连接。
  const applied = this.config.mcp?.servers;
  const nothingStaged =
    declared === undefined || (applied !== undefined && sameMcpDeclaration(declared, applied));
  if (nothingStaged && !this.mcpReconnectNeeded) return;
  // create 时声明的会话（session/create 的 mcpServers 落在 config.mcp，没有暂存声明）欠
  // 补连时按生效配置补连。
  const desired = declared ?? applied;
  const epoch = this.mcpAttachEpoch;
  const attached = this.mcpClientAttached;
  const wantsConnections = attached && desired !== undefined && Object.keys(desired).length > 0;
  // 迟到注入的 port/session 必须先于发布存在：通知只送达已订阅的 session。
  if (wantsConnections) ensureClientMcpSession(this);
  // 一次通知同时落挂起标志与最新声明：adoption + 新声明只触发一次 reconcile，
  // 不会先按旧声明连一轮再替换。detach 期间声明照样记下，快照仍是空集。
  const changed = source.update({
    suspended: !attached,
    ...(declared === undefined ? {} : { override: clientMcpConfiguration(declared) }),
  });
  let settled = true;
  if (changed) {
    // 发布即上游 reconcile：session 收敛连接。等它落定再登记工具——本轮按最新声明构建。
    await this.mcpSession?.startup;
  } else if (wantsConnections && desired && this.mcpReconnectNeeded) {
    // 快照没变、只有补连欠账（adoption 后 / 显式 retry / 连接已死）：发布不触发
    // reconcile，显式补连一次。
    settled = await retryClientMcpConnections(this, desired);
  }
  // 迟到完成不得覆盖更新状态：连接期间 attachment 变过（含 detach 后又 adopt 的往返，
  // 那时快照仍是空集）或 runtime 关了，本轮结果作废，补连旗标留给当前 owner。
  if (this.mcpClosed || !this.mcpClientAttached || epoch !== this.mcpAttachEpoch) return;
  if (!settled) return;
  if (declared !== undefined) {
    // R5：生效配置只在整轮边界提交——读 config.mcp 的调用方必须看到与连接一致的
    // servers/enabled；本回合已冻结的 admission 不受影响。
    this.config.mcp = {
      ...this.config.mcp,
      enabled: Object.keys(declared).length > 0,
      servers: structuredClone(declared),
    };
  }
  // 与上游每个请求的登记入口相同：把 session 当前视图登记到 registry，清空 / 替换时
  // 旧的注册名先注销。回合内不等下一步 initializeMcp。
  const previousCount = this.registeredMcpToolNames?.length ?? 0;
  await initializeMcp.call(this, this.rootTraceContext);
  this.logger?.info("MCP configured servers applied", {
    ...traceContextToLogContext(this.rootTraceContext),
    event: "mcp.apply.completed",
    module: "core.runtime",
    registeredToolCount: this.registeredMcpToolNames?.length ?? 0,
    removedToolCount: previousCount,
    serverCount: Object.keys(desired ?? {}).length,
    status: "completed",
  });
  if (declared !== undefined && Object.keys(declared).length === 0) {
    // client 显式清空（[]）：释放 session 自有资源；工厂 memo 复位，再次注入拿全新 port。
    // 借用式 port（无 createMcpPort——注入方拥有）只断开连接，不代替注入方关资源（评审 R7）。
    await releaseClientMcpSession(this);
  }
  this.mcpReconnectNeeded = false;
}

async function releaseClientMcpSession(runtime: AgentRuntimeInternal): Promise<void> {
  if (!runtime.createMcpPort) return;
  const port = runtime.mcpPort;
  runtime.mcpSession?.close();
  runtime.mcpSession = undefined;
  runtime.mcpPort = undefined;
  await port?.close();
}

/** MCP 相关错误的脱敏类别：adapter/config 错误 message 可能回显 command/env/header/URL。 */
function mcpErrorKind(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}
