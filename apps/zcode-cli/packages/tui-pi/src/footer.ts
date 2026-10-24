// Footer 双行组件：statusBox 恒挂活动行 + meta 行两个单行组件，高度不随
// busy/内容变化。pi-tui `Loader.render` 固定产出「空行 + 内容行」（给编辑器
// 留呼吸位），`Text.render` 会把溢出文本折成多行——恒定布局要求每个子组件
// 恰好一行，故两者都只取渲染首行（Text 已按宽度换行并补齐，首行即天然单行
// 截断，窄终端/长 status 也不会撑高 footer）。

import { Container, Loader, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatMetaLine } from "./status-line.js";
import type { AppStore } from "./store.js";
import type { PiTheme } from "./theme.js";

/**
 * 空闲指示：单空格帧让消息列与 busy 的「spinner + 空格」对齐；
 * 帧数 ≤1 时 restartAnimation 不启动定时器，idle 零 tick。
 */
export const ACTIVITY_IDLE_INDICATOR = { frames: [" "] };

/** spinner + status 活动行：busy 时动画帧，idle 时空白帧位 + status。 */
export class ActivityLine extends Loader {
  override render(width: number): string[] {
    const rows = super.render(width);
    return [rows[1] ?? " ".repeat(Math.max(0, width))];
  }
}

/**
 * meta 行：左区 cwd + 用量簇，右区 ctx + `model · thought · mode`。持有最新
 * state 在 render(width) 时按需收缩（formatMetaLine），恒为单行。
 */
export class MetaLine implements Component {
  private cwdLabel = "";
  private state: AppStore["state"] | undefined;

  constructor(private readonly theme: PiTheme) {}

  setState(state: AppStore["state"], cwdLabel: string): void {
    this.state = state;
    this.cwdLabel = cwdLabel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const line = this.state
      ? formatMetaLine({ cwdLabel: this.cwdLabel, state: this.state, width })
      : "";
    return [this.theme.muted(line)];
  }
}

/**
 * Footer 恒定两行的唯一 owner：活动行（spinner + status）与 meta 行常驻，
 * 只换内容不换结构。活动判定与 quitChoice.turnBusy 同口径（busy 或前台
 * activeTurnId），attach 会话的远端 turn 也转 spinner；指示切换只在 busy
 * 沿变化时发生，空闲指示帧数 ≤1，idle 下没有帧定时器空转。
 */
export class StatusFooter extends Container {
  private readonly activity: ActivityLine;
  private readonly meta: MetaLine;
  private activityActive = false;

  constructor(tui: TUI, theme: PiTheme) {
    super();
    this.activity = new ActivityLine(tui, theme.accent, theme.muted, "");
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
    state: AppStore["state"];
  }): void {
    const { state } = input;
    const active = state.busy || state.activeTurnId !== undefined;
    if (active !== this.activityActive) {
      this.activityActive = active;
      this.activity.setIndicator(active ? undefined : ACTIVITY_IDLE_INDICATOR);
    }
    this.activity.setMessage(state.status || (active ? input.idleHint : ""));
    this.meta.setState(state, input.cwdLabel);
  }

  stop(): void {
    this.activity.stop();
  }
}
