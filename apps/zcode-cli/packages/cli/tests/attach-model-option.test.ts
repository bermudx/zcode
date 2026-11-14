import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  ZCODE_PROTOCOL_VERSION,
  type DynamicWorkflowMode,
  type ZCodeModelOption,
} from "@zcode/shared";
import type { RunContext } from "@zcode/shared-types";
import { run } from "../src/run.js";
import {
  runAttachCommand,
  resolveInitialModelRef,
} from "../src/attach/attach-command.js";
import { workflowModeSessionParams } from "../src/workflow-mode.js";
import { parseAttachEntryArgs } from "../src/attach/attach-entry-args.js";
import {
  GLM_COMPACT_CONTEXT_WINDOW,
  isGlmModelId,
  resolveCompactContextWindowForModel,
} from "../src/attach/attach-compact-cap.js";

/**
 * `--model` 启动模型选择（docs/design/v2/tui-attach-shared-core.md
 * 「启动模型选择」）：作用域仅 tui --shared-core（attach/piz）；应用点在
 * 会话物化后经既有 session/setModel 链路；bare id 目录唯一命中时补全
 * provider（不区分大小写，多命中优先当前 provider）；未知/未消歧的多命中
 * 在 TUI 接管前以 stderr 报错退出。
 */

const SID = "sess-1";
const CODING_PLAN_PROVIDER = "account:zai-individual-coding-plan";
const HIGHSPEED_PROVIDER = "account:zai-highspeed-card";

/** 真实 server 的 catalog 项形状（实测 session/create 回包）：身份在 ref 里，
 *  元数据是 label/providerLabel/reasoning/properties。 */
const modelOption = (
  modelId: string,
  providerId = "zai",
  reasoning: { defaultLevel: string; levels: { label: string; value: string }[] } = {
    defaultLevel: "max",
    levels: [{ label: "max", value: "max" }],
  },
): ZCodeModelOption => ({
  label: modelId,
  properties: {
    inputFormat: {
      supportsAudio: false,
      supportsImage: true,
      supportsPdf: true,
      supportsText: true,
      supportsVideo: false,
    },
    outputFormat: { supportsText: true },
  },
  providerLabel: "Z.AI",
  reasoning,
  ref: { modelId, providerId },
});

function makeSnapshot(
  currentModelId = "glm-4.6",
  available: ZCodeModelOption[] = [
    modelOption("glm-4.6"),
    modelOption("glm-4.7"),
    modelOption("glm-5.3"),
  ],
  currentProviderId = "zai",
) {
  return {
    messages: [],
    projection: {
      activeToolCalls: [],
      backgroundJobs: [],
      contextUsed: 0,
      contextWindow: 200_000,
      mode: "build",
      pendingPermissions: [],
      sessionId: SID,
      status: "idle",
      totalTokenCount: 0,
      turnCount: 0,
    },
    protocol: { name: "ZCode Protocol", version: ZCODE_PROTOCOL_VERSION },
    runtime: { eventSeq: 0, pendingRequestIds: [], stateRevision: 0 },
    session: {
      createdAt: 1_700_000_000_000,
      mode: "build",
      sessionId: SID,
      sessionKind: "interactive",
      status: "idle",
      title: "attach model test",
      traceId: "trace-1",
      updatedAt: 1_700_000_000_000,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    },
    settings: {
      mode: { current: "build" },
      model: {
        available,
        current: { modelId: currentModelId, providerId: currentProviderId },
      },
      thoughtLevel: { available: [], current: "medium", enabled: true },
    },
  };
}

type Captured = { method: string; params: Record<string, unknown> };

