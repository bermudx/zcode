import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ZCODE_PROTOCOL_VERSION, zcodeProtocolErrorCodes } from "@zcode/shared";
import { getZCodeCopy } from "@zcode/i18n";
import { connectAttachClient } from "../src/attach/attach-client.js";
import { AttachSessionHandle } from "../src/attach/attach-session.js";
import {
  AttachRuntime,
  createAttachPromptHandler,
} from "../src/attach/attach-tui-options.js";

const SID = "sess-1";

/** 真实 server 的 catalog 项形状（实测 session/create 回包）：身份在 ref 里，
 *  元数据是 label/providerLabel/reasoning/properties。 */
const modelOption = (modelId: string, providerId = "zai") => ({
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
  reasoning: { defaultLevel: "max", levels: [{ label: "max", value: "max" }] },
  ref: { modelId, providerId },
});

function makeSnapshot(version: number = ZCODE_PROTOCOL_VERSION) {
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
    protocol: { name: "ZCode Protocol", version },
    runtime: { eventSeq: 0, pendingRequestIds: [], stateRevision: 0 },
    session: {
      createdAt: 1_700_000_000_000,
      mode: "build",
      sessionId: SID,
      sessionKind: "interactive",
      status: "idle",
      title: "attach test",
      traceId: "trace-1",
      updatedAt: 1_700_000_000_000,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    },
    settings: {
      mode: { current: "build" },
      model: {
        available: [modelOption("glm-4.6"), modelOption("glm-4.7"), modelOption("glm-5.3")],
        current: { modelId: "glm-4.6", providerId: "zai" },
      },
      thoughtLevel: { available: [], current: "medium", enabled: true },
    },
  };
}

function rawEvent(params: {
  inputId?: string;
  payload?: Record<string, unknown>;
  seq: number;
  turnId?: string;
  type: string;
}) {
  return {
    id: `evt-${params.seq}`,
    payload: params.payload ?? {},
    sequenceNumber: params.seq,
    sessionId: SID,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    traceId: "trace-1",
    turnId: params.turnId,
    type: params.type,
  };
}

type Captured = { method: string; params: Record<string, unknown> };
type CapturedResponse = { error?: unknown; id: string; result?: unknown };

type FakeCore = {
  requests: Captured[];
  /** 客户端对 server 反向请求（interaction/*）的应答行。 */
  responses: CapturedResponse[];
  socketPath: string;
  notify: (params: unknown) => void;
  sendRequest: (id: string, method: string, params: unknown) => void;
  /** 原样写一行（不套 JSON 帧）：注入畸形行等传输级垃圾。 */
  raw: (line: string) => void;
  kill: () => Promise<void>;
  close: () => Promise<void>;
};

