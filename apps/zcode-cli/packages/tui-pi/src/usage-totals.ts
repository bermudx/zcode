// 状态行的 session 累计用量（pi footer 的 ↑/↓/R 是累计计数）。契约里没有
// session 级权威用量源——turn_complete / submitPrompt 的 usage 都是
// createModelUsageSummaryFromEvents(本回合事件) 的回合口径，采纳会把
// 累计显示打回本回合数字——所以这里只做纯折叠：model_complete 与
// model_request_failed 的单请求用量逐次累加，与权威口径同一事件集合
// （contracts/session.events.ts:1275-1290）。
// 调用方只投递 applyMainSessionEvent 已采纳（主会话门 + 事件 id 去重）的
// 事件——同一事件经 session sink 与 per-turn onEvent 双投递，dedup 保证
// 恰好一次。attach 中途接入只计接入后流量；resetSessionProjection 时清零。

import {
  SessionEventType,
  getModelUsageInputWindowTokens,
  type ModelCompletePayload,
  type ModelNetworkStatusEvent,
  type ModelUsage,
  type SessionEvent,
} from "@zcode/contracts";
import { isMainSessionEvent, type TuiOptions } from "@zcode/tui/internals";
import type { AppStore, UsageTotals } from "./store.js";

export class UsageTotalsAccumulator {
  private totals: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  constructor(
    private readonly store: AppStore,
    private readonly options: Pick<TuiOptions, "getMainSessionId">,
  ) {}

  handleEvent(event: SessionEvent): void {
    // 主会话门独立于调用方 dedup 再声明一次：本类的领域不变量就是
    // 「只累计主会话用量」，不信任调用点纪律。
    if (!isMainSessionEvent(event, this.options.getMainSessionId?.())) return;
    if (event.type === SessionEventType.ModelComplete) {
      const payload = event.payload as ModelCompletePayload | undefined;
      if (payload?.usage) this.fold(payload.usage);
      // pi 的 CH 是最近一次请求的 cacheHit.latestHitRate（0–1）。
      const rate = payload?.cacheHit?.latestHitRate;
      if (typeof rate === "number" && Number.isFinite(rate)) {
        this.store.set("cacheHitRate", rate);
      }
      return;
    }
    if (event.type === SessionEventType.ModelNetworkStatus) {
      const payload = event.payload as ModelNetworkStatusEvent | undefined;
      if (payload?.type === "model_request_failed" && payload.usage) {
        this.fold(payload.usage);
      }
    }
  }

  reset(): void {
    this.totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    this.store.set("usageTotals", undefined);
    this.store.set("cacheHitRate", undefined);
  }

  private fold(usage: ModelUsage): void {
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

  private publish(): void {
    this.store.set("usageTotals", { ...this.totals });
  }
}