/** 假 core：按 method 路由到应答表（同 attach-adapter.test.ts 的 harness）。 */
async function startFakeCore(
  socketPath: string,
  responder: (request: Captured) => unknown,
): Promise<{ close: () => Promise<void>; requests: Captured[] }> {
  const requests: Captured[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as { id?: string; method?: string };
        if (!message.method || message.id === undefined) continue;
        const request: Captured = {
          method: message.method,
          params: (JSON.parse(line) as { params?: Record<string, unknown> }).params ?? {},
        };
        requests.push(request);
        Promise.resolve(responder(request))
          .then((value) =>
            socket.write(`${JSON.stringify({ id: message.id, result: value ?? {} })}\n`),
          )
          .catch((error: Error) =>
            socket.write(
              `${JSON.stringify({ error: { code: -32000, message: error.message }, id: message.id })}\n`,
            ),
          );
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    requests,
  };
}

interface AttachHarness {
  coreRequests: Captured[];
  destroy: () => Promise<void>;
  runAttach: (
    initialModel?: string,
    resume?: { continueSession?: boolean },
    options?: { submitInsideTui?: readonly string[]; workflowMode?: DynamicWorkflowMode },
  ) => Promise<{
    exitCode: number;
    initialModel?: string;
    initialResultModel?: string;
    stderr: string;
  }>;
}

/** runAttachCommand + 假 core：默认走 session/create 新会话路径。 */
async function startAttachHarness(
  available?: ZCodeModelOption[],
  startModelId = "glm-4.6",
  startProviderId = "zai",
): Promise<AttachHarness> {
  const dir = await mkdtemp(join(tmpdir(), "attach-model-"));
  const workspace = join(dir, "workspace");
  const { resolveSocketPath } = await import("../src/app-server-spawn.js");
  const socketPath = resolveSocketPath({ env: { ZCODE_DATA_BASE_DIR: dir } });
  await mkdir(dirname(socketPath), { recursive: true });
  let currentModelId = startModelId;
  let currentProviderId = startProviderId;
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/create" || request.method === "session/resume") {
      return makeSnapshot(currentModelId, available, currentProviderId);
    }
    if (request.method === "session/list") {
      return { sessions: [{ sessionId: SID, updatedAt: 42 }] };
    }
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/messages") {
      // /resume 后的 loadSessionTranscript：回包按共享 schema 校验，缺 messages 键即拒。
      return { messages: [] };
    }
    if (request.method === "session/setModel") {
      const model = request.params.model as { modelId: string; providerId: string };
      currentModelId = model.modelId;
      currentProviderId = model.providerId;
      return makeSnapshot(currentModelId, available, currentProviderId);
    }
    if (request.method === "runtime/capabilities") return {};
    return {};
  });
  const runAttach = (
    initialModel?: string,
    resume?: { continueSession?: boolean },
    attachOptions?: {
      submitInsideTui?: readonly string[];
      workflowMode?: DynamicWorkflowMode;
    },
  ) => {
    const stderrChunks: string[] = [];
    const ctx = {
      argv: [],
      stderr: {
        write: (chunk: string) => {
          stderrChunks.push(chunk);
          return true;
        },
      } as never,
      stdin: process.stdin,
      // 退出续接提示走 ctx.stdout：接静默 sink，提示不污染测试输出。
      stdout: { write: () => true } as never,
    } as RunContext;
    let tuiOptions: Record<string, unknown> | undefined;
    const deps = {
      cwd: () => workspace,
      env: { ...process.env, ZCODE_DATA_BASE_DIR: dir },
      resolveWorkspaceGitBranch: async () => undefined,
      runTui: async (options: Record<string, unknown>) => {
        tuiOptions = options;
        // TUI 接管后依次提交（/new、/resume <id> 等 commandCenter 路由）。
        for (const input of attachOptions?.submitInsideTui ?? []) {
          await (
            options.submitPrompt as (input: string, opts?: object) => Promise<unknown>
          )(input, {});
        }
        return 0;
      },
    } as never;
    return runAttachCommand(
      ctx,
      {} as never,
      deps,
      "0.0.0-test",
      "pi",
      { continueSession: resume?.continueSession === true },
      initialModel,
      undefined,
      attachOptions?.workflowMode,
    ).then((exitCode) => {
      const initialResult = tuiOptions?.initialResult as
        | { model?: string }
        | undefined;
      return {
        exitCode,
        initialModel: tuiOptions?.initialModel as string | undefined,
        initialResultModel: initialResult?.model,
        stderr: stderrChunks.join(""),
      };
    });
  };
  return {
    coreRequests: core.requests,
    destroy: async () => {
      await core.close();
      await rm(dir, { force: true, recursive: true });
    },
    runAttach,
  };
}

