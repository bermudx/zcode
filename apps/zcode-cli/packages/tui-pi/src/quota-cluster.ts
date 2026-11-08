// 额度簇状态的唯一 owner（SubagentDirectory 同构：store 是唯一可写面，
// 组件只读）。刷新策略与 pi goodies provider-balance 对齐：
//   · 空闲轮询 60s ± 15s 抖动；每次刷新尝试与上一次间隔 ≥30s
//   · turn 沿（busy 下降沿）授权一次刷新尝试——仍受 ≥30s 防抖（与空闲轮询
//     同一闸门），快速连击 turn 不放大请求频率
//   · 读数 30min TTL：超龄读数从 footer 消失，不悬挂假数据
//   · 失败保留上次读数；失败 episode 存续期间 footer 右簇在读数前挂
//     `stale: ` 前缀、无读数时挂 `quota !` 徽标（footer.ts 组合，
//     数据源 renderQuotaError），成功落地或 reset 清除。stderr 单行诊断
//     只在调用方确认安全（非 TTY 重定向）时接线——TTY 下裸写会砸进
//     输入框且无法被重绘清除；同一失败消息只诊断一次，失败后空闲拍
//     退避 60s
//     （FAILURE_BACKOFF_MS，provider-balance 同分工：权威拍仍尝试）
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
/**
 * 失败后空闲轮询的退避窗口（provider-balance FAILURE_BACKOFF_MS 同值）：
 * 永久性失败（无 coding-plan 凭据）不该每 60s 重打一行 stderr；空闲拍
 * 在窗口内直接跳过，turn 沿/启动/reset 等权威拍仍尝试（≥30s 防抖不变）。
 */
const FAILURE_BACKOFF_MS = 60_000;

export interface QuotaClusterPorts {
  readUsageQuota?: () => Promise<UsageQuotaSnapshot>;
  /** 刷新落地后请求重绘（倒计时/百分比随帧更新）。 */
  requestRender?: () => void;
  /** 诊断通道（TuiOptions.stderr，仅非 TTY 重定向时接线）；缺席时失败只走 footer 徽标。 */
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
  private lastFailureAt: number | undefined;
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
   * opportunistic=true 的空闲拍额外受失败退避（FAILURE_BACKOFF_MS）约束
   * ——provider-balance 同分工：用户活动触发的权威拍值得真实尝试，后台
   * 拍在端点/凭据持续失败时静默让路，不把永久失败变成刷屏日志。
   */
  refresh(opportunistic = false): void {
    const readUsageQuota = this.ports.readUsageQuota;
    if (!readUsageQuota || this.inflight) return;
    if (
      opportunistic &&
      this.lastFailureAt !== undefined &&
      this.now() - this.lastFailureAt < FAILURE_BACKOFF_MS
    ) {
      return;
    }
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
        // 成功即恢复：清退避窗口与失败 episode（provider-balance「成功让
        // 空闲拍恢复」同义）——同消息的下一段失败是新事件，允许再次诊断。
        this.lastFailureAt = undefined;
        this.store.set("quotaError", undefined);
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
   * footer 失败出口的数据源：自上次成功落地以来存在失败 episode 时返回
   * `quota !`。footer.ts 组合时读数在场则改挂 `stale: ` 前缀，仅无读数
   * （未取到/超 TTL）时以独立徽标落地。TTY 下 stderr 诊断被 app 层闸掉
   * （裸写 stderr 会落在输入框里且重绘清不掉），徽标是无读数时交互界面
   * 上的唯一可视出口；episode 持续期间常驻，不随读数 TTL 消失。
   */
  renderQuotaError(): string | undefined {
    return this.store.state.quotaError === undefined ? undefined : "quota !";
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
    this.lastFailureAt = undefined;
    this.store.set("quotaBalance", undefined);
    this.store.set("quotaFetchedAt", undefined);
    this.store.set("quotaError", undefined);
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
      // 空闲拍是 opportunistic：失败退避窗口内跳过（见 refresh）。
      this.refresh(true);
      this.scheduleIdleTimer();
    }, IDLE_REFRESH_INTERVAL_MS + jitter);
  }

  private clearTimer(timer: unknown): void {
    if (timer === undefined) return;
    const clearTimer = this.ports.clearTimer ?? ((inner: unknown) => clearTimeout(inner as never));
    clearTimer(timer);
  }

  private noteFailure(cause: unknown): void {
    this.lastFailureAt = this.now();
    const message = cause instanceof Error ? cause.message : String(cause);
    // store.quotaError 双职：footer `quota !` 徽标的 episode 存续标记
    // （store.set 经 onStateChanged → updateFooter 落屏）+ stderr 诊断的
    // 按消息去重键。无诊断通道（TTY 下 app 不接线 stderr）时徽标仍亮。
    // 同一失败只诊断一次（provider-balance reportFailure 走文件日志 +
    // 非 TTY 才 stderr 的同精神；这里没有文件面，收敛为按消息去重）：
    // 永久失败（无凭据）每 60s 一行会把终端刷成噪声墙。消息变化或成功
    // （quotaError 在落地读数时清除）后重新允许一次诊断。
    if (message !== this.store.state.quotaError) {
      const stderr = this.ports.stderr;
      if (stderr) stderr.write(`[tui-pi] quota refresh failed: ${message}\n`);
    }
    this.store.set("quotaError", message);
  }
}
