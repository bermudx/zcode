// Footer stats 行布局（pi-mono footer 同构）：左区 session 用量簇
// （↑in ↓out R… CH%）+ ctx 仪表 `{pct}%/{win}`，右区身份簇
// `(provider) model · thought · mode · agents:N`。pwd 行（`~/cwd (branch)`）
// 见 formatPwdLine。收缩顺序：左区行尾截断 → 右区按剩余宽度截断
// （余窗不足 MIN_RIGHT_WIDTH 时右区整体退场，不留碎片）。

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

/**
 * 组装用量簇段。cacheHitRate 为 `cacheHit.latestHitRate`（0–1 单请求口径，
 * 同 pi 的 latestCacheHitRate）；缺省时回退 session 累计
 * `cacheRead/input`（React sidebar `cacheHitLabel` 同一公式）。
 * 无 `$` 段：契约无定价来源，plan 额度读数属 provider-balance 方向。
 */
export function formatUsageCluster(input: {
  usageTotals?: UsageTotals;
  cacheHitRate?: number;
}): string | undefined {
  const parts: string[] = [];
  const { usageTotals } = input;
  if (
    !usageTotals ||
    usageTotals.inputTokens + usageTotals.outputTokens + usageTotals.cacheReadTokens === 0
  ) {
    return undefined;
  }
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
  return parts.join(" ");
}

/** `63%/255k`；无窗口但有 contextUsed 时降级 `ctx 5.0k`。 */
export function formatContextSegment(contextUsage: ContextUsage): string | undefined {
  const used = contextUsage.contextUsed;
  const win = contextUsage.contextWindow;
  if (win !== undefined && win > 0) {
    return `${used !== undefined ? `${((used / win) * 100).toFixed(1)}%` : "–"}/${formatTokens(win)}`;
  }
  return used !== undefined ? `ctx ${formatTokens(used)}` : undefined;
}

/** `provider/model` → `(provider) model`；裸 id 原样显示。 */
export function formatModelLabel(model: string): string | undefined {
  if (!model) return undefined;
  const slash = model.lastIndexOf("/");
  if (slash <= 0 || slash === model.length - 1) return model;
  return `(${model.slice(0, slash)}) ${model.slice(slash + 1)}`;
}

/** 右区身份簇：`model · thought · mode · agents:N`。ctx 仪表在左区用量簇旁。 */
export function formatIdentityCluster(s: AppStore["state"]): string | undefined {
  const identity = [
    formatModelLabel(s.model),
    s.thoughtLevel || undefined,
    s.mode || undefined,
  ].filter(Boolean);
  const running = s.subagents?.running.length ?? 0;
  if (running > 0) identity.push(`agents:${running}`);
  const text = identity.join(" · ");
  return text.length > 0 ? text : undefined;
}

/** cwd 显示标签：`$HOME` 前缀折叠为 `~`；相对路径原样保留。 */
export function formatCwdLabel(input: { cwd?: string; home?: string }): string {
  const cwd = input.cwd?.replace(/\\/g, "/") ?? "";
  const home = input.home?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

/** pwd 行：`~/cwd (branch)`，行尾 "…" 截断（pi 同款）；branch 缺省只显 cwd。 */
export function formatPwdLine(input: {
  branch?: string;
  cwdLabel?: string;
  width: number;
}): string {
  if (input.width < 1) return "";
  const base = input.cwdLabel ?? "";
  const text = input.branch ? `${base} (${input.branch})` : base;
  if (text.length === 0) return "";
  return truncateToWidth(text, input.width, "…");
}

/** stats 行左区：用量簇与 ctx 仪表同侧（pi footer 同构），空段跳过。 */
const formatStatsLeft = (s: AppStore["state"]): string =>
  [
    formatUsageCluster({
      cacheHitRate: s.cacheHitRate,
      usageTotals: s.usageTotals,
    }),
    formatContextSegment(s.contextUsage),
  ]
    .filter((part) => part && part.length > 0)
    .join(" ");

/**
 * stats 行整行组装：左区放不下先行尾截断，右区再按剩余宽度截断
 * （pi footer 同序；右区截断无标记，避免挤掉身份簇尾部）。余窗不足
 * MIN_RIGHT_WIDTH 时右区整体退场——1–3 列只够渲染 `(`/`(p`/`(pr` 级
 * 碎片，会在收缩谱上留一截可见毛刺。
 */
export function formatStatsLine(input: { state: AppStore["state"]; width: number }): string {
  const { state, width } = input;
  if (width < 1) return "";
  const MIN_PADDING = 2;
  const MIN_RIGHT_WIDTH = 4;
  let left = formatStatsLeft(state);
  if (visibleWidth(left) > width) left = truncateToWidth(left, width, "…");
  const leftWidth = visibleWidth(left);
  const availableForRight = width - leftWidth - MIN_PADDING;
  const right = formatIdentityCluster(state) ?? "";
  if (availableForRight < MIN_RIGHT_WIDTH) return left;
  const rightText =
    visibleWidth(right) > availableForRight ? truncateToWidth(right, availableForRight, "") : right;
  const padding = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(rightText)));
  return `${left}${padding}${rightText}`;
}