// ── resolveInitialModelRef：取值归一 ──

test("bare model id 唯一命中时补全 provider", () => {
  const available = [modelOption("glm-4.6"), modelOption("glm-5.3")];
  assert.equal(resolveInitialModelRef("glm-5.3", available), "zai/glm-5.3");
});

test("lowercase short name resolves to the coding-plan catalog's canonical GLM id", () => {
  const available = [
    modelOption("GLM-5.3", CODING_PLAN_PROVIDER),
    modelOption("GLM-5.3-Flash", CODING_PLAN_PROVIDER),
  ];
  for (const input of ["glm-5.3", "GlM-5.3", " GLM-5.3 "]) {
    assert.equal(resolveInitialModelRef(input, available), `${CODING_PLAN_PROVIDER}/GLM-5.3`);
  }
  assert.equal(
    resolveInitialModelRef("glm-5.3-flash", available),
    `${CODING_PLAN_PROVIDER}/GLM-5.3-Flash`,
  );
});

test("bare ids match case-insensitively for non-GLM providers too", () => {
  assert.equal(
    resolveInitialModelRef("other-model", [modelOption("Other-Model", "custom")]),
    "custom/Other-Model",
  );
});

test("short name prefers the current provider, not catalog order", () => {
  const available = [
    modelOption("GLM-5.3", HIGHSPEED_PROVIDER),
    modelOption("GLM-5.3", CODING_PLAN_PROVIDER),
  ];
  assert.equal(
    resolveInitialModelRef("glm-5.3", available, CODING_PLAN_PROVIDER),
    `${CODING_PLAN_PROVIDER}/GLM-5.3`,
  );
  assert.equal(
    resolveInitialModelRef("glm-5.3", available, HIGHSPEED_PROVIDER),
    `${HIGHSPEED_PROVIDER}/GLM-5.3`,
  );
  assert.throws(
    () => resolveInitialModelRef("glm-5.3", available, "unrelated"),
    /matches multiple providers/,
  );
});

test("short name still resolves a unique match outside the current provider", () => {
  assert.equal(
    resolveInitialModelRef("glm-5.3", [modelOption("GLM-5.3", CODING_PLAN_PROVIDER)], "custom"),
    `${CODING_PLAN_PROVIDER}/GLM-5.3`,
  );
});

test("bare id and effort both use catalog casing", () => {
  const available = [
    modelOption("GLM-5.3", CODING_PLAN_PROVIDER, {
      defaultLevel: "max",
      levels: [{ label: "High", value: "High" }, { label: "max", value: "max" }],
    }),
  ];
  assert.equal(
    resolveInitialModelRef("glm-5.3$HIGH", available),
    `${CODING_PLAN_PROVIDER}/GLM-5.3$High`,
  );
  assert.throws(
    () => resolveInitialModelRef("glm-5.3$unknown", available),
    /Select a supported reasoning effort.*High, max/,
  );
  assert.throws(
    () => resolveInitialModelRef("glm-5.3$", available),
    /is not available/,
  );
});

test("literal bare model ids containing dollar signs take precedence over effort", () => {
  const available = [modelOption("Custom$Model", "custom"), modelOption("Custom", "custom")];
  assert.equal(resolveInitialModelRef("custom$model", available), "custom/Custom$Model");
});

