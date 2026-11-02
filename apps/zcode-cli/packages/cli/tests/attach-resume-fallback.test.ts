import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ZCODE_PROTOCOL_VERSION } from "@zcode/shared";
import type { RunContext } from "@zcode/shared-types";
import { runAttachCommand } from "../src/attach/attach-command.js";

/**
 * 显式 resume 意图的失败必须浮出（stderr + exit 1），不得静默回退
 * session/create（docs/design/v2/tui-attach-shared-core.md「会话选择」）。
 * 回归来源：截断 id `--resume sess_99f180d5` 曾被 `.catch(() => undefined)`
 * 吞掉 not-found，无声开出空新会话（2026-10-24）。
 */

const FULL_ID = "sess_99f180d5-a07d-4424-87d7-5dda4402a881";
const PREFIX = "sess_99f180d5";

function makeSnapshot(sessionId: string, messages: unknown[] = []) {
  return {
    messages,
    projection: {
      activeToolCalls: [],
      backgroundJobs: [],
      contextUsed: 0,
      contextWindow: 200_000,
      mode: "build",
      pendingPermissions: [],
      sessionId,
      status: "idle",
      totalTokenCount: 0,
      turnCount: 0,
    },
    protocol: { name: "ZCode Protocol", version: ZCODE_PROTOCOL_VERSION },
    runtime: { eventSeq: 0, pendingRequestIds: [], stateRevision: 0 },
    session: {
      createdAt: 1_700_000_000_000,
      mode: "build",
      sessionId,
      sessionKind: "interactive",
      status: "idle",
      title: "attach resume test",
      traceId: "trace-1",
      updatedAt: 1_700_000_000_000,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    },
    settings: {
      mode: { current: "build" },
      model: { available: [], current: { modelId: "glm-4.6", providerId: "zai" } },
      thoughtLevel: { available: [], current: "medium", enabled: true },
    },
  };
}

type Captured = { method: string; params: Record<string, unknown> };

/** 假 core：同 attach-model-option.test.ts 的 harness 形状。 */
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
        // 同步 throw 也必须落进 error 应答：直接调 responder 会让异常
        // 逃出 data handler（未处理 Error 事件 + 请求永不应答）。
        Promise.resolve()
          .then(() => responder(request))
          .then((value) =>
            socket.write(`${JSON.stringify({ id: message.id, result: value ?? {} })}\n`),
          )
          .catch((error: Error) =>
            socket.write(
              `${JSON.stringify({ error: { code: -32004, message: error.message }, id: message.id })}\n`,
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

interface Harness {
  coreRequests: Captured[];
  destroy: () => Promise<void>;
  runAttach: (resume: { continueSession?: boolean; resumeSessionId?: string }) => Promise<{
    exitCode: number;
    restoredCount: number | undefined;
    stderr: string;
  }>;
}

async function startHarness(
  responder: (request: Captured) => unknown,
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "attach-resume-"));
  const workspace = join(dir, "workspace");
  const { resolveSocketPath } = await import("../src/app-server-spawn.js");
  const socketPath = resolveSocketPath(
    { workspacePath: workspace },
    { env: { ZCODE_DATA_BASE_DIR: dir } },
  );
  await mkdir(dirname(socketPath), { recursive: true });
  const core = await startFakeCore(socketPath, responder);
  const runAttach = (resume: { continueSession?: boolean; resumeSessionId?: string }) => {
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
        return 0;
      },
    } as never;
    return runAttachCommand(
      ctx,
      {} as never,
      deps,
      "0.0.0-test",
      "pi",
      { continueSession: resume.continueSession === true, resumeSessionId: resume.resumeSessionId },
    ).then((exitCode) => {
      const initialResult = tuiOptions?.initialResult as
        | { restoredMessages?: unknown[] }
        | undefined;
      return {
        exitCode,
        restoredCount: initialResult?.restoredMessages?.length,
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

test("--resume <unique prefix> resumes the full id and replays restoredMessages", async () => {
  const harness = await startHarness((request) => {
    if (request.method === "session/list") {
      return { sessions: [{ sessionId: FULL_ID, updatedAt: 20 }] };
    }
    if (request.method === "session/resume") {
      if (request.params.sessionId !== FULL_ID) {
        throw new Error(`Session not found: ${String(request.params.sessionId)}`);
      }
      return makeSnapshot(FULL_ID, [
        {
          info: {
            agent: "main",
            messageId: "m1",
            role: "user",
            sessionId: FULL_ID,
            time: { created: 1 },
          },
          parts: [
            {
              messageId: "m1",
              partId: "p1",
              sessionId: FULL_ID,
              text: "hello restore",
              type: "text",
            },
          ],
        },
      ]);
    }
    if (request.method === "session/create") {
      throw new Error("silent create must not happen");
    }
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: FULL_ID };
    }
    return {};
  });
  try {
    const result = await harness.runAttach({ resumeSessionId: PREFIX });
    assert.equal(result.exitCode, 0);
    assert.equal(result.restoredCount, 1, "restoredMessages must carry the transcript");
    const resumeCalls = harness.coreRequests.filter((r) => r.method === "session/resume");
    assert.equal(resumeCalls.length, 1);
    assert.equal(resumeCalls[0].params.sessionId, FULL_ID, "prefix must expand to full id");
    assert.equal(
      harness.coreRequests.some((r) => r.method === "session/create"),
      false,
      "successful resume must not create a new session",
    );
  } finally {
    await harness.destroy();
  }
});

test("--resume <unknown id> surfaces the core error instead of silently creating", async () => {
  const harness = await startHarness((request) => {
    if (request.method === "session/list") return { sessions: [] };
    if (request.method === "session/resume") {
      throw new Error(`Session not found: ${String(request.params.sessionId)}`);
    }
    if (request.method === "session/create") {
      throw new Error("silent create must not happen");
    }
    return {};
  });
  try {
    const result = await harness.runAttach({ resumeSessionId: "sess_missing" });
    assert.equal(result.exitCode, 1, "explicit resume failure must exit non-zero");
    assert.match(result.stderr, /Session not found: sess_missing/);
    assert.equal(
      harness.coreRequests.some((r) => r.method === "session/create"),
      false,
      "failed explicit resume must not fall back to session/create",
    );
  } finally {
    await harness.destroy();
  }
});

test("-c with no sessions errors instead of silently creating", async () => {
  const harness = await startHarness((request) => {
    if (request.method === "session/list") return { sessions: [] };
    if (request.method === "session/create") {
      throw new Error("silent create must not happen");
    }
    return {};
  });
  try {
    const result = await harness.runAttach({ continueSession: true });
    assert.equal(result.exitCode, 1, "-c with no sessions must exit non-zero");
    assert.match(result.stderr, /No resumable session found for /);
    assert.equal(
      harness.coreRequests.some((r) => r.method === "session/create"),
      false,
      "-c with no sessions must not silently create",
    );
  } finally {
    await harness.destroy();
  }
});

test("no resume intent still creates a new session", async () => {
  const harness = await startHarness((request) => {
    if (request.method === "session/list") {
      throw new Error("no intent must not list");
    }
    if (request.method === "session/create") return makeSnapshot("sess-created");
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: "sess-created" };
    }
    return {};
  });
  try {
    const result = await harness.runAttach({});
    assert.equal(result.exitCode, 0);
    assert.equal(result.restoredCount, undefined, "fresh session has no restoredMessages");
    assert.ok(harness.coreRequests.some((r) => r.method === "session/create"));
  } finally {
    await harness.destroy();
  }
});
