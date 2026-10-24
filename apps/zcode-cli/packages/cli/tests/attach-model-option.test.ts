import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ZCODE_PROTOCOL_VERSION, type ZCodeModelOption } from "@zcode/shared";
import type { RunContext } from "@zcode/shared-types";
import { run } from "../src/run.js";
import {
  runAttachCommand,
  resolveInitialModelRef,
} from "../src/attach/attach-command.js";
import { parseAttachEntryArgs } from "../src/attach/attach-entry-args.js";

/**
 * `--model` 启动模型选择（docs/design/v2/tui-attach-shared-core.md
 * 「启动模型选择」）：作用域仅 tui --shared-core（attach/piz）；应用点在
 * 会话物化后经既有 session/setModel 链路；bare id 目录唯一命中时补全
 * provider；未知/多命中在 TUI 接管前以 stderr 报错退出。
 */

const SID = "sess-1";

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
        current: { modelId: currentModelId, providerId: "zai" },
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
  runAttach: (initialModel?: string, resume?: { continueSession?: boolean }) => Promise<{
    exitCode: number;
    initialModel?: string;
    initialResultModel?: string;
    stderr: string;
  }>;
}

/** runAttachCommand + 假 core：默认走 session/create 新会话路径。 */
async function startAttachHarness(
  available?: ZCodeModelOption[],
): Promise<AttachHarness> {
  const dir = await mkdtemp(join(tmpdir(), "attach-model-"));
  const workspace = join(dir, "workspace");
  const { resolveSocketPath } = await import("../src/app-server-spawn.js");
  const socketPath = resolveSocketPath(
    { workspacePath: workspace },
    { env: { ZCODE_DATA_BASE_DIR: dir } },
  );
  await mkdir(dirname(socketPath), { recursive: true });
  let currentModelId = "glm-4.6";
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/create") return makeSnapshot(currentModelId, available);
    if (request.method === "session/resume") return makeSnapshot(currentModelId, available);
    if (request.method === "session/list") {
      return { sessions: [{ sessionId: SID, updatedAt: 42 }] };
    }
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/setModel") {
      currentModelId = (request.params.model as { modelId: string }).modelId;
      return makeSnapshot(currentModelId, available);
    }
    if (request.method === "runtime/capabilities") return {};
    return {};
  });
  const runAttach = (
    initialModel?: string,
    resume?: { continueSession?: boolean },
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
      stdout: process.stdout,
    } as RunContext;
    let tuiOptions: Record<string, unknown> | undefined;
    const deps = {
      cwd: () => workspace,
      env: { ...process.env, ZCODE_DATA_BASE_DIR: dir },
      resolveWorkspaceGitBranch: async () => undefined,
      runTui: async (options: Record<string, unknown>) => {
        tuiOptions = options;
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

test("完整 ref 与 $effort 后缀原样透传", () => {
  const available = [modelOption("glm-5.3")];
  assert.equal(resolveInitialModelRef("zai/glm-5.3", available), "zai/glm-5.3");
  assert.equal(resolveInitialModelRef("zai/glm-5.3$high", available), "zai/glm-5.3$high");
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
  const h = await startAttachHarness();
  try {
    const result = await h.runAttach("glm-5.3");
    assert.equal(result.exitCode, 0, result.stderr);
    const setModel = h.coreRequests.find((r) => r.method === "session/setModel");
    assert.deepEqual(setModel?.params.model, {
      modelId: "glm-5.3",
      options: { reasoningLevel: "max" },
      providerId: "zai",
    });
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
