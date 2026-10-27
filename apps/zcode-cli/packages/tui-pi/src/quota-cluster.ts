// 额度簇状态的唯一 owner（SubagentDirectory 同构：store 是唯一可写面，
// 组件只读）。刷新策略与 pi goodies provider-balance 对齐：
//   · 空闲轮询 60s ± 15s 抖动；每次刷新尝试与上一次间隔 ≥30s
//   · turn 沿（busy 下降沿）授权一次刷新尝试——仍受 ≥30s 防抖（与空闲轮询
//     同一闸门），快速连击 turn 不放大请求频率
//   · 读数 30min TTL：超龄读数从 footer 消失，不悬挂假数据
//   · 失败保留上次读数并写单行 stderr 诊断（诊断走 stderr，不占协议 stdout）
// options.readUsageQuota 缺席（旧 core / 未接线）时整个簇静默。

import type { UsageQuotaSnapshot } from "@zcode/shared";
import type { AppStore } from "./store.js";
import { formatBalance, quotaSnapshotToBalance, type Balance } from "./quota.js";

/** 读数展示 TTL：超龄即从 footer 退场（provider-balance 同值）。 */
const QUOTA_DISPLAY_TTL_MS = 30 * 60 * 1000;
/** 空闲轮询周期与抖动上限。 */
const IDLE_REFRESH_INTERVAL_MS = 60_000;
const IDLE_REFRESH_JITTER_MS = 15_000;
/** 两次刷新尝试的最小间隔（turn 沿与空闲轮询共用，防抖）。 */
const REFRESH_MIN_INTERVAL_MS = 30_000;

export interface QuotaClusterPorts {
  readUsageQuota?: () => Promise<UsageQuotaSnapshot>;
  /** 刷新落地后请求重绘（倒计时/百分比随帧更新）。 */
  requestRender?: () => void;
  /** 诊断通道（TuiOptions.stderr）；缺席时失败静默。 */
  stderr?: { write(chunk: string): void };
  /** 测试注入时钟与定时器；缺省走全局。 */
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class QuotaCluster {
  private generation = 0;
  private inflight = false;
  private lastAttemptAt = 0;
  private idleTimer: unknown = undefined;
  private readonly ports: QuotaClusterPorts;

  constructor(
    private readonly store: AppStore,
    ports: QuotaClusterPorts,
  ) {
    this.ports = ports;
  }

  /** 应用启动：立即授权刷新一次，并起空闲轮询。 */
  start(): void {
    if (!this.ports.readUsageQuota) return;
    this.scheduleIdleTimer();
    this.refresh();
  }

  /** turn 沿（busy 下降沿）调用：授权一次刷新尝试（仍受 ≥30s 防抖）。 */
  onTurnSettled(): void {
    if (!this.ports.readUsageQuota) return;
    this.refresh();
  }

  /**
   * 拉取并落地快照。in-flight 去重；min-interval 是所有路径共用的统一闸门：
   * turn 沿与空闲轮询一并受 ≥30s 防抖（tui-pi-frontend.md「turn 沿刷新
   * ≥30s 间隔」同语义），仅启动首拍与 reset()（lastAttemptAt 归零）绕过。
   */
  refresh(): void {
    const readUsageQuota = this.ports.readUsageQuota;
    if (!readUsageQuota || this.inflight) return;
    const nowMs = this.now();
    if (nowMs - this.lastAttemptAt < REFRESH_MIN_INTERVAL_MS && this.lastAttemptAt !== 0) {
      return;
    }
    this.lastAttemptAt = nowMs;
    this.inflight = true;
    const epoch = this.generation;
    void readUsageQuota()
      .then((snapshot) => {
        if (epoch !== this.generation) return;
        const balance = quotaSnapshotToBalance(snapshot);
        // 空读数与失败同态：保留上次读数，不把 footer 闪成空串。
        if (balance.length === 0) {
          this.noteFailure(new Error("provider returned no quota windows"));
          return;
        }
        this.store.set("quotaBalance", balance);
        this.store.set("quotaFetchedAt", this.now());
        this.ports.requestRender?.();
      })
      .catch((cause: unknown) => {
        if (epoch !== this.generation) return;
        this.noteFailure(cause);
      })
      .finally(() => {
        if (epoch !== this.generation) return;
        this.inflight = false;
      });
  }

  /**
   * footer 渲染读数：TTL 内的最近快照按当前时钟格式化（↻ 倒计时随帧
   * 走时）；无读数 / 超龄 / 簇缺席返回 undefined，pwd 行退化为普通行。
   */
  renderQuotaText(nowMs: number): string | undefined {
    const state = this.store.state;
    const balance = state.quotaBalance as Balance | undefined;
    const fetchedAt = state.quotaFetchedAt;
    if (!balance || balance.length === 0 || fetchedAt === undefined) return undefined;
    if (nowMs - fetchedAt >= QUOTA_DISPLAY_TTL_MS) return undefined;
    return formatBalance(balance, nowMs);
  }

  /** 会话投影重置：清读数并立刻补一拍（新会话/新账户口径）；绕过 min-interval。 */
  reset(): void {
    this.generation += 1;
    this.inflight = false;
    this.lastAttemptAt = 0;
    this.store.set("quotaBalance", undefined);
    this.store.set("quotaFetchedAt", undefined);
    this.refresh();
  }

  dispose(): void {
    this.generation += 1;
    this.inflight = false;
    this.clearTimer(this.idleTimer);
    this.idleTimer = undefined;
  }

  private now(): number {
    return this.ports.now ? this.ports.now() : Date.now();
  }

  private scheduleIdleTimer(): void {
    const setTimer = this.ports.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    const jitter = Math.floor(Math.random() * IDLE_REFRESH_JITTER_MS);
    this.clearTimer(this.idleTimer);
    this.idleTimer = setTimer(() => {
      this.refresh();
      this.scheduleIdleTimer();
    }, IDLE_REFRESH_INTERVAL_MS + jitter);
  }

  private clearTimer(timer: unknown): void {
    if (timer === undefined) return;
    const clearTimer = this.ports.clearTimer ?? ((inner: unknown) => clearTimeout(inner as never));
    clearTimer(timer);
  }

  private noteFailure(cause: unknown): void {
    const stderr = this.ports.stderr;
    if (!stderr) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    stderr.write(`[tui-pi] quota refresh failed: ${message}\n`);
  }
}