test("完整 ref 与 $effort 后缀原样透传", () => {
  const available = [modelOption("glm-5.3")];
  assert.equal(resolveInitialModelRef("zai/glm-5.3", available), "zai/glm-5.3");
  assert.equal(resolveInitialModelRef("zai/glm-5.3$high", available), "zai/glm-5.3$high");
  assert.equal(
    resolveInitialModelRef(`${CODING_PLAN_PROVIDER}/glm-5.3$HIGH`, available),
    `${CODING_PLAN_PROVIDER}/glm-5.3$HIGH`,
  );
});

test("未知 bare id 报错并列出可用完整 ref", () => {
  const available = [modelOption("glm-4.6"), modelOption("glm-5.3")];
  assert.throws(
    () => resolveInitialModelRef("nope", available),
    /"nope" is not available. Available models: zai\/glm-4.6, zai\/glm-5.3/,
  );
});

test("bare id 多 provider 命中时报错并列出候选", () => {
  const available = [modelOption("glm-5.3", "zai"), modelOption("glm-5.3", "bigmodel")];
  assert.throws(
    () => resolveInitialModelRef("glm-5.3", available),
    /matches multiple providers: zai\/glm-5.3, bigmodel\/glm-5.3/,
  );
});

test("禁用项不参与 bare id 补全", () => {
  const disabled = { ...modelOption("glm-5.3"), disabledReason: "plan required" };
  const available = [modelOption("glm-4.6"), disabled];
  assert.throws(
    () => resolveInitialModelRef("glm-5.3", available),
    /is not available/,
  );
});

test("disabled current-provider matches cannot win the short-name tiebreak", () => {
  const available = [
    { ...modelOption("GLM-5.3", CODING_PLAN_PROVIDER), disabledReason: "plan required" },
    modelOption("GLM-5.3", HIGHSPEED_PROVIDER),
    modelOption("GLM-5.3", "another-provider"),
  ];
  assert.throws(
    () => resolveInitialModelRef("glm-5.3", available, CODING_PLAN_PROVIDER),
    /matches multiple providers/,
  );
  assert.throws(
    () => resolveInitialModelRef("glm-5.3", available.slice(0, 1), CODING_PLAN_PROVIDER),
    /is not available/,
  );
});

// ── parseAttachEntryArgs：zcode-attach（piz）入口解析 ──

test("zcode-attach 解析 --model 与 -c 组合", () => {
  const parsed = parseAttachEntryArgs(["-c", "--model", "glm-5.3"]);
  assert.equal(parsed.initialModel, "glm-5.3");
  assert.equal(parsed.resume.continueSession, true);
});

test("zcode-attach --model 缺值报错", () => {
  assert.throws(() => parseAttachEntryArgs(["--model"]), /--model requires a value/);
  assert.throws(() => parseAttachEntryArgs(["--model", ""]), /--model requires a value/);
});

// 回归证据（P004-F5，2026-10-26 评审）：--resume 缺值曾静默置
// resumeSessionId=undefined → 降级为开新会话——正是 9b46915f 在别处清除的
// 静默回退形态。与 --model 同判：显式报错。
test("zcode-attach --resume 缺值报错，不静默降级为新会话", () => {
  assert.throws(() => parseAttachEntryArgs(["--resume"]), /--resume requires a value/);
  assert.throws(() => parseAttachEntryArgs(["--resume", ""]), /--resume requires a value/);
});

// #53 回归：`--flag=value` 写法曾被静默忽略。
test("zcode-attach 接受 --flag=value 写法", () => {
  const parsed = parseAttachEntryArgs([
    "--model=zai/glm-5.3",
    "--workflow-mode=onDemand",
    "--resume=sess-1",
    "--locale=en",
  ]);
  assert.equal(parsed.initialModel, "zai/glm-5.3");
  assert.equal(parsed.workflowMode, "onDemand");
  assert.equal(parsed.resume.resumeSessionId, "sess-1");
  assert.equal(parsed.options.locale, "en");
  assert.throws(() => parseAttachEntryArgs(["--model="]), /--model requires a value/);
  assert.throws(() => parseAttachEntryArgs(["--workflow-mode=bogus"]), /disabled|onDemand|alwaysOn/);
});

