import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type {
  ModelSelection,
  UsageQuotaSnapshot,
  ZCodeModelOption,
  ZCodeSessionUsageTotals,
} from "@zcode/shared";
import type {
  CollaborationMode,
  ModelUsageSummary,
  McpServerStatus,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
  PermissionBrokerResult,
  SessionEvent,
  SessionProjection,
  SupportedLocale,
  ToolResultDisplayPayload,
  UiThemeMode,
  UiThemePreference,
  TurnId,
  TurnSteerResult,
} from "@zcode/contracts";

export type TuiContextUsage = Pick<SessionProjection, "contextUsed" | "contextWindow">;

export type TuiSessionMetadata = Pick<
  TuiSubmitPromptResult,
  "locale" | "model" | "theme" | "thoughtLevel" | "modelOptions" | "effortOptions" | "loginRequired"
>;

export type TuiSwitchableMode = Extract<
  CollaborationMode,
  "plan" | "build" | "edit" | "yolo" | "guarded"
>;

export type TuiSetModeResult = {
  mode: CollaborationMode;
  response?: string;
};

export type TuiSetMode = (mode: TuiSwitchableMode) => Promise<TuiSetModeResult> | TuiSetModeResult;

export type TuiPromptAttachment = {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
};

export type TuiPromptInput =
  | string
  | {
      text: string;
      attachments?: TuiPromptAttachment[];
      /** Model picker commands retain the reference separately from their display text. */
      modelSelection?: ModelSelection;
    };

export type TuiImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type TuiClipboardImage = {
  dataUrl: string;
  mediaType: TuiImageMediaType;
  sizeBytes?: number;
};

export type TuiReadClipboardImage = (options?: {
  abortSignal?: AbortSignal;
}) => Promise<TuiClipboardImage | null>;

export type TuiWriteClipboardText = (text: string) => Promise<void> | void;

export type TuiWorkspacePathKind = "directory" | "file";

export type TuiWorkspacePathSuggestion = {
  kind: TuiWorkspacePathKind;
  path: string;
};

export type TuiWorkspacePathSuggestionResult = {
  items: readonly TuiWorkspacePathSuggestion[];
  truncated: boolean;
};

export type TuiListWorkspacePathSuggestions = (request: {
  abortSignal?: AbortSignal;
  limit?: number;
  token: string;
}) => Promise<TuiWorkspacePathSuggestionResult>;

export type TuiSelectionItem = {
  command: string;
  disabledReason?: string;
  id: string;
  input?: TuiSelectionInput;
  keywords?: readonly string[];
  meta?: string;
  pending?: TuiSelectionPending;
  primary: string;
  secondary?: string;
};

export type TuiSelectionInput = {
  cancelStatus?: string;
  clearStatus?: string;
  emptyStatus?: string;
  help?: string;
  mask?: boolean;
  placeholder?: string;
  primary: string;
  secondary?: string;
  status?: string;
  submitStatus?: string;
};

export type TuiSelectionPending = {
  cancelStatus?: string;
  help?: string;
  primary: string;
  secondary?: string;
  status?: string;
};

export type TuiSelection = {
  emptyMessage: string;
  filterable?: boolean;
  help?: string;
  items: TuiSelectionItem[];
  placement?: "action" | "composer";
  prompt: string;
  selectedIndex?: number;
  title: string;
};

export type TuiRestoredTranscriptPart =
  | {
      text: string;
      type: "text";
    }
  | {
      text: string;
      type: "thought";
    }
  | {
      error?: string;
      input: Record<string, unknown>;
      output?: string;
      resultDisplay?: ToolResultDisplayPayload;
      status: "pending" | "running" | "completed" | "failed";
      title?: string;
      toolCallId: string;
      toolName: string;
      type: "tool";
    };

export type TuiSubmitPromptResult = {
  effortOptions?: readonly TuiEffortOption[];
  modelOptions?: readonly TuiModelOption[];
  locale?: SupportedLocale;
  loginRequired?: boolean;
  mode?: CollaborationMode;
  model?: string;
  theme?: UiThemePreference;
  projection?: Partial<TuiContextUsage>;
  response: string;
  resetSessionProjection?: boolean;
  restoredMessages?: Array<{
    id?: string;
    content: string;
    parts?: TuiRestoredTranscriptPart[];
    role: "agent" | "system" | "user";
  }>;
  selection?: TuiSelection;
  sessionId?: string;
  thoughtLevel?: string;
  traceId?: string;
  turnId?: string;
  usage?: ModelUsageSummary;
  /**
   * session 级累计用量的一次性种子（协议快照 `runtime.usageTotals`，
   * core 对 session eventStore 的折叠）。只在会话绑定结果上携带
   * （attach initialResult、/new、/resume），消费方把它采纳为累计
   * 基线后继续折叠 live 事件；回合结果不携带——快照不会逐回合刷新，
   * 陈旧种子会回退已折叠的计数。
   */
  usageTotals?: ZCodeSessionUsageTotals;
};

