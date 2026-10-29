// 状态行的 session 累计用量（pi footer 的 ↑/↓/R 是累计计数）。turn_complete
// / submitPrompt 的 usage 都是 createModelUsageSummaryFromEvents(本回合事件)
// 的回合口径，采纳会把累计显示打回本回合数字——所以 live 部分只做纯折叠：
// model_complete 与 model_request_failed 的单请求用量逐次累加，与
// contracts summarizeSessionUsageTotals 同一事件集合、同一字段口径。
// 调用方只投递 applyMainSessionEvent 已采纳（主会话门 + 事件 id 去重）的
// 事件——同一事件经 session sink 与 per-turn onEvent 双投递，dedup 保证
// 恰好一次。接入前的部分由绑定结果的 usageTotals 种子补齐（协议快照
// runtime.usageTotals，core 对 eventStore 同口径折叠）；resetSessionProjection
// 时清零。

import {
  SessionEventType,
  getModelUsageInputWindowTokens,
  type ModelCompletePayload,
  type ModelNetworkStatusEvent,
  type ModelUsage,
  type SessionEvent,
} from "@zcode/contracts";
import {
  isMainSessionEvent,
  type TuiOptions,
  type TuiSubmitPromptResult,
} from "@zcode/tui/internals";
import type { AppStore, UsageTotals } from "./store.js";
import { cacheExclusiveInputTokens, lookupModelRates, requestCostUsd } from "./pricing.js";

export class UsageTotalsAccumulator {
  private totals: UsageTotals = { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };

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

  /**
   * 绑定结果携带的 session 级种子（协议快照 runtime.usageTotals，
   * contracts summarizeSessionUsageTotals 产出——与 fold 同一事件集合、
   * 同一字段口径）：采纳为累计基线，live 事件自此继续折叠。seed 替换而
   * 非累加，重复应用幂等。costUsd 没有历史分布，只能对整份种子按当前
   * 模型目录价一次性估值——与逐请求折叠的归界误差同级。
   */
  seed(totals: TuiSubmitPromptResult["usageTotals"] | undefined): void {
    if (!totals) return;
    const inputTokens = Math.max(0, totals.inputTokens);
    const outputTokens = Math.max(0, totals.outputTokens);
    const cacheReadTokens = Math.max(0, totals.cacheReadTokens);
    const cacheWriteTokens = Math.max(0, totals.cacheWriteTokens);
    const rates = lookupModelRates(this.store.state.model);
    const costUsd = rates
      ? requestCostUsd(rates, {
          cacheReadTokens,
          cacheWriteTokens,
          inputTokens: cacheExclusiveInputTokens({
            cacheReadTokens,
            cacheWriteTokens,
            inputWindowTokens: inputTokens,
          }),
          outputTokens,
        })
      : 0;
    this.totals = { cacheReadTokens, cacheWriteTokens, costUsd, inputTokens, outputTokens };
    this.publish();
    const rate = totals.latestCacheHitRate;
    if (typeof rate === "number" && Number.isFinite(rate)) {
      this.store.set("cacheHitRate", rate);
    }
  }

  reset(): void {
    this.totals = { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    this.store.set("usageTotals", undefined);
    this.store.set("cacheHitRate", undefined);
  }

  private fold(usage: ModelUsage): void {
    // TokenUsage 分支只有 cacheTokens 聚合值，没有 read/write 拆分。
    const cacheRead = "cacheReadTokens" in usage ? usage.cacheReadTokens : undefined;
    const cacheWrite = usage.cacheWriteTokens;
    const inputWindowTokens = getModelUsageInputWindowTokens(usage) ?? 0;
    const cacheReadTokens = Math.max(0, cacheRead ?? 0);
    const cacheWriteTokens = Math.max(0, cacheWrite ?? 0);
    // 契约无成本字段：按折叠时刻当前模型的目录价计价（pi 按条目模型计价，
    // 中途换模型时这里有一次请求的归界误差，契约带模型 id 后可消除）；
    // 未知模型成本贡献为 0。input 基座去掉 cache 两项，防重复计费。
    const rates = lookupModelRates(this.store.state.model);
    const costUsd = rates
      ? requestCostUsd(rates, {
          cacheReadTokens,
          cacheWriteTokens,
          inputTokens: cacheExclusiveInputTokens({
            cacheReadTokens,
            cacheWriteTokens,
            inputWindowTokens,
          }),
          outputTokens: Math.max(0, usage.outputTokens ?? 0),
        })
      : 0;
    this.totals = {
      cacheReadTokens: this.totals.cacheReadTokens + cacheReadTokens,
      cacheWriteTokens: this.totals.cacheWriteTokens + cacheWriteTokens,
      costUsd: this.totals.costUsd + costUsd,
      inputTokens: this.totals.inputTokens + inputWindowTokens,
      outputTokens: this.totals.outputTokens + Math.max(0, usage.outputTokens ?? 0),
    };
    this.publish();
  }

  private publish(): void {
    this.store.set("usageTotals", { ...this.totals });
  }
}
