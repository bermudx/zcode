// Coding Plan 额度簇的纯格式化层（pi goodies provider-balance 同构移植，
// glyph 语义一致：`5h: 99% ↻4h · 7d: 32% ↻5d9h`，↻ = 窗口重置倒计时）。
// 数据来自共享协议 `usage/codingPlanQuota`（core 用 provider 凭据拉监控
// 端点，返回共享 UsageQuotaSnapshot）；本模块只做 limit → 窗口映射与
// 渲染，不发网络请求。zai 监控端点的字段语义（percentage 为已用口径、
// nextResetTime 秒/毫秒双容差、unit 枚举）与 provider-balance
// parseZaiQuota 保持一致。

import type { UsageQuotaLimit, UsageQuotaSnapshot } from "@zcode/shared";

export interface QuotaWindow {
  /** 剩余额度，0–100。 */
  remainingPercent: number;
  /** 窗口长度（秒），渲染成紧凑 `7d`/`5h` 标签。 */
  windowSeconds?: number;
  /** 窗口重置时刻（Unix 秒）。 */
  resetAt?: number;
}

export type Balance = QuotaWindow[];

const QUOTA_LIMIT_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);

/** zai 监控端点 unit 枚举：1=天 3=小时 5=分钟 6=周（parseZaiQuota 同表）。 */
function limitWindowSeconds(limit: UsageQuotaLimit): number | null {
  const unit = limit.unit;
  const number = limit.number;
  if (typeof unit !== "number" || typeof number !== "number") return null;
  if (!Number.isInteger(number) || number <= 0) return null;
  const secondsPerUnit: Record<number, number> = {
    1: 24 * 60 * 60,
    3: 60 * 60,
    5: 60,
    6: 7 * 24 * 60 * 60,
  };
  const multiplier = secondsPerUnit[unit];
  return multiplier ? number * multiplier : null;
}

/**
 * 已用百分比：优先 `percentage`；旧响应缺 percentage 时按 usage/remaining/
 * currentValue 折算，不把不完整额度伪装成 0%（parseZaiUsedPercent 同式）。
 */
function limitUsedPercent(limit: UsageQuotaLimit): number | null {
  if (typeof limit.percentage === "number" && Number.isFinite(limit.percentage)) {
    return limit.percentage;
  }
  const limitValue = typeof limit.usage === "number" ? limit.usage : null;
  if (limitValue === null || limitValue <= 0) return null;
  const remaining = typeof limit.remaining === "number" ? limit.remaining : null;
  const currentValue = typeof limit.currentValue === "number" ? limit.currentValue : null;
  const used =
    remaining !== null ? Math.max(limitValue - remaining, currentValue ?? 0) : currentValue;
  return used === null ? null : (used / limitValue) * 100;
}

/** nextResetTime 兼容毫秒/秒两种返回（≥1e10 视为毫秒），防倒计时变十年。 */
function limitResetAt(limit: UsageQuotaLimit): number | undefined {
  const nextResetTime = limit.nextResetTime;
  if (typeof nextResetTime !== "number" || !Number.isFinite(nextResetTime) || nextResetTime <= 0) {
    return undefined;
  }
  return nextResetTime >= 10_000_000_000 ? nextResetTime / 1000 : nextResetTime;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** 共享 UsageQuotaLimit（已用口径）→ 剩余窗口；无法解析的 limit 返回 null。 */
export function quotaLimitToWindow(limit: UsageQuotaLimit): QuotaWindow | null {
  if (!QUOTA_LIMIT_TYPES.has(limit.type)) return null;
  const usedPercent = limitUsedPercent(limit);
  if (usedPercent === null) return null;
  const windowSeconds = limitWindowSeconds(limit);
  // provider-balance parseZaiQuota 同门：unit/number 无法解析的 limit 丢弃，
  // 不渲染无窗口标签的孤立百分比。
  if (windowSeconds === null) return null;
  const resetAt = limitResetAt(limit);
  return {
    remainingPercent: clampPercent(100 - usedPercent),
    windowSeconds,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/** 快照 → 窗口列表；窗口按秒升序（5h 在前，provider-balance 同序）。 */
export function quotaSnapshotToBalance(snapshot: UsageQuotaSnapshot): Balance {
  return snapshot.limits
    .flatMap((limit) => {
      const window = quotaLimitToWindow(limit);
      return window ? [window] : [];
    })
    .sort((a, b) => (a.windowSeconds ?? 0) - (b.windowSeconds ?? 0));
}

function formatWindowDuration(windowSeconds: number): string {
  const minutes = Math.max(1, Math.round(windowSeconds / 60));
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** 倒计时：`now/m/h/d/d{h}` 空格紧凑式（footer 是状态栏不是散文）。 */
function formatResetCountdown(secondsUntilReset: number): string {
  const minutes = Math.max(0, Math.ceil(secondsUntilReset / 60));
  if (minutes === 0) return "now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d${remainingHours}h`;
}

function formatResetSuffix(resetAt: number | undefined, nowMs: number): string {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0) {
    return "";
  }
  return ` ↻${formatResetCountdown(resetAt - nowMs / 1000)}`;
}

/** `[label ]7d: 72%[ ↻4d4h]`：单窗口段。 */
export function formatQuotaWindow(window: QuotaWindow, nowMs: number): string {
  const label = window.windowSeconds ? `${formatWindowDuration(window.windowSeconds)}: ` : "";
  const percent = `${clampPercent(window.remainingPercent)}%`;
  return `${label}${percent}${formatResetSuffix(window.resetAt, nowMs)}`;
}

/** 窗口簇：`5h: 99% ↻4h · 7d: 32% ↻5d9h`；空列表渲染为空串。 */
export function formatBalance(balance: Balance, nowMs: number): string {
  return balance.map((window) => formatQuotaWindow(window, nowMs)).join(" · ");
}
