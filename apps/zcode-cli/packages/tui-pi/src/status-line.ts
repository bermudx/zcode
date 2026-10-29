// Footer stats 行布局（pi-mono footer 同构）：左区 session 用量簇
// （↑in ↓out R… [W…] [CH%] [$cost]）+ ctx 仪表 `{pct}%/{win}(auto)`，右区
// 身份簇 `(provider) model • thought • mode • agents:N`。pwd 行
// （`~/cwd (branch)` + 可选右对齐额度簇）见 formatPwdLine / formatPwdRow。
// 分段门与分隔符、右对齐最小间距、截断标记均对齐 pi footer：
// 左区行尾 "..." 截断 → 右区按剩余宽度截断（无标记）。

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextUsage } from "@zcode/tui/internals";
import type { PiTheme } from "./theme.js";
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
 * 组装用量簇段（pi footer 同门同序）：↑/↓/R/W 只在计数 >0 时出现；
 * CH 仅当 `cacheRead>0 || cacheWrite>0` 且最近请求命中率在时显示
 * （pi `latestCacheHitRate` 同口径，0–1 小数渲染成一位小数百分比）。
 * 命中率出界（<0 或 >1）属于 provider 数据异常：隐藏该段，不伪造 100%+。
 */
export function formatUsageCluster(input: {
  usageTotals?: UsageTotals;
  cacheHitRate?: number;
}): string | undefined {
  const parts: string[] = [];
  const { usageTotals } = input;
  if (!usageTotals) return undefined;
  if (usageTotals.inputTokens > 0) parts.push(`↑${formatTokens(usageTotals.inputTokens)}`);
  if (usageTotals.outputTokens > 0) parts.push(`↓${formatTokens(usageTotals.outputTokens)}`);
  if (usageTotals.cacheReadTokens > 0) parts.push(`R${formatTokens(usageTotals.cacheReadTokens)}`);
  if (usageTotals.cacheWriteTokens > 0) parts.push(`W${formatTokens(usageTotals.cacheWriteTokens)}`);
  const hasCacheTraffic = usageTotals.cacheReadTokens > 0 || usageTotals.cacheWriteTokens > 0;
  const hit = input.cacheHitRate;
  if (hasCacheTraffic && hit !== undefined && Number.isFinite(hit) && hit >= 0 && hit <= 1) {
    parts.push(`CH${(hit * 100).toFixed(1)}%`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** `$0.019`：目录价估算累计 >0 时显示；$0（plan 内置档）与未知模型不出段。 */
export function formatCostSegment(costUsd: number | undefined): string | undefined {
  if (costUsd === undefined || !(costUsd > 0)) return undefined;
  return `$${costUsd.toFixed(3)}`;
}

/** `63%/255k`；无窗口但有 contextUsed 时降级 `ctx 5.0k`。 */
export function formatContextSegment(
  contextUsage: ContextUsage,
  options?: { autoCompact?: boolean },
): string | undefined {
  return contextSegmentParts(contextUsage, options).text || undefined;
}

/**
 * ctx 段结构化形态：pi footer 同款——窗口在时 `{pct}%/{win}`（used 缺失为
 * `?`），仅有 used 时降级 `ctx {compact(used)}`；`(auto)` 直接拼在段尾。
 * percent 供阈值着色（>90 danger、>70 warning）。
 */
function contextSegmentParts(
  contextUsage: ContextUsage,
  options?: { autoCompact?: boolean },
): { text: string; percent: number | null } {
  const used = contextUsage.contextUsed;
  const win = contextUsage.contextWindow;
  const auto = options?.autoCompact ? " (auto)" : "";
  if (win !== undefined && win > 0) {
    if (used === undefined) return { text: `?/${formatTokens(win)}${auto}`, percent: null };
    const percent = (used / win) * 100;
    return { text: `${percent.toFixed(1)}%/${formatTokens(win)}${auto}`, percent };
  }
  return {
    text: used !== undefined ? `ctx ${formatTokens(used)}${auto}` : "",
    percent: null,
  };
}

/** `provider/model` → `(provider) model`；裸 id 原样显示。 */
export function formatModelLabel(model: string): string | undefined {
  if (!model) return undefined;
  const slash = model.lastIndexOf("/");
  if (slash <= 0 || slash === model.length - 1) return model;
  return `(${model.slice(0, slash)}) ${model.slice(slash + 1)}`;
}

/** `provider/model` → `{provider, model}`；裸 id 无 provider。 */
function splitModelLabel(model: string): { provider?: string; model: string } {
  const slash = model.lastIndexOf("/");
  if (slash <= 0 || slash === model.length - 1) return { model };
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/**
 * pi footer `contextWindow ?? model.contextWindow` 同款回退：会话事件还没
 * 给出窗口时（attach 首帧、新会话首个 model_complete 之前），用当前模型
 * 的目录窗口渲染 `?/{win}`。model 为 `provider/model` 时要求 provider
 * 一并匹配，避免同名模型误取另一家的窗口。
 */
function contextUsageWithModelWindow(s: AppStore["state"]): ContextUsage {
  if (s.contextUsage.contextWindow !== undefined || !s.model) return s.contextUsage;
  const split = splitModelLabel(s.model);
  const option = (s.modelOptions ?? []).find(
    (candidate) =>
      candidate.ref?.modelId === split.model &&
      (split.provider === undefined || candidate.ref.providerId === split.provider),
  );
  const contextWindow = option?.contextWindow;
  return contextWindow === undefined
    ? s.contextUsage
    : { ...s.contextUsage, contextWindow };
}

/**
 * 可用 provider 数：modelOptions 里去重后的 providerId 数（pi
 * `getAvailableProviderCount()` 同角色）。快照缺席时按 1 处理——不凭空
 * 显示 provider 前缀。
 */
function availableProviderCount(s: AppStore["state"]): number {
  const providers = new Set<string>();
  for (const option of s.modelOptions ?? []) {
    const providerId = option.ref?.providerId;
    if (providerId) providers.add(providerId);
  }
  return Math.max(1, providers.size);
}

/**
 * 右区身份簇（pi footer 同语法）：`model`，provider 前缀
 * `(provider) ` 仅当可用 provider 数 >1；`• {thinkingLevel}`（off 显式
 * `thinking off`，pi 同文案）；mode / agents:N 为 piz 扩展段，沿用 `•`
 * 附着在 pi 段之后。
 */
export function formatIdentityCluster(s: AppStore["state"]): string | undefined {
  const split = s.model ? splitModelLabel(s.model) : { model: "no-model" };
  if (!split.model) return undefined;
  const parts: string[] = [];
  const prefix =
    split.provider && availableProviderCount(s) > 1 ? `(${split.provider}) ` : "";
  parts.push(`${prefix}${split.model}`);
  if (s.thoughtLevel) {
    parts.push(s.thoughtLevel === "off" ? "thinking off" : s.thoughtLevel);
  }
  if (s.mode) parts.push(s.mode);
  const running = s.subagents?.running.length ?? 0;
  if (running > 0) parts.push(`agents:${running}`);
  return parts.join(" • ");
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

/** pwd 行：`~/cwd (branch)`，行尾 "..." 截断（pi 同款）；branch 缺省只显 cwd。 */
export function formatPwdLine(input: {
  branch?: string;
  cwdLabel?: string;
  width: number;
}): string {
  if (input.width < 1) return "";
  const base = input.cwdLabel ?? "";
  const text = input.branch ? `${base} (${input.branch})` : base;
  if (text.length === 0) return "";
  return truncateToWidth(text, input.width, "...");
}

/**
 * pwd 行整行组装（pi goodies provider-balance
 * `addBalanceToWorkingDirectoryLine` 同构移植）：额度读数右对齐、`dim`，
 * 两区间距 ≥2 空格（padding 下限 1）；右半 ≥ 全宽时只渲染右半（截断无
 * 标记）；左半按余宽 "..." 截断。quotaText 缺席时退化为普通 pwd 行。
 */
export function formatPwdRow(input: {
  branch?: string;
  cwdLabel?: string;
  width: number;
  theme: Pick<PiTheme, "dim">;
  quotaText?: string;
}): string {
  if (input.width < 1) return "";
  const styled = input.theme.dim(formatPwdLine(input));
  const quotaText = input.quotaText;
  if (!quotaText) return truncateToWidth(styled, input.width, input.theme.dim("..."));
  const right = input.theme.dim(quotaText);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= input.width) return truncateToWidth(right, input.width, "");
  const maxLeftWidth = Math.max(0, input.width - rightWidth - 2);
  const left = truncateToWidth(styled, maxLeftWidth, input.theme.dim("..."));
  const padding = " ".repeat(Math.max(1, input.width - visibleWidth(left) - rightWidth));
  return `${left}${padding}${right}`;
}

/** stats 行左区：用量簇 + $ + ctx 仪表（pi footer 同序），空段跳过。 */
const formatStatsLeftSegments = (
  s: AppStore["state"],
): { text: string; style?: "warning" | "danger"; isContext?: boolean }[] => {
  const segments: { text: string; style?: "warning" | "danger"; isContext?: boolean }[] = [];
  const usage = formatUsageCluster({
    cacheHitRate: s.cacheHitRate,
    usageTotals: s.usageTotals,
  });
  if (usage) segments.push({ text: usage });
  const cost = formatCostSegment(s.usageTotals?.costUsd);
  if (cost) segments.push({ text: cost });
  const ctx = contextSegmentParts(contextUsageWithModelWindow(s), { autoCompact: s.autoCompact });
  if (ctx.text) {
    segments.push({
      isContext: true,
      style: ctx.percent === null ? undefined : ctx.percent > 90 ? "danger" : ctx.percent > 70 ? "warning" : undefined,
      text: ctx.text,
    });
  }
  return segments;
};

/**
 * stats 行整行组装：左区放不下先行尾 "..." 截断，右区再按剩余宽度截断
 * （pi footer 同序；右区截断无标记，避免挤掉身份簇尾部）。着色同 pi：
 * 整行 dim，ctx 百分比 >90 danger、>70 warning（着色段两侧的 dim 独立
 * 包裹——外层 dim 会被内段 reset 提前终结）。
 */
export function formatStatsLine(input: { state: AppStore["state"]; width: number; theme: PiTheme }): string {
  const { state, width, theme } = input;
  if (width < 1) return "";
  const MIN_PADDING = 2;
  const segments = formatStatsLeftSegments(state);
  const contextIndex = segments.findIndex((segment) => segment.isContext);
  const renderSegment = (segment: { text: string; style?: "warning" | "danger" }): string => {
    if (segment.style === "danger") return theme.danger(segment.text);
    if (segment.style === "warning") return theme.warning(segment.text);
    return theme.dim(segment.text);
  };
  let statsLeft: string;
  if (contextIndex >= 0) {
    const before = segments.slice(0, contextIndex).map(renderSegment).join(" ");
    const at = renderSegment(segments[contextIndex]);
    const after = segments.slice(contextIndex + 1).map(renderSegment).join(" ");
    statsLeft = [before, at, after].filter((part) => part.length > 0).join(" ");
  } else {
    statsLeft = segments.map(renderSegment).join(" ");
  }
  if (visibleWidth(statsLeft) > width) {
    statsLeft = truncateToWidth(statsLeft, width, theme.dim("..."));
  }
  const leftWidth = visibleWidth(statsLeft);
  const right = formatIdentityCluster(state) ?? "";
  const availableForRight = width - leftWidth - MIN_PADDING;
  let rightText = right;
  if (visibleWidth(right) > availableForRight) {
    rightText = availableForRight > 0 ? truncateToWidth(right, availableForRight, "") : "";
  }
  if (rightText.length === 0) return statsLeft;
  const padding = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(rightText)));
  return `${statsLeft}${theme.dim(padding + rightText)}`;
}
