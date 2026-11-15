import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "@zcode/shared-types";
import { run } from "../src/run.js";
import type { RunDependencies } from "../src/run.js";
import { createCommandCenter, listSlashCommandSuggestions } from "../src/command-center.js";
import type { CommandCenterApp, CommandCenterDeps } from "../src/command-center.js";
import { createTuiSubmitPrompt } from "../src/tui-prompt-handler.js";
import { acpWorkflowModeOption } from "../src/attach/attach-entry-args.js";
import {
  DEFAULT_ACP_WORKFLOW_MODE,
  normalizeWorkflowModeOption,
  WORKFLOW_DISABLED_NOTICE,
  WORKFLOW_MODE_SCOPE_ERROR,
} from "../src/workflow-mode.js";

/**
 * 独立 CLI 的 `--workflow-mode`（docs/dynamic-workflow/launch.md「The standalone CLI:
 * `--workflow-mode`」，DWG-14 ～ DWG-17）。缺省 disabled；两个 runtime 字段总是显式写出。
 */

type CapturedWriteStream = NodeJS.WriteStream & { output: () => string };

const createWriteStream = (): CapturedWriteStream => {
  let output = "";
  return {
    isTTY: false,
    output: () => output,
    write: (chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown) => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      (done as (() => void) | undefined)?.();
      return true;
    },
  } as CapturedWriteStream;
};

const createContext = (argv: string[]) =>
  ({
    argv,
    stderr: createWriteStream(),
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stdout: createWriteStream(),
  }) satisfies RunContext;

const fakeProjection = {
  contextUsed: 0,
  contextWindow: 0,
  status: "idle",
  totalTokenCount: 0,
  turnCount: 1,
};

type RuntimeConfigSeen = {
  dynamicWorkflowEnabled?: boolean;
  dynamicWorkflowToolsOnDemand?: boolean;
};

