/**
 * tui-pi 对外契约：pi-tui 渲染引擎上的第二个交互式 TUI 前端
 * （`zcode tui --tui-frontend=pi`）。调用方（packages/cli 的
 * tui-command 运行时装载器）只消费 src/index.ts 暴露的 runTui；
 * TuiOptions 由 @zcode/tui/internals 定义并跨前端共享，本模块不重定义。
 */
import type { TuiOptions } from "@zcode/tui/internals";

export interface TuiPiContract {
  /**
   * 启动交互式 TUI 并持有终端直到退出。
   * 前置：options.stdin/stdout 均为 TTY；非交互环境向 stderr 写出
   * 用户可读错误并返回 1。不可重入：同一进程同时只运行一个实例。
   * 返回：进程退出码（0 = 正常；Ctrl+C 双击、Ctrl+D 等退出路径与
   * @zcode/tui 语义一致）。副作用：独占 stdin 原始输入与 stdout
   * 渲染面，结束前恢复终端状态。
   */
  runTui(options: TuiOptions): Promise<number>;
}
