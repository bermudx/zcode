// Footer meta 行布局：左区 cwd + session 用量簇（↑in ↓out R… CH%），
// 右区 ctx 仪表 + 模型身份 `(provider) model · thought · mode · agents:N`。
// 宽度不够时依次退让：先丢用量簇，再省略 cwd，最后截右区尾部。

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextUsage } from "@zcode/tui/internals";
import type { AppStore, UsageTotals } from "./store.js";

const ZONE_GAP = 2;

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

/** 右区身份簇：ctx 仪表空两格接 `model · thought · mode · agents:N`。 */
export function formatIdentityCluster(s: AppStore["state"]): string | undefined {
  const identity = [
    formatModelLabel(s.model),
    s.thoughtLevel || undefined,
    s.mode || undefined,
  ].filter(Boolean);
  const running = s.subagents?.running.length ?? 0;
  if (running > 0) identity.push(`agents:${running}`);
  const ctx = formatContextSegment(s.contextUsage);
  const identityText = identity.join(" · ");
  const text = [ctx, identityText].filter((part) => part && part.length > 0).join("  ");
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

/** 保留路径尾部的左省略：`budget` 不足 2 时整段隐藏。 */
const ellipsizeLeft = (text: string, budget: number): string => {
  if (budget < 1) return "";
  if (visibleWidth(text) <= budget) return text;
  if (budget < 2) return "";
  // 按码点从尾部往回取，宽字符（CJK 路径）也不会超出预算。
  const chars = [...text];
  let tail = "";
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const next = chars[i] + tail;
    if (visibleWidth(next) >= budget) break;
    tail = next;
  }
  return `…${tail}`;
};

/** `left + 空白 + right` 单行拼接；放不下返回 undefined。 */
const composeZones = (left: string, right: string, width: number): string | undefined => {
  if (width < 1) return "";
  if (!left) return visibleWidth(right) <= width ? right : undefined;
  if (!right) return visibleWidth(left) <= width ? left : undefined;
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < ZONE_GAP) return undefined;
  return `${left}${" ".repeat(gap)}${right}`;
};

/**
 * meta 行整行组装：左区 `cwd  用量簇`，右区 ctx + 身份簇。
 * 收缩顺序：丢用量簇 → cwd 左省略 → 只剩右区 → 右区硬截断。
 */
export function formatMetaLine(input: {
  cwdLabel?: string;
  state: AppStore["state"];
  width: number;
}): string {
  const { state, width } = input;
  const right = formatIdentityCluster(state) ?? "";
  const cluster = formatUsageCluster({
    cacheHitRate: state.cacheHitRate,
    usageTotals: state.usageTotals,
  });
  const cwd = input.cwdLabel ?? "";

  for (const left of [cluster ? `${cwd}${cwd ? "  " : ""}${cluster}` : cwd, cwd]) {
    if (!left) continue;
    const line = composeZones(left, right, width);
    if (line !== undefined) return line;
  }
  const budget = Math.max(0, width - visibleWidth(right) - ZONE_GAP);
  const shrunk = composeZones(ellipsizeLeft(cwd, budget), right, width);
  if (shrunk !== undefined) return shrunk;
  return truncateToWidth(right, Math.max(1, width));
}
