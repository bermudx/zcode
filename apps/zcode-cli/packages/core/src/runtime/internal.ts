import { PermissionService, ToolScheduler } from "./deps.js";
import type { ModelRequestSessionFeature } from "@zcode/contracts";
import type { PromptSnapshot } from "./helpers/prompt-snapshot.js";
import type { TotalTokensBudgetState } from "./helpers/total-tokens-budget.js";
import type { InstructionRefreshReason } from "../context/types.js";
import type {
  Logger,
  ModelSelection,
  EventReducer,
  MessageId,
  TurnId,
  ModelToolContract,
  PermissionBrokerPort,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  ContextSourcePort,
  ContextSourceSnapshot,
  ExecutionPort,
  FileSystemPort,
  HookRunner,
  ImageProcessorPort,
  PdfDocumentPort,
  McpConnectionSnapshot,
  McpServerConfig,
  SkillLoadOutcome,
  SkillPort,
  McpPort,
  DynamicWorkflowRunPort,
  ModelCatalogPort,
  SubagentPort,
  ToolArtifactStorePort,
  TraceContext,
  MessageHistory,
  ReadFileStateMap,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ContextBuildResult,
  PendingInputEditLock,
} from "./deps.js";
import type {
  ActiveTurnSteeringState,
  ActiveTurnStartReservation,
  ActiveForegroundExecutionState,
  ForegroundPromotionLeaseState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  BackgroundTaskNotificationSealReason,
  PendingModelChangeTimeline,
  ProviderRuntimeHeadersPort,
  MainTurnCacheHitAggregate,
  RuntimeTurnFileChangeMap,
} from "./types.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { WorkflowBlockedReminderClock } from "../runtime-task/workflow-blocked-reminder.js";
import type { BackgroundSubagentStallClock } from "../subagent/background-stall.js";
import type { DynamicWorkflowActivationSource } from "./methods/dynamic-workflow-activation.js";
import type { AgentRuntimeCoreMethods } from "./internal-methods.js";
import type { AgentRuntimeTurnMethods } from "./internal-turn-methods.js";
import type { AgentRuntimeHookMethods } from "./internal-hook-methods.js";
import type { MemoryRecallState } from "../memory/recall/index.js";
import type { ProjectMemoryRecallPrefetch } from "./helpers/project-memory-recall.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { ProjectMemoryUpdate } from "./helpers/project-memory-dream.js";
import type { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";

/**
 * 一个在飞 client MCP connect 操作（startup 或 boundary apply 的单次 connect
 * await）。servers 是开连时的不可变声明快照，controller 持有本次 connect 的
 * signal，epoch 是登记时的 attachment 代次——只作登记时点诊断，判定仍以
 * 当前 mcpAttachEpoch 为准。
 */
export interface McpConnectOperation {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  readonly controller: AbortController;
  readonly epoch: number;
}

export interface AgentRuntimeInternal
  extends AgentRuntimeCoreMethods, AgentRuntimeTurnMethods, AgentRuntimeHookMethods {
  sessionId: SessionId;
  turnNumber: number;
  config: AgentRuntimeConfig;
  permissionService: PermissionService;
  permissionBroker: PermissionBrokerPort;
  toolScheduler: ToolScheduler;
  eventReducer: EventReducer;
  eventStore: SessionEventStorePort;
  rootTraceContext: TraceContext;
  appVersion: string;
  logger?: Logger;
  eventSinks: Set<SessionEventSink>;
  now: () => Date;
  isRemoteWorkspace: () => boolean;
  registry: ToolRegistry;
  executor: ToolExecutor;
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  modelFactory: AgentRuntimeDeps["modelFactory"];
  modelIoDir?: string;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  sessionModelSelection: ModelSelection | undefined;
  messageHistory: MessageHistory;
  readFileState: ReadFileStateMap;
  cachedTools: ModelToolContract[] | null;
  /** 首次装配选定的会话工具运行位置；分支刷新复用它，不能回落到另一种实现。 */
  sessionControlKind?: "cli" | "app";
  /** 工作流工具面是否已注册（launch.md「On demand: activation」）；非 onDemand 会话出生即 true。 */
  dynamicWorkflowToolsActivated: boolean;
  dynamicWorkflowActivationSource?: DynamicWorkflowActivationSource;
  /** 本会话用过的能力标签（session-features 模块是唯一写入方）；只增不减。 */
  sessionFeatures: Set<ModelRequestSessionFeature>;
  /** session-features entry 写入队列的尾部；串行写，避免旧集合覆盖新集合。 */
  sessionFeaturesWrite: Promise<void>;
  contextBuilder: ContextBuilder | null;
  contextInitialized: boolean;
  contextSourceSnapshot?: ContextSourceSnapshot;
  // 新会话初始化时刚读过的 Git 尚未用于宣告；第一次判断后清除，恢复的会话不设。
  sessionStartGitPrefetch?: boolean;
  // 本 runtime 已确认不是 Git 仓库的目录；同一目录不再检查（目录里 git init 后由新 runtime 发现）。
  nonGitDirectories?: Set<string>;
  // 从存储恢复的 runtime 还没有自己读过是否仓库；第一次环境公告读一次后清除。
  repositoryRecheckPending?: boolean;
  latestContextBuildResult?: ContextBuildResult;
  // 指令增量的 reason：未设置即 session_start；compaction 提交重读后改为 compaction，之后不再改回。
  instructionRefreshReason?: InstructionRefreshReason;
  // 最近一次读取时读不出来的指令文件与 Memory 索引路径（启动与 compaction 采用重读时写入）；不算删除。
  unreadableInstructionPaths?: ReadonlySet<string>;
  // 主会话的 prompt 快照（helpers/prompt-snapshot.ts 是唯一写入方）；undefined 没有，null 已清掉。
  promptSnapshot?: PromptSnapshot | null;
  memoryRoot?: string;
  memoryIndexContent?: string;
  memoryRecallState: MemoryRecallState;
  memoryRecallPrefetch?: ProjectMemoryRecallPrefetch;
  memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  memoryDreamLastScanAtMs: number;
  pendingMemoryUpdate?: ProjectMemoryUpdate;
  contextSourcePort?: ContextSourcePort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  /**
   * 迟到注入补建 session MCP port 的同步工厂（issue #31 client MCP）。
   * 由 bootstrap 的 app 装配注入；空会话首个显式 server 到来前不得调用它。
   */
  createMcpPort?: () => McpPort | undefined;
  /**
   * client attachment 信号的退订函数（评审 R1）：只存退订，不存第二份生命周期
   * 状态；信号 abort 后自清，beginShutdown 兜底解除。
   */
  mcpDetachUnsubscribe?: () => void;
  /**
   * 借用方 MCP 入口（评审 R3）：workflow/script 子会话由父注入；startup 阶段
   * await 一次拿 {port, config, snapshot}，缺席即普通自有 port 语义。
   */
  borrowMcpAccess?: AgentRuntimeDeps["borrowMcpAccess"];
  /**
   * client 注入 MCP 的期望/已生效配置（`Record<serverName, config>`）。undefined =
   * 从未收到 client 声明，继续用 config.mcp.servers；显式 {} = client 清空，
   * 不回退文件/plugin 配置。版本号只在 desired 变化时递增，apply 按版本判断是否欠账。
   */
  mcpDesiredServers?: Record<string, McpServerConfig>;
  mcpDesiredVersion: number;
  mcpAppliedVersion: number;
  /** 当前连接集合对应的配置快照；undefined = 仍是启动时 config.mcp.servers。 */
  mcpAppliedServers?: Record<string, McpServerConfig>;
  /**
   * client 侧 attach/detach 闸门。false 时同步拒绝新的 client stdio 准入，
   * 迟到连接结果不得复活子进程；adoption 置回 true 并把 mcpReconnectNeeded 立起。
   */
  mcpClientAttached: boolean;
  /**
   * attach/detach 代次。performMcpApply 在 connect 前取样、await 后比对：
   * 代次变了（detach/adopt/close）本轮结果作废——只有当前 attached owner
   * 允许提交 apply 与清 reconnect 旗标（评审 R2）。
   */
  mcpAttachEpoch: number;
  /**
   * 全部在飞 client MCP connect 操作的登记表（startup 与 boundary apply 各一条/
   * 次）。每次 connect await 前登记、finally 只删自己那条——单标量会被
   * constructor startup 与并发 apply 互相覆盖，导致 detach 并集漏掉在飞条目、
   * 子进程泄漏（评审 F1）。detach 先取全表 server 名并集再 abort 各自 controller；
   * beginShutdown abort 全部在飞记录。
   */
  mcpInFlightConnects: Set<McpConnectOperation>;
  /** detach 断开过连接，attach 后回合边界需要补连。 */
  mcpReconnectNeeded: boolean;
  /** 串行化所有 configure/attach/detach 的应用尾部；防迟到完成覆盖新配置。 */
  mcpApplyTail: Promise<void>;
  /** runtime 关闭后置位；之后的 configure/apply 一律拒绝落地。 */
  mcpClosed: boolean;
  residencyBlockingWorkCount: number;
  residencyBlockingWork: Set<Promise<unknown>>;
  mcpInitialized: boolean;
  mcpToolsRegistered: boolean;
  /** 初始化 / 上次刷新时注册的 MCP 工具名与集合签名。 */
  registeredMcpToolNames?: string[];
  mcpToolsSignature?: string;
  mcpToolListRevision?: number;
  subagentPort?: SubagentPort;
  getAgentDefinitions: NonNullable<AgentRuntimeDeps["getAgentDefinitions"]>;
  prepareAgentDefinitions: (input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }) => Promise<void>;

  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry: RuntimeTaskRegistry;
  /**
   * 「run 还欠着决定、主代理闲着」的提醒钟（methods/dynamic-workflow-blocked-reminder.ts）。真实 runtime 上
   * 恒在场；可选只为让手写的局部 runtime 桩不必带它。
   */
  workflowBlockedReminder?: WorkflowBlockedReminderClock;
  /** 后台 Agent 无进展提醒（subagent/background-stall.ts）。 */
  subagentStallReminder?: BackgroundSubagentStallClock;
  branchGeneration: number;
  artifactStore?: ToolArtifactStorePort;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  skillLoadOutcome?: SkillLoadOutcome;
  workingDirectory: string;
  workspaceRoot: string;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  sessionPersisted: boolean;
  needsPlanModeExitReminder: boolean;
  /** 恢复时对账出的「上一代 runtime 退出时被中断的后台 Agent」提醒，下一轮请求前落盘后清空。 */
  pendingPreviousRuntimeAgentNotice?: string;
  latestConversationMessageId?: MessageId;
  latestAssistantMessageId?: MessageId;
  latestAssistantTurnId?: TurnId;
  mainTurnCacheHitAggregate: MainTurnCacheHitAggregate;
  /** token 预算倒数的计数器；只在内存，resume 时重新开始。 */
  totalTokensBudget: TotalTokensBudgetState;
  currentTurnFileChanges: RuntimeTurnFileChangeMap;
  lastAssistantCompletedAtMs?: number;
  autoCompactConsecutiveFailures: number;
  runtimeCommandQueue: RuntimeCommandQueue;
  runtimeCommandDrainActive: boolean;
  activeForegroundExecution?: ActiveForegroundExecutionState;
  foregroundPromotionLease?: ForegroundPromotionLeaseState;
  activeTurn?: ActiveTurnSteeringState;
  activeTurnStartReservation?: ActiveTurnStartReservation;
  pendingInputSequence: number;
  pendingInputReservations: Map<string, string>;
  pendingInputEditLocks: Map<string, PendingInputEditLock>;
  permissionFullAccessPending?: boolean;
  pendingInputDrains?: number;
  lastPermissionGrantId?: string;
  queueAutoDrain: boolean;
  queueExternalDrainActive: boolean;
  shuttingDown: boolean;
  readonly shutdownSignal: AbortSignal;
  workChanged: Set<() => void>;
  backgroundTaskNotificationsSealed: boolean;
  backgroundTaskNotificationSealReason?: BackgroundTaskNotificationSealReason;
  pendingModelChangeTimeline?: PendingModelChangeTimeline;
  pendingWorktreeCreation?: import("@zcode/contracts").WorktreeCreationFact;
  sessionStartHookRan: boolean;
  sessionTitleGenerationAttempted: boolean;
  agentTelemetry: RuntimeTelemetryFacade;
}
