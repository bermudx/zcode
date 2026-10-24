// 状态行用量簇：pi-mono footer 形态（↑in ↓out R{cacheRead} CH{hit}% ctx%/win
// agents:N）的纯格式化。↑↓R 读 UsageTotalsAccumulator 的 session 累计——
// `state.usage` 在 turn 内是单请求口径，不能直接用。

import type { ContextUsage } from "@zcode/tui/internals";
import type { AppStore, UsageTotals } from "./store.js";

/** pi-mono `formatTokens` 等值（footer.js）：紧凑计数 103k / 1.8M / 255k。 */
export function formatTokens(count: number): string {
  if (count < 1e3) return count.toString();
  if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1e3)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

/** 整行组装：mode | model | thought | busy? | status | 用量簇。 */
export function formatStatusLine(s: AppStore["state"]): string {
  const parts: string[] = [];
  if (s.mode) parts.push(`mode:${s.mode}`);
  if (s.model) parts.push(s.model.split("/").pop() ?? s.model);
  if (s.thoughtLevel) parts.push(`thought:${s.thoughtLevel}`);
  if (s.busy) parts.push("busy");
  if (s.status) parts.push(s.status);
  const cluster = formatUsageCluster({
    usageTotals: s.usageTotals,
    contextUsage: s.contextUsage,
    cacheHitRate: s.cacheHitRate,
    runningSubagents: s.subagents?.running.length,
  });
  if (cluster) parts.push(cluster);
  return parts.join("  |  ");
}

/**
 * 组装用量簇段。cacheHitRate 为 `cacheHit.latestHitRate`（0–1 单请求口径，
 * 同 pi 的 latestCacheHitRate）；缺省时回退 session 累计
 * `cacheRead/input`（React sidebar `cacheHitLabel` 同一公式）。
 * `contextWindow` 缺失但有 contextUsed 时降级为 `ctx {compact}`。
 * 无 `$` 段：契约无定价来源，plan 额度读数属 provider-balance 方向。
 */
export function formatUsageCluster(input: {
  usageTotals?: UsageTotals;
  contextUsage: ContextUsage;
  cacheHitRate?: number;
  runningSubagents?: number;
}): string | undefined {
  const parts: string[] = [];
  const { usageTotals } = input;
  if (
    usageTotals &&
    usageTotals.inputTokens + usageTotals.outputTokens + usageTotals.cacheReadTokens > 0
  ) {
    parts.push(`↑${formatTokens(usageTotals.inputTokens)}`);
    parts.push(`↓${formatTokens(usageTotals.outputTokens)}`);
    parts.push(`R${formatTokens(usageTotals.cacheReadTokens)}`);
    const hit =
      input.cacheHitRate ??
      (usageTotals.inputTokens > 0
        ? usageTotals.cacheReadTokens / usageTotals.inputTokens
        : undefined);
    // 命中率出界（<0 或 >1）属于 provider 数据异常：隐藏该段，不伪造 100%+。
    if (hit !== undefined && Number.isFinite(hit) && hit >= 0 && hit <= 1) {
      parts.push(`CH${(hit * 100).toFixed(1)}%`);
    }
  }
  const used = input.contextUsage.contextUsed;
  const win = input.contextUsage.contextWindow;
  if (win !== undefined && win > 0) {
    parts.push(
      `${used !== undefined ? `${((used / win) * 100).toFixed(1)}%` : "–"}/${formatTokens(win)}`,
    );
  } else if (used !== undefined) {
    parts.push(`ctx ${formatTokens(used)}`);
  }
  const running = input.runningSubagents ?? 0;
  if (running > 0) parts.push(`agents:${running}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
