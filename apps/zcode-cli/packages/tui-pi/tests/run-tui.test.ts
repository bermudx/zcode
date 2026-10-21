import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiOptions } from "@zcode/tui/internals";
import { runPiTui } from "../src/run-tui.js";

const optionsWithStdio = (stdio: {
  stdinTTY: boolean;
  stdoutTTY: boolean;
  onStderr: (chunk: string) => void;
}): TuiOptions =>
  ({
    stdin: { isTTY: stdio.stdinTTY } as NodeJS.ReadStream,
    stdout: { isTTY: stdio.stdoutTTY } as NodeJS.WriteStream,
    stderr: { write: (chunk: string) => stdio.onStderr(chunk) } as NodeJS.WriteStream,
  }) as TuiOptions;

test("runPiTui refuses non-TTY stdin", async () => {
  let stderr = "";
  const code = await runPiTui(
    optionsWithStdio({
      onStderr: (chunk) => {
        stderr += chunk;
      },
      stdinTTY: false,
      stdoutTTY: true,
    }),
  );
  assert.equal(code, 1);
  assert.match(stderr, /requires a TTY/);
});

test("runPiTui refuses non-TTY stdout", async () => {
  let stderr = "";
  const code = await runPiTui(
    optionsWithStdio({
      onStderr: (chunk) => {
        stderr += chunk;
      },
      stdinTTY: true,
      stdoutTTY: false,
    }),
  );
  assert.equal(code, 1);
  assert.match(stderr, /requires a TTY/);
});
