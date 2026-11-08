import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZCODE_PROTOCOL_VERSION } from "@zcode/shared";
import { AcpCoreSessions } from "../src/acp/acp-sessions.js";

// 协议 fixture 不是 live core；但使用真实 socket、AttachRuntime 和 session handle，
// 防止 fake session 层再次掩盖 client 未安装或 waiter 被替换的错误。
function snapshot(sessionId: string) {
  return {
    messages: [],
    protocol: { name: "ZCode Protocol", version: ZCODE_PROTOCOL_VERSION },
    runtime: { eventSeq: 0, pendingRequestIds: [], stateRevision: 0 },
    projection: {
      activeToolCalls: [], backgroundJobs: [], contextUsed: 0, contextWindow: 200_000,
      mode: "build", pendingPermissions: [], sessionId, status: "idle",
      totalTokenCount: 0, turnCount: 0,
    },
    session: {
      createdAt: 1, updatedAt: 1, mode: "build", sessionId,
      sessionKind: "interactive", status: "idle", title: "ACP test",
      traceId: "trace-test", workspace: { workspaceKey: "/workspace", workspacePath: "/workspace" },
    },
    settings: {
      mode: { current: "build" },
      model: {
        available: [{
          label: "test-model", ref: { modelId: "test-model", providerId: "test" },
          properties: {
            inputFormat: {
              supportsAudio: false, supportsImage: false, supportsPdf: false,
              supportsText: true, supportsVideo: false,
            },
            outputFormat: { supportsText: true },
          },
        }],
        current: { modelId: "test-model", providerId: "test" },
      },
      thoughtLevel: { available: [], current: "medium", enabled: true },
    },
  };
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "acp-sessions-"));
  const socketPath = join(directory, "core.sock");
  const sockets = new Set<Socket>();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const connectedRefs: Array<{ workspaceIdentity?: string; workspacePath: string }> = [];
  let connectionCount = 0;
  let rejectClose = false;
  let seq = 0;
  let promptInput: string | undefined;
  const notify = (sessionId: string, type: string, payload: Record<string, unknown>) => {
    for (const socket of sockets) socket.write(`${JSON.stringify({
      method: "session/rawEvent",
      params: {
        id: `event-${++seq}`, payload, sequenceNumber: seq, sessionId,
        timestamp: new Date().toISOString(), traceId: "trace-test", turnId: "turn-test", type,
      },
    })}\n`);
  };
  const server = createServer((socket) => {
    connectionCount++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)) as {
          id: string; method: string; params: Record<string, unknown>;
        };
        buffer = buffer.slice(newline + 1);
        requests.push(message);
        const sessionId = String(message.params.sessionId ?? `session-${requests.length}`);
        let result: unknown = {};
        if (message.method === "session/create" || message.method === "session/resume") {
          result = snapshot(sessionId);
        } else if (message.method === "session/subscribe") {
          result = { eventSeq: seq, events: [], rawEvents: [], sessionId };
        } else if (message.method === "v4/command") {
          result = { commandId: message.params.commandId, status: "accepted", revisionAtDecision: 0 };
          if (message.params.type === "sendText") {
            promptInput = String(message.params.commandId);
            notify(sessionId, "turn_started", { inputId: promptInput });
          }
        }
        socket.write(`${JSON.stringify(
          message.method === "session/close" && rejectClose
            ? { id: message.id, error: { code: -32000, message: "injected close failure" } }
            : { id: message.id, result },
        )}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const sessions = new AcpCoreSessions({
    env: {},
    ensureConnected: async (ref) => {
      connectedRefs.push(ref);
      return { socketPath };
    },
  });
  t.after(async () => {
    await sessions.closeAll();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    sessions, requests, sockets, notify, connectedRefs, socketPath,
    get connectionCount() { return connectionCount; },
    get promptInput() { return promptInput; },
    rejectClose: (reject: boolean) => { rejectClose = reject; },
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for socket event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("ACP real lane connects for new/resume and closes its owned socket", async (t) => {
  const f = await fixture(t);
  const opened = await f.sessions.open("/workspace");
  const resumed = await f.sessions.resume({ cwd: "/workspace", sessionId: "persisted" });
  assert.equal(resumed.handle.sessionId, "persisted");
  assert.ok(f.requests.some((r) => r.method === "session/subscribe" && r.params.sessionId === opened.handle.sessionId));
  assert.equal(f.connectionCount, 1);
  await f.sessions.closeAll();
  await until(() => f.sockets.size === 0);
});

test("ACP lanes for different cwds converge on the single core and keep per-cwd workspace refs", async (t) => {
  const f = await fixture(t);
  await f.sessions.open("/workspace");
  await f.sessions.open("/other");
  // 单一 core：per-cwd lane 只是到同一端点的多条连接；workspace 身份仍随
  // 会话级请求按 cwd 发送，不进入传输选择。
  assert.equal(f.connectionCount, 2);
  const creates = f.requests.filter((r) => r.method === "session/create");
  assert.deepEqual(
    creates.map((r) => (r.params.workspace as { workspacePath: string }).workspacePath),
    ["/workspace", "/other"],
  );
  assert.deepEqual(
    f.connectedRefs.map((r) => r.workspacePath),
    ["/workspace", "/other"],
  );
});

test("ACP bound resume preserves the active prompt waiter", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.open("/workspace");
  const prompt = session.handle.submitPrompt("hello");
  await until(() => f.promptInput !== undefined);
  const resumed = await f.sessions.resume({ cwd: "/workspace", sessionId: session.handle.sessionId });
  assert.equal(resumed, session);
  f.notify(session.handle.sessionId, "turn_complete", { inputId: f.promptInput, response: "done" });
  assert.equal((await prompt).response, "done");
  const firstInput = f.promptInput;
  const followup = session.handle.submitPrompt("again");
  await until(() => f.promptInput !== firstInput);
  f.notify(session.handle.sessionId, "turn_complete", { inputId: f.promptInput, response: "again" });
  assert.equal((await followup).response, "again");
  await assert.rejects(
    f.sessions.resume({ cwd: "/other-workspace", sessionId: session.handle.sessionId }),
    /different cwd/,
  );
});

test("ACP close failure retains binding for retry; successful close removes recovery", async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.open("/workspace");
  f.rejectClose(true);
  await assert.rejects(f.sessions.closeSession(session.handle.sessionId), /injected close failure/);
  assert.equal(f.sessions.get(session.handle.sessionId), session);
  f.rejectClose(false);
  await f.sessions.closeSession(session.handle.sessionId);
  assert.equal(f.sessions.get(session.handle.sessionId), undefined);
  const before = f.requests.length;
  for (const socket of f.sockets) socket.destroy();
  await until(() => f.connectionCount === 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(!f.requests.slice(before).some((r) =>
    r.method === "session/resume" || r.method === "session/subscribe"));
});

test("ACP reconnect opens a fresh transport for handles and lifecycle requests", async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.open("/workspace");
  const initialSubscriptions = f.requests.filter((r) => r.method === "session/subscribe").length;
  for (const socket of f.sockets) socket.destroy();
  await until(() => f.requests.filter((r) => r.method === "session/subscribe").length > initialSubscriptions);
  assert.equal(f.connectionCount, 2);
  await session.handle.setMode("plan");
  await f.sessions.open("/workspace");
  await f.sessions.resume({ cwd: "/workspace", sessionId: "cold-after-reconnect" });
  await f.sessions.closeSession(session.handle.sessionId);
  assert.ok(f.requests.some((r) => r.method === "session/close"));
});
