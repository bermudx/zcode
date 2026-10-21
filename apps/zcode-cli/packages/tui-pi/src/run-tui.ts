// runTui entry for the pi-tui frontend. Same callable shape as
// @zcode/tui's runTui: (options: TuiOptions) => Promise<number>.

import {
  KeybindingsManager,
  ProcessTerminal,
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
import { createPiTheme } from "./theme.js";

const NON_TTY_ERROR =
  "zcode interactive frontend requires a TTY. Use --prompt for headless runs.";
const THEME_QUERY_TIMEOUT_MS = 250;
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

  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);

  // Theme resolution mirrors the React frontend: explicit initialThemeMode /
  // stored preference first, else sniff the terminal's reported colors.
  let detectedMode = options.initialThemeMode ?? null;
  if (!detectedMode) {
    const colors = await tui
      .queryTerminalColors({ timeoutMs: THEME_QUERY_TIMEOUT_MS })
      .catch(() => null);
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

  tui.start();

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
  await app.stop();
  return code;
}
