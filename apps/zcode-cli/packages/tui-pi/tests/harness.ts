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
  flush: () => Promise<void>;
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
    // `!` harness 测试钉死 /bin/sh：交接管线语义与具体 shell 无关，真实
    // `zsh -ic`（z4h 初始化）会超过 flush 的等待窗口且依赖本机 rc。
    env: { ...process.env, SHELL: "/bin/sh" },
    onExit: (code) => {
      exitCode = code;
    },
    options: opts,
    theme: createPiTheme({ noColor: true }),
    tui,
  });
  tui.start();

  const internals = app as unknown as AppInternals;
  return {
    app,
    draftText: () => internals.editor.getText(),
    exitCode: () => exitCode,
    feed: (data) => terminal.inputHandler?.(data),
    flush: async () => {
      // requestRender is throttled at TuiBase.MIN_RENDER_INTERVAL_MS (16ms);
      // a real timer covers both the async submit chain and the render tick.
      await new Promise((resolve) => setTimeout(resolve, 40));
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
export const CTRL_Y = "\x19";
export const CTRL_X = "\x18";
export const SHIFT_TAB = "\x1b[Z";
export const UP = "\x1b[A";
export const DOWN = "\x1b[B";
export const ENTER = "\r";
export const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
