// Mutable application state holder. The shared projection internals take
// React.Dispatch<SetStateAction<T>>-shaped setters; this store supplies the
// same call shape without React.

import type { ModelUsageSummary, SessionEvent, TodoItem, TurnId } from "@zcode/contracts";
import type { ZCodeSessionSubagentsResult } from "@zcode/shared";
import type { Balance } from "./quota.js";
import type {
  ApprovalPrompt,
  CacheStats,
  ContextUsage,
  DraftAttachment,
  Message,
  ModifiedFileStat,
  NetworkRequest,
  QueuedInput,
  SelectionState,
  SlashSelectionState,
  TuiEffortOption,
  TuiModelOption,
} from "@zcode/tui/internals";

export type SetState<T> = (value: T | ((previous: T) => T)) => void;

export type MutableRef<T> = { current: T };

export const ref = <T>(initial: T): MutableRef<T> => ({ current: initial });

/** Session 累计用量（pi footer ↑↓R[W] 的累计口径），UsageTotalsAccumulator 持有。 */
export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 客户端目录价估算（USD）；未知模型不计入，见 pricing.ts。 */
  costUsd: number;
};

export class AppStore {
  readonly state = {
    activeTurnId: undefined as TurnId | undefined,
    /** 当前 turn 的计时锚点（epoch ms）；与 activeTurnId 同生命周期。 */
    activeTurnStartedAtMs: undefined as number | undefined,
    approvalQueue: [] as ApprovalPrompt[],
    busy: false,
    /** core auto-compact 设置态；契约字段落地前恒 undefined，footer 不显示 (auto)。 */
    autoCompact: undefined as boolean | undefined,
    cacheHitRate: undefined as number | undefined,
    cacheStats: undefined as CacheStats | undefined,
    contextUsage: {} as ContextUsage,
    draftAttachments: [] as DraftAttachment[],
    /** Ctrl+T：transcript 内 thought part 正文展开/收起（纯展示态）。 */
    expandThoughts: false,
    lastError: undefined as string | undefined,
    lastEvent: "",
    liveModelText: "",
    loginRequired: false,
    messages: [] as Message[],
    mode: "yolo" as string,
    model: "",
    modelOptions: [] as TuiModelOption[],
    effortOptions: [] as TuiEffortOption[],
    thoughtLevel: "",
    modifiedFiles: [] as ModifiedFileStat[],
    networkRequests: [] as NetworkRequest[],
    queuedInputs: [] as QueuedInput[],
    selection: undefined as SelectionState | undefined,
    slashSelection: undefined as SlashSelectionState | undefined,
    status: "",
    statusDetails: [] as string[],
    subagents: undefined as ZCodeSessionSubagentsResult | undefined,
    subagentsError: undefined as string | undefined,
    todos: [] as TodoItem[],
    traceId: undefined as string | undefined,
    usage: undefined as ModelUsageSummary | undefined,
    usageTotals: undefined as UsageTotals | undefined,
    /** CLI 启动快照（`TuiStartupOptions.workspaceGitBranch`），无 live watcher。 */
    workspaceGitBranch: undefined as string | undefined,
    /** Coding Plan 额度簇（quota-cluster 唯一写入）。 */
    quotaBalance: undefined as Balance | undefined,
    quotaFetchedAt: undefined as number | undefined,
    /** 额度刷新失败 episode 的诊断消息；存在即 footer 挂 `quota !` 徽标。 */
    quotaError: undefined as string | undefined,
  };

  /** Maps used by the shared projection; stable identity matters. */
  readonly assistantMessageIdsByToolCallId = new Map<string, string>();
  readonly modifiedFileToolCallIds = new Set<string>();
  readonly toolNamesById = new Map<string, string>();
  readonly appliedEventIds = new Set<string>();
  readonly turnAbort: MutableRef<AbortController | undefined> = ref(undefined);

  private listeners = new Set<(key: keyof AppStore["state"]) => void>();

  onChange(listener: (key: keyof AppStore["state"]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(key: keyof AppStore["state"]): void {
    for (const listener of this.listeners) listener(key);
  }

  setter<K extends keyof AppStore["state"]>(key: K): SetState<AppStore["state"][K]> {
    return (value) => {
      this.state[key] =
        typeof value === "function"
          ? (value as (previous: AppStore["state"][K]) => AppStore["state"][K])(this.state[key])
          : value;
      this.notify(key);
    };
  }

  set<K extends keyof AppStore["state"]>(key: K, value: AppStore["state"][K]): void {
    this.state[key] = value;
    this.notify(key);
  }

  observeSessionEvent?: (event: SessionEvent) => void;
}
