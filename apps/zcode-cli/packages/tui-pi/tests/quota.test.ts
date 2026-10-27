// 额度簇：quota.ts 纯格式化（provider-balance 同构）+ QuotaCluster 刷新
// 策略（空闲轮询、turn 沿授权刷新、min-interval 防抖、30min TTL、失败保留
// 上次读数 + stderr 诊断、readUsageQuota 缺席静默）。

import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageQuotaLimit, UsageQuotaSnapshot } from "@zcode/shared";
import { AppStore } from "../src/store.js";
import { QuotaCluster } from "../src/quota-cluster.js";
import {
  formatBalance,
  formatQuotaWindow,
  quotaLimitToWindow,
  quotaSnapshotToBalance,
} from "../src/quota.js";

const limit = (over: Partial<UsageQuotaLimit>): UsageQuotaLimit =>
  ({
    type: "TOKENS_LIMIT",
    unit: 3,
    number: 5,
    percentage: 1,
    usageDetails: [],
    ...over,
  }) as UsageQuotaLimit;

const snapshot = (limits: UsageQuotaLimit[]): UsageQuotaSnapshot => ({ level: null, limits });

/** 手工时钟 + 手工定时器：不睡真实时钟验证轮询与 TTL。 */
class FakeClock {
  nowMs = 1_000_000;
  readonly timers: { callback: () => void; at: number }[] = [];

  now = (): number => this.nowMs;

  setTimer = (callback: () => void, ms: number): object => {
    const timer = { callback, at: this.nowMs + ms };
    this.timers.push(timer);
    return timer;
  };

  clearTimer = (timer: unknown): void => {
    const index = this.timers.indexOf(timer as { callback: () => void; at: number });
    if (index >= 0) this.timers.splice(index, 1);
  };

  /** 推进时钟并触发到期定时器（一轮）。 */
  advance(ms: number): void {
    this.nowMs += ms;
    const due = this.timers.filter((timer) => timer.at <= this.nowMs);
    for (const timer of due) {
      this.clearTimer(timer);
      timer.callback();
    }
  }
}

const stderrChunks: string[] = [];
const fakeStderr = { write: (chunk: string) => void stderrChunks.push(chunk) };