// ── runAttachCommand：启动期 setModel 应用 ──

test("create 路径：--model 完整 ref 触发 session/setModel 且目录校验默认档位", async () => {
  const h = await startAttachHarness();
  try {
    const result = await h.runAttach("zai/glm-5.3");
    assert.equal(result.exitCode, 0, result.stderr);
    const setModel = h.coreRequests.find((r) => r.method === "session/setModel");
    assert.ok(setModel, "session/setModel request was sent");
    assert.deepEqual(setModel?.params.model, {
      modelId: "glm-5.3",
      options: { reasoningLevel: "max" },
      providerId: "zai",
    });
    assert.equal(setModel?.params.sessionId, SID);
  } finally {
    await h.destroy();
  }
});

test("create 路径：bare id 目录唯一命中 → 补全 provider", async () => {
  const h = await startAttachHarness([modelOption("GLM-5.3", CODING_PLAN_PROVIDER)]);
  try {
    const result = await h.runAttach("glm-5.3");
    assert.equal(result.exitCode, 0, result.stderr);
    const setModel = h.coreRequests.find((r) => r.method === "session/setModel");
    assert.deepEqual(setModel?.params.model, {
      modelId: "GLM-5.3",
      options: { reasoningLevel: "max" },
      providerId: CODING_PLAN_PROVIDER,
    });
  } finally {
    await h.destroy();
  }
});

for (const continueSession of [false, true]) {
  test(`${continueSession ? "resume" : "create"}: lowercase alias keeps the current coding-plan provider and effort`, async () => {
    const h = await startAttachHarness(
      [
        modelOption("GLM-5.3", HIGHSPEED_PROVIDER),
        modelOption("GLM-5.3", CODING_PLAN_PROVIDER, {
          defaultLevel: "max",
          levels: [{ label: "max", value: "max" }, { label: "high", value: "high" }],
        }),
      ],
      "GLM-5.3",
      CODING_PLAN_PROVIDER,
    );
    try {
      const result = await h.runAttach("glm-5.3$HIGH", { continueSession });
      assert.equal(result.exitCode, 0, result.stderr);
      const requests = h.coreRequests.filter((request) => request.method === "session/setModel");
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0]?.params.model, {
        modelId: "GLM-5.3",
        options: { reasoningLevel: "high" },
        providerId: CODING_PLAN_PROVIDER,
      });
      if (continueSession) {
        assert.equal(result.initialResultModel, `${CODING_PLAN_PROVIDER}/GLM-5.3`);
      }
    } finally {
      await h.destroy();
    }
  });
}

test("unknown short-name effort fails before TUI startup and never sets a model", async () => {
  const h = await startAttachHarness([modelOption("GLM-5.3", CODING_PLAN_PROVIDER)]);
  try {
    const result = await h.runAttach("glm-5.3$unknown");
    assert.equal(result.exitCode, 1);
    assert.equal(result.initialModel, undefined);
    assert.match(result.stderr, /--model: Select a supported reasoning effort/);
    assert.equal(h.coreRequests.some((request) => request.method === "session/setModel"), false);
  } finally {
    await h.destroy();
  }
});

test("create 路径：$effort 后缀透传档位", async () => {
  const h = await startAttachHarness(
    [
      modelOption("glm-5.3", "zai", {
        defaultLevel: "max",
        levels: [
          { label: "max", value: "max" },
          { label: "high", value: "high" },
        ],
      }),
      modelOption("glm-4.6"),
    ],
  );
  try {
    const result = await h.runAttach("zai/glm-5.3$high");
    assert.equal(result.exitCode, 0, result.stderr);
    const setModel = h.coreRequests.find((r) => r.method === "session/setModel");
    assert.equal(
      (setModel?.params.model as { options?: { reasoningLevel?: string } }).options
        ?.reasoningLevel,
      "high",
    );
  } finally {
    await h.destroy();
  }
});

