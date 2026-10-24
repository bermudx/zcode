// 状态行的 session 累计用量（pi footer 的 ↑/↓/R 是累计计数）。`state.usage`
// 在 turn 内被 applyModelCompleteEvent 以单请求 ModelUsage 覆盖、只在
// turn_complete 回到权威累计——直接读它会让 ↑↓ 回合内跳变。本累计器把
// 主会话 model_complete 的单请求用量逐次折入；turn_complete 携带的权威
// session summary 到点整段采信（替换，不累加，自愈漂移），submitPrompt
// 结果的 result.usage 走 adopt() 同口径。

import {
  SessionEventType,
  getModelUsageInputWindowTokens,
  type ModelCompletePayload,
  type ModelUsageSummary,
  type SessionEvent,
} from "@zcode/contracts";
import { isMainSessionEvent, usageFromPayload, type TuiOptions } from "@zcode/tui/internals";
import type { AppStore, UsageTotals } from "./store.js";

export class UsageTotalsAccumulator {
  private totals: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  constructor(
    private readonly store: AppStore,
    private readonly options: Pick<TuiOptions, "getMainSessionId">,
  ) {}

  handleEvent(event: SessionEvent): void {
    if (event.type === SessionEventType.TurnComplete) {
      // turn_complete 的 usage 是权威 session summary：整段采信，回合内折叠
      // 误差与 sidecar 用量在此归并（替换非累加，不双计）。
      const summary = usageFromPayload(
        (event.payload ?? {}) as Record<string, unknown>,
      );
      if (summary) this.adopt(summary);
      return;
    }
    if (event.type !== SessionEventType.ModelComplete) return;
    // 只计主会话：subagent tool mirror 与子会话 model_complete 已由
    // isMainSessionEvent 排除，与子代理目录/转写投影的主会话门一致。
    if (!isMainSessionEvent(event, this.options.getMainSessionId?.())) return;
    const payload = event.payload as ModelCompletePayload | undefined;
    const usage = payload?.usage;
    if (usage) {
      // TokenUsage 分支只有 cacheTokens 聚合值，没有 read/write 拆分。
      const cacheRead = "cacheReadTokens" in usage ? usage.cacheReadTokens : undefined;
      this.totals = {
        inputTokens:
          this.totals.inputTokens + (getModelUsageInputWindowTokens(usage) ?? 0),
        outputTokens: this.totals.outputTokens + Math.max(0, usage.outputTokens ?? 0),
        cacheReadTokens: this.totals.cacheReadTokens + Math.max(0, cacheRead ?? 0),
      };
      this.publish();
    }
    // pi 的 CH 是最近一次请求的 cacheHit.latestHitRate（0–1）。
    const rate = payload?.cacheHit?.latestHitRate;
    if (typeof rate === "number" && Number.isFinite(rate)) {
      this.store.set("cacheHitRate", rate);
    }
  }

  /** 权威 session summary（submitPrompt result.usage）整段采信。 */
  adopt(summary: ModelUsageSummary): void {
    this.totals = {
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      cacheReadTokens: summary.cacheReadTokens,
    };
    this.publish();
  }

  reset(): void {
    this.totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    this.store.set("usageTotals", undefined);
    this.store.set("cacheHitRate", undefined);
  }

  private publish(): void {
    this.store.set("usageTotals", { ...this.totals });
  }
}
