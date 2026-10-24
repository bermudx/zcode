// busy 退出三选一：有 turn 在前台跑（含等交互）时，第一下退出键不直接退出——
// arm 后状态栏给出三选一，armed 窗口内 Ctrl-D 分离退出（agent 继续跑）、
// Ctrl-C 停 agent 并退出、Esc 留在原地，其余键静默取消 armed。
//
// Ctrl-C 字节路径与 SIGINT 信号路径共用本模块（SIGINT 不经过 dispatchChord），
// 所以 armed 判定必须在 onCtrlC 内，不能放键盘拦截层。

import { matchesKey } from "@earendil-works/pi-tui";
import {
  shouldClearPromptDraftOnCtrlC,
  type CtrlCExitGuard,
} from "@zcode/tui/internals";
import { resetCtrlCExitGuard, runCtrlCIntent } from "./ctrl-c-intent.js";

export const BUSY_QUIT_CHOICE_WINDOW_MS = 4_000;
export const BUSY_QUIT_CHOICE_PROMPT =
  "Turn running — Ctrl-D: detach & quit (agent keeps running) · Ctrl-C: stop agent & quit · Esc: stay";
export const BUSY_QUIT_CHOICE_CANCELLED_STATUS = "Staying — agent keeps running.";

export interface BusyQuitChoiceDeps {
  /**
   * Ctrl-C 双击确认 guard：必须由 app 持有并与"其他键重置双击"路径共享同一实例
   * （dispatchChord 在非 Ctrl-C 键上 resetCtrlCExitGuard）。
   */
  ctrlCGuard: CtrlCExitGuard;
  /** 有 turn 在前台跑（含等交互）：退出必须经三选一，不能直接 abort。 */
  turnBusy(): boolean;
  abortTurn(): void;
  clearDraft(): void;
  setStatus(status: string): void;
  exit(code: number): void;
  /**
   * "stop & quit" 的 sessionStop 上达口：attach 宿主经 socket 发送并等有界回执
   * （socket 先行关闭会让 fire-and-forget 的 stop 落不了线）。非 attach 宿主可
   * 缺省——同进程退出本就终结一切，退化为本地 abort。
   */
  requestStopActiveTurn(): Promise<void> | undefined;
}

export class BusyQuitChoice {
  private readonly ctrlCGuard: CtrlCExitGuard;
  private armedAt = 0;

  constructor(private readonly deps: BusyQuitChoiceDeps) {
    this.ctrlCGuard = deps.ctrlCGuard;
  }

  private armed(nowMs = Date.now()): boolean {
    return this.armedAt > 0 && nowMs - this.armedAt < BUSY_QUIT_CHOICE_WINDOW_MS;
  }

  private arm(): void {
    resetCtrlCExitGuard(this.ctrlCGuard);
    this.armedAt = Date.now();
    this.deps.setStatus(BUSY_QUIT_CHOICE_PROMPT);
  }

  private async stopActiveThenExit(): Promise<void> {
    await this.deps.requestStopActiveTurn?.();
    this.deps.abortTurn();
    this.deps.exit(0);
  }

  /**
   * Ctrl-C 意图（字节路径与 SIGINT 共用同一 guard 与同一份状态）：
   * armed 窗口内 = stop & quit（保留旧"双击 Ctrl-C 杀掉 agent"的肌肉记忆）；
   * busy 且空草稿 = arm 三选一；其余走原双击退出语义。
   */
  onCtrlC(draft: string): void {
    if (this.armed()) {
      this.armedAt = 0;
      void this.stopActiveThenExit();
      return;
    }
    if (this.deps.turnBusy() && !shouldClearPromptDraftOnCtrlC(draft)) {
      this.arm();
      return;
    }
    runCtrlCIntent({
      abortTurn: this.deps.abortTurn,
      clearDraft: this.deps.clearDraft,
      draft,
      exit: () => this.deps.exit(0),
      guard: this.ctrlCGuard,
      setStatus: this.deps.setStatus,
    });
  }

  /** Ctrl-D：armed 窗口内 = 分离退出；busy = arm 三选一。返回 true 表示已消费。 */
  onCtrlD(): boolean {
    if (this.armed()) {
      this.armedAt = 0;
      this.deps.exit(0);
      return true;
    }
    if (this.deps.turnBusy()) {
      this.arm();
      return true;
    }
    return false;
  }

  /**
   * dispatchChord 阶段的 armed 键拦截：Ctrl-D 分离退出 / Esc 留下已消费返回 true；
   * Ctrl-C 让位 handleCtrlCIntent（SIGINT 同源判定只在那一条路径）；其余键取消
   * armed 后照常走各自语义。
   */
  interceptArmedKey(data: string): boolean {
    if (!this.armed()) return false;
    if (matchesKey(data, "ctrl+d")) {
      this.armedAt = 0;
      this.deps.exit(0);
      return true;
    }
    if (matchesKey(data, "escape")) {
      this.armedAt = 0;
      this.deps.setStatus(BUSY_QUIT_CHOICE_CANCELLED_STATUS);
      return true;
    }
    if (!matchesKey(data, "ctrl+c")) this.armedAt = 0;
    return false;
  }
}
