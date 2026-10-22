import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ZCODE_PROTOCOL_VERSION } from "@zcode/shared";
import { connectAttachClient } from "../src/attach/attach-client.js";
import { AttachSessionHandle } from "../src/attach/attach-session.js";
import {
  AttachRuntime,
  createAttachPromptHandler,
} from "../src/attach/attach-tui-options.js";

const SID = "sess-1";

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
        available: [{ modelId: "glm-4.6", providerId: "zai" }],
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

type FakeCore = {
  requests: Captured[];
  socketPath: string;
  notify: (params: unknown) => void;
  kill: () => Promise<void>;
  close: () => Promise<void>;
};

/** 假 core：按 method 路由到应答表；rawEvent 通过注入的 sender 回放。 */
async function startFakeCore(
  socketPath: string,
  responder: (request: Captured, notify: (params: unknown) => void) => unknown,
): Promise<FakeCore> {
  const requests: Captured[] = [];
  const sockets = new Set<Socket>();
  const notify = (params: unknown): void => {
    for (const socket of sockets) {
      socket.write(`${JSON.stringify({ method: "session/rawEvent", params })}\n`);
    }
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
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (!message.method || message.id === undefined) continue;
        const request: Captured = {
          method: message.method,
          params: message.params ?? {},
        };
        requests.push(request);
        const result = responder(request, notify);
        Promise.resolve(result)
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
    kill: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    notify,
    requests,
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
    assert.ok(received.some((event) => event.type === "turn_steer_drained"));
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
    initial.settings.model.available = [
      { modelId: "glm-4.6", providerId: "zai" },
      { modelId: "glm-4.7", providerId: "zai" },
    ];
    (handle as unknown as { snapshot: unknown }).snapshot = initial;
    handle.applyStatePatch({
      // modelAvailability:"current" 过滤投影：available 只剩当前模型，不得覆盖 catalog。
      model: {
        available: [{ modelId: "glm-4.7", providerId: "zai" }],
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
        available: [{ modelId: "glm-4.6", providerId: "zai" }],
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
