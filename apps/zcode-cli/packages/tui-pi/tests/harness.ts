// In-test virtual terminal + mounted PiTuiApp. pi-tui has no VirtualTerminal
// export, so this implements the small Terminal surface TuiMainScreen needs
// and captures both input callbacks and rendered output. Feeding bytes
// through `feed()` exercises the real dispatch path: global input listeners
// (chords) → focused component handleInput.

import { TuiMainScreen, type ProgramStatus, type Terminal } from "@earendil-works/pi-tui";
import type { SessionEvent } from "@zcode/contracts";
import { setActiveTuiThemeMode, type TuiOptions } from "@zcode/tui/internals";
import { PiTuiApp } from "../src/app.js";
import type { AppStore } from "../src/store.js";
import { createPiTheme } from "../src/theme.js";

export class VirtualTerminal implements Terminal {
  output = "";
  inputHandler: ((data: string) => void) | undefined;
  resizeHandler: (() => void) | undefined;
  columns = 100;
  rows = 40;
  kittyProtocolActive = false;
  stopped = false;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
  }

  stop(): void {
    this.stopped = true;
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.output += data;
  }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: ProgramStatus): void {}

  /** Drop previously written frames so assertions only see new output. */
  resetOutput(): void {
    this.output = "";
  }
}

export type Harness = {
  app: PiTuiApp;
  store: AppStore;
  draftText: () => string;
  exitCode: () => number | undefined;
  feed: (data: string) => void;
  /** 等待「待渲染请求已落地 + 可选条件成立」；跨进程边界的调用方传 `until`。 */
  flush: (until?: () => boolean, timeoutMs?: number) => Promise<void>;
  output: () => string;
  resetOutput: () => void;
  sessionEvents: ((event: SessionEvent) => void) | undefined;
  stop: () => Promise<void>;
  terminal: VirtualTerminal;
  tui: TuiMainScreen;
};

/** App internals the tests legitimately poke at; TS-private is runtime-visible. */
type AppInternals = {
  editor: { getText(): string };
  store: AppStore;
};

/**
 * pi-tui 渲染调度器的内部探测点（TS-private，运行时可见；仅测试 harness 使用）。
 * requestRender 同步置 renderRequested，nextTick 里排 ≤16ms 节流定时器；两者
 * 都空闲即「没有等待中的渲染」。
 */
type RenderSchedulerProbe = {
  renderRequested?: unknown;
  renderTimer?: unknown;
  stopped?: unknown;
};

const FLUSH_DEFAULT_DEADLINE_MS = 5_000;
const FLUSH_POLL_INTERVAL_MS = 5;

export const createHarness = (options: Partial<TuiOptions> = {}): Harness => {
  setActiveTuiThemeMode("dark");
  const terminal = new VirtualTerminal();
  const tui = new TuiMainScreen(terminal);
  let sessionEvents: ((event: SessionEvent) => void) | undefined;
  let exitCode: number | undefined;

  const opts = {
    stderr: { write: () => true } as NodeJS.WriteStream,
    stdin: { isTTY: true } as NodeJS.ReadStream,
    stdout: { isTTY: true } as NodeJS.WriteStream,
    submitPrompt: async () => ({ response: "" }),
    subscribeSessionEvents: (sink: (event: SessionEvent) => void) => {
      sessionEvents = sink;
      return () => {};
    },
    ...options,
  } as TuiOptions;

  const app = new PiTuiApp({
    // env 不含 SHELL → `!` 走确定性回退链（bash -c、无 rc），隔离本机 rc
    // 与交互时序；交互分支的 rc 行为由 shell.test.ts 直接对 runShellCommand
    // 验证。
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    onExit: (code) => {
      exitCode = code;
    },
    options: opts,
    theme: createPiTheme({ noColor: true }),
    tui,
  });
  tui.start();

  const internals = app as unknown as AppInternals;
  // flush 的轮询判据：调度器里没有等待中的渲染（busy spinner 每 80ms 主动
  // tick，只能取单次观察，不能等「永久静默」）。
  const scheduler = tui as unknown as RenderSchedulerProbe;
  const renderPending = () =>
    scheduler.stopped !== true &&
    (scheduler.renderRequested === true || scheduler.renderTimer !== undefined);
  const drainPendingTicks = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    app,
    draftText: () => internals.editor.getText(),
    exitCode: () => exitCode,
    feed: (data) => terminal.inputHandler?.(data),
    flush: async (until, timeoutMs = FLUSH_DEFAULT_DEADLINE_MS) => {
      // Bug 根因（P003-F1）：旧实现是固定 40ms sleep——`!cmd` 等跨进程边界的
      // 工作在满负载下超过预算，转写行缺席导致断言偶发失败。改为条件轮询：
      // 微任务链与 requestRender 的 nextTick 跳在任何 macrotask 前全部清空，
      // sleep 期间 resolve 的续体也先于下一个 setImmediate 跑完，故
      // 「settle 后检查」不会漏掉已排队的渲染请求。跨进程调用方传 `until`
      // 条件（如转写行出现），由轮询等到成立为止；超时 fail loud。
      const deadline = Date.now() + timeoutMs;
      const settled = () => !renderPending() && (until ? until() : true);
      await drainPendingTicks();
      while (!settled()) {
        if (Date.now() >= deadline) {
          throw new Error(
            `tui-pi harness flush() timed out after ${timeoutMs}ms ` +
              `(renderPending: ${renderPending()}); narrow the \`until\` condition ` +
              "or investigate the async chain under test",
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, FLUSH_POLL_INTERVAL_MS));
        await drainPendingTicks();
      }
    },
    output: () => terminal.output,
    resetOutput: () => terminal.resetOutput(),
    sessionEvents,
    stop: async () => {
      await app.stop();
    },
    store: internals.store,
    terminal,
    tui,
  };
};

let eventSequence = 0;

/** Minimal SessionEvent factory; unique ids keep the 2048 dedup window happy. */
export const sessionEvent = (
  type: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): SessionEvent =>
  ({
    id: `evt-${(eventSequence += 1)}`,
    payload,
    sequenceNumber: eventSequence,
    sessionId: "sess-test",
    timestamp: new Date(),
    traceId: "trace-test",
    type,
    ...extra,
  }) as SessionEvent;

export const ESC = "\x1b";
export const CTRL_C = "\x03";
export const CTRL_D = "\x04";
export const CTRL_P = "\x10";
export const CTRL_L = "\x0c";
export const CTRL_N = "\x0e";
export const CTRL_O = "\x0f";
export const CTRL_Q = "\x11";
export const CTRL_T = "\x14";
export const CTRL_Y = "\x19";
export const CTRL_X = "\x18";
export const SHIFT_TAB = "\x1b[Z";
export const UP = "\x1b[A";
export const DOWN = "\x1b[B";
export const ALT_UP = "\x1b[1;3A";
export const ENTER = "\r";
export const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