export type TuiRequestPermission = (
  request: PermissionBrokerRequest,
  options?: PermissionBrokerRequestOptions,
) => Promise<PermissionBrokerResult>;

/**
 * TUI 挂载时登记审批入口，返回注销函数。入口在挂载期间一直有效，不随单次提交切换：
 * 主会话回合之外的询问（通知驱动的回合、CreateSession 建的后台会话）也走同一个审批队列。
 */
export type TuiRegisterPermissionRequester = (
  requestPermission: TuiRequestPermission,
) => () => void;

export type TuiSubmitPrompt = (
  prompt: TuiPromptInput,
  options: {
    abortSignal: AbortSignal;
    onEvent?: (event: SessionEvent) => void | Promise<void>;
  },
) => Promise<TuiSubmitPromptResult>;

export type TuiSendInputResult =
  | {
      kind: "started_turn";
      result: TuiSubmitPromptResult;
    }
  | {
      kind: "command_result";
      result: TuiSubmitPromptResult;
    }
  | {
      /**
       * 宿主没有 follow-up 队列的消费通道（进程内 runtime 的 queue lane 无
       * 提升器，见 tui-prompt-handler 与 turn-steering.md）：UI 必须提示不可
       * 排队并恢复草稿，不能显示"已排队"后静默丢失。
       */
      kind: "queue_unavailable";
    }
  | TurnSteerResult;

export type TuiSendInput = (
  input: TuiPromptInput,
  options: {
    abortSignal?: AbortSignal;
    /** busy 输入的 TUI 语义：steer=注入当前 turn（Enter），queue=follow-up 排队（Ctrl+Q）。 */
    delivery?: "steer" | "queue";
    expectedTurnId?: TurnId;
    onEvent?: (event: SessionEvent) => void | Promise<void>;
  },
) => Promise<TuiSendInputResult>;

/**
 * Alt+Up 撤回：把 TUI 队列区投影出的 pendingInputIds 交回其 owner 摘除
 * （attach：core pendingInputs 走协议、客户端本地队列本地摘除；进程内：
 * app.removeQueueItem）。返回实际移除的 id 集——已被消费/未命中的项不撤。
 */
export type TuiRemoveQueuedInputs = (
  pendingInputIds: readonly string[],
) => Promise<readonly string[]>;

export type TuiRecallPreviousInput = (
  skip?: number,
) => Promise<{ attachments?: TuiPromptAttachment[]; text: string } | null>;

export type TuiCancelBackgroundTask = (taskId: string) => Promise<unknown>;

export type TuiReadSubagents = (input?: {
  endedCursor?: string;
  endedLimit?: number;
}) => Promise<import("@zcode/shared").ZCodeSessionSubagentsResult>;
export type TuiSubagentTranscriptSnapshot = {
  sessionId: string;
  sequenceNumber: number;
  messages: NonNullable<TuiSubmitPromptResult["restoredMessages"]>;
  events: SessionEvent[];
  replayMessageIds: string[];
};
export type TuiReadSubagentTranscript = (
  childSessionId: string,
) => Promise<TuiSubagentTranscriptSnapshot>;

/**
 * 跨回合常驻的会话事件订阅。
 *
 * 为什么不复用 `submitPrompt` / `sendInput` 的 per-turn `onEvent`：dwf 进度是**出回合事件**
 * （turnId 为空），per-turn sink 在回合结束即死——这正是 TUI 今天丢 dwf 事件的结构性原因。
 * 后台完成通知驱动的模型回合同理（它由 runtime 命令队列自驱，没有任何 per-turn sink 在听）。
 *
 * 返回 unsubscribe；`replaceApp`（`/new` `/resume` `/fork`）时由 CLI 侧重挂。
 */
export type TuiSubscribeSessionEvents = (sink: (event: SessionEvent) => void) => () => void;

/**
 * 会话级 workflow run 摘要（`app.listDynamicWorkflowRuns`），用于冷启动/恢复时补种镜像。
 *
 * `label` / `updatedAt` 是 additive optional：老服务端不发这两个键，读侧退回 runId、不显示时间。
 * `resumable` 由服务端裁定，**绝不**在 TUI 重推导。
 */
export type TuiWorkflowRunSummary = {
  runId: string;
  toolCallId?: string;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
  stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded";
  label?: string;
  updatedAt?: number;
  resumable?: boolean;
};

export type TuiListWorkflowRuns = () => Promise<readonly TuiWorkflowRunSummary[]>;