/** 记录每次建 app 时的两个工作流字段；app 本身只够跑通一次 prompt / TUI 启动。 */
function createRecordingDeps(): { deps: RunDependencies; seen: RuntimeConfigSeen[] } {
  const seen: RuntimeConfigSeen[] = [];
  const deps: RunDependencies = {
    createModelAdapter: () => ({}) as never,
    createZCodeApp: (options) => {
      const config = (options?.runtimeConfig ?? {}) as RuntimeConfigSeen;
      seen.push({
        dynamicWorkflowEnabled: config.dynamicWorkflowEnabled,
        dynamicWorkflowToolsOnDemand: config.dynamicWorkflowToolsOnDemand,
      });
      return {
        getLocale: () => "en-US",
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: `session-${seen.length}`,
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    loadDotenv: () => ({ keys: [], loaded: false }),
    startProcessProviderRegistryRuntime: async () =>
      ({ dispose: () => {}, runtime: { registryService: {} } }) as never,
    skipUserConfig: true,
    listCustomCommands: async () => ({ commands: [], diagnostics: [] }) as never,
  };
  return { deps, seen };
}

const DISABLED_PAIR = { dynamicWorkflowEnabled: false, dynamicWorkflowToolsOnDemand: false };
const ON_DEMAND_PAIR = { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: true };
const ALWAYS_ON_PAIR = { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: false };

// ── DWG-14：取值与 runtime 字段 ────────────────────────────────────────────

test("TUI without --workflow-mode writes the disabled pair and suggests no /workflow", async () => {
  const { deps, seen } = createRecordingDeps();
  let suggestions: string[] = [];
  const ctx = createContext(["tui"]);
  const exitCode = await run(ctx, {
    ...deps,
    runTui: async (options) => {
      // TUI 的斜杠命令与首个 App 由启动选项异步提供（TUI 启动画面先渲染，再加载会话元数据）。
      const startup = await options.loadStartupOptions?.();
      suggestions = (startup?.slashCommands ?? options.slashCommands ?? []).map(
        (entry) => entry.name,
      );
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.ok(seen.length > 0, "the TUI creates its first app at startup");
  for (const config of seen) assert.deepEqual(config, DISABLED_PAIR);
  assert.ok(!suggestions.includes("workflow"));
  assert.ok(suggestions.includes("dwf"), "/dwf stays for viewing existing runs");
});

test("TUI with --workflow-mode onDemand writes the onDemand pair and suggests /workflow", async () => {
  const { deps, seen } = createRecordingDeps();
  let suggestions: string[] = [];
  const ctx = createContext(["--workflow-mode", "onDemand"]);
  const exitCode = await run(ctx, {
    ...deps,
    runTui: async (options) => {
      // TUI 的斜杠命令与首个 App 由启动选项异步提供（TUI 启动画面先渲染，再加载会话元数据）。
      const startup = await options.loadStartupOptions?.();
      suggestions = (startup?.slashCommands ?? options.slashCommands ?? []).map(
        (entry) => entry.name,
      );
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.ok(seen.length > 0);
  for (const config of seen) assert.deepEqual(config, ON_DEMAND_PAIR);
  assert.ok(suggestions.includes("workflow"));
});

test("every app the TUI creates, including /new, carries the same pair", async () => {
  const { deps, seen } = createRecordingDeps();
  const handler = createTuiSubmitPrompt(
    deps,
    {},
    "test",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    "off",
    undefined,
    undefined,
    "alwaysOn",
  );
  try {
    await handler.getSessionMetadata!();
    await handler("/new", { abortSignal: new AbortController().signal });
  } finally {
    await handler.close?.();
  }
  assert.equal(seen.length, 2);
  for (const config of seen) assert.deepEqual(config, ALWAYS_ON_PAIR);
});

test("an unknown --workflow-mode value fails before any app is created", async () => {
  const { deps, seen } = createRecordingDeps();
  const ctx = createContext(["--prompt", "hello", "--workflow-mode", "sometimes"]);
  assert.equal(await run(ctx, deps), 1);
  assert.match(
    ctx.stderr.output(),
    /Unsupported --workflow-mode value: sometimes\. Supported modes: disabled, onDemand, alwaysOn\./,
  );
  assert.deepEqual(seen, []);
});

// ── DWG-15：作用域 ──────────────────────────────────────────────────────────

for (const argv of [["app-server"], ["agent-server"], ["login"], ["skills"]] as const) {
  test(`--workflow-mode is rejected with ${argv[0]}`, async () => {
    const { deps, seen } = createRecordingDeps();
    const ctx = createContext([...argv, "--workflow-mode", "alwaysOn"]);
    assert.equal(await run(ctx, deps), 1);
    assert.equal(ctx.stderr.output(), `${WORKFLOW_MODE_SCOPE_ERROR}\n`);
    assert.deepEqual(seen, []);
  });
}

// ── issue #5：acp lane ──────────────────────────────────────────────────────
// ACP 缺省 onDemand（与其他 lane 的 disabled 不同）：mode 经 runAcpCommand
// 第五参数进会话层，逐条 create/resume 下发灰度字段。

test("acp with a bogus --workflow-mode exits 1 naming the three values", async () => {
  const ctx = createContext(["acp", "--workflow-mode", "bogus"]);
  assert.equal(await run(ctx, {}), 1);
  assert.match(
    ctx.stderr.output(),
    /Unsupported --workflow-mode value: bogus\. Supported modes: disabled, onDemand, alwaysOn\./,
  );
});

test("acp --workflow-mode alwaysOn reaches runAcpCommand with alwaysOn", async () => {
  let seen: string | undefined;
  const ctx = createContext(["acp", "--workflow-mode", "alwaysOn"]);
  assert.equal(
    await run(ctx, {
      runAcpCommand: async (_ctx, _options, _deps, _version, workflowMode) => {
        seen = workflowMode;
        return 0;
      },
    }),
    0,
  );
  assert.equal(seen, "alwaysOn");
});

test("acp without --workflow-mode reaches runAcpCommand with the onDemand default", async () => {
  let seen: string | undefined;
  const ctx = createContext(["acp"]);
  assert.equal(
    await run(ctx, {
      runAcpCommand: async (_ctx, _options, _deps, _version, workflowMode) => {
        seen = workflowMode;
        return 0;
      },
    }),
    0,
  );
  assert.equal(seen, "onDemand");
});

// ── verifier F1/F-A/F-B：acp lane argv 解析，两个入口同一条 parseArgs 管线 ──
// monolith 的 parseArgs 对重复 string 旗标是 last-wins，且只校验生效值；
// `--` 之后的 token 是位置参数不再解析；值 token 是旗标形状时报 ambiguous。
// zcode-attach acp 曾用手写扫描：F1 取第一个值（disabled bogus → exit 0），
// F-A 把 `-x` 当值吞掉（→ exit 0），F-B 不认 `--`（bogus → exit 1、
// disabled → 错发 disabled）。两边一致：
// 末位非法 → exit 1；合法重复 → 末位生效；被覆盖的非法值不单独报错；
// `--` 之后的 --workflow-mode 不生效（ACP 缺省 onDemand）。

test("acp --workflow-mode disabled --workflow-mode bogus exits 1 (monolith)", async () => {
  const ctx = createContext(["acp", "--workflow-mode", "disabled", "--workflow-mode", "bogus"]);
  assert.equal(await run(ctx, {}), 1);
  assert.match(
    ctx.stderr.output(),
    /Unsupported --workflow-mode value: bogus\. Supported modes: disabled, onDemand, alwaysOn\./,
  );
});

test("acp repeated --workflow-mode is last-wins on the monolith, even over a bogus first value", async () => {
  const seen: string[] = [];
  const deps: RunDependencies = {
    runAcpCommand: async (_ctx, _options, _deps, _version, workflowMode) => {
      seen.push(workflowMode);
      return 0;
    },
  };
  assert.equal(
    await run(
      createContext(["acp", "--workflow-mode", "onDemand", "--workflow-mode", "alwaysOn"]),
      deps,
    ),
    0,
  );
  assert.equal(
    await run(
      createContext(["acp", "--workflow-mode", "bogus", "--workflow-mode", "disabled"]),
      deps,
    ),
    0,
  );
  assert.deepEqual(seen, ["alwaysOn", "disabled"]);
});

// F-A：`--workflow-mode` 的值 token 是旗标形状 → parseArgs 报 ambiguous，两边 exit 1。
test("acp --workflow-mode -x --workflow-mode alwaysOn exits 1 on both entries", async () => {
  const argv = ["acp", "--workflow-mode", "-x", "--workflow-mode", "alwaysOn"];
  const ctx = createContext(argv);
  assert.equal(await run(ctx, {}), 1);
  assert.match(ctx.stderr.output(), /argument is ambiguous/);
  assert.throws(() => acpWorkflowModeOption(argv), /argument is ambiguous/);
});

// F-B：`--` 之后的 --workflow-mode 是位置参数，两边都不生效 → ACP 缺省 onDemand。
test("acp -- --workflow-mode <value> is positional on both entries", async () => {
  const seen: string[] = [];
  const deps: RunDependencies = {
    runAcpCommand: async (_ctx, _options, _deps, _version, workflowMode) => {
      seen.push(workflowMode);
      return 0;
    },
  };
  for (const value of ["bogus", "disabled"]) {
    const ctx = createContext(["acp", "--", "--workflow-mode", value]);
    assert.equal(await run(ctx, deps), 0);
  }
  assert.deepEqual(seen, ["onDemand", "onDemand"]);
  // attach 侧同一 resolve 组合：位置参数里的旗标取不到值 → 缺省 onDemand。
  const resolve = (argv: string[]) =>
    normalizeWorkflowModeOption(acpWorkflowModeOption(argv)) ?? DEFAULT_ACP_WORKFLOW_MODE;
  assert.equal(resolve(["acp", "--", "--workflow-mode", "bogus"]), "onDemand");
  assert.equal(resolve(["acp", "--", "--workflow-mode", "disabled"]), "onDemand");
});

test("zcode-attach acp resolves --workflow-mode repeats exactly like the monolith", () => {
  // 与 attach-main 同一组合：acpWorkflowModeOption → normalize → ACP 缺省 onDemand。
  // argv 与 monolith 的 ctx.argv 同形（含 `acp` 子命令位）。
  const resolve = (argv: string[]) =>
    normalizeWorkflowModeOption(acpWorkflowModeOption(argv)) ?? DEFAULT_ACP_WORKFLOW_MODE;
  assert.equal(
    resolve(["acp", "--workflow-mode", "disabled", "--workflow-mode", "alwaysOn"]),
    "alwaysOn",
  );
  assert.equal(
    resolve(["acp", "--workflow-mode=onDemand", "--workflow-mode", "disabled"]),
    "disabled",
  );
  // F1 回归：末位非法必须与 monolith 一样拒绝（曾取第一个值 → 静默 exit 0）。
  assert.throws(
    () => resolve(["acp", "--workflow-mode", "disabled", "--workflow-mode", "bogus"]),
    /Unsupported --workflow-mode value: bogus\. Supported modes: disabled, onDemand, alwaysOn\./,
  );
  assert.throws(
    () => resolve(["acp", "--workflow-mode", "disabled", "--workflow-mode=bogus"]),
    /Unsupported --workflow-mode value: bogus/,
  );
  // parseArgs 同款 last-wins：被覆盖的非法值不单独报错。
  assert.equal(
    resolve(["acp", "--workflow-mode", "bogus", "--workflow-mode", "disabled"]),
    "disabled",
  );
  // parseArgs 同款缺值/未知旗标报错（措辞来自 node:util，不再是手写文案）。
  assert.throws(() => acpWorkflowModeOption(["acp", "--workflow-mode"]), /argument missing/);
  assert.throws(() => acpWorkflowModeOption(["acp", "--not-a-flag"]), /Unknown option/);
});

// ── DWG-17：headless ─────────────────────────────────────────────────────────

test("headless /workflow under the default mode exits 1 before any app exists", async () => {
  const { deps, seen } = createRecordingDeps();
  const ctx = createContext(["--prompt", "/workflow build me a plan"]);
  assert.equal(await run(ctx, deps), 1);
  assert.equal(ctx.stderr.output(), `Error: ${WORKFLOW_DISABLED_NOTICE}\n`);
  assert.equal(ctx.stdout.output(), "");
  assert.deepEqual(seen, []);
});

test("headless /help lists /workflow only when workflows are on", async () => {
  const disabled = createContext(["--prompt", "/help"]);
  assert.equal(await run(disabled, createRecordingDeps().deps), 0);
  assert.doesNotMatch(disabled.stdout.output(), /\/workflow/);
  assert.match(disabled.stdout.output(), /\/dwf/);

  const onDemand = createContext(["--prompt", "/help", "--workflow-mode", "onDemand"]);
  assert.equal(await run(onDemand, createRecordingDeps().deps), 0);
  assert.match(onDemand.stdout.output(), /\/workflow \[what the workflow should accomplish\]/);
});

// ── DWG-16：命令面 ───────────────────────────────────────────────────────────

function createHarness(
  workflowMode: CommandCenterDeps["workflowMode"],
  app: Partial<CommandCenterApp> = {},
) {
  const calls = { getApp: 0, submitted: [] as string[] };
  const submitPrompt = createCommandCenter({
    getApp: async () => {
      calls.getApp += 1;
      return {
        sessionId: "sess_active",
        traceId: "trace-active",
        submitPrompt: async (prompt: string) => {
          calls.submitted.push(prompt);
          return { response: "submitted", traceId: "trace-submit" };
        },
        ...app,
      } as never;
    },
    getMode: () => "build" as never,
    resumeApp: async () => {
      throw new Error("resumeApp should not run");
    },
    workflowMode,
  });
  return { calls, submitPrompt };
}

const ABORT = { abortSignal: new AbortController().signal };

test("disabled: /workflow answers the notice locally without an app or a model turn", async () => {
  const { calls, submitPrompt } = createHarness("disabled");
  const result = await submitPrompt("/workflow review the auth module", ABORT);
  assert.equal(result.response, WORKFLOW_DISABLED_NOTICE);
  assert.equal(calls.getApp, 0);
  assert.deepEqual(calls.submitted, []);
});

test("disabled: /help and /help workflow leave /workflow out", async () => {
  const { submitPrompt } = createHarness("disabled");
  const all = await submitPrompt("/help", ABORT);
  assert.doesNotMatch(all.response, /\/workflow/);
  const single = await submitPrompt("/help workflow", ABORT);
  assert.match(single.response, /^Unknown slash command: \/workflow\./);
  assert.doesNotMatch(single.response, /Available commands:.*\/workflow\b/);
});

test("disabled: /dwf list and cancel still work, resume is refused before the server", async () => {
  let resumed = 0;
  let cancelled = 0;
  const { submitPrompt } = createHarness("disabled", {
    listDynamicWorkflowRuns: async () => [],
    cancelBackgroundTask: async () => {
      cancelled += 1;
      return { cancelled: true, status: "cancelled" } as never;
    },
    resumeWorkflowRun: async () => {
      resumed += 1;
      return { ok: true, runId: "dwfrun_1" } as never;
    },
  });

  assert.match((await submitPrompt("/dwf list", ABORT)).response, /No dynamic workflow runs/);
  assert.match(
    (await submitPrompt("/dwf cancel dwfrun_1", ABORT)).response,
    /Cancelled dynamic workflow run dwfrun_1/,
  );
  assert.equal(cancelled, 1);
  assert.equal(
    (await submitPrompt("/dwf resume dwfrun_1", ABORT)).response,
    WORKFLOW_DISABLED_NOTICE,
  );
  assert.equal(resumed, 0);
});

for (const mode of ["onDemand", "alwaysOn"] as const) {
  test(`${mode}: /workflow is suggested and submitted to the app as before`, async () => {
    const { calls, submitPrompt } = createHarness(mode);
    const result = await submitPrompt("/workflow review the auth module", ABORT);
    assert.equal(result.response, "submitted");
    assert.deepEqual(calls.submitted, ["/workflow review the auth module"]);
    const names = listSlashCommandSuggestions(undefined, { workflowMode: mode }).map(
      (entry) => entry.name,
    );
    assert.ok(names.includes("workflow"));
  });
}

test("disabled: the suggestion list drops only /workflow", () => {
  const all = listSlashCommandSuggestions().map((entry) => entry.name);
  const disabled = listSlashCommandSuggestions(undefined, { workflowMode: "disabled" }).map(
    (entry) => entry.name,
  );
  assert.deepEqual(
    disabled,
    all.filter((name) => name !== "workflow"),
  );
});
