// Footer 恒两行组件：statusBox 恒挂活动行 + meta 行两个单行组件，高度不随
// busy/内容变化。pi-tui `Loader.render` 固定产出「空行 + 内容行」（给编辑器
// 留呼吸位），`Text.render` 会把溢出文本折成多行——恒定布局要求每个子组件
// 恰好一行，故两者都只取渲染首行（Text 已按宽度换行并补齐，首行即天然单行
// 截断，窄终端/长 status 也不会撑高 footer）。

import { Container, Loader, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatElapsedMs } from "@zcode/tui/internals";
import { appendFooterRightZone, formatPwdLine, formatStatsLine } from "./status-line.js";
import type { AppStore } from "./store.js";
import type { PiTheme } from "./theme.js";

/**
 * 空闲指示：单空格帧让消息列与 busy 的「spinner + 空格」对齐；
 * 帧数 ≤1 时 restartAnimation 不启动定时器，idle 零 tick。
 */
export const ACTIVITY_IDLE_INDICATOR = { frames: [" "] };

/**
 * 活动行：`~/cwd (branch)` 行首 + spinner/status 中列 + 行尾额度簇。
 * pwd 是常驻锚点（meta 行让位后移上来），status/spinner 占剩余中列，
 * 额度簇右对齐在行尾（账号级读数不占 meta 行的 session 左区）——
 * 余量不足时丢额度不截 status（appendFooterRightZone）。
 */
/** 行尾右簇内 turn 级 elapsed 与账号级额度簇的间距（与右区最小间距同宽）。 */
const FOOTER_RIGHT_CLUSTER_GAP = "  ";

export class ActivityLine extends Loader {
  private quotaText: string | undefined;
  private quotaError: string | undefined;
  private turnStartMs: number | undefined;
  private branch: string | undefined;
  private cwdLabel = "";

  constructor(
    tui: TUI,
    private readonly theme: PiTheme,
  ) {
    super(tui, theme.accent, theme.muted, "");
  }

  setLocation(input: { branch?: string; cwdLabel: string }): void {
    this.branch = input.branch;
    this.cwdLabel = input.cwdLabel;
  }

  setQuota(quotaText: string | undefined): void {
    this.quotaText = quotaText;
  }

  setQuotaError(quotaError: string | undefined): void {
    this.quotaError = quotaError;
  }

  setTurnStartMs(turnStartMs: number | undefined): void {
    this.turnStartMs = turnStartMs;
  }

  override render(width: number): string[] {
    const pwd = formatPwdLine({ branch: this.branch, cwdLabel: this.cwdLabel, width });
    const styledPwd = pwd ? this.theme.dim(pwd) : "";
    const statusWidth = Math.max(0, width - visibleWidth(styledPwd) - (styledPwd ? 2 : 0));
    const rows = statusWidth > 0 ? super.render(statusWidth) : [];
    const statusLine = rows[1] ?? " ".repeat(statusWidth);
    const line = styledPwd
      ? statusWidth > 0
        ? `${styledPwd}  ${statusLine}`
        : styledPwd
      : statusLine;
    // 行尾右簇：turn 级 elapsed 在前（每 spinner tick 重算，无独立定时器），
    // 账号级额度簇殿后保持行尾锚点；无失败徽标时余量不足仍丢整个右区。
    const elapsed =
      this.turnStartMs === undefined
        ? undefined
        : formatElapsedMs(Date.now() - this.turnStartMs);
    // 失败 episode 与读数并存时给读数挂 `stale: ` 前缀（不再尾部并挂
    // `quota !`）：前缀直接说明「显示的是旧数据」，尾部徽标易被读成
    // 又一项读数。无读数可标（未取到/超 TTL）时保留独立徽标，失败不静默。
    const quotaCluster = this.quotaText
      ? this.quotaError
        ? `stale: ${this.quotaText}`
        : this.quotaText
      : this.quotaError;
    const right = [elapsed, quotaCluster]
      .filter((part): part is string => Boolean(part))
      .join(FOOTER_RIGHT_CLUSTER_GAP);
    const fullLine = appendFooterRightZone({
      line,
      right: right || undefined,
      theme: this.theme,
      width,
    });
    // appendFooterRightZone 放不下时原样返回 line。TTY 下徽标是唯一失败
    // 出口，不能被可选的陈旧读数/elapsed 连带挤掉；用同一宽度/间距规则
    // 再尝试独立徽标，仍不截断 cwd/status，也不维护第二套适配判断。
    if (fullLine !== line || !this.quotaError) return [fullLine];
    return [
      appendFooterRightZone({
        line,
        right: this.quotaError,
        theme: this.theme,
        width,
      }),
    ];
  }
}

/**
 * meta 行：左区用量簇 + ctx 仪表，右区身份簇（formatStatsLine）。cwd 已
 * 上移到活动行行首，meta 行只剩 session 统计。着色在 formatStatsLine 内
 * 按 pi 阈值完成（整行 dim、ctx 按占用分档），持有最新 state 在
 * render(width) 时按需收缩，恒为单行。
 */
export class MetaLine implements Component {
  private state: AppStore["state"] | undefined;

  constructor(private readonly theme: PiTheme) {}

  setState(state: AppStore["state"]): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const line = this.state
      ? formatStatsLine({
          state: this.state,
          theme: this.theme,
          width,
        })
      : "";
    return [line];
  }
}

/**
 * Footer 恒定两行的唯一 owner：活动行（cwd + spinner/status + 行尾额度簇）
 * 与 meta 行（用量/ctx | 身份）常驻，只换内容不换结构。活动判定与
 * quitChoice.turnBusy 同口径（busy 或前台 activeTurnId），attach 会话的
 * 远端 turn 也转 spinner；指示切换只在 busy 沿变化时发生，空闲指示帧数
 * ≤1，idle 下没有帧定时器空转。
 */
export class StatusFooter extends Container {
  private readonly activity: ActivityLine;
  private readonly meta: MetaLine;
  private activityActive = false;

  constructor(tui: TUI, theme: PiTheme) {
    super();
    this.activity = new ActivityLine(tui, theme);
    // pi-tui 的 Loader 在构造时经 setIndicator→start() 就启动常驻 setInterval：
    // footer 恒定挂载形态下立刻用空闲指示接管——帧数 ≤1 不启动定时器，
    // 否则空转 tick 会阻止进程退出。
    this.activity.setIndicator(ACTIVITY_IDLE_INDICATOR);
    this.meta = new MetaLine(theme);
    this.addChild(this.activity);
    this.addChild(this.meta);
  }

  update(input: {
    cwdLabel: string;
    idleHint: string;
    quotaText?: string;
    quotaError?: string;
    state: AppStore["state"];
  }): void {
    const { state } = input;
    const active = state.busy || state.activeTurnId !== undefined;
    if (active !== this.activityActive) {
      this.activityActive = active;
      this.activity.setIndicator(active ? undefined : ACTIVITY_IDLE_INDICATOR);
    }
    this.activity.setTurnStartMs(active ? state.activeTurnStartedAtMs : undefined);
    this.activity.setMessage(state.status || (active ? input.idleHint : ""));
    this.activity.setLocation({ branch: state.workspaceGitBranch, cwdLabel: input.cwdLabel });
    this.activity.setQuota(input.quotaText);
    this.activity.setQuotaError(input.quotaError);
    this.meta.setState(state);
  }

  stop(): void {
    this.activity.stop();
  }
}
