// Footer 双行组件：statusBox 恒挂活动行 + meta 行两个单行组件，高度不随
// busy/内容变化。pi-tui `Loader.render` 固定产出「空行 + 内容行」（给编辑器
// 留呼吸位），`Text.render` 会把溢出文本折成多行——恒定布局要求每个子组件
// 恰好一行，故两者都只取渲染首行（Text 已按宽度换行并补齐，首行即天然单行
// 截断，窄终端/长 status 也不会撑高 footer）。

import { Loader, Text } from "@earendil-works/pi-tui";

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

/** mode|model|thought|用量簇 meta 行：Text 单行形态。 */
export class MetaLine extends Text {
  override render(width: number): string[] {
    const rows = super.render(width);
    return [rows[0] ?? " ".repeat(Math.max(0, width))];
  }
}
