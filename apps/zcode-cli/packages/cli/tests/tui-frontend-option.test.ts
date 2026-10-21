import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import type { RunContext } from "@zcode/shared-types";
import { run, type RunDependencies } from "../src/run.js";

/**
 * `--tui-frontend` 的校验与作用域（docs/design/v2/tui-pi-frontend.md）：
 * 仅接受 opentui|pi，只作用于 tui 命令，且注入的 deps.runTui 优先级最高。
 */

function harness(argv: string[]) {
  let stdout = "";
  let stderr = "";
  let tuiCalls = 0;
  const appOptions: ZCodeAppOptions[] = [];
  const ctx: RunContext = {
    argv,
    stdin: { isTTY: true } as NodeJS.ReadStream,
    stdout: {
      isTTY: true,
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
  };
  const deps: RunDependencies = {
    skipUserConfig: true,
    env: {},
    loadDotenv: () => ({ keys: [], loaded: false }),
    resolveLatestSession: async () => ({ id: "sess_frontend" }) as never,
    resolveWorkspaceGitBranch: async () => undefined,
    listCustomCommands: async () => ({ commands: [], diagnostics: [] }),
    startProcessProviderRegistryRuntime: async () =>
      ({ runtime: { registryService: {} }, dispose: () => {} }) as never,
    createZCodeApp: (options) => {
      appOptions.push(options!);
      return {
        sessionId: "sess_frontend",
        traceId: "trace-frontend",
        runtime: {},
        close: async () => {},
        getLocale: () => "en-US",
        getModel: () => "openai/test",
        getThoughtLevel: () => "medium",
        getTheme: () => "dark",
        readSubagents: async () => [],
        listMcpServers: async () => [],
      } as never;
    },
    runTui: async () => {
      tuiCalls += 1;
      return 0;
    },
  };
  return {
    ctx,
    deps,
    stderr: () => stderr,
    stdout: () => stdout,
    tuiCalls: () => tuiCalls,
  };
}

test("rejects unsupported --tui-frontend values", async () => {
  const h = harness(["--tui-frontend", "bogus"]);
  assert.equal(await run(h.ctx, h.deps), 1);
  assert.match(h.stderr(), /--tui-frontend must be one of opentui, pi/);
});

test("rejects --tui-frontend outside the tui command", async () => {
  const h = harness(["--tui-frontend", "pi", "--prompt", "hello"]);
  assert.equal(await run(h.ctx, h.deps), 1);
  assert.match(h.stderr(), /--tui-frontend can only be used with the tui command/);
});

test("tui command accepts --tui-frontend pi with injected runTui", async () => {
  const h = harness(["tui", "--tui-frontend", "pi"]);
  assert.equal(await run(h.ctx, h.deps), 0, h.stderr());
  assert.equal(h.tuiCalls(), 1);
});

test("tui command accepts --tui-frontend opentui", async () => {
  const h = harness(["tui", "--tui-frontend", "opentui"]);
  assert.equal(await run(h.ctx, h.deps), 0, h.stderr());
  assert.equal(h.tuiCalls(), 1);
});
