import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ZCODE_PROTOCOL_VERSION } from "@zcode/shared";
import type { RunContext } from "@zcode/shared-types";
import { formatExitResumeHint, runAttachCommand } from "../src/attach/attach-command.js";

/**
 * 退出续接提示（docs/design/v2/tui-attach-shared-core.md「退出续接提示」）：
 * attach 客户端正常退出后，stdout 打两行可执行的恢复指引。命令名跟随入口
 * （zcode-attach → `piz`，monolith attach → `zcode attach`），会话 id 跟随
 * /new /resume /fork 换绑后的当前绑定，非 0 退出（non-TTY 拒绝等）不打。
 */

const FIRST_ID = "sess_exit_hint_first";
const SECOND_ID = "sess_exit_hint_second";

function makeSnapshot(sessionId: string) {
  return {
    messages: [],
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
      title: "attach exit hint test",
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

/** 假 core：同 attach-resume-fallback.test.ts 的 harness 形状。 */
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

interface AttachOptions {
  attachHerdrAgent?: "piz";
  /** 假 runTui 的返回码：0 = 正常退出，1 = 模拟 non-TTY 拒绝。 */
  runTuiResult?: number;
  /** 假 runTui 拿到控制权后先提交的输入（如 "/new"），验证提示跟随换绑。 */
  submitInsideTui?: string;
  /** 假 stdout 标记为 TTY：OSC 7501 reporter 只在 piz 入口 + TTY 激活。 */
  stdoutIsTTY?: boolean;
}

async function startHarness(): Promise<{
  coreRequests: Captured[];
  runAttach: (options?: AttachOptions) => Promise<{ exitCode: number; stdout: string }>;
  destroy: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "attach-exit-hint-"));
  const workspace = join(dir, "workspace");
  const { resolveSocketPath } = await import("../src/app-server-spawn.js");
  const socketPath = resolveSocketPath(
    { workspacePath: workspace },
    { env: { ZCODE_DATA_BASE_DIR: dir } },
  );
  await mkdir(dirname(socketPath), { recursive: true });
  let creates = 0;
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/create") {
      creates += 1;
      return makeSnapshot(creates === 1 ? FIRST_ID : SECOND_ID);
    }
    if (request.method === "session/subscribe") {
      return {
        eventSeq: 0,
        events: [],
        rawEvents: [],
        sessionId: String(request.params.sessionId ?? FIRST_ID),
      };
    }
    return {};
  });
  const runAttach = async (options: AttachOptions = {}) => {
    const stdoutChunks: string[] = [];
    const ctx = {
      argv: [],
      stderr: { write: () => true } as never,
      stdin: process.stdin,
      stdout: {
        ...(options.stdoutIsTTY ? { isTTY: true } : {}),
        write: (chunk: string) => {
          stdoutChunks.push(chunk);
          return true;
        },
      } as never,
    } as RunContext;
    const deps = {
      cwd: () => workspace,
      // 环境隔离：herdr 三件套显式置空（缺任一体 reporter 即不激活），
      // 不随跑测试者的 shell 环境漂移。
      env: {
        ...process.env,
        ZCODE_DATA_BASE_DIR: dir,
        HERDR_ENV: "",
        HERDR_PANE_ID: "",
        HERDR_BIN_PATH: "",
      },
      resolveWorkspaceGitBranch: async () => undefined,
      runTui: async (tuiOptions: Record<string, unknown>) => {
        if (options.submitInsideTui) {
          await (tuiOptions.submitPrompt as (input: string) => Promise<unknown>)(
            options.submitInsideTui,
          );
        }
        return options.runTuiResult ?? 0;
      },
    } as never;
    const exitCode = await runAttachCommand(
      ctx,
      {} as never,
      deps,
      "0.0.0-test",
      "pi",
      undefined,
      undefined,
      options.attachHerdrAgent,
    );
    return { exitCode, stdout: stdoutChunks.join("") };
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

test("piz 入口：空新会话正常退出也打两行 piz --resume 指引（恒定可预测）", async () => {
  const harness = await startHarness();
  try {
    const result = await harness.runAttach({ attachHerdrAgent: "piz" });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, formatExitResumeHint("piz", FIRST_ID));
    assert.equal(result.stdout, `Resume this session with:\npiz --resume ${FIRST_ID}\n`);
  } finally {
    await harness.destroy();
  }
});

test("monolith attach 入口：命令名 zcode attach", async () => {
  const harness = await startHarness();
  try {
    const result = await harness.runAttach();
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `Resume this session with:\nzcode attach --resume ${FIRST_ID}\n`);
  } finally {
    await harness.destroy();
  }
});

test("非 0 退出（non-TTY 拒绝等）不打提示", async () => {
  const harness = await startHarness();
  try {
    const result = await harness.runAttach({ attachHerdrAgent: "piz", runTuiResult: 1 });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
  } finally {
    await harness.destroy();
  }
});

test("/new 换绑后提示跟随新会话 id，不是启动快照的旧 id", async () => {
  const harness = await startHarness();
  try {
    const result = await harness.runAttach({
      attachHerdrAgent: "piz",
      submitInsideTui: "/new",
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `Resume this session with:\npiz --resume ${SECOND_ID}\n`);
    const creates = harness.coreRequests.filter((r) => r.method === "session/create");
    assert.equal(creates.length, 2, "/new must create the second session core-side");
  } finally {
    await harness.destroy();
  }
});

// ── OSC 7501 程序状态上报接线（spec「OSC 7501 程序状态上报」）──
// piz 入口 + TTY：绑定 idle 与退出 idle 两条带内序列，退出序列先于续接提示；
// monolith 入口或非 TTY：零 OSC 字节。

const OSC_IDLE = "\u001b]7501;state=idle:app=piz\u001b\\";

test("piz 入口 + TTY：绑定与退出各发一条 OSC 7501 idle，且先于续接提示", async () => {
  const harness = await startHarness();
  try {
    const result = await harness.runAttach({
      attachHerdrAgent: "piz",
      stdoutIsTTY: true,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(
      result.stdout,
      `${OSC_IDLE}${OSC_IDLE}${formatExitResumeHint("piz", FIRST_ID)}`,
    );
  } finally {
    await harness.destroy();
  }
});

test("OSC 7501 门：monolith 入口（TTY）与非 TTY（piz 入口）都零字节", async () => {
  const harness = await startHarness();
  try {
    const monolith = await harness.runAttach({ stdoutIsTTY: true });
    assert.equal(monolith.exitCode, 0);
    assert.ok(!monolith.stdout.includes("\u001b]7501;"), "monolith must not emit OSC 7501");

    const piped = await harness.runAttach({ attachHerdrAgent: "piz" });
    assert.equal(piped.exitCode, 0);
    assert.ok(!piped.stdout.includes("\u001b]7501;"), "non-TTY stdout must not emit OSC 7501");
    // 同一 harness 内两次 runAttach 共享 create 计数，id 不定；只钉形状。
    assert.match(piped.stdout, /^Resume this session with:\npiz --resume sess_exit_hint_\w+\n$/);
  } finally {
    await harness.destroy();
  }
});