/** 异步刷新落地（promise 链走完）后再断言。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// 统一纪元：NOW_S 秒 / NOW_MS 毫秒（resetAt 是 Unix 秒，now 是毫秒）。
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;

const cluster = (
  store: AppStore,
  readUsageQuota: () => Promise<UsageQuotaSnapshot>,
  clock: FakeClock,
): QuotaCluster =>
  new QuotaCluster(store, {
    clearTimer: clock.clearTimer,
    now: clock.now,
    readUsageQuota,
    requestRender: () => {},
    setTimer: clock.setTimer,
    stderr: fakeStderr,
  });

test("quota windows: used→remaining flip, labels, reset countdown", () => {
  // 用户 pi 粘贴样本：5h 窗余 99%、4h 后重置；7d 窗余 32%、5d9h 后重置。
  assert.equal(
    formatQuotaWindow(
      { remainingPercent: 99, resetAt: NOW_S + 4 * 3600, windowSeconds: 5 * 3600 },
      NOW_MS,
    ),
    "5h: 99% ↻4h",
  );
  assert.equal(
    formatQuotaWindow(
      { remainingPercent: 32, resetAt: NOW_S + (5 * 24 + 9) * 3600, windowSeconds: 7 * 24 * 3600 },
      NOW_MS,
    ),
    "7d: 32% ↻5d9h",
  );
  // 倒计时边界：<1h 分钟、<1d 小时、整日、到期 now。
  assert.equal(
    formatQuotaWindow({ remainingPercent: 50, resetAt: NOW_S + 90 * 60, windowSeconds: 3600 }, NOW_MS),
    "1h: 50% ↻1h",
  );
  assert.equal(
    formatQuotaWindow({ remainingPercent: 50, resetAt: NOW_S, windowSeconds: 3600 }, NOW_MS),
    "1h: 50% ↻now",
  );
  assert.equal(
    formatQuotaWindow({ remainingPercent: 50, resetAt: NOW_S + 30, windowSeconds: 3600 }, NOW_MS),
    "1h: 50% ↻1m",
  );
  assert.equal(formatQuotaWindow({ remainingPercent: 12.4 }, 0), "12%");
  // clamp 0–100。
  assert.equal(formatQuotaWindow({ remainingPercent: -5 }, 0), "0%");
  assert.equal(formatQuotaWindow({ remainingPercent: 140 }, 0), "100%");
});

test("formatBalance joins windows with · in ascending window order", () => {
  const balance = quotaSnapshotToBalance(
    snapshot([
      limit({ percentage: 68, unit: 1, number: 7, nextResetTime: (NOW_S + (5 * 24 + 9) * 3600) * 1000 }),
      limit({ percentage: 1, unit: 3, number: 5, nextResetTime: (NOW_S + 4 * 3600) * 1000 }),
    ]),
  );
  assert.equal(formatBalance(balance, NOW_MS), "5h: 99% ↻4h · 7d: 32% ↻5d9h");
});

test("limit mapping: unit table, ms/sec reset tolerance, legacy fallbacks, type filter", () => {
  // unit 枚举：1=天 3=小时 5=分钟 6=周。
  assert.equal(quotaLimitToWindow(limit({ unit: 1, number: 7 }))?.windowSeconds, 7 * 24 * 3600);
  assert.equal(quotaLimitToWindow(limit({ unit: 5, number: 30 }))?.windowSeconds, 30 * 60);
  assert.equal(quotaLimitToWindow(limit({ unit: 6, number: 1 }))?.windowSeconds, 7 * 24 * 3600);
  assert.equal(quotaLimitToWindow(limit({ unit: 2, number: 5 })), null);
  // nextResetTime 秒/毫秒双容差。
  assert.equal(quotaLimitToWindow(limit({ nextResetTime: NOW_MS }))?.resetAt, NOW_S);
  assert.equal(quotaLimitToWindow(limit({ nextResetTime: NOW_S }))?.resetAt, NOW_S);
  // 旧响应缺 percentage：usage/remaining 折算，不伪装 0%。
  assert.equal(
    quotaLimitToWindow(limit({ percentage: undefined, usage: 1_000, remaining: 500 }))?.remainingPercent,
    50,
  );
  // 不完整额度（无 usage）→ 丢弃该 limit。
  assert.equal(quotaLimitToWindow(limit({ percentage: undefined })), null);
  // 非 token 窗口类型过滤。
  assert.equal(quotaLimitToWindow(limit({ type: "TIME_LIMIT" })), null);
});

test("cluster: startup refresh lands the balance; render gates on the 30min TTL", async () => {
  const store = new AppStore();
  const clock = new FakeClock();
  const h = cluster(store, async () => snapshot([limit({ percentage: 1 })]), clock);
  h.start();
  await flush();
  assert.ok(store.state.quotaBalance?.length === 1);
  assert.ok(h.renderQuotaText(clock.nowMs)?.startsWith("5h: 99%"));
  // TTL 外读数退场。
  assert.equal(h.renderQuotaText(clock.nowMs + 31 * 60 * 1000), undefined);
  h.dispose();
});

test("cluster: idle polling continues on a jittered timer; min interval debounces", async () => {
  const store = new AppStore();
  const clock = new FakeClock();
  let fetches = 0;
  const h = cluster(store, async () => {
    fetches += 1;
    return snapshot([limit({ percentage: 1 })]);
  }, clock);
  h.start();
  await flush();
  assert.equal(fetches, 1);
  // 60–75s 后空闲 tick 触发一拍（advance 跨过抖动上限）；距上次尝试 <30s
  // 的调用被去抖。
  clock.advance(76_000);
  await flush();
  assert.equal(fetches, 2);
  h.onTurnSettled();
  assert.equal(fetches, 2, "min-interval debounce holds within 30s");
  clock.advance(31_000);
  h.onTurnSettled();
  await flush();
  assert.equal(fetches, 3);
  // 空闲定时器仍在（自续）。
  assert.equal(clock.timers.length, 1);
  h.dispose();
  assert.equal(clock.timers.length, 0);
});

test("cluster: failure keeps the last reading and writes a stderr diagnostic", async () => {
  const store = new AppStore();
  const clock = new FakeClock();
  let fail = false;
  const h = cluster(
    store,
    async () => {
      if (fail) throw new Error("502 bad gateway");
      return snapshot([limit({ percentage: 1 })]);
    },
    clock,
  );
  h.start();
  await flush();
  const firstText = h.renderQuotaText(clock.nowMs);
  assert.ok(firstText);
  stderrChunks.length = 0;
  fail = true;
  clock.advance(76_000);
  await flush();
  // 读数保留，不闪空；诊断落 stderr。
  assert.deepEqual(store.state.quotaBalance?.length, 1);
  assert.ok(stderrChunks.join("").includes("quota refresh failed: 502 bad gateway"));
  h.dispose();
});

test("cluster: silent when readUsageQuota is absent; reset clears and re-fetches", async () => {
  const store = new AppStore();
  const bare = new QuotaCluster(store, {});
  bare.start();
  bare.onTurnSettled();
  assert.equal(store.state.quotaBalance, undefined);

  const clock = new FakeClock();
  let fetches = 0;
  const h = cluster(store, async () => {
    fetches += 1;
    return snapshot([limit({ percentage: 50 })]);
  }, clock);
  h.start();
  await flush();
  assert.equal(fetches, 1);
  h.reset();
  await flush();
  assert.equal(fetches, 2);
  assert.ok(store.state.quotaBalance?.length === 1);
  h.dispose();
});