test("resume 路径：-c --model 对恢复的会话应用 setModel", async () => {
  const h = await startAttachHarness();
  try {
    const result = await h.runAttach("glm-5.3", { continueSession: true });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(h.coreRequests.some((r) => r.method === "session/resume"));
    const setModel = h.coreRequests.find((r) => r.method === "session/setModel");
    assert.deepEqual(setModel?.params.model, {
      modelId: "glm-5.3",
      options: { reasoningLevel: "max" },
      providerId: "zai",
    });
    // resume 分支的 initialResult.model 也要反映切换后的模型。
    assert.equal(result.initialResultModel, "zai/glm-5.3");
  } finally {
    await h.destroy();
  }
});

test("未知模型：TUI 接管前退出码 1，stderr 列出可用 ref", async () => {
  const h = await startAttachHarness();
  try {
    const result = await h.runAttach("nope");
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--model: "nope" is not available/);
    assert.match(result.stderr, /zai\/glm-5\.3/);
  } finally {
    await h.destroy();
  }
});

test("空值 --model：报错退出", async () => {
  const h = await startAttachHarness();
  try {
    const result = await h.runAttach("  ");
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /--model requires a non-empty value/);
  } finally {
    await h.destroy();
  }
});

// ── 压缩窗口上限（GLM → 262K，跟随当前模型） ──

const capRequests = (requests: Captured[]) =>
  requests
    .filter((r) => r.method === "session/setCompactContextWindow")
    .map((r) => r.params.compactContextWindow);

test("压缩上限谓词：GLM 家族大小写不敏感，非 GLM 不设", () => {
  assert.equal(GLM_COMPACT_CONTEXT_WINDOW, 262_000);
  for (const id of ["GLM-5.3", "GLM-5.3-Flash", "glm-5.3", "glm-4.6"]) {
    assert.equal(isGlmModelId(id), true, id);
    assert.equal(resolveCompactContextWindowForModel(id), 262_000, id);
  }
  for (const id of ["claude-sonnet-4", "gpt-5", "my-glm-fork", "", undefined]) {
    assert.equal(isGlmModelId(id), false, String(id));
    assert.equal(resolveCompactContextWindowForModel(id), undefined, String(id));
  }
});

test("create 路径：GLM 当前模型 → 下发 262000", async () => {
  const h = await startAttachHarness(undefined, "GLM-5.3");
  try {
    const result = await h.runAttach();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(capRequests(h.coreRequests), [262_000]);
    assert.equal(
      h.coreRequests.find((r) => r.method === "session/setCompactContextWindow")?.params
        .sessionId,
      SID,
    );
  } finally {
    await h.destroy();
  }
});

test("create 路径：非 GLM 当前模型 → 显式清除（null），不下发数值", async () => {
  const h = await startAttachHarness(
    [modelOption("claude-sonnet-4"), modelOption("glm-5.3")],
    "claude-sonnet-4",
  );
  try {
    const result = await h.runAttach();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(capRequests(h.coreRequests), [null]);
  } finally {
    await h.destroy();
  }
});

test("resume 路径：恢复会话后按其当前模型下发", async () => {
  const h = await startAttachHarness(undefined, "glm-5.3");
  try {
    const result = await h.runAttach(undefined, { continueSession: true });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(h.coreRequests.some((r) => r.method === "session/resume"));
    assert.deepEqual(capRequests(h.coreRequests), [262_000]);
  } finally {
    await h.destroy();
  }
});

