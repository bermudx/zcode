import type { CollaborationMode, ModelUsageSummary, TodoItem, TurnId } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React from "react";
import { validContextUsage } from "./app-event-data.js";
import type {
  CacheStats,
  ContextUsage,
  Message,
  ModifiedFileStat,
  NetworkRequest,
  QueuedInput,
  SelectionState,
} from "./app-model.js";
import { appendAgentResult } from "./app-submit.js";
import { createSelectionState } from "./app-selection-state.js";
import type { TuiOptions, TuiSubmitPromptResult } from "./types.js";

type TuiApplyResultInput = {
  fallback: {
    locale: NonNullable<TuiOptions["locale"]>;
    loginRequired: boolean;
    mode: CollaborationMode;
    model: string;
  };
  activeTurnIdRef: React.MutableRefObject<TurnId | undefined>;
  modifiedFileToolCallIds: Set<string>;
  setActiveTurnId: (turnId: TurnId | undefined) => void;
  setActiveTurnStartedAtMs?: (startedAtMs: number | undefined) => void;
  setCacheStats: React.Dispatch<React.SetStateAction<CacheStats | undefined>>;
  setContextUsage: React.Dispatch<React.SetStateAction<ContextUsage>>;
  setEffortOptions: React.Dispatch<React.SetStateAction<NonNullable<TuiOptions["effortOptions"]>>>;
  setLastEvent: (event: string) => void;
  setLiveModelText: (value: string) => void;
  setLocale: (locale: NonNullable<TuiOptions["locale"]>) => void;
  setLoginRequired: (loginRequired: boolean) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setMode: React.Dispatch<React.SetStateAction<CollaborationMode>>;
  setModel: (model: string) => void;
  setModelOptions: React.Dispatch<React.SetStateAction<NonNullable<TuiOptions["modelOptions"]>>>;
  setModifiedFiles: React.Dispatch<React.SetStateAction<ModifiedFileStat[]>>;
  setNetworkRequests: React.Dispatch<React.SetStateAction<NetworkRequest[]>>;
  setQueuedInputs: React.Dispatch<React.SetStateAction<QueuedInput[]>>;
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>;
  setStatus: (status: string) => void;
  setThoughtLevel: (thoughtLevel: string) => void;
  setTodos: React.Dispatch<React.SetStateAction<TodoItem[]>>;
  setTraceId: (traceId: string | undefined) => void;
  setUsage: React.Dispatch<React.SetStateAction<ModelUsageSummary | undefined>>;
  workspaceDirectory?: string;
};

/**
 * settle 守卫：result 携带的已 settle 回合仍是当前活跃回合时，连同计时
 * 锚点一起清掉；不匹配（已有新回合接管）则什么都不动。调用方以普通值
 * 调用 setter，不把副作用藏进 state updater。
 */
export function clearSettledActiveTurn(input: {
  activeTurnId: TurnId | undefined;
  // result.turnId 是未品牌化的 string，与品牌 TurnId 只做相等比较。
  settledTurnId: string | undefined;
  setActiveTurnId: (turnId: TurnId | undefined) => void;
  setActiveTurnStartedAtMs?: (startedAtMs: number | undefined) => void;
}): void {
  if (!input.settledTurnId || input.activeTurnId !== input.settledTurnId) return;
  input.setActiveTurnId(undefined);
  input.setActiveTurnStartedAtMs?.(undefined);
}

export function useTuiApplyResult(input: TuiApplyResultInput) {
  return React.useCallback(
    (result: TuiSubmitPromptResult, preserveTurnState = false) => {
      const resultCopy = getZCodeCopy(result.locale ?? input.fallback.locale).tui;
      input.setMode(result.mode ?? input.fallback.mode);
      input.setModel(result.model ?? input.fallback.model);
      if (result.locale) input.setLocale(result.locale);
      if (result.loginRequired !== undefined) input.setLoginRequired(result.loginRequired);
      if (result.effortOptions) input.setEffortOptions(result.effortOptions);
      if (result.modelOptions) input.setModelOptions(result.modelOptions);
      if ("thoughtLevel" in result) input.setThoughtLevel(result.thoughtLevel ?? "");
      input.setMessages((current) =>
        appendAgentResult(current, result, { workspaceDirectory: input.workspaceDirectory }),
      );
      if (preserveTurnState) {
        input.setStatus("Agent is still responding.");
        return;
      }
      input.setTraceId(result.traceId);
      input.setLiveModelText("");

      // 同上（tui-pi applyResult）：result.turnId 是已 settle 回合，
      // 不回写成 activeTurnId；仅当它仍被标记为活跃时清掉。当前值读
      // ref 镜像、两个 setter 都在 updater 之外调用——updater 必须纯，
      // React 可能重复调用或丢弃它，副作用写在里面会与 activeTurnId
      // 的变更脱钩。
      clearSettledActiveTurn({
        activeTurnId: input.activeTurnIdRef.current,
        settledTurnId: result.turnId,
        setActiveTurnId: input.setActiveTurnId,
        setActiveTurnStartedAtMs: input.setActiveTurnStartedAtMs,
      });
      // 换绑结果会同时携带 reset 与绑定种子（projection/usageTotals）：
      // 必须先清空再落种子，否则 reset 会把刚种上的快照读数抹掉。
      if (result.resetSessionProjection) {
        input.setUsage(undefined);
        input.setContextUsage({});
        input.setCacheStats(undefined);
        input.setTodos([]);
        input.setNetworkRequests([]);
        input.setModifiedFiles([]);
        input.modifiedFileToolCallIds.clear();
      }
      if (result.usage) input.setUsage(result.usage);
      if (result.projection) {
        input.setContextUsage((current) => ({
          ...current,
          ...validContextUsage(result.projection ?? {}),
        }));
      }

      input.setSelection(createSelectionState(result.selection));
      input.setQueuedInputs([]);
      const activeLoginRequired = result.loginRequired ?? input.fallback.loginRequired;
      input.setStatus(
        result.selection
          ? result.selection.prompt
          : activeLoginRequired
            ? resultCopy.loginRequired.status
            : resultCopy.status.ready,
      );
      input.setLastEvent(result.turnId ? `turn ${result.turnId}` : "complete");
    },
    [input],
  );
}
