// `piz acp` 回归：真实 socket 上的 fake core + 真实 ACP stdio 帧，覆盖
// initialize / session/new / prompt（含 update 投影与 permission 反向请求）/ cancel /
// setSessionMode / closeSession 全链路。协议帧走 @agentclientprotocol/sdk 的
// ndJsonStream，core 端是 node:net 假服务。
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Readable, Writable } from "node:stream";
import { test } from "node:test";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { AcpCoreBridge } from "../src/attach/acp/acp-core-bridge.js";
import { createAcpAgent } from "../src/attach/acp/acp-agent.js";

// ── fake core（unix socket NDJSON） ──────────────────────────────

type CoreHarness = {
  socketPath: string;
  received: Array<{ method?: string; params?: Record<string, unknown> }>;
  sendNotification: (method: string, params: unknown) => void;
  sendReverseRequest: (id: string, method: string, params: unknown) => void;
  awaitReverseResponse: (id: string) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
};

const startFakeCore = async (dir: string): Promise<CoreHarness> => {
  const socketPath = join(dir, "core.sock");
  const sockets = new Set<Socket>();
  const received: CoreHarness["received"] = [];
  const reverseWaiters = new Map<string, (message: Record<string, unknown>) => void>();
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
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.method === undefined && message.id !== undefined) {
          const waiter = reverseWaiters.get(String(message.id));
          if (waiter) {
            reverseWaiters.delete(String(message.id));
            waiter(message);
          }
          continue;
        }
        if (typeof message.method === "string" && typeof message.id !== "undefined") {
          received.push({ method: message.method, params: message.params as Record<string, unknown> });
          const params = (message.params ?? {}) as Record<string, unknown>;
          let result: unknown = {};
          if (message.method === "session/create") {
            result = {
              session: { sessionId: "sess-acp-1" },
              snapshot: {
                protocol: { name: "zcode", version: 4 },
                session: { sessionId: "sess-acp-1", workspace: { workspacePath: params.workspace ? (params.workspace as { workspacePath: string }).workspacePath : "/tmp" } },
                settings: {
                  model: {
                    current: { providerId: "zai", modelId: "glm-4.6" },
                    available: [
                      { ref: { providerId: "zai", modelId: "glm-4.6" }, name: "GLM-4.6" },
                    ],
                  },
                  thoughtLevel: { enabled: true, available: [{ id: "medium" }] },
                  mode: { current: "build" },
                },
                projection: { contextWindow: 0, contextUsed: 0 },
                runtime: {},
                messages: [],
              },
            };
          } else if (message.method === "session/resume") {
            result = { sessionId: params.sessionId };
          } else if (message.method === "v4/command") {
            result = { commandId: params.commandId, status: "accepted", revisionAtDecision: 1 };
          } else if (message.method === "session/setMode") {
            result = { mode: params.mode };
          }
          socket.write(`${JSON.stringify({ id: message.id, result })}\n`);
          continue;
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const write = (payload: Record<string, unknown>): void => {
    for (const socket of sockets) socket.write(`${JSON.stringify(payload)}\n`);
  };
  return {
    socketPath,
    received,
    sendNotification: (method, params) => write({ method, params }),
    sendReverseRequest: (id, method, params) => write({ id, method, params }),
    awaitReverseResponse: (id) =>
      new Promise((resolve) => {
        reverseWaiters.set(id, resolve);
      }),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
};

// ── 极简 ACP client（raw JSON-RPC over ndJsonStream） ──────────────

type AcpClient = {
  request: (method: string, params: unknown) => Promise<Record<string, unknown>>;
  notify: (method: string, params: unknown) => void;
  onRequest: (handler: (id: unknown, method: string, params: unknown) => void) => void;
  onNotification: (handler: (method: string, params: Record<string, unknown>) => void) => void;
  respond: (id: unknown, result: unknown) => void;
};

const startAcpClient = (agentIn: PassThrough, agentOut: PassThrough): AcpClient => {
  let counter = 0;
  const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void }>();
  const requestHandlers = new Set<(id: unknown, method: string, params: unknown) => void>();
  const notificationHandlers = new Set<(method: string, params: Record<string, unknown>) => void>();
  const parse = (line: string): void => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.method !== undefined && message.id !== undefined) {
      for (const handler of requestHandlers) handler(message.id, message.method as string, message.params);
      return;
    }
    if (message.method !== undefined) {
      for (const handler of notificationHandlers) handler(message.method as string, (message.params ?? {}) as Record<string, unknown>);
      return;
    }
    if (message.id !== undefined) {
      const entry = pending.get(String(message.id));
      if (entry) {
        pending.delete(String(message.id));
        entry.resolve((message.result ?? message.error ?? {}) as Record<string, unknown>);
      }
    }
  };
  let buffer = "";
  agentOut.setEncoding("utf8");
  agentOut.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) parse(line);
    }
  });
  return {
    request: async (method, params) => {
      const id = `c-${++counter}`;
      const promise = new Promise<Record<string, unknown>>((resolve) => pending.set(id, { resolve }));
      agentIn.write(`${JSON.stringify({ id, method, params })}\n`);
      return promise;
    },
    notify: (method, params) => {
      agentIn.write(`${JSON.stringify({ method, params })}\n`);
    },
    onRequest: (handler) => {
      requestHandlers.add(handler);
    },
    onNotification: (handler) => {
      notificationHandlers.add(handler);
    },
    respond: (id, result) => {
      agentIn.write(`${JSON.stringify({ id, result })}\n`);
    },
  };
  void responders;
};