test("--model 切到非 GLM：setModel 之后重算为 null；仅同步一次", async () => {
  const h = await startAttachHarness(
    [modelOption("claude-sonnet-4"), modelOption("glm-5.3")],
    "glm-5.3",
  );
  try {
    const result = await h.runAttach("zai/claude-sonnet-4");
    assert.equal(result.exitCode, 0, result.stderr);
    const methods = h.coreRequests.map((r) => r.method);
    assert.ok(
      methods.indexOf("session/setCompactContextWindow") > methods.indexOf("session/setModel"),
      "cap must be recomputed after the model switch",
    );
    assert.deepEqual(capRequests(h.coreRequests), [null]);
  } finally {
    await h.destroy();
  }
});

test("--model 切到 GLM：setModel 之后下发 262000", async () => {
  const h = await startAttachHarness(
    [modelOption("claude-sonnet-4"), modelOption("glm-5.3")],
    "claude-sonnet-4",
  );
  try {
    const result = await h.runAttach("zai/glm-5.3");
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(capRequests(h.coreRequests), [262_000]);
  } finally {
    await h.destroy();
  }
});

// ── run：--model 作用域（仅 tui --shared-core） ──

function scopeHarness(argv: string[]) {
  let stderr = "";
  const ctx: RunContext = {
    argv,
    stdin: { isTTY: true } as NodeJS.ReadStream,
    stdout: {
      isTTY: true,
      write: () => true,
    } as unknown as NodeJS.WriteStream,
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    } as unknown as NodeJS.WriteStream,
  };
  const deps = {
    skipUserConfig: true,
    env: {},
    loadDotenv: () => ({ keys: [], loaded: false }),
    resolveLatestSession: async () => ({ id: "sess_model" }) as never,
    resolveWorkspaceGitBranch: async () => undefined,
    listCustomCommands: async () => ({ commands: [], diagnostics: [] }),
    runTui: async () => 0,
  } as never;
  return { ctx, deps, stderr: () => stderr };
}

test("run：--model 不能用于 monolith tui（无 --shared-core）", async () => {
  const h = scopeHarness(["tui", "--model", "zai/glm-5.3"]);
  assert.equal(await run(h.ctx, h.deps), 1);
  assert.match(h.stderr(), /--model can only be used with tui --shared-core/);
});

test("run：--model 不能与 --prompt 组合", async () => {
  const h = scopeHarness(["--prompt", "hi", "--shared-core", "--model", "zai/glm-5.3"]);
  assert.equal(await run(h.ctx, h.deps), 1);
  assert.match(h.stderr(), /--model can only be used with tui --shared-core/);
});

test("run：--model 不能用于非 tui 命令", async () => {
  const h = scopeHarness(["--model", "zai/glm-5.3"]);
  assert.equal(await run(h.ctx, h.deps), 1);
  assert.match(h.stderr(), /--model can only be used with tui --shared-core/);
});

// ── --workflow-mode：attach 车道会话级灰度 ──
// attach 车道（zcode-attach/piz、zcode attach、tui --shared-core）没有 Host
// 下发 mode，进程旗标的解析值必须随 session/create 与每次 session/resume 下发，
// 服务端按参数优先裁决（launch.md「The standalone CLI: `--workflow-mode`」）。
// 不能走 workspace/updateDynamicWorkflowPolicy：单 core 跨 workspace/客户端共享，
// 进程级偏好会被别的 pane 覆盖或泄漏。旗标缺席 = 两键都不下发（fail-closed 不变）。

test("workflowModeSessionParams：disabled 不发参数，其余 mode 显式携带两键", () => {
  assert.deepEqual(workflowModeSessionParams("disabled"), {});
  assert.deepEqual(workflowModeSessionParams("onDemand"), {
    dynamicWorkflowEnabled: true,
    dynamicWorkflowMode: "onDemand",
  });
  assert.deepEqual(workflowModeSessionParams("alwaysOn"), {
    dynamicWorkflowEnabled: true,
    dynamicWorkflowMode: "alwaysOn",
  });
});

