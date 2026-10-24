// 协作模式轮询：TUI_SWITCHABLE_MODES 循环 + setMode 端口的乐观/回滚写入。
// 从 app.ts 拆出以守住 800 行上限；store 是唯一状态载体。

import {
  TUI_SWITCHABLE_MODES,
  type TuiOptions,
  type TuiSwitchableMode,
} from "@zcode/tui/internals";
import type { AppStore } from "./store.js";

export function cycleCollaborationMode(
  store: AppStore,
  options: Pick<TuiOptions, "setMode">,
): void {
  const setModeHandler = options.setMode;
  if (!setModeHandler) {
    store.set("status", "Mode switching is not available in this client.");
    return;
  }
  const previousMode = store.state.mode;
  const index = TUI_SWITCHABLE_MODES.findIndex((mode) => mode === previousMode);
  const nextMode = TUI_SWITCHABLE_MODES[(index < 0 ? 0 : index + 1) % TUI_SWITCHABLE_MODES.length];
  store.set("mode", nextMode);
  void Promise.resolve(setModeHandler(nextMode as TuiSwitchableMode)).then(
    (result) => {
      store.set("mode", result.mode);
      store.set(
        "status",
        result.response ??
          `Mode switched to ${`${result.mode}`.slice(0, 1).toUpperCase()}${`${result.mode}`.slice(1)}.`,
      );
    },
    (error: unknown) => {
      store.set("mode", previousMode);
      const message = error instanceof Error ? error.message : String(error);
      store.set("status", `Mode switch failed: ${message}`);
    },
  );
}
