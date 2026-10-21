import type { runTui } from "@zcode/tui";

type PiTuiRuntimeModule = {
  runTui: typeof runTui;
};

/**
 * Load the pi-tui frontend (`--tui-frontend=pi`).
 *
 * Unlike `@zcode/tui`, the pi frontend has no SEA asset packaging yet; under
 * SEA the import cannot resolve, so fail with an actionable message instead
 * of a bare module-not-found.
 */
export const loadPiTuiRuntime = async (): Promise<PiTuiRuntimeModule> => {
  const sea = await import("node:sea");
  if (sea.isSea()) {
    throw new Error(
      "--tui-frontend=pi is not packaged in this binary. Re-run without the flag to use the default frontend.",
    );
  }
  return (await import("@zcode/tui-pi")) as PiTuiRuntimeModule;
};