test("zcode-attach 解析 --workflow-mode 并校验取值", () => {
  assert.equal(
    parseAttachEntryArgs(["--workflow-mode", "onDemand"]).workflowMode,
    "onDemand",
  );
  assert.equal(
    parseAttachEntryArgs(["--workflow-mode", "alwaysOn"]).workflowMode,
    "alwaysOn",
  );
  // 缺值与非法值都显式失败（与 --model/--resume 同判），不静默降级成 disabled。
  assert.throws(
    () => parseAttachEntryArgs(["--workflow-mode"]),
    /--workflow-mode requires a value/,
  );
  assert.throws(
    () => parseAttachEntryArgs(["--workflow-mode", "sometimes"]),
    /Unsupported --workflow-mode value: sometimes\. Supported modes: disabled, onDemand, alwaysOn\./,
  );
});

test("create 路径：--workflow-mode onDemand → session/create 携带灰度参数", async () => {
  const h = await startAttachHarness();
  try {
    const result = await h.runAttach(undefined, undefined, { workflowMode: "onDemand" });
    assert.equal(result.exitCode, 0, result.stderr);
    const create = h.coreRequests.find((r) => r.method === "session/create");
    assert.ok(create, "session/create request was sent");
    assert.equal(create.params.dynamicWorkflowEnabled, true);
    assert.equal(create.params.dynamicWorkflowMode, "onDemand");
  } finally {
    await h.destroy();
  }
});

test("resume 路径：onDemand + 启动恢复目标 → session/resume 携带灰度参数", async () => {
  const h = await startAttachHarness();
  try {
    const result = await h.runAttach(
      undefined,
      { continueSession: true },
      { workflowMode: "onDemand" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const resumes = h.coreRequests.filter((r) => r.method === "session/resume");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0]?.params.dynamicWorkflowEnabled, true);
    assert.equal(resumes[0]?.params.dynamicWorkflowMode, "onDemand");
    assert.equal(h.coreRequests.some((r) => r.method === "session/create"), false);
  } finally {
    await h.destroy();
  }
});

test("旗标缺席或显式 disabled：create 与 resume 都不携带灰度键", async () => {
  const h = await startAttachHarness();
  try {
    assert.equal((await h.runAttach()).exitCode, 0);
    const create = h.coreRequests.find((r) => r.method === "session/create");
    assert.ok(create, "session/create request was sent");
    assert.equal("dynamicWorkflowEnabled" in create.params, false);
    assert.equal("dynamicWorkflowMode" in create.params, false);
  } finally {
    await h.destroy();
  }
  const h2 = await startAttachHarness();
  try {
    const result = await h2.runAttach(
      undefined,
      { continueSession: true },
      { workflowMode: "disabled" },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const resume = h2.coreRequests.find((r) => r.method === "session/resume");
    assert.ok(resume, "session/resume request was sent");
    assert.equal("dynamicWorkflowEnabled" in resume.params, false);
    assert.equal("dynamicWorkflowMode" in resume.params, false);
  } finally {
    await h2.destroy();
  }
});

test("/new 与 /resume <id>：onDemand 下新会话请求携带同一灰度参数", async () => {
  const h = await startAttachHarness();
  try {
    const result = await h.runAttach(undefined, undefined, {
      submitInsideTui: ["/new", "/resume sess-1"],
      workflowMode: "onDemand",
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const creates = h.coreRequests.filter((r) => r.method === "session/create");
    assert.equal(creates.length, 2, "startup create + /new create");
    for (const call of creates) {
      assert.equal(call.params.dynamicWorkflowEnabled, true);
      assert.equal(call.params.dynamicWorkflowMode, "onDemand");
    }
    const resumes = h.coreRequests.filter((r) => r.method === "session/resume");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0]?.params.sessionId, SID);
    assert.equal(resumes[0]?.params.dynamicWorkflowEnabled, true);
    assert.equal(resumes[0]?.params.dynamicWorkflowMode, "onDemand");
  } finally {
    await h.destroy();
  }
});