/** 假 core：按 method 路由到应答表；rawEvent 通过注入的 sender 回放。 */
async function startFakeCore(
  socketPath: string,
  responder: (request: Captured, notify: (params: unknown) => void, raw: (line: string) => void) => unknown,
): Promise<FakeCore> {
  const requests: Captured[] = [];
  const responses: CapturedResponse[] = [];
  const sockets = new Set<Socket>();
  const notify = (params: unknown): void => {
    for (const socket of sockets) {
      socket.write(`${JSON.stringify({ method: "session/rawEvent", params })}\n`);
    }
  };
  const sendRequest = (id: string, method: string, params: unknown): void => {
    for (const socket of sockets) {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    }
  };
  const raw = (line: string): void => {
    for (const socket of sockets) socket.write(line);
  };
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
        const message = JSON.parse(line) as {
          error?: unknown;
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
          result?: unknown;
        };
        // 客户端对反向请求的应答行（id + result/error，无 method）。
        if (message.method === undefined && message.id !== undefined) {
          responses.push({
            error: message.error,
            id: String(message.id),
            result: message.result,
          });
          continue;
        }
        if (!message.method || message.id === undefined) continue;
        const request: Captured = {
          method: message.method,
          params: message.params ?? {},
        };
        requests.push(request);
        const result = responder(request, notify, raw);
        Promise.resolve(result)
          .then((value) =>
            socket.write(`${JSON.stringify({ id: message.id, result: value ?? {} })}\n`),
          )
          .catch((error: Error & { code?: number; data?: unknown }) =>
            socket.write(
              `${JSON.stringify({
                error: {
                  code: typeof error.code === "number" ? error.code : -32000,
                  data: error.data,
                  message: error.message,
                },
                id: message.id,
              })}\n`,
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
    kill: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    notify,
    raw,
    requests,
    responses,
    sendRequest,
    socketPath,
  };
}

async function makeHandle(socketPath: string): Promise<{
  client: Awaited<ReturnType<typeof connectAttachClient>>;
  handle: AttachSessionHandle;
}> {
  const client = await connectAttachClient(socketPath);
  const handle = new AttachSessionHandle({
    client,
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  // 生产路径由 AttachRuntime.installClient 统一路由 rawEvent 通知；
  // 直接构造 handle 的用例需要自己接线。
  client.onNotification((method, params) => {
    if (method === "session/rawEvent") {
      handle.ingestRawEvent(params as never);
    }
  });
  return { client, handle };
}

test("subscribe 发送 raw eventFormat 且回放事件 revive 为 Date", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return {
        eventSeq: 2,
        events: [],
        rawEvents: [rawEvent({ seq: 1, type: "session_created" })],
        sessionId: SID,
      };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  const received: unknown[] = [];
  handle.addSink((event) => received.push(event));
  try {
    await handle.subscribe();
    const subscribe = core.requests.find((r) => r.method === "session/subscribe");
    assert.equal(subscribe?.params.eventFormat, "raw");
    assert.equal(subscribe?.params.deliveryKind, "desktop-continuous");
    assert.equal(received.length, 1);
    const event = received[0] as { timestamp: unknown; type: string };
    assert.ok(event.timestamp instanceof Date);
    assert.equal(event.type, "session_created");
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("submitPrompt → session/send，turn_complete 事件解析出响应", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], sessionId: SID };
    }
    if (request.method === "session/send") {
      const inputId = request.params.inputId as string;
      queueMicrotask(() => {
        notify(
          rawEvent({
            inputId,
            payload: { inputId, input: "hi", turnNumber: 1 },
            seq: 1,
            turnId: "turn-1",
            type: "turn_started",
          }),
        );
        notify(
          rawEvent({
            payload: { response: "hello back", resultType: "completed" },
            seq: 2,
            turnId: "turn-1",
            type: "turn_complete",
          }),
        );
      });
      return { accepted: true, sessionId: SID, stateRevision: 1 };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    await handle.subscribe();
    const result = await handle.submitPrompt("hi");
    const send = core.requests.find((r) => r.method === "session/send");
    assert.equal(send?.params.sessionId, SID);
    assert.equal(send?.params.content, "hi");
    assert.equal(result.response, "hello back");
    assert.equal(result.turnId, "turn-1");
    assert.equal(result.sessionId, SID);
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 回归证据（P004-F1，2026-10-26 评审）：submitPrompt 曾把 per-turn onEvent
// 挂进常驻 sinks 且从不摘除——每回合泄漏一个闭包，后续每条事件都扇出到全部
// 陈旧 onEvent（O(turns)/事件，直到句柄被 /new //resume 换掉）。与 monolith
// 对齐（prompt-command.ts 的 finally 摘除）：回合 settle / 发送失败即摘除
// 本轮 onEvent；回合外事件只属于常驻订阅（subscribeSessionEvents）。
test("submitPrompt 的 per-turn onEvent 回合结束即摘除：不随回合累积、无陈旧回调", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  let turn = 0;
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/send") {
      const inputId = request.params.inputId as string;
      turn += 1;
      const turnId = `turn-${turn}`;
      queueMicrotask(() => {
        notify(
          rawEvent({
            inputId,
            payload: { inputId, input: `p-${turn}`, turnNumber: turn },
            seq: turn * 2 - 1,
            turnId,
            type: "turn_started",
          }),
        );
        notify(
          rawEvent({
            payload: { response: `r-${turn}`, resultType: "completed" },
            seq: turn * 2,
            turnId,
            type: "turn_complete",
          }),
        );
      });
      return { accepted: true, sessionId: SID, stateRevision: turn };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  const firstEvents: string[] = [];
  const secondEvents: string[] = [];
  try {
    const first = await handle.submitPrompt("one", {
      onEvent: (event) => {
        firstEvents.push(event.type);
      },
    });
    const second = await handle.submitPrompt("two", {
      onEvent: (event) => {
        secondEvents.push(event.type);
      },
    });
    assert.equal(first.response, "r-1");
    assert.equal(second.response, "r-2");
    // 第二回合的事件只到达第二回合的 onEvent：第一回合的陈旧回调不得再触发。
    assert.deepEqual(
      firstEvents,
      ["turn_started", "turn_complete"],
      "first-turn onEvent must not observe the second turn",
    );
    assert.deepEqual(secondEvents, ["turn_started", "turn_complete"]);
    // 回合外事件：per-turn onEvent 都已摘除，一个都不触发（常驻订阅另有其主）。
    handle.ingestRawEvent(rawEvent({ seq: 9, type: "session_created" }));
    assert.equal(firstEvents.length, 2, "stale first-turn onEvent must not fire after its turn");
    assert.equal(
      secondEvents.length,
      2,
      "per-turn onEvent must not outlive its turn (monolith finally semantics)",
    );
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// P004-F1 的发送失败路径：session/send 被拒时 per-turn onEvent 同样要摘除。
test("submitPrompt 发送失败后 per-turn onEvent 即摘除", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/send") {
      // 拒绝以 rejected promise 返回：同步 throw 会逃出 socket data handler。
      return Promise.reject(Object.assign(new Error("core rejected"), { code: -32000 }));
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  const events: string[] = [];
  try {
    await assert.rejects(handle.submitPrompt("boom", {
      onEvent: (event) => {
        events.push(event.type);
      },
    }), /core rejected/);
    handle.ingestRawEvent(rawEvent({ seq: 9, type: "session_created" }));
    assert.equal(events.length, 0, "onEvent must be detached after session/send failure");
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("recallPreviousInput → session/recallPreviousInput", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/recallPreviousInput") {
      return { entry: { text: "previous prompt" } };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    const entry = await handle.recallPreviousInputHistory(1);
    const recall = core.requests.find(
      (r) => r.method === "session/recallPreviousInput",
    );
    assert.equal(recall?.params.skip, 1);
    assert.equal(entry?.text, "previous prompt");
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// readUsageQuota → usage/codingPlanQuota：协议面客户端用共享 schema 严格收
// （不再 cast）；外部监控 wire 的容错规整在 core 侧 parseCodingPlanQuotaEnvelope。
test("readUsageQuota → usage/codingPlanQuota parses the protocol result strictly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "usage/codingPlanQuota") {
      return {
        level: "glm-coding-plan",
        limits: [
          {
            type: "TOKENS_LIMIT",
            usage: 100,
            usageDetails: [{ modelCode: "glm-5.3-flash", usage: 100 }],
          },
        ],
      };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    const snapshot = await handle.readUsageQuota();
    const quota = core.requests.find((r) => r.method === "usage/codingPlanQuota");
    assert.equal(quota?.params.sessionId, SID);
    assert.equal(snapshot.level, "glm-coding-plan");
    assert.equal(snapshot.limits[0]?.type, "TOKENS_LIMIT");
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("readUsageQuota fails loudly on protocol drift instead of casting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "usage/codingPlanQuota") {
      // 外部 wire 的形状（usageDetails 可缺席）不允许出现在协议面：
      // core 侧负责兜底成共享形状，客户端遇漂移必须显式失败。
      return { level: null, limits: [{ type: "TOKENS_LIMIT" }] };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    await assert.rejects(handle.readUsageQuota(), /usageDetails/);
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 回归证据（P004-F3，2026-10-26 评审）：断线状态行曾硬编码法语（无视
// --locale）。状态文案必须走 i18n 目录：tui.connection.* 三键在全部 locale
// 文件里都有，且不同 locale 解析出各自文案。
test("断线状态文案三键在 en-US/zh-CN 目录齐全且按 locale 区分", () => {
  const en = getZCodeCopy("en-US").tui.connection;
  const zh = getZCodeCopy("zh-CN").tui.connection;
  assert.equal(en.lost, "Connection to shared core lost — reconnecting…");
  assert.equal(en.reconnected, "Reconnected to shared core");
  assert.equal(
    en.reconnectedSessionUnavailable,
    "Reconnected to shared core — session unavailable, retrying…",
  );
  assert.equal(zh.lost, "与共享 core 的连接已断开——正在重连…");
  assert.equal(zh.reconnected, "已重新连接共享 core");
  assert.equal(
    zh.reconnectedSessionUnavailable,
    "已重新连接共享 core——会话暂不可用，正在重试…",
  );
  // 键互不相同：不是同一份硬编码穿两层。
  assert.notEqual(en.lost, zh.lost);
  assert.notEqual(en.reconnected, zh.reconnected);
  assert.notEqual(en.reconnectedSessionUnavailable, zh.reconnectedSessionUnavailable);
});

// P004-F3 的发射路径：AttachRuntime 按 options.locale 从目录取状态行——
// 断线 / 重连成功 / 重连但会话不可恢复三个状态都不得再出现硬编码法语。
test("AttachRuntime 断线状态行按 locale 走 i18n 目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-status-locale-"));
  const socketPath = join(dir, "core.sock");
  const goodResponder = (request: Captured): unknown => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    return {};
  };
  // 冷 core：subscribe/resume 都回 sessionUnavailable → 会话不可恢复。
  const coldResponder = (request: Captured): unknown => {
    if (request.method === "session/subscribe") {
      return Promise.reject(
        Object.assign(new Error("session unavailable"), {
          code: zcodeProtocolErrorCodes.sessionUnavailable,
        }),
      );
    }
    if (request.method === "session/resume") {
      return Promise.reject(
        Object.assign(new Error("no such session"), {
          code: zcodeProtocolErrorCodes.sessionUnavailable,
        }),
      );
    }
    return {};
  };
  let core = await startFakeCore(socketPath, goodResponder);
  const runtime = new AttachRuntime({
    locale: "zh-CN",
    socketPath,
    workspace: { workspaceIdentity: undefined, workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
  });
  const statuses: string[] = [];
  runtime.onConnectionStatus((status) => statuses.push(status));
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  runtime.registerSession(handle);
  const firstClient = await runtime.connect();
  try {
    await core.kill();
    await firstClient.closed;
    assert.equal(statuses.at(-1), "与共享 core 的连接已断开——正在重连…");
    core = await startFakeCore(socketPath, goodResponder);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(statuses.at(-1), "已重新连接共享 core");
    await core.kill();
    await runtime.currentClient().closed;
    assert.equal(statuses.at(-1), "与共享 core 的连接已断开——正在重连…");
    core = await startFakeCore(socketPath, coldResponder);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(statuses.at(-1), "已重新连接共享 core——会话暂不可用，正在重试…");
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("断线重连后按最后 sequenceNumber 续订", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const responder = (request: Captured): unknown => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 5, events: [], rawEvents: [], sessionId: SID };
    }
    return {};
  };
  let core = await startFakeCore(socketPath, responder);
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  runtime.registerSession(handle);
  await handle.subscribe();
  // 注入一条 seq=5 的 live 事件，让 lastSeq 前进后再断线。
  core.notify(rawEvent({ seq: 5, type: "session_created" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await core.kill();
  // 等客户端感知 close 后重启 fake core。
  await client.closed;
  core = await startFakeCore(socketPath, responder);
  // 触发重连定时器第一轮（1s backoff）。
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const resubscribes = core.requests.filter((r) => r.method === "session/subscribe");
  assert.equal(resubscribes.length >= 1, true);
  assert.equal(resubscribes.at(-1)?.params.afterSeq, 5);
  await runtime.close();
  await core.close();
  await rm(dir, { force: true, recursive: true });
});

test("协议版本不匹配 → 退出码 2 与可操作错误", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-version-"));
  const workspace = join(dir, "workspace");
  const { resolveSocketPath } = await import("../src/app-server-spawn.js");
  const socketPath = resolveSocketPath(
    { workspacePath: workspace },
    { env: { ZCODE_DATA_BASE_DIR: dir } },
  );
  await (await import("node:fs/promises")).mkdir(
    (await import("node:path")).dirname(socketPath),
    { recursive: true },
  );
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/create") {
      return makeSnapshot(999);
    }
    if (request.method === "runtime/capabilities") return {};
    return {};
  });
  const { runAttachCommand } = await import("../src/attach/attach-command.js");
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
  };
  const deps = {
    cwd: () => workspace,
    env: { ...process.env, ZCODE_DATA_BASE_DIR: dir },
    runTui: async () => 0,
  } as never;
  try {
    const exitCode = await runAttachCommand(ctx, {} as never, deps, "0.0.0-test");
    assert.equal(exitCode, 2);
    assert.match(stderrChunks.join(""), /Shared core protocol v999/);
  } finally {
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 回归证据（P004-F4，2026-10-26 评审）：生产路径曾不给 connectAttachClient /
// AttachRuntime 传 logger——传输内建诊断（丢畸形行、坏协议消息、socket 错误）
// 全部 optional-chain 成 no-op，坏流静默降级。runAttachCommand 必须把（节流的）
// stderr 诊断 logger 接进两条路径。
test("runAttachCommand 给传输接 stderr 诊断：畸形行有日志、连接继续", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-transport-log-"));
  const workspace = join(dir, "workspace");
  const { resolveSocketPath } = await import("../src/app-server-spawn.js");
  const socketPath = resolveSocketPath(
    { workspacePath: workspace },
    { env: { ZCODE_DATA_BASE_DIR: dir } },
  );
  await (await import("node:fs/promises")).mkdir(
    (await import("node:path")).dirname(socketPath),
    { recursive: true },
  );
  // 第一条到达的写往连接注入一行畸形 NDJSON；正式 create 响应随后照发。
  const core = await startFakeCore(socketPath, (request, _notify, raw) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/create") {
      raw("{{{not json\n");
      return makeSnapshot();
    }
    return {};
  });
  const { runAttachCommand } = await import("../src/attach/attach-command.js");
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
  };
  const deps = {
    cwd: () => workspace,
    env: { ...process.env, ZCODE_DATA_BASE_DIR: dir },
    runTui: async () => 0,
  } as never;
  try {
    const exitCode = await runAttachCommand(ctx, {} as never, deps, "0.0.0-test");
    assert.equal(exitCode, 0);
    assert.match(
      stderrChunks.join(""),
      /attach transport: attach client dropped malformed line/,
      "malformed transport line must surface a stderr diagnostic",
    );
    // 连接继续：runTui 正常拿到控制权（exitCode 0），create 流程未被坏行打断。
  } finally {
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("sendInput 忙时本地排队，turn settle 后 drain 成第二条 session/send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  let finishFirstTurn: (() => void) | undefined;
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/send") {
      const inputId = request.params.inputId as string;
      const content = request.params.content as string;
      const turnId = `turn-${content}`;
      queueMicrotask(() => {
        notify(
          rawEvent({
            inputId,
            payload: { inputId, input: content, turnNumber: 1 },
            seq: 1,
            turnId,
            type: "turn_started",
          }),
        );
        if (content !== "first") {
          notify(
            rawEvent({
              payload: { response: `r-${content}`, resultType: "completed" },
              seq: 3,
              turnId,
              type: "turn_complete",
            }),
          );
        }
      });
      if (content === "first") {
        finishFirstTurn = () =>
          notify(
            rawEvent({
              payload: { response: "r1", resultType: "completed" },
              seq: 2,
              turnId,
              type: "turn_complete",
            }),
          );
      }
      return { accepted: true, sessionId: SID, stateRevision: 1 };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  const received: Array<{ type: string }> = [];
  handle.addSink((event) => received.push(event as { type: string }));
  try {
    await handle.subscribe();
    const first = handle.submitPrompt("first");
    // 等 turn_started 到达，pendingTurns 非空。
    await new Promise((resolve) => setTimeout(resolve, 30));
    const queued = await handle.sendInput("second");
    assert.equal(queued.kind, "queued");
    if (queued.kind === "queued") assert.equal(queued.queueLength, 1);
    assert.ok(received.some((event) => event.type === "turn_steer_queued"));
    // 忙期间没有第二条 session/send——core 只收单并发 prompt。
    assert.equal(
      core.requests.filter((r) => r.method === "session/send").length,
      1,
    );
    finishFirstTurn!();
    await first;
    // drain = microtask + 一次 session/send 往返。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sends = core.requests.filter((r) => r.method === "session/send");
    assert.equal(sends.length, 2);
    assert.equal(sends[1]?.params.content, "second");
    // 合成 drained 事件携带 drainedInputs（含原文）：重放的新回合没有本地乐观
    // user row，TUI transcript 行由 drained payload 补出（2026-10-25 live 修复）。
    const drained = received.find(
      (event) => (event as { type: string }).type === "turn_steer_drained",
    ) as { payload?: { drainedInputs?: Array<{ text?: string }> } } | undefined;
    assert.ok(drained?.payload?.drainedInputs?.some((item) => item.text === "second"));
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("stopActiveTurn 显式发 session/stop 并等回执；连接断开则尽力返回", async () => {
  // "stop & quit" 路径：abortSignal 的 fire-and-forget sessionStop 之外再显式
  // 发一次并等有界回执，保证退出前 stop 已落线。
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, () => ({}));
  const { client, handle } = await makeHandle(socketPath);
  try {
    await handle.stopActiveTurn();
    const stops = core.requests.filter((r) => r.method === "session/stop");
    assert.equal(stops.length, 1);
    assert.equal(stops[0]?.params.sessionId, SID);
    // 连接已断开时 clientOf 抛错：尽力路径必须静默返回，不阻塞退出。
    client.close();
    await handle.stopActiveTurn();
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("sendInput '/model …' 经 commandCenter → session/setModel，不发 session/send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/setModel") {
      // 真实 server 的 afterStateMutation 直接返回快照本体（无 {snapshot} 包装）；
      // fake 若只回包装形状，会掩盖 applyMutationSnapshot 漏更新的回归。
      return makeSnapshot();
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const snapshot = makeSnapshot() as {
    settings: { model: { available: unknown[] } };
  } & ReturnType<typeof makeSnapshot>;
  snapshot.settings.model.available = [
    {
      label: "glm-4.6",
      reasoning: { defaultLevel: "max", levels: [{ value: "max" }] },
      ref: { modelId: "glm-4.6", providerId: "zai" },
    },
  ];
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: snapshot as never,
  });
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    const result = await handler.sendInput!("/model zai/glm-4.6", {});
    assert.equal(result.kind, "command_result");
    // 直返快照形状下 getModel() 必须读到新模型，否则 Ctrl+P 轮换会在原地打转。
    assert.match(
      String((result.result as { model?: string }).model ?? ""),
      /glm-4\.6/,
    );
    assert.ok(
      core.requests.some((r) => r.method === "session/setModel"),
      "expected session/setModel request",
    );
    assert.ok(
      !core.requests.some((r) => r.method === "session/send"),
      "slash command must not reach session/send",
    );
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("会话中途 /model 切换：压缩上限跟随当前模型；旧 core（-32601）静默", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  let currentModelId = "glm-5.3";
  let legacyCore = false;
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/setModel") {
      currentModelId = (request.params as { model: { modelId: string } }).model.modelId;
      const snapshot = makeSnapshot() as ReturnType<typeof makeSnapshot> & {
        settings: { model: { current: unknown } };
      };
      snapshot.settings.model.current = { modelId: currentModelId, providerId: "zai" };
      return snapshot;
    }
    if (request.method === "session/setCompactContextWindow" && legacyCore) {
      return Promise.reject(Object.assign(new Error("Method not found"), { code: -32601 }));
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const snapshot = makeSnapshot() as ReturnType<typeof makeSnapshot> & {
    settings: { model: { available: unknown[]; current: unknown } };
  };
  snapshot.settings.model.current = { modelId: "glm-5.3", providerId: "zai" };
  snapshot.settings.model.available = [
    modelOption("glm-5.3"),
    modelOption("claude-sonnet-4"),
  ];
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: snapshot as never,
  });
  const caps = () =>
    core.requests
      .filter((r) => r.method === "session/setCompactContextWindow")
      .map((r) => (r.params as { compactContextWindow: unknown }).compactContextWindow);
  try {
    assert.equal(handle.getCompactContextWindow(), 262_000);
    await handle.setModel("zai/claude-sonnet-4");
    assert.equal(handle.getCompactContextWindow(), undefined);
    await handle.setModel("zai/glm-5.3");
    assert.deepEqual(caps(), [null, 262_000]);

    // 旧 core 不认识该方法：不抛、不出 notice。
    legacyCore = true;
    const notices: unknown[] = [];
    handle.addSink((event) => {
      if ((event.type as string) === "session_notice") notices.push(event);
    });
    await handle.syncCompactContextWindow();
    assert.deepEqual(notices, []);
  } finally {
    client.close();
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 回归证据（2026-10-22，`piz` 实测）：首行是绝对路径的多行输入被当成 `/home/daniel/...`
// slash 命令，只回一句 "Unknown command" —— 整段正文根本没发出去。attach 是交互式客户端，
// 解析不出来的 `/...` 必须原样按普通 prompt 提交给 core。
test("首行为绝对路径的多行输入按普通 prompt 提交，而不是回 Unknown command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/send") {
      const inputId = request.params.inputId as string;
      const content = request.params.content as string;
      const turnId = "turn-forward";
      queueMicrotask(() => {
        notify(
          rawEvent({
            inputId,
            payload: { inputId, input: content, turnNumber: 1 },
            seq: 1,
            turnId,
            type: "turn_started",
          }),
        );
        notify(
          rawEvent({
            payload: { response: `r-${content}`, resultType: "completed" },
            seq: 2,
            turnId,
            type: "turn_complete",
          }),
        );
      });
      return { accepted: true, sessionId: SID, stateRevision: 1 };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  const text = "/home/daniel/dots/pi/models.json\n\nlogfare models can change every day, give me 5 ideas";
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    const result = await handler(text, {});
    const sends = core.requests.filter((r) => r.method === "session/send");
    assert.equal(sends.length, 1, "expected exactly one session/send");
    // 原文逐字下发（含首行路径与空行）。
    assert.equal(sends[0]?.params.content, text);
    assert.equal(result.response, `r-${text}`);
    assert.equal(result.response.includes("Unknown command"), false);
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("applyStatePatch 合并 state/updated settings 并补发 ModelSelected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  try {
    const handle = new AttachSessionHandle({
      client: () => {
        throw new Error("no client needed");
      },
      sessionId: SID,
      snapshot: makeSnapshot() as never,
    });
    const events: unknown[] = [];
    handle.addSink((event) => events.push(event));
    // 初始 catalog 两项；setModel 只发 settings patch、不发 raw 事件。
    const initial = makeSnapshot() as {
      settings: { model: { available: unknown[]; current: unknown } };
    } & ReturnType<typeof makeSnapshot>;
    initial.settings.model.available = [modelOption("glm-4.6"), modelOption("glm-4.7")];
    (handle as unknown as { snapshot: unknown }).snapshot = initial;
    handle.applyStatePatch({
      // modelAvailability:"current" 过滤投影：available 只剩当前模型，不得覆盖 catalog。
      model: {
        available: [modelOption("glm-4.7")],
        current: { modelId: "glm-4.7", providerId: "zai" },
      },
    });
    assert.match(String(handle.getModel() ?? ""), /glm-4\.7/);
    const settings = (handle as unknown as { snapshot: { settings: { model: { available: unknown[] } } } })
      .snapshot.settings;
    assert.equal(settings.model.available.length, 2, "filtered available must not clobber catalog");
    assert.equal(
      events.filter((e) => (e as { type?: string }).type === "model_selected").length,
      1,
      "expected one ModelSelected sink event",
    );
    // 相同 current 再 patch：幂等，不再补发。
    handle.applyStatePatch({
      model: {
        available: [modelOption("glm-4.6")],
        current: { modelId: "glm-4.7", providerId: "zai" },
      },
    });
    assert.equal(
      events.filter((e) => (e as { type?: string }).type === "model_selected").length,
      1,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// 回归证据（2026-10-22，`piz` 实测）：/new 走 session/create + session/subscribe
// (includeSnapshot)。create 回的是完整 catalog，subscribe 回的 available 是
// `modelAvailability:"current"` 投影——只剩当前模型。整包替换句柄快照后，
// 第一次 Ctrl+P 报 "Unable to switch model: Model is not available: …"（该失败
// 回包又把 1 项列表写进 TUI store），第二次 Ctrl+P 报 "Only one model available."。
test("subscribe 的过滤快照不会把句柄的模型 catalog 缩成当前项", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const filtered = makeSnapshot() as {
    settings: { model: { available: unknown[] } };
  } & ReturnType<typeof makeSnapshot>;
  filtered.settings.model.available = [modelOption("glm-4.6")];
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID, snapshot: filtered };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    assert.equal((await handle.listModels()).length, 3);
    await handle.subscribe(undefined, true);
    const models = (await handle.listModels()) as Array<{ ref?: { modelId?: string } }>;
    assert.equal(models.length, 3, "filtered subscribe snapshot must not shrink the catalog");
    assert.ok(models.some((model) => model.ref?.modelId === "glm-5.3"));
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("/new 之后 listModelOptions 仍返回完整 catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const created = makeSnapshot() as {
    session: { sessionId: string };
    settings: { model: { available: unknown[] } };
  } & ReturnType<typeof makeSnapshot>;
  created.session = { ...created.session, sessionId: "sess-new" };
  const subscribed = makeSnapshot() as {
    session: { sessionId: string };
    settings: { model: { available: unknown[] } };
  } & ReturnType<typeof makeSnapshot>;
  subscribed.session = { ...subscribed.session, sessionId: "sess-new" };
  // server 侧订阅快照的真实形状：仅当前模型。
  subscribed.settings.model.available = [modelOption("glm-4.6")];
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/create") return created;
    if (request.method === "session/subscribe") {
      return {
        eventSeq: 0,
        events: [],
        rawEvents: [],
        sessionId: "sess-new",
        snapshot: subscribed,
      };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    const result = await handler("/new", {});
    assert.match(result.response ?? "", /Started new session/);
    const models = (await handler.listModelOptions?.()) as Array<{
      ref?: { modelId?: string };
    }>;
    assert.equal(
      models.length,
      3,
      "/new must keep the session-create catalog, not the subscribe projection",
    );
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 回归证据（2026-10-22，`piz` 实测）：TUI 附件形状 {type,path} 直接进 session/send 时，
// server 的 mapProtocolPromptAttachment 只读 kind/localPath，整条附件被静默丢弃——
// `@src/alpha.ts` 提交成功、模型却什么都没收到。协议边界必须做一次形状转换。
test("prompt 附件按 session/send 的协议形状下发（kind/localPath, kind/dataBase64）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/send") {
      const inputId = request.params.inputId as string;
      queueMicrotask(() => {
        notify(
          rawEvent({
            payload: { inputId, response: "ok" },
            seq: 2,
            turnId: "turn-attach",
            type: "turn_complete",
          }),
        );
      });
      return { accepted: true };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  // AttachRuntime 只给已注册的会话分发 session/rawEvent（生产路径由
  // createAttachPromptHandler 注册）；直接构造句柄的用例必须自己登记。
  runtime.registerSession(handle);
  try {
    const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;
    await handle.submitPrompt({
      attachments: [
        { path: "src/alpha.ts", type: "file" },
        { content: "inline text", type: "file" },
        { content: dataUrl, path: "@shot.png", type: "image" },
      ],
      text: "review @src/alpha.ts",
    });
    const send = core.requests.find((request) => request.method === "session/send");
    assert.ok(send, "expected session/send");
    assert.deepEqual(send.params.attachments, [
      { filename: "src/alpha.ts", kind: "file", localPath: "src/alpha.ts" },
      { filename: "attachment", kind: "file", textContent: "inline text" },
      {
        dataBase64: Buffer.from("png-bytes").toString("base64"),
        filename: "shot.png",
        kind: "image",
        mimeType: "image/png",
      },
    ]);
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 裸 /skill 在 attach 下走 skills/referenceCatalog（session 权威快照）——
// 修复前 deps.listSkills 未接线，恒回 "Skill listing is not available in this client."
test("裸 /skill 经 skills/referenceCatalog 取会话快照并格式化为命令结果", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const catalog = {
    authority: "session",
    skills: [
      {
        description: "Reviews diffs for style and bugs.",
        enabled: true,
        id: "glm:workspace:/repo/.agents/skills/code-review",
        name: "code-review",
        nativeScope: "project",
        path: "/repo/.agents/skills/code-review",
        scope: "workspace",
        source: "agents",
        whenToUse: "When asked to review code.",
      },
      {
        description: "Formats code.",
        enabled: true,
        id: "glm:plugin:/plugins/fmt/skills/lint",
        name: "lint",
        nativeScope: "project",
        path: "/plugins/fmt/skills/lint",
        pluginName: "fmt",
        qualifiedName: "fmt:lint",
        scope: "plugin",
        source: "plugin",
      },
    ],
    totalDiscovered: 3,
  };
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "skills/referenceCatalog") return catalog;
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    const result = await handler("/skill", {});
    const request = core.requests.find((r) => r.method === "skills/referenceCatalog");
    // session 权威：带 sessionId 时 server 用 runtime 冻结快照，不现扫磁盘。
    assert.deepEqual(request?.params, {
      sessionId: SID,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    assert.match(result.response ?? "", /Available skills \(2\)/);
    assert.match(result.response ?? "", /code-review/);
    // qualifiedName 优先于 name 作可调用名，原 name 作为 alias 附注。
    assert.match(result.response ?? "", /fmt:lint/);
    assert.match(result.response ?? "", /alias lint/);
    assert.match(result.response ?? "", /Use \/skill <name> \[task\] to load one/);
    assert.ok(
      !core.requests.some((r) => r.method === "session/send"),
      "bare /skill must not reach session/send",
    );
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("/skill <name> [task] 改写为 Skill tool 指令按普通 prompt 下发", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/send") {
      const inputId = request.params.inputId as string;
      queueMicrotask(() => {
        notify(
          rawEvent({
            inputId,
            payload: { inputId, response: "skill turn done", resultType: "completed" },
            seq: 1,
            turnId: "turn-skill",
            type: "turn_complete",
          }),
        );
      });
      return { accepted: true, sessionId: SID, stateRevision: 1 };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    const result = await handler("/skill fmt:lint fix my imports", {});
    const send = core.requests.find((r) => r.method === "session/send");
    assert.ok(send, "expected session/send");
    const content = String(send.params.content);
    assert.match(content, /skill named `fmt:lint`/);
    assert.match(content, /Skill` tool with name `fmt:lint`/);
    assert.match(content, /fix my imports/);
    assert.equal(result.response, "skill turn done");
    assert.ok(
      !core.requests.some((r) => r.method === "skills/referenceCatalog"),
      "/skill <name> must not consult the catalog",
    );
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// ---- interaction/* 反向请求（2026-10-23 实测 bug：attach 下 AskUserQuestion 不可用）----
// 修复前两处断点：interaction/requestUserInput 落 method not found；
// interaction/requestPermission 把 PermissionBrokerResult（含 resolvedAt）原样回传，
// 被服务端 strict schema 拒绝——工具侧只见 "Permission request failed"。

const INTERACTION_WAIT_MS = 2_000;

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + INTERACTION_WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const PERMISSION_OPTIONS = [
  {
    kind: "allow_once",
    name: "Allow once",
    optionId: "allow_once",
    response: { decision: "allow", reason: "Approved once" },
  },
  {
    kind: "allow_always",
    name: "Always allow in this project",
    optionId: "allow_project",
    response: {
      decision: "allow",
      permissionUpdates: [
        { behavior: "allow", rules: [{ toolName: "Bash" }], type: "addRules" },
      ],
      reason: "Approved for this project",
    },
  },
  {
    kind: "deny",
    name: "Deny",
    optionId: "deny",
    response: { decision: "deny", reason: "The user doesn't want to proceed." },
  },
];

function interactionCoreResponder(request: Captured): unknown {
  if (request.method === "session/subscribe") {
    return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
  }
  if (request.method === "session/send") {
    return { accepted: true, sessionId: SID, stateRevision: 1 };
  }
  return {};
}

async function startInteractionFixture(dir: string): Promise<{
  core: FakeCore;
  handle: AttachSessionHandle;
  runtime: AttachRuntime;
}> {
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, interactionCoreResponder);
  const runtime = new AttachRuntime({ socketPath });
  await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  runtime.registerSession(handle);
  return { core, handle, runtime };
}

function finishTurn(core: FakeCore, inputId?: string): void {
  core.notify(
    rawEvent({
      payload: { inputId, response: "done", resultType: "completed" },
      seq: 9,
      turnId: "turn-1",
      type: "turn_complete",
    }),
  );
}

test("requestUserInput(AskUserQuestion) → wizard 请求 → accept + answers/annotations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-interaction-"));
  const { core, handle, runtime } = await startInteractionFixture(dir);
  const captured: { options?: unknown; request?: unknown } = {};
  try {
    const turn = handle.submitPrompt("hi", {
      requestPermission: async (request, options) => {
        captured.request = request;
        captured.options = options;
        return {
          decision: "modify",
          modifiedInput: {
            annotations: { "Pick one?": { preview: "pv" } },
            answers: { "Pick one?": "A" },
            questions: [],
          },
          reason: "Answered in TUI",
          resolvedAt: new Date(),
        };
      },
    });
    await waitFor(() => core.requests.some((r) => r.method === "session/send"));
    core.sendRequest("srv-1", "interaction/requestUserInput", {
      input: {
        questions: [
          {
            header: "h",
            options: [
              { description: "d", label: "A" },
              { description: "d", label: "B" },
            ],
            question: "Pick one?",
          },
        ],
      },
      prompt: "need clarification",
      questions: [
        {
          header: "h",
          options: [
            { label: "A", value: "A" },
            { label: "B", value: "B" },
          ],
          question: "Pick one?",
        },
      ],
      requestId: "req-q1",
      schema: { toolName: "AskUserQuestion" },
      sessionId: SID,
      toolCallId: "tc-1",
      toolName: "AskUserQuestion",
    });
    await waitFor(() => core.responses.some((r) => r.id === "srv-1"));
    const request = captured.request as {
      input: { questions: Array<{ question: string }> };
      toolName: string;
    };
    // requester 拿到的是 PermissionBrokerRequest 形态：toolName=AskUserQuestion 且
    // input 原样——真实 TUI requester 据此建 questionState 渲染 wizard。
    assert.equal(request.toolName, "AskUserQuestion");
    assert.equal(request.input.questions[0]?.question, "Pick one?");
    assert.ok(
      (captured.options as { signal?: AbortSignal })?.signal instanceof AbortSignal,
    );
    const response = core.responses.find((r) => r.id === "srv-1");
    assert.deepEqual(response?.result, {
      action: "accept",
      content: {
        annotations: { "Pick one?": { preview: "pv" } },
        answers: { "Pick one?": "A" },
      },
    });
    finishTurn(core);
    await turn;
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("requestUserInput 同 requestId 重发 → callback 只调一次，迟到的重发回同一份应答", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-interaction-"));
  const { core, handle, runtime } = await startInteractionFixture(dir);
  let calls = 0;
  let release: (() => void) | undefined;
  try {
    const turn = handle.submitPrompt("hi", {
      requestPermission: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { decision: "deny", reason: "Denied in TUI", resolvedAt: new Date() };
      },
    });
    await waitFor(() => core.requests.some((r) => r.method === "session/send"));
    const params = {
      requestId: "req-dup",
      schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
      sessionId: SID,
      toolName: "ExitPlanMode",
    };
    core.sendRequest("srv-1", "interaction/requestUserInput", params);
    await waitFor(() => calls === 1);
    // reannounce：同一业务 requestId、不同 wire id。
    core.sendRequest("srv-2", "interaction/requestUserInput", params);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1, "duplicate requestId must not invoke the requester twice");
    release?.();
    await waitFor(() => core.responses.some((r) => r.id === "srv-2"));
    const first = core.responses.find((r) => r.id === "srv-1");
    const second = core.responses.find((r) => r.id === "srv-2");
    assert.deepEqual(first?.result, { action: "decline", reason: "Denied in TUI" });
    assert.deepEqual(second?.result, { action: "decline", reason: "Denied in TUI" });
    finishTurn(core);
    await turn;
  } finally {
    release?.();
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("requestUserInput(ExitPlanMode) → 普通审批 allow → accept approve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-interaction-"));
  const { core, handle, runtime } = await startInteractionFixture(dir);
  const captured: { request?: unknown } = {};
  try {
    const turn = handle.submitPrompt("hi", {
      requestPermission: async (request) => {
        captured.request = request;
        return { decision: "allow", reason: "Approved in TUI", resolvedAt: new Date() };
      },
    });
    await waitFor(() => core.requests.some((r) => r.method === "session/send"));
    core.sendRequest("srv-1", "interaction/requestUserInput", {
      input: { plan: "do x" },
      prompt: "Review this implementation plan.",
      requestId: "req-p1",
      schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
      sessionId: SID,
      toolName: "ExitPlanMode",
    });
    await waitFor(() => core.responses.some((r) => r.id === "srv-1"));
    const request = captured.request as { approvalMode?: string; toolName: string };
    assert.equal(request.toolName, "ExitPlanMode");
    assert.equal(request.approvalMode, "user-once");
    const response = core.responses.find((r) => r.id === "srv-1");
    assert.deepEqual(response?.result, {
      action: "accept",
      content: { answer: "approve" },
    });
    finishTurn(core);
    await turn;
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("requestPermission → 回 option.response 原文（无 resolvedAt）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-interaction-"));
  const { core, handle, runtime } = await startInteractionFixture(dir);
  const captured: { request?: unknown } = {};
  try {
    const turn = handle.submitPrompt("hi", {
      requestPermission: async (request) => {
        captured.request = request;
        return { decision: "deny", reason: "Denied in TUI", resolvedAt: new Date() };
      },
    });
    await waitFor(() => core.requests.some((r) => r.method === "session/send"));
    core.sendRequest("srv-1", "interaction/requestPermission", {
      input: { command: "rm x" },
      options: PERMISSION_OPTIONS,
      reason: "Bash requires approval",
      requestId: "req-1",
      riskLevel: "high",
      sessionId: SID,
      toolCallId: "tc-1",
      toolName: "Bash",
    });
    await waitFor(() => core.responses.some((r) => r.id === "srv-1"));
    const request = captured.request as { toolName: string; approvalMode?: string };
    assert.equal(request.toolName, "Bash");
    assert.equal(request.approvalMode, undefined);
    const response = core.responses.find((r) => r.id === "srv-1");
    // deny option 的 response 原文（服务端 reason），不是 TUI 的 "Denied in TUI"。
    assert.deepEqual(response?.result, PERMISSION_OPTIONS[2]!.response);
    finishTurn(core);
    await turn;
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("requestPermission user-once 选项 → approvalMode 还原为 user-once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-interaction-"));
  const { core, handle, runtime } = await startInteractionFixture(dir);
  const captured: { request?: unknown } = {};
  try {
    const turn = handle.submitPrompt("hi", {
      requestPermission: async (request) => {
        captured.request = request;
        return { decision: "allow", resolvedAt: new Date() };
      },
    });
    await waitFor(() => core.requests.some((r) => r.method === "session/send"));
    core.sendRequest("srv-1", "interaction/requestPermission", {
      input: {},
      options: [PERMISSION_OPTIONS[0], PERMISSION_OPTIONS[2]],
      reason: "approval",
      requestId: "req-uo",
      riskLevel: "medium",
      sessionId: SID,
      toolCallId: "tc-1",
      toolName: "WebFetch",
    });
    await waitFor(() => core.responses.some((r) => r.id === "srv-1"));
    const request = captured.request as { approvalMode?: string };
    assert.equal(request.approvalMode, "user-once");
    const response = core.responses.find((r) => r.id === "srv-1");
    assert.deepEqual(response?.result, PERMISSION_OPTIONS[0]!.response);
    finishTurn(core);
    await turn;
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("permission_resolved 事件撤下悬空交互 → 请求侧收到 error 应答", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-interaction-"));
  const { core, handle, runtime } = await startInteractionFixture(dir);
  let aborted = false;
  try {
    const turn = handle.submitPrompt("hi", {
      requestPermission: async (_request, options) => {
        const signal = (options as { signal?: AbortSignal })?.signal;
        return await new Promise((resolve, reject) => {
          // 与真实 createTuiPermissionRequester 一致：signal 已 aborted 时立即
          // 拒绝（resolved 事件可能与请求同帧到达，早于 invoke 执行）。
          if (signal?.aborted) {
            aborted = true;
            reject(new Error("Permission request cancelled"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("Permission request cancelled"));
            },
            { once: true },
          );
        });
      },
    });
    await waitFor(() => core.requests.some((r) => r.method === "session/send"));
    core.sendRequest("srv-1", "interaction/requestPermission", {
      input: {},
      options: PERMISSION_OPTIONS,
      reason: "approval",
      requestId: "req-stale",
      riskLevel: "low",
      sessionId: SID,
      toolCallId: "tc-1",
      toolName: "Bash",
    });
    await waitFor(() => core.requests.some((r) => r.method === "session/send"));
    // 服务端先行 settle（自动应答/abort）→ resolved 事件必须撤下本端面板。
    core.notify(
      rawEvent({
        payload: { decision: "deny", requestId: "req-stale" },
        seq: 5,
        type: "permission_resolved",
      }),
    );
    await waitFor(() => aborted);
    await waitFor(() => core.responses.some((r) => r.id === "srv-1"));
    const response = core.responses.find((r) => r.id === "srv-1");
    assert.ok(response?.error, "aborted interaction should answer with error");
    finishTurn(core);
    await turn;
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("无 handler（无在途回合）时 permission → deny / userInput → decline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-interaction-"));
  const { core, runtime } = await startInteractionFixture(dir);
  try {
    core.sendRequest("srv-1", "interaction/requestPermission", {
      input: {},
      options: PERMISSION_OPTIONS,
      reason: "approval",
      requestId: "req-nh",
      riskLevel: "low",
      sessionId: SID,
      toolCallId: "tc-1",
      toolName: "Bash",
    });
    core.sendRequest("srv-2", "interaction/requestUserInput", {
      requestId: "req-nh2",
      schema: { toolName: "AskUserQuestion" },
      sessionId: SID,
      toolName: "AskUserQuestion",
    });
    await waitFor(() => core.responses.length === 2);
    const permission = core.responses.find((r) => r.id === "srv-1");
    const userInput = core.responses.find((r) => r.id === "srv-2");
    assert.equal(
      (permission?.result as { decision?: string })?.decision,
      "deny",
    );
    assert.equal(
      (userInput?.result as { action?: string })?.action,
      "decline",
    );
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// ── 自定义命令（commands/referenceCatalog）──
// 契约：目录经协议取（瘦客户端不本地重扫），展开留在 core 的 input facade ——
// 未知 `/name args` 必须原文转发 session/send（客户端侧展开会砍 !`cmd` 动态语法）。

const commandCatalog = {
  commands: [
    {
      description: "Review Guidelines",
      name: "review",
      path: "/home/user/.zcode/commands/review.md",
      scope: "user",
      source: "zcode",
    },
  ],
  totalDiscovered: 1,
};

test("/help 列出自定义命令（commands/referenceCatalog 目录）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "commands/referenceCatalog") return commandCatalog;
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    const result = (await handler("/help", {})) as { response?: string };
    assert.match(result.response ?? "", /Custom commands:/);
    assert.match(result.response ?? "", /\/review: Review Guidelines/);
    // 目录请求携带 workspace ref，方法名与 shared 协议表一致。
    const catalogCalls = core.requests.filter(
      (r) => r.method === "commands/referenceCatalog",
    );
    assert.equal(catalogCalls.length, 1);
    assert.deepEqual(catalogCalls[0]?.params?.workspace, {
      workspaceKey: "/tmp/ws",
      workspacePath: "/tmp/ws",
    });
    assert.ok(
      !core.requests.some((r) => r.method === "session/send"),
      "help must not reach session/send",
    );
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("/review 参数原文转发 session/send（展开在 core 的 input facade，不在客户端）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "commands/referenceCatalog") return commandCatalog;
    if (request.method === "session/send") {
      const inputId = request.params.inputId as string;
      const content = request.params.content as string;
      queueMicrotask(() => {
        notify(rawEvent({ inputId, payload: { inputId }, seq: 1, turnId: "t", type: "turn_started" }));
        notify(rawEvent({ payload: { response: "ok", resultType: "completed" }, seq: 2, turnId: "t", type: "turn_complete" }));
      });
      return { accepted: true, sessionId: SID, stateRevision: 1 };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    await handler("/review apps/cli/src/main.ts", {});
    const sends = core.requests.filter((r) => r.method === "session/send");
    assert.equal(sends.length, 1, "expected exactly one session/send");
    // 逐字转发：客户端不做任何展开/改写 —— core 的 facade 负责并记 displayInput。
    assert.equal(sends[0]?.params.content, "/review apps/cli/src/main.ts");
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("loadStartupOptions 的 slashCommands 含协议目录里的自定义命令", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-startup-"));
  const workspace = join(dir, "workspace");
  const { resolveSocketPath } = await import("../src/app-server-spawn.js");
  const socketPath = resolveSocketPath(
    { workspacePath: workspace },
    { env: { ZCODE_DATA_BASE_DIR: dir } },
  );
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(socketPath), { recursive: true });
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/create") return makeSnapshot();
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "commands/referenceCatalog") {
      return {
        commands: [
          {
            argumentHint: "<prompt>",
            description: "Rephrase a prompt into an effective form",
            name: "good-prompt",
            path: "/home/user/.zcode/commands/good-prompt.md",
            scope: "user",
            source: "zcode",
          },
        ],
        totalDiscovered: 1,
      };
    }
    return {};
  });
  const { runAttachCommand } = await import("../src/attach/attach-command.js");
  let captured: { slashCommands?: Array<{ usage?: string }> } = {};
  const deps = {
    cwd: () => workspace,
    env: { ...process.env, ZCODE_DATA_BASE_DIR: dir },
    // git 分支解析在临时目录失败 → .catch 吞掉，不阻塞启动数据。
    resolveWorkspaceGitBranch: async () => undefined,
    runTui: async (options: { loadStartupOptions?: () => Promise<unknown> }) => {
      captured = (await options.loadStartupOptions?.()) as typeof captured;
      return 0;
    },
  } as never;
  try {
    const exitCode = await runAttachCommand(
      { argv: [], stderr: process.stderr, stdin: process.stdin, stdout: process.stdout } as never,
      {} as never,
      deps,
      "0.0.0-test",
    );
    assert.equal(exitCode, 0);
    const usages = (captured.slashCommands ?? []).map((s) => s.usage);
    assert.ok(usages.includes("/good-prompt <prompt>"), `got: ${usages.join(", ")}`);
    assert.ok(
      core.requests.some((r) => r.method === "commands/referenceCatalog"),
      "expected catalog request",
    );
  } finally {
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// ── steer / follow-up 双 lane 与 Alt+Up 撤回（pi-mono 对齐，2026-10-25）──
// Enter busy → 协议 delivery:"steer" 直驱 core steerTurn（真实事件驱动 UI）；
// Ctrl+Q busy → 本地 follow-up FIFO；撤回分本地摘除与 session/discardPendingInputs。

/** 单并发 busy 夹具：首回合 turn_started 后挂起，pendingTurns 非空。 */
async function startBusyFixture(
  dir: string,
  respondSteer: (
    request: Captured,
  ) => unknown = () => ({},
  ),
): Promise<{
  core: FakeCore;
  handle: AttachSessionHandle;
  runtime: AttachRuntime;
  settleFirstTurn: () => void;
}> {
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/send") {
      if (request.params.delivery === "steer") return respondSteer(request);
      const inputId = request.params.inputId as string;
      queueMicrotask(() => {
        notify(
          rawEvent({
            inputId,
            payload: { inputId, input: request.params.content, turnNumber: 1 },
            seq: 1,
            turnId: "turn-busy",
            type: "turn_started",
          }),
        );
      });
      return { accepted: true, sessionId: SID, stateRevision: 1 };
    }
    if (request.method === "session/discardPendingInputs") {
      return { removed: [] };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  runtime.registerSession(handle);
  const settleFirstTurn = (): void => {
    core.notify(
      rawEvent({
        payload: { response: "done", resultType: "completed" },
        seq: 9,
        turnId: "turn-busy",
        type: "turn_complete",
      }),
    );
  };
  void handle.submitPrompt("first").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { core, handle, runtime, settleFirstTurn };
}

test("busy sendInput delivery steer → session/send delivery:steer，回执 pendingInputId 直通", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-steer-"));
  const steerReceipt = {
    accepted: true,
    sessionId: SID,
    stateRevision: 2,
    steerQueued: { pendingInputId: "core-p1", queueLength: 1, turnId: "turn-busy" },
  };
  const { core, handle, runtime, settleFirstTurn } = await startBusyFixture(dir, () => steerReceipt);
  const events: Array<{ payload: Record<string, unknown>; type: string }> = [];
  handle.addSink((event) => events.push(event as never));
  try {
    const result = await handle.sendInput("redirect please", { delivery: "steer" });
    assert.equal(result.kind, "queued");
    if (result.kind === "queued") {
      assert.equal(result.pendingInputId, "core-p1");
      assert.equal(result.queueLength, 1);
    }
    const steerSend = core.requests.find(
      (r) => r.method === "session/send" && r.params.delivery === "steer",
    );
    assert.ok(steerSend, "expected session/send with delivery steer");
    assert.equal(steerSend.params.content, "redirect please");
    assert.equal(steerSend.params.sessionId, SID);
    // steer 不落本地 follow-up 队列：settle 后不得重放第二条 session/send。
    settleFirstTurn();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const sends = core.requests.filter((r) => r.method === "session/send");
    assert.equal(
      sends.filter((r) => r.params.delivery !== "steer").length,
      1,
      "steer must not re-enter the local follow-up queue",
    );
    // 队列区由 core 真实事件驱动，客户端不合成 queued 行。
    assert.equal(
      events.filter((event) => event.type === "turn_steer_queued").length,
      0,
      "steer lane must not synthesize turn_steer_queued locally",
    );
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("steer 被拒（guard.steerRejected.*）回退本地 follow-up 队列", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-steer-reject-"));
  // responder 里同步 throw 会炸掉 socket data handler：协议错误必须以
  // rejected promise 的形式进入 fake core 的应答链。
  const rejectSteer = (): Promise<never> => {
    const error = new Error(
      "Steer rejected: turn_not_steerable",
    ) as Error & { code: number; data: unknown };
    error.code = -32010;
    error.data = { reasonCode: "guard.steerRejected.turn_not_steerable" };
    return Promise.reject(error);
  };
  const { core, handle, runtime, settleFirstTurn } = await startBusyFixture(dir, rejectSteer);
  const events: Array<{ payload: Record<string, unknown>; type: string }> = [];
  handle.addSink((event) => events.push(event as never));
  try {
    const result = await handle.sendInput("queue me instead", { delivery: "steer" });
    assert.equal(result.kind, "queued");
    if (result.kind === "queued") {
      assert.match(result.pendingInputId, /^attach-input-queued-/);
    }
    const queued = events.find((event) => event.type === "turn_steer_queued");
    assert.ok(queued, "fallback must synthesize the follow-up queue row");
    assert.equal(queued.payload.delivery, "queue");
    assert.equal(queued.payload.input, "queue me instead");
  } finally {
    settleFirstTurn();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("steer 协议级失败（非 guard.steerRejected）如实上抛", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-steer-error-"));
  const rejectSteer = (): Promise<never> => Promise.reject(new Error("socket exploded"));
  const { core, handle, runtime, settleFirstTurn } = await startBusyFixture(dir, rejectSteer);
  try {
    await assert.rejects(
      () => handle.sendInput("fail loudly", { delivery: "steer" }),
      /socket exploded/,
    );
  } finally {
    settleFirstTurn();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("busy sendInput delivery queue → 本地 follow-up 队列，不触 steer 协议", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-queue-"));
  const { core, handle, runtime, settleFirstTurn } = await startBusyFixture(dir);
  const events: Array<{ payload: Record<string, unknown>; type: string }> = [];
  handle.addSink((event) => events.push(event as never));
  try {
    const result = await handle.sendInput("after you finish", { delivery: "queue" });
    assert.equal(result.kind, "queued");
    assert.equal(
      core.requests.some((r) => r.method === "session/send" && r.params.delivery === "steer"),
      false,
      "explicit queue must not touch the steer protocol lane",
    );
    const queued = events.find((event) => event.type === "turn_steer_queued");
    assert.ok(queued);
    assert.equal(queued.payload.delivery, "queue");
  } finally {
    settleFirstTurn();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("discardPendingInputs：本地项摘除合成 discarded，core 项走 session/discardPendingInputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-discard-"));
  let remoteRemoved: string[] = [];
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/send") {
      const inputId = request.params.inputId as string;
      queueMicrotask(() => {
        core.notify(
          rawEvent({
            inputId,
            payload: { inputId, input: request.params.content, turnNumber: 1 },
            seq: 1,
            turnId: "turn-busy",
            type: "turn_started",
          }),
        );
      });
      return { accepted: true, sessionId: SID, stateRevision: 1 };
    }
    if (request.method === "session/discardPendingInputs") {
      remoteRemoved = request.params.pendingInputIds as string[];
      return { removed: [remoteRemoved[0]] };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  runtime.registerSession(handle);
  const events: Array<{ payload: Record<string, unknown>; type: string }> = [];
  handle.addSink((event) => events.push(event as never));
  try {
    void handle.submitPrompt("first").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const local = await handle.sendInput("local follow-up", { delivery: "queue" });
    assert.equal(local.kind, "queued");
    const localId = local.kind === "queued" ? local.pendingInputId : "";

    const removed = await handle.discardPendingInputs([localId, "core-p9"]);
    assert.deepEqual(removed, [localId, "core-p9"]);
    // 本地项：合成 turn_steer_discarded（UI 摘行）；未命中项留给真实事件。
    const discarded = events.filter((event) => event.type === "turn_steer_discarded");
    assert.equal(discarded.length, 1);
    assert.deepEqual(discarded[0]!.payload.pendingInputIds, [localId]);
    // core 项：协议下发，返回实际移除集。
    const discardCall = core.requests.find(
      (r) => r.method === "session/discardPendingInputs",
    );
    assert.ok(discardCall);
    assert.deepEqual(discardCall.params.pendingInputIds, ["core-p9"]);
    assert.equal(discardCall.params.sessionId, SID);
    assert.deepEqual(remoteRemoved, ["core-p9"]);
  } finally {
    // 收掉挂起的首回合，避免悬空 pendingTurn 拖住测试进程的事件循环。
    core.notify(
      rawEvent({
        payload: { response: "done", resultType: "completed" },
        seq: 99,
        turnId: "turn-busy",
        type: "turn_complete",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("createAttachPromptHandler 暴露 removeQueuedInputs 端口并随句柄生效", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-remove-port-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/discardPendingInputs") {
      return { removed: request.params.pendingInputIds };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  runtime.registerSession(handle);
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    assert.equal(typeof handler.removeQueuedInputs, "function");
    const removed = await handler.removeQueuedInputs!(["core-p1", "core-p2"]);
    assert.deepEqual(removed, ["core-p1", "core-p2"]);
    const discardCall = core.requests.find(
      (r) => r.method === "session/discardPendingInputs",
    );
    assert.ok(discardCall);
    assert.deepEqual(discardCall.params.pendingInputIds, ["core-p1", "core-p2"]);
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 回归证据（P004-F2，2026-10-26 评审）：TUI 内裸 /resume 曾用 sessions.at(-1)
// 取“最近会话”——server 的 session/list 返回顺序不保证（实测创建序/任意序
// 混排，attach-command 的入口路径因此改过显式排序），会静默恢复陈旧会话。
// TUI 内必须走同一裁决：按 updatedAt（退化 createdAt）显式取最大。
test("TUI 裸 /resume 按 updatedAt 取最近会话，而不是列表末位", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-resume-latest-"));
  const socketPath = join(dir, "core.sock");
  // 故意混排：陈旧会话不在末位、最新会话在中间。
  const listed = [
    { id: "sess-middle", updatedAt: 200 },
    { id: "sess-newest", updatedAt: 300 },
    { id: "sess-stale", updatedAt: 100 },
  ];
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/list") {
      return { sessions: listed };
    }
    if (request.method === "session/resume") {
      return { sessionId: request.params.sessionId };
    }
    if (request.method === "session/messages") {
      return { messages: [] };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  runtime.registerSession(handle);
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    const result = (await handler("/resume", {})) as { response?: string };
    const resumeCall = core.requests.find((r) => r.method === "session/resume");
    assert.ok(resumeCall, "expected session/resume request");
    assert.equal(resumeCall.params.sessionId, "sess-newest");
    assert.match(result.response ?? "", /Resumed session sess-newest/);
    assert.ok(
      !core.requests.some((r) => r.method === "session/create"),
      "bare /resume must not silently create a new session",
    );
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// P004-F2 的空列表分支：显式报错（与入口 -c 的 “No resumable session found”
// 同语义），不再静默留在当前会话装作成功。
test("TUI 裸 /resume 空列表显式报错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-resume-empty-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/list") {
      return { sessions: [] };
    }
    if (request.method === "session/messages") {
      return { messages: [] };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  runtime.registerSession(handle);
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    await assert.rejects(handler("/resume", {}), /No resumable session found for \/tmp\/ws/);
    assert.ok(!core.requests.some((r) => r.method === "session/resume"));
    assert.ok(!core.requests.some((r) => r.method === "session/create"));
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});


// 回归证据（2026-11-14，`piz` 页脚排查）：subscribeSessionEvents 曾绑定在调用时刻
// 的 current 句柄——/resume /new /fork 换绑后，TUI 常驻 sink 留在旧句柄上，
// 新会话的出回合事件永远到不了页脚（per-turn onEvent 掩盖了故障，表现静默）。
// monolith 的 sessionEventRelay 在换绑时迁移订阅；attach 侧由 durableSinks +
// onSessionBound 承担同一职责。
test("subscribeSessionEvents 的常驻 sink 随 /resume 换绑到新句柄", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-sink-swap-"));
  const socketPath = join(dir, "core.sock");
  const resumed = makeSnapshot() as {
    session: { sessionId: string };
  } & ReturnType<typeof makeSnapshot>;
  resumed.session = { ...resumed.session, sessionId: "sess-2" };
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return {
        eventSeq: 0,
        events: [],
        rawEvents: [],
        sessionId: request.params.sessionId,
        snapshot: resumed,
      };
    }
    if (request.method === "session/resume") {
      return { sessionId: request.params.sessionId };
    }
    if (request.method === "session/messages") {
      return { messages: [] };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    const received: string[] = [];
    handler.subscribeSessionEvents?.((event) => {
      received.push(`${event.sessionId}:${event.type}`);
    });
    const result = await handler("/resume sess-2", {});
    assert.match(result.response ?? "", /Resumed session sess-2/);
    assert.equal(handler.getMainSessionId?.(), "sess-2");
    // 新会话的出回合事件必须到达常驻 sink——这是 footer 在 /resume 后能收到
    // 远端发起回合的 model_complete/spinner 的前提。
    core.notify({ ...rawEvent({ seq: 7, type: "model_complete" }), sessionId: "sess-2" });
    // 旧会话的事件不再投递：sink 已迁移，旧句柄上已无该订阅。
    core.notify(rawEvent({ seq: 8, type: "model_complete" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(received, ["sess-2:model_complete"]);
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 换绑结果的页脚种子：订阅快照的 runtime.contextUsage / runtime.usageTotals
// 必须经 sessionSnapshotSeed 上溯到 /resume /new 的 TuiSubmitPromptResult——
// 否则恢复会话的 footer 在下一个 model_complete 前没有任何用量/ctx 读数。
test("/resume 结果携带快照的 projection 与 usageTotals 种子", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-seed-"));
  const socketPath = join(dir, "core.sock");
  const resumed = makeSnapshot() as {
    session: { sessionId: string };
  } & ReturnType<typeof makeSnapshot>;
  resumed.session = { ...resumed.session, sessionId: "sess-2" };
  resumed.runtime = {
    ...resumed.runtime,
    contextUsage: { size: 255_000, used: 103_000 },
    usageTotals: {
      cacheReadTokens: 27_000_000,
      cacheWriteTokens: 0,
      inputTokens: 463_000,
      latestCacheHitRate: 1,
      outputTokens: 118_000,
    },
  };
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return {
        eventSeq: 0,
        events: [],
        rawEvents: [],
        sessionId: request.params.sessionId,
        snapshot: resumed,
      };
    }
    if (request.method === "session/resume") {
      return { sessionId: request.params.sessionId };
    }
    if (request.method === "session/messages") {
      return { messages: [] };
    }
    return {};
  });
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  try {
    const handler = createAttachPromptHandler({
      client,
      initialHandle: handle,
      runtime,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    });
    const result = await handler("/resume sess-2", {});
    assert.equal(result.resetSessionProjection, true);
    assert.deepEqual(result.projection, {
      contextUsed: 103_000,
      contextWindow: 255_000,
    });
    assert.deepEqual(result.usageTotals, {
      cacheReadTokens: 27_000_000,
      cacheWriteTokens: 0,
      inputTokens: 463_000,
      latestCacheHitRate: 1,
      outputTokens: 118_000,
    });
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("sessionSnapshotSeed 回退到 projection（无 runtime.contextUsage）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-seed-projection-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, () => ({}));
  const client = await connectAttachClient(socketPath);
  try {
    const snapshot = makeSnapshot() as ReturnType<typeof makeSnapshot>;
    snapshot.projection = {
      ...snapshot.projection,
      contextUsed: 267_000,
      contextWindow: 255_000,
    };
    const handle = new AttachSessionHandle({
      client,
      sessionId: SID,
      snapshot: snapshot as never,
    });
    const seed = handle.sessionSnapshotSeed();
    assert.deepEqual(seed.projection, {
      contextUsed: 267_000,
      contextWindow: 255_000,
    });
    assert.equal(seed.usageTotals, undefined);
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});
