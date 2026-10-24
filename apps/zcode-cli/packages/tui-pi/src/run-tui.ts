// runTui entry for the pi-tui frontend. Same callable shape as
// @zcode/tui's runTui: (options: TuiOptions) => Promise<number>.

import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  setKeybindings,
} from "@earendil-works/pi-tui";
import type { TuiOptions } from "@zcode/tui/internals";
import {
  resolveTuiThemeMode,
  setActiveTuiThemeMode,
} from "@zcode/tui/internals";
import type { TerminalColors } from "@earendil-works/pi-tui";
import type { UiThemeMode } from "@zcode/contracts";
import { PiTuiApp } from "./app.js";
import { killTrackedShellChildren } from "./shell.js";
import {
  queryTerminalColorsAtStartup,
  STARTUP_QUERY_TIMEOUT_MS,
} from "./terminal-startup.js";
import { QuietProcessTerminal } from "./terminal-input-filter.js";
import { createPiTheme } from "./theme.js";

const NON_TTY_ERROR =
  "zcode interactive frontend requires a TTY. Use --prompt for headless runs.";
const BRIGHTNESS_THRESHOLD = 128;

/** pi-tui reports {r,g,b}; brightness rule mirrors @zcode/tui's hex inference. */
const inferModeFromColors = (colors: TerminalColors): UiThemeMode | null => {
  const bg = colors.background ?? colors.palette?.[0];
  if (!bg) return null;
  const brightness = (bg.r * 299 + bg.g * 587 + bg.b * 114) / 1000;
  return brightness > BRIGHTNESS_THRESHOLD ? "light" : "dark";
};

export async function runPiTui(options: TuiOptions): Promise<number> {
  if (!options.stdin.isTTY || !options.stdout.isTTY) {
    options.stderr.write(`${NON_TTY_ERROR}\n`);
    return 1;
  }

  const terminal = new QuietProcessTerminal();
  const tui = new TuiMainScreen(terminal);

  // Theme resolution mirrors the React frontend: explicit initialThemeMode /
  // stored preference first, else sniff the terminal's reported colors.
  // 查询与回复排空必须在 raw 模式下完成（见 terminal-startup.ts 头注）：
  // canonical 窗口内发查询会被行纪律把回复回显到屏幕。
  let detectedMode = options.initialThemeMode ?? null;
  if (!detectedMode) {
    const colors = await queryTerminalColorsAtStartup({
      stdin: options.stdin,
      stdout: options.stdout,
      timeoutMs: STARTUP_QUERY_TIMEOUT_MS,
    }).catch(() => null);
    if (colors) detectedMode = inferModeFromColors(colors);
  }
  setActiveTuiThemeMode(resolveTuiThemeMode(options.theme, detectedMode));

  const theme = createPiTheme({ noColor: options.noColor });
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

  let exitResolve: (code: number) => void = () => {};
  const exitPromise = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });

  const app = new PiTuiApp({
    onExit: (code) => exitResolve(code),
    options,
    theme,
    tui,
  });

  // SIGINT 与 raw 模式下的 Ctrl-C 字节同义：同一个双击确认。缺这个 handler 时
  // Node 的默认行为是直接终止进程（exit 130），多路复用器（herdr pane 等）把
  // Ctrl-C 递送为信号时就会首按即死，与字节路径的“再按一次退出”不一致。
  const onSigint = () => app.handleCtrlCIntent();
  process.on("SIGINT", onSigint);

  // detached `!` children survive client death otherwise (pi-mono reaps them
  // on SIGTERM/SIGHUP/crash). `exit` covers clean shutdown; signal handlers
  // kill children then re-raise so the default termination still applies.
  process.on("exit", killTrackedShellChildren);
  const reapThenReraise = (signal: NodeJS.Signals): void => {
    process.once(signal, () => {
      killTrackedShellChildren();
      process.kill(process.pid, signal);
    });
  };
  reapThenReraise("SIGTERM");
  if (process.platform !== "win32") reapThenReraise("SIGHUP");

  tui.start();

  // React 前端在 constructor 消费 options.initialResult（attach resume-latest
  // 的恢复 transcript）；pi 侧等效：tui.start() 后立刻 applyResult。
  if (options.initialResult) {
    app.applyResult(options.initialResult);
  }

  // Startup metadata paints after the first frame, same contract as the
  // React frontend: composer visible immediately, options hydrate after.
  if (options.loadStartupOptions) {
    void options
      .loadStartupOptions()
      .then((startup) => app.applyStartupOptions(startup))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(`Failed to load startup options: ${message}\n`);
      });
  }

  const code = await exitPromise;
  // signal handler 是 ref 句柄：不摘掉会让进程在 TUI 退出后仍挂着不退。
  process.off("SIGINT", onSigint);
  await app.stop();
  return code;
}