const rawEvent = (sessionId: string, seq: number, type: string, payload: Record<string, unknown> = {}) => ({
  id: `evt-${seq}`,
  sessionId,
  type,
  timestamp: new Date().toISOString(),
  traceId: "t",
  sequenceNumber: seq,
  payload,
});

test("piz acp: full turn over real socket with permission reverse request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "piz-acp-"));
  try {
    const core = await startFakeCore(dir);
    const agentToClient = new PassThrough(); // agent → client
    const clientToAgent = new PassThrough(); // client → agent
    const bridge = new AcpCoreBridge({
      version: "test",
      env: {},
      ensureConnected: async () => ({ socketPath: core.socketPath }),
    });
    new AgentSideConnection(
      (conn) => createAcpAgent({ bridge, connection: conn, env: {}, version: "test" }),
      ndJsonStream(Writable.toWeb(agentToClient), Readable.toWeb(clientToAgent)),
    );
    const client = startAcpClient(clientToAgent, agentToClient);
    const updates: Array<Record<string, unknown>> = [];
    client.onNotification((method, params) => {
      if (method === "session/update") updates.push(params.update as Record<string, unknown>);
    });
    // 客户端侧应答 agent 的反向请求（session/request_permission、elicitation）。
    const reverseResponses: Array<Record<string, unknown>> = [];
    client.onRequest((id, method, params) => {
      if (method === "session/request_permission") {
        const options = (params as { options: Array<{ optionId: string }> }).options;
        reverseResponses.push(params as Record<string, unknown>);
        client.respond(id, { outcome: { outcome: "selected", optionId: options[0].optionId } });
        return;
      }
      client.respond(id, {});
    });

    const init = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    assert.equal(init.protocolVersion, 1);
    assert.equal((init.agentCapabilities as { loadSession: boolean }).loadSession, false);

    const session = await client.request("session/new", {
      cwd: dir,
      mcpServers: [{ type: "stdio", name: "ignored", command: "noop", args: [], env: [] }],
    });
    assert.equal(session.sessionId, "sess-acp-1");
    const modes = session.modes as { availableModes: Array<{ id: string }>; currentModeId: string };
    assert.ok(modes.availableModes.some((mode) => mode.id === "plan"));
    assert.equal(modes.currentModeId, "build");
    const models = session.models as { currentModelId: string; availableModels: Array<{ modelId: string }> };
    assert.equal(models.currentModelId, "zai/glm-4.6");

    // prompt：fake core 收到 sendText 后发一条权限反向请求，再播事件收口。
    const promptPromise = client.request("session/prompt", {
      sessionId: "sess-acp-1",
      prompt: [{ type: "text", text: "hello" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sendText = core.received.find((entry) => entry.method === "v4/command");
    assert.ok(sendText, "core received v4 sendText");
    core.sendReverseRequest("req-1", "interaction/requestPermission", {
      requestId: "req-1",
      sessionId: "sess-acp-1",
      toolCallId: "tool-1",
      toolName: "Bash",
      reason: "run command",
      riskLevel: "medium",
      input: { command: "ls" },
      options: [
        { optionId: "opt-allow", kind: "allow_once", name: "Allow once", response: { decision: "allow" } },
        { optionId: "opt-deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
      ],
    });
    const permissionResponse = await core.awaitReverseResponse("req-1");
    // 应答必须是 core option.response 原文。
    assert.deepEqual(permissionResponse.result, { decision: "allow" });
    assert.equal(reverseResponses.length, 1);
    core.sendNotification("session/rawEvent", rawEvent("sess-acp-1", 1, "turn_started", { inputId: "x" }));
    core.sendNotification("session/rawEvent", rawEvent("sess-acp-1", 2, "model.streaming", { kind: "text_delta", delta: "hi there" }));
    core.sendNotification("session/rawEvent", rawEvent("sess-acp-1", 3, "turn_complete", {}));
    const promptResult = await promptPromise;
    assert.equal(promptResult.stopReason, "end_turn");
    assert.ok(
      updates.some((u) => u.sessionUpdate === "agent_message_chunk" && (u.content as { text: string }).text === "hi there"),
      "agent_message_chunk projected",
    );

    // setSessionMode → core setMode + current_mode_update。
    const modePromise = client.request("session/set_mode", { sessionId: "sess-acp-1", modeId: "plan" });
    await modePromise;
    assert.ok(core.received.some((entry) => entry.method === "session/setMode" && entry.params?.mode === "plan"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(updates.some((u) => u.sessionUpdate === "current_mode_update" && u.currentModeId === "plan"));

    // cancel：prompt 未收口前发 cancel，core stop 后 turn_complete → cancelled。
    const cancelPrompt = client.request("session/prompt", {
      sessionId: "sess-acp-1",
      prompt: [{ type: "text", text: "long task" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.notify("session/cancel", { sessionId: "sess-acp-1" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(core.received.filter((entry) => entry.method === "v4/command").length >= 2);
    core.sendNotification("session/rawEvent", rawEvent("sess-acp-1", 4, "turn_complete", {}));
    const cancelResult = await cancelPrompt;
    assert.equal(cancelResult.stopReason, "cancelled");

    // close：真实 stop + session/close。
    await client.request("session/close", { sessionId: "sess-acp-1" });
    assert.ok(core.received.some((entry) => entry.method === "session/close"));

    await bridge.close();
    await core.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piz acp: AskUserQuestion elicitation form and plan approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "piz-acp-"));
  try {
    const core = await startFakeCore(dir);
    const agentToClient = new PassThrough();
    const clientToAgent = new PassThrough();
    const bridge = new AcpCoreBridge({
      version: "test",
      env: {},
      ensureConnected: async () => ({ socketPath: core.socketPath }),
    });
    new AgentSideConnection(
      (conn) => createAcpAgent({ bridge, connection: conn, env: {}, version: "test" }),
      ndJsonStream(Writable.toWeb(agentToClient), Readable.toWeb(clientToAgent)),
    );
    const client = startAcpClient(clientToAgent, agentToClient);
    const elicitations: Array<Record<string, unknown>> = [];
    client.onRequest((id, method, params) => {
      if (method === "session/request_permission") {
        const options = (params as { options: Array<{ optionId: string }> }).options;
        client.respond(id, { outcome: { outcome: "selected", optionId: options[0].optionId } });
        return;
      }
      if (method === "elicitation/create") {
        elicitations.push(params as Record<string, unknown>);
        const schema = (params as { requestedSchema: { properties: Record<string, { enum?: string[] }> } }).requestedSchema;
        const key = Object.keys(schema.properties)[0];
        const value = schema.properties[key].enum?.[0] ?? "approve";
        client.respond(id, { action: "accept", content: { [key]: value } });
        return;
      }
      client.respond(id, {});
    });
    await client.request("initialize", { protocolVersion: 1 });
    await client.request("session/new", { cwd: dir, mcpServers: [] });

    // AskUserQuestion → form elicitation（string enum；multiSelect 无 enum）。
    const askPromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      core.sendReverseRequest("req-q", "interaction/requestUserInput", {
        requestId: "req-q",
        sessionId: "sess-acp-1",
        toolName: "AskUserQuestion",
        prompt: "pick one",
        questions: [
          { question: "Which?", header: "Choice", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
          { question: "Which many?", header: "Many", multiSelect: true, options: [{ value: "x", label: "X" }] },
        ],
      });
      return core.awaitReverseResponse("req-q");
    })();
    const askResponse = await askPromise;
    assert.equal(askResponse.result && (askResponse.result as { action: string }).action, "accept");
    const askElicitation = elicitations.find((e) => (e.message as string) === "pick one") as {
      requestedSchema: { properties: Record<string, { enum?: string[]; type: string }> };
    };
    assert.deepEqual(askElicitation.requestedSchema.properties.Choice.enum, ["a", "b"]);
    assert.equal(askElicitation.requestedSchema.properties.Many.enum, undefined, "multiSelect typed as text");

    // ExitPlanMode → approve/reject elicitation。
    await new Promise((resolve) => setTimeout(resolve, 20));
    core.sendReverseRequest("req-p", "interaction/requestUserInput", {
      requestId: "req-p",
      sessionId: "sess-acp-1",
      toolName: "ExitPlanMode",
      prompt: "Approve the plan?",
      schema: { interaction: "plan_approval" },
    });
    const planResponse = await core.awaitReverseResponse("req-p");
    assert.deepEqual(planResponse.result, { action: "accept", content: { answer: "approve" } });

    await bridge.close();
    await core.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