/**
 * workflow run 的冷回放：把本会话名下、镜像里
 * 还没有的 run 从 journal 回放成进度事件信封，逐条喂给镜像的共享 reducer——重启 / `/resume`
 * 之后卡片显示的是真实步数、用量与子代理，而不是 0/0 的空壳。
 */
export type TuiReplayWorkflowRuns = (input: {
  excludeRunIds: ReadonlySet<string>;
}) => Promise<readonly WorkflowRunProgressEnvelope[]>;

/**
 * 当前**主会话** id。是 getter 而不是值：`/new` `/resume` `/fork` 会换会话，
 * 快照下来的 id 会立刻过期，然后把整条转写误判成外来事件。
 */
export type TuiGetMainSessionId = () => string | undefined;

export type TuiListMcpServers = () => Promise<Record<string, McpServerStatus>>;

export type TuiSlashCommandSuggestion = {
  aliases?: readonly string[];
  name: string;
  summary: string;
  usage: string;
};

export type TuiModelOption = ZCodeModelOption;

export type TuiEffortOption = {
  description?: string;
  id: string;
  label: string;
};

export type TuiModeOption = {
  description: string;
  id: TuiSwitchableMode;
  label: string;
};

/**
 * `/skill <Tab>` 参数补全条目：name 是可被 Skill tool 直接调用的名字
 * （qualifiedName 优先），description 仅作补全提示。目录由 CLI 组合层在
 * startup 快照；session 内发现结果冻结，不随文件系统热更新。
 */
export type TuiSkillSuggestion = {
  description: string;
  name: string;
};

export type TuiOptions = {
  /** Called after the startup screen has painted; runtime ownership stays in CLI. */
  loadStartupOptions?: () => Promise<TuiStartupOptions>;
  initialMode?: CollaborationMode;
  initialModel?: string;
  initialResult?: TuiSubmitPromptResult;
  initialThoughtLevel?: string;
  loginRequired?: boolean;
  locale?: SupportedLocale;
  theme?: UiThemePreference;
  initialThemeMode?: UiThemeMode;
  developerMode?: boolean;
  version?: string;
  workspaceDirectory?: string;
  workspaceGitBranch?: string;
  noColor: boolean;
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  cancelBackgroundTask?: TuiCancelBackgroundTask;
  readSubagents?: TuiReadSubagents;
  /** Coding Plan 额度快照（attach 协议 usage/codingPlanQuota）；缺席时额度簇静默。 */
  readUsageQuota?: () => Promise<UsageQuotaSnapshot>;
  readSubagentTranscript?: TuiReadSubagentTranscript;
  listWorkspacePathSuggestions?: TuiListWorkspacePathSuggestions;
  listMcpServers?: TuiListMcpServers;
  listWorkflowRuns?: TuiListWorkflowRuns;
  replayWorkflowRuns?: TuiReplayWorkflowRuns;
  getMainSessionId?: TuiGetMainSessionId;
  registerPermissionRequester?: TuiRegisterPermissionRequester;
  readClipboardImage?: TuiReadClipboardImage;
  recallPreviousInput?: TuiRecallPreviousInput;
  sendInput?: TuiSendInput;
  removeQueuedInputs?: TuiRemoveQueuedInputs;
  setMode?: TuiSetMode;
  effortOptions?: readonly TuiEffortOption[];
  modelOptions?: readonly TuiModelOption[];
  listModelOptions?: () => Promise<readonly TuiModelOption[]>;
  slashCommands?: readonly TuiSlashCommandSuggestion[];
  skillSuggestions?: readonly TuiSkillSuggestion[];
  submitPrompt: TuiSubmitPrompt;
  /**
   * "stop & quit" 路径的 session/stop 上达：turn abort controller 是客户端本地
   * 语义，attach 模式下停 server 端 turn 必须显式发 session/stop 并等它有界回执，
   * 否则 socket 先关、stop 可能没落线。resolve 时机为 ack 或超时（尽力而为）。
   */
  requestStopActiveTurn?: () => Promise<void>;
  subscribeSessionEvents?: TuiSubscribeSessionEvents;
  /**
   * 瘦客户端 (tui-attach) 的连接状态：server 断开/重连时 pousse un libellé
   * vers la ligne de status du composer. Optionnel : absent en mode in-process.
   */
  subscribeConnectionStatus?: (listener: (status: string) => void) => () => void;
  subscribeThemeMode?: (listener: (mode: UiThemeMode) => void) => () => void;
  setTerminalBackgroundColor?: (color: string) => void;
  writeClipboardText?: TuiWriteClipboardText;
};

export type TuiStartupOptions = Pick<
  TuiOptions,
  | "initialMode"
  | "initialModel"
  | "initialThoughtLevel"
  | "loginRequired"
  | "locale"
  | "theme"
  | "modelOptions"
  | "effortOptions"
  | "slashCommands"
  | "skillSuggestions"
  | "workspaceGitBranch"
>;
