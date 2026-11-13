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
import { uploadAttachment } from "../src/attach/attach-v4-attachments.js";
import {
  AttachRuntime,
  createAttachPromptHandler,
  type AttachInteractionStatusPort,
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

/** 完整的 wire sessionInfo（makeSnapshot().session 即服务端真实形状），
 *  picker 的 session/list 校验走全量 schema，缺字段的残桩过不了。 */
function sessionInfo(sessionId: string, overrides: Record<string, unknown> = {}) {
  return { ...makeSnapshot().session, sessionId, ...overrides };
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

/** v4 command ACK（shared commandAckSchema 允许的成功形状）。 */
const v4AckAccepted = (commandId: string) => ({
  commandId,
  revisionAtDecision: 1,
  result: { delivery: "startNow", inputId: commandId, type: "inputAccepted" },
  status: "accepted",
});

/** v4/command sendText 夹具：按 commandId 回放 turn_started + turn_complete。 */
function respondV4SendText(
  notify: (params: unknown) => void,
  request: Captured,
  options: { response?: string; turnId?: string } = {},
): unknown {
  const commandId = request.params.commandId as string;
  const text = (request.params.payload as { text?: string }).text ?? "";
  const turnId = options.turnId ?? `turn-${text}`;
  queueMicrotask(() => {
    notify(
      rawEvent({
        inputId: commandId,
        payload: { inputId: commandId, input: text, turnNumber: 1 },
        seq: 1,
        turnId,
        type: "turn_started",
      }),
    );
    notify(
      rawEvent({
        payload: { response: options.response ?? `r-${text}`, resultType: "completed" },
        seq: 2,
        turnId,
        type: "turn_complete",
      }),
    );
  });
  return v4AckAccepted(commandId);
}

test("submitPrompt → v4/command sendText，turn_complete 事件解析出响应", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], sessionId: SID };
    }
    if (request.method === "v4/command") {
      return respondV4SendText(notify, request, { response: "hello back", turnId: "turn-1" });
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    await handle.subscribe();
    const result = await handle.submitPrompt("hi");
    const commands = core.requests.filter((r) => r.method === "v4/command");
    assert.equal(commands.length, 1, "expected exactly one v4/command");
    const send = commands[0];
    assert.equal(send?.params.sessionId, SID);
    assert.equal(send?.params.type, "sendText");
    assert.match(String(send?.params.commandId), /^attach-cmd-/);
    assert.equal((send?.params.payload as { text?: string }).text, "hi");
    // 空闲提交不指定 requestedDelivery（缺省 startNow 语义，忙时 admission 自动排队），
    // 且恒带 keepQueueAndSend（仅 held/choice 生效，避免 v4 stop 后被 disposition 门拒绝）。
    assert.equal((send?.params.payload as { requestedDelivery?: string }).requestedDelivery, undefined);
    assert.equal(
      (send?.params.payload as { heldQueueDisposition?: string }).heldQueueDisposition,
      "keepQueueAndSend",
    );
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
    if (request.method === "v4/command") {
      const commandId = request.params.commandId as string;
      const text = (request.params.payload as { text?: string }).text ?? "";
      turn += 1;
      const turnId = `turn-${turn}`;
      queueMicrotask(() => {
        notify(
          rawEvent({
            inputId: commandId,
            payload: { inputId: commandId, input: text, turnNumber: turn },
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
      return v4AckAccepted(commandId);
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

// P004-F1 的发送失败路径：sendText 的 ACK 被拒（rejected/failed 族）时
// per-turn onEvent 同样要摘除。
test("submitPrompt 发送失败后 per-turn onEvent 即摘除", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "v4/command") {
      return {
        commandId: request.params.commandId,
        message: "core rejected",
        reasonCode: "fault.command.executionFailed",
        revisionAtDecision: 0,
        status: "failed",
      };
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
    assert.equal(events.length, 0, "onEvent must be detached after sendText failure");
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// ACK 失败必须把 pending 等待器一并摘掉：否则后续合法提交会被孤儿等待器的
// firstPending 兜底错误地 settle 到别人的回合。
test("submitPrompt ACK 拒绝后清理等待器，后续提交不受污染", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  let rejected = false;
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "v4/command") {
      const commandId = request.params.commandId as string;
      if (!rejected) {
        rejected = true;
        return {
          commandId,
          reasonCode: "fault.command.executionFailed",
          revisionAtDecision: 0,
          status: "failed",
        };
      }
      return respondV4SendText(notify, request);
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    await handle.subscribe();
    await assert.rejects(() => handle.submitPrompt("no"), /fault\.command\.executionFailed/);
    const ok = await handle.submitPrompt("yes");
    assert.equal(ok.response, "r-yes", "next submit must settle to its own turn");
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// CommandInbox 以 (sessionId, commandId) 持久去重：重发拿到 duplicate 也算成功，
// turn 的解析仍走事件流（关联幂等由 pendingInputId/turnId 保证）。
test("submitPrompt 收到 duplicate ACK 视为成功，turn 仍由事件解析", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "v4/command") {
      const commandId = request.params.commandId as string;
      queueMicrotask(() => {
        notify(
          rawEvent({
            inputId: commandId,
            payload: { inputId: commandId, input: "dup", turnNumber: 1 },
            seq: 1,
            turnId: "turn-dup",
            type: "turn_started",
          }),
        );
        notify(
          rawEvent({
            payload: { response: "r-dup", resultType: "completed" },
            seq: 2,
            turnId: "turn-dup",
            type: "turn_complete",
          }),
        );
      });
      return {
        commandId,
        revisionAtDecision: 3,
        result: { delivery: "startNow", inputId: commandId, type: "inputAccepted" },
        status: "duplicate",
      };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    await handle.subscribe();
    const result = await handle.submitPrompt("dup");
    assert.equal(result.response, "r-dup");
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
  const socketPath = resolveSocketPath({ env: { ZCODE_DATA_BASE_DIR: dir } });
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
    // 退出续接提示走 ctx.stdout：接静默 sink，提示不污染测试输出。
    stdout: { write: () => true } as never,
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
  const socketPath = resolveSocketPath({ env: { ZCODE_DATA_BASE_DIR: dir } });
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
    // 退出续接提示走 ctx.stdout：接静默 sink，提示不污染测试输出。
    stdout: { write: () => true } as never,
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

test("sendInput 忙时本地排队，turn settle 后 drain 成第二条 v4 sendText", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  let finishFirstTurn: (() => void) | undefined;
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "v4/command") {
      const commandId = request.params.commandId as string;
      const content = (request.params.payload as { text?: string }).text ?? "";
      const turnId = `turn-${content}`;
      queueMicrotask(() => {
        notify(
          rawEvent({
            inputId: commandId,
            payload: { inputId: commandId, input: content, turnNumber: 1 },
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
      return v4AckAccepted(commandId);
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
    // 忙期间没有第二条 sendText——排队语义在客户端 FIFO。
    assert.equal(
      core.requests.filter((r) => r.method === "v4/command").length,
      1,
    );
    finishFirstTurn!();
    await first;
    // drain = microtask + 一次 v4/command 往返。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sends = core.requests.filter((r) => r.method === "v4/command");
    assert.equal(sends.length, 2);
    assert.equal((sends[1]?.params.payload as { text?: string }).text, "second");
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

test("stopActiveTurn 显式发 v4/command stop 并等回执；连接断开则尽力返回", async () => {
  // "stop & quit" 路径：abortSignal 的 fire-and-forget v4 stop 之外再显式
  // 发一次并等有界回执，保证退出前 stop 已落线。
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, () => ({}));
  const { client, handle } = await makeHandle(socketPath);
  try {
    await handle.stopActiveTurn();
    const stops = core.requests.filter(
      (r) => r.method === "v4/command" && r.params.type === "stop",
    );
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

test("sendInput '/model …' 经 commandCenter → session/setModel，不发 v4 sendText", async () => {
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
      !core.requests.some(
        (r) => r.method === "v4/command" && r.params.type === "sendText",
      ),
      "slash command must not reach the sendText command lane",
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
    if (request.method === "v4/command") {
      return respondV4SendText(notify, request, { turnId: "turn-forward" });
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
    const sends = core.requests.filter(
      (r) => r.method === "v4/command" && r.params.type === "sendText",
    );
    assert.equal(sends.length, 1, "expected exactly one sendText command");
    // 原文逐字下发（含首行路径与空行）。
    assert.equal((sends[0]?.params.payload as { text?: string }).text, text);
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

test("applyStatePatch 仅思考档位变化也补发 ModelSelected（其他客户端改档位）", () => {
  const handle = new AttachSessionHandle({
    client: () => {
      throw new Error("no client needed");
    },
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  const events: unknown[] = [];
  handle.addSink((event) => events.push(event));
  const modelSelected = () =>
    events.filter((e) => (e as { type?: string }).type === "model_selected").length;
  handle.applyStatePatch({ thoughtLevel: { available: [], current: "low", enabled: true } });
  assert.equal(modelSelected(), 1);
  // 同档位再来一次：幂等。
  handle.applyStatePatch({ thoughtLevel: { available: [], current: "low", enabled: true } });
  assert.equal(modelSelected(), 1);
  handle.applyStatePatch({ thoughtLevel: { available: [], current: "high", enabled: true } });
  assert.equal(modelSelected(), 2);
  // TUI 从事件读档位：事件必须携带最新档位，否则终端显示被清空。
  const last = events.at(-1) as {
    payload: { modelSelection?: { options?: { reasoningLevel?: string } } };
  };
  assert.equal(last.payload.modelSelection?.options?.reasoningLevel, "high");
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
    // /new 的会话与启动 create 同规是 deferred 草稿：首发前不进 session/list，
    // 不被 picker / -c 选中。
    const createCall = core.requests.find((r) => r.method === "session/create");
    assert.equal(createCall?.params.persistence, "deferred");
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

// 回归证据（2026-10-22，`piz` 实测）：TUI 附件形状必须先经协议边界转换成 core
// 认识的引用再提交——v4 迁移后磁盘路径直传 AttachmentRef（零拷贝），草稿占位
// 附件（剪贴板图片 data URL、内联文本）经 begin/chunk/commit 寄存为 URI ref。
test("prompt 附件按 v4 引用下发：磁盘路径直传，data URL/内联文本先寄存", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  let refCounter = 0;
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "v4/attachment/begin") {
      refCounter += 1;
      return {
        nextChunkIndex: 0,
        state: "staging",
        uploadId: request.params.uploadId,
      };
    }
    if (request.method === "v4/attachment/chunk") {
      return { nextChunkIndex: 1, uploadId: request.params.uploadId };
    }
    if (request.method === "v4/attachment/commit") {
      return { ref: `zcode-artifact://up-${refCounter}` };
    }
    if (request.method === "v4/command") {
      return respondV4SendText(notify, request, { turnId: "turn-attach" });
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
    const begins = core.requests.filter((r) => r.method === "v4/attachment/begin");
    assert.equal(begins.length, 2, "path ref needs no upload; image + inline text do");
    const imageBegin = begins.find((r) => r.params.mime === "image/png");
    assert.ok(imageBegin, "expected the image upload begin");
    assert.equal(imageBegin?.params.fileName, "shot.png");
    assert.equal(imageBegin?.params.totalBytes, Buffer.byteLength("png-bytes"));
    assert.equal(imageBegin?.params.totalChunks, 1);
    assert.match(String(imageBegin?.params.checksum), /^sha256:[0-9a-f]{64}$/);
    const textBegin = begins.find((r) => r.params.mime === "text/plain");
    assert.equal(textBegin?.params.fileName, "attachment");
    assert.equal(
      core.requests.filter((r) => r.method === "v4/attachment/chunk").length,
      2,
    );
    assert.equal(
      core.requests.filter((r) => r.method === "v4/attachment/commit").length,
      2,
    );
    const send = core.requests.find(
      (r) => r.method === "v4/command" && r.params.type === "sendText",
    );
    assert.ok(send, "expected v4/command sendText");
    // v4 引用进 payload.attachments（信封不再有顶层 attachments 字段）。
    assert.deepEqual((send.params.payload as { attachments?: unknown[] }).attachments, [
      // 磁盘路径直传：core 端按普通 file 路径附件读取（零上传）。
      { bytes: 0, fileName: "src/alpha.ts", mime: "application/octet-stream", ref: "src/alpha.ts" },
      // 内联文本与图片寄存为 artifact URI ref，core 在模型请求阶段读回
      // （映射按附件数组顺序串行上传：文本先于图片提交）。
      { bytes: 11, fileName: "attachment", mime: "text/plain", ref: "zcode-artifact://up-1" },
      { bytes: 9, fileName: "shot.png", mime: "image/png", ref: "zcode-artifact://up-2" },
    ]);
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 寄存失败必须中止提交并回收暂存：半成品会占用 core 的暂存预算直到 TTL。
test("附件寄存失败 → abort 暂存并让 submitPrompt 如实失败", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  let aborted = false;
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "v4/attachment/begin") {
      return { nextChunkIndex: 0, state: "staging", uploadId: request.params.uploadId };
    }
    if (request.method === "v4/attachment/chunk") {
      return Promise.reject(Object.assign(new Error("chunk rejected"), { code: -32000 }));
    }
    if (request.method === "v4/attachment/abort") {
      aborted = true;
      return {};
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    await handle.subscribe();
    const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;
    await assert.rejects(
      handle.submitPrompt({
        attachments: [{ content: dataUrl, path: "@shot.png", type: "image" }],
        text: "with attachment",
      }),
      /chunk rejected/,
    );
    assert.equal(aborted, true, "staging must be aborted after a failed chunk");
    assert.equal(
      core.requests.some((r) => r.method === "v4/command"),
      false,
      "sendText must not fire when attachment staging fails",
    );
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

for (const stage of ["begin", "chunk", "commit"] as const) {
  test(`abort during attachment ${stage} is handled immediately and never sends the cancelled prompt`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "attach-upload-cancel-"));
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const core = await startFakeCore(join(dir, "core.sock"), async (request) => {
      if (request.method === `v4/attachment/${stage}`) await blocked;
      if (request.method === "v4/attachment/begin") {
        return { nextChunkIndex: 0, state: "staging", uploadId: request.params.uploadId };
      }
      if (request.method === "v4/attachment/chunk") {
        return { nextChunkIndex: 1, uploadId: request.params.uploadId };
      }
      if (request.method === "v4/attachment/commit") return { ref: "zcode-artifact://cancel" };
      return {};
    });
    const runtime = new AttachRuntime({ socketPath: core.socketPath });
    await runtime.connect();
    const handle = new AttachSessionHandle({
      client: () => runtime.currentClient(), sessionId: SID, snapshot: makeSnapshot() as never,
    });
    runtime.registerSession(handle);
    try {
      const submission = assert.rejects(handle.submitPrompt({
        attachments: [
          { content: `data:image/png;base64,${Buffer.alloc(600_000).toString("base64")}`, path: "@first.png", type: "image" },
          { content: "must not upload", type: "file" },
        ],
        text: "cancelled prompt",
      }, { abortSignal: controller.signal }), /aborted/);
      await waitFor(() => core.requests.some((r) => r.method === `v4/attachment/${stage}`));
      const requestsAtAbort = core.requests.length;
      controller.abort();
      // 跨过 Node unhandledRejection 的检查轮次，不能等上传完成才观察 turnPromise。
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(core.requests.length, requestsAtAbort, "no unscoped stop while uploading");
      release?.();
      await submission;
      const uploads = core.requests.filter((r) => r.method === "v4/attachment/begin");
      assert.equal(uploads.length, 1, "do not upload the next attachment");
      assert.equal(core.requests.some((r) => r.method === "v4/command"), false);
      if (stage !== "commit") {
        assert.equal(core.requests.some((r) => r.method === "v4/attachment/abort"), true);
      }
      if (stage === "chunk") {
        assert.equal(core.requests.filter((r) => r.method === "v4/attachment/chunk").length, 1);
        assert.equal(core.requests.some((r) => r.method === "v4/attachment/commit"), false);
      }
    } finally {
      release?.();
      await runtime.close();
      await core.close();
      await rm(dir, { force: true, recursive: true });
    }
  });
}

test("already aborted submissions never upload or send commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-pre-abort-"));
  const core = await startFakeCore(join(dir, "core.sock"), () => ({}));
  const runtime = new AttachRuntime({ socketPath: core.socketPath });
  await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(), sessionId: SID, snapshot: makeSnapshot() as never,
  });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(handle.submitPrompt({
      attachments: [{ content: "not uploaded", type: "file" }], text: "no send",
    }, { abortSignal: controller.signal }), /aborted/);
    await assert.rejects(handle.submitPrompt("no send", { abortSignal: controller.signal }), /aborted/);
    assert.equal(core.requests.length, 0);
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("a completed submission detaches its abort listener before the next turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-abort-listener-"));
  const core = await startFakeCore(join(dir, "core.sock"), (request, notify) =>
    respondV4SendText(notify, request));
  const runtime = new AttachRuntime({ socketPath: core.socketPath });
  await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(), sessionId: SID, snapshot: makeSnapshot() as never,
  });
  runtime.registerSession(handle);
  const controller = new AbortController();
  try {
    await handle.submitPrompt("completed", { abortSignal: controller.signal });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(core.requests.some((r) => r.method === "v4/command" && r.params.type === "stop"), false);
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("a late completion from an aborted turn cannot settle a newer pending prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-stale-complete-"));
  const core = await startFakeCore(join(dir, "core.sock"), (request, notify) => {
    if (request.params.type === "stop") return v4AckAccepted(String(request.params.commandId));
    if ((request.params.payload as { text?: string })?.text === "old") {
      notify(rawEvent({
        payload: { inputId: request.params.commandId, input: "old", turnNumber: 1 },
        seq: 1, turnId: "old-turn", type: "turn_started",
      }));
    }
    return v4AckAccepted(String(request.params.commandId));
  });
  const runtime = new AttachRuntime({ socketPath: core.socketPath });
  await runtime.connect();
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(), sessionId: SID, snapshot: makeSnapshot() as never,
  });
  runtime.registerSession(handle);
  const controller = new AbortController();
  try {
    const old = assert.rejects(handle.submitPrompt("old", { abortSignal: controller.signal }), /aborted/);
    await waitFor(() => handle.eventSeq === 1);
    controller.abort();
    await old;
    let settled = false;
    const next = handle.submitPrompt("new").then((result) => { settled = true; return result; });
    await waitFor(() => core.requests.filter((r) => r.params.type === "sendText").length === 2);
    core.notify(rawEvent({
      payload: { response: "stale" }, seq: 2, turnId: "old-turn", type: "turn_complete",
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, "explicit old turnId must not fall through to firstPending");
    const sent = core.requests.find((r) => (r.params.payload as { text?: string })?.text === "new");
    core.notify(rawEvent({
      payload: { inputId: sent?.params.commandId, input: "new", turnNumber: 2 },
      seq: 3, turnId: "new-turn", type: "turn_started",
    }));
    core.notify(rawEvent({
      payload: { response: "fresh" }, seq: 4, turnId: "new-turn", type: "turn_complete",
    }));
    assert.equal((await next).response, "fresh");
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

for (const diagnostics of ["logger", "stderr", "throwing logger"] as const) {
  test(`failed upload cleanup reports via ${diagnostics} without replacing the primary error`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "attach-upload-cleanup-"));
    const core = await startFakeCore(join(dir, "core.sock"), async (request) => {
      if (request.method === "v4/attachment/begin") {
        return { nextChunkIndex: 0, state: "staging", uploadId: request.params.uploadId };
      }
      if (request.method === "v4/attachment/chunk") throw new Error("primary chunk failure");
      if (request.method === "v4/attachment/abort") throw new Error("cleanup failure");
      return {};
    });
    const client = await connectAttachClient(core.socketPath);
    const lines: string[] = [];
    if (diagnostics !== "logger") {
      t.mock.method(process.stderr, "write", (line: string) => { lines.push(line); return true; });
    }
    try {
      await assert.rejects(uploadAttachment(client, {
        bytes: Buffer.from("upload"), connectionId: "conn", fileName: "fixture.txt",
        mime: "text/plain", sessionId: SID,
        logger: diagnostics === "stderr" ? undefined : {
          warn: (message) => {
            if (diagnostics === "throwing logger") throw new Error("logger failure");
            lines.push(message);
          },
        },
      }), /primary chunk failure/);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /attach v4 upload abort cleanup failed \(uploadId attach-up-[^)]+\): cleanup failure/);
      const begin = core.requests.find((r) => r.method === "v4/attachment/begin");
      const abort = core.requests.find((r) => r.method === "v4/attachment/abort");
      assert.equal(abort?.params.uploadId, begin?.params.uploadId);
    } finally {
      client.close();
      await core.close();
      await rm(dir, { force: true, recursive: true });
    }
  });
}

for (const beginReply of ["malformed", "committed"] as const) {
  test(`unexpected ${beginReply} begin receipt cleans up and never submits a prompt`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "attach-upload-begin-"));
    const core = await startFakeCore(join(dir, "core.sock"), (request) => {
      if (request.method === "v4/attachment/begin") {
        return beginReply === "malformed" ? { state: "bad" } : {
          nextChunkIndex: 1, ref: "zcode-artifact://unexpected",
          state: "committed", uploadId: request.params.uploadId,
        };
      }
      return {};
    });
    const client = await connectAttachClient(core.socketPath);
    const handle = new AttachSessionHandle({
      client, sessionId: SID, snapshot: makeSnapshot() as never,
    });
    try {
      await assert.rejects(handle.submitPrompt({
        attachments: [{ content: "upload", type: "file" }], text: "no send",
      }));
      assert.deepEqual(core.requests.map((r) => r.method), ["v4/attachment/begin", "v4/attachment/abort"]);
      assert.equal(core.requests[0].params.uploadId, core.requests[1].params.uploadId);
    } finally {
      client.close();
      await core.close();
      await rm(dir, { force: true, recursive: true });
    }
  });
}

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
      !core.requests.some(
        (r) => r.method === "v4/command" && r.params.type === "sendText",
      ),
      "bare /skill must not reach the sendText command lane",
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
    if (request.method === "v4/command") {
      const commandId = request.params.commandId as string;
      queueMicrotask(() => {
        notify(
          rawEvent({
            inputId: commandId,
            payload: { inputId: commandId, response: "skill turn done", resultType: "completed" },
            seq: 1,
            turnId: "turn-skill",
            type: "turn_complete",
          }),
        );
      });
      return v4AckAccepted(commandId);
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
    const send = core.requests.find(
      (r) => r.method === "v4/command" && r.params.type === "sendText",
    );
    assert.ok(send, "expected v4/command sendText");
    const content = String((send.params.payload as { text?: string }).text);
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

function interactionCoreResponder(request: Captured, notify: (params: unknown) => void): unknown {
  if (request.method === "session/subscribe") {
    return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
  }
  if (request.method === "v4/command") {
    if (request.params.type === "sendText") {
      queueMicrotask(() => notify(rawEvent({
        payload: { inputId: request.params.commandId, turnNumber: 1 },
        seq: 1, turnId: "turn-1", type: "turn_started",
      })));
    }
    return v4AckAccepted(String(request.params.commandId));
  }
  return {};
}

async function startInteractionFixture(
  dir: string,
  interactionStatus?: AttachInteractionStatusPort,
): Promise<{
  core: FakeCore;
  handle: AttachSessionHandle;
  runtime: AttachRuntime;
}> {
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, interactionCoreResponder);
  const runtime = new AttachRuntime({
    socketPath,
    ...(interactionStatus ? { interactionStatus } : {}),
  });
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
    await waitFor(() => core.requests.some((r) => r.method === "v4/command"));
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
    await waitFor(() => core.requests.some((r) => r.method === "v4/command"));
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
    await waitFor(() => core.requests.some((r) => r.method === "v4/command"));
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
    await waitFor(() => core.requests.some((r) => r.method === "v4/command"));
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
    await waitFor(() => core.requests.some((r) => r.method === "v4/command"));
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
    await waitFor(() => core.requests.some((r) => r.method === "v4/command"));
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
    await waitFor(() => core.requests.some((r) => r.method === "v4/command"));
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

// ── interaction 面板状态端口（OSC 7501 reporter 的 blocked 真相源）──
// 契约（spec「OSC 7501 程序状态上报」）：面板真正渲染给用户期间
// interactionBlocked（permission 审批 / question wizard 各带 kind 与 msg），
// settle 后 interactionResolved；无 handler 早退（面板从未出现）不触发。

test("interactionStatus 端口：三种面板 blocked/resolved，无 handler 不触发", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-interaction-"));
  type PortCall = { kind: "blocked" | "resolved"; blockedKind?: string; message?: string };
  const calls: PortCall[] = [];
  const port: AttachInteractionStatusPort = {
    interactionBlocked: (kind, message) => {
      calls.push({ kind: "blocked", blockedKind: kind, message });
    },
    interactionResolved: () => {
      calls.push({ kind: "resolved" });
    },
  };
  const { core, handle, runtime } = await startInteractionFixture(dir, port);
  let release: (() => void) | undefined;
  try {
    const turn = handle.submitPrompt("hi", {
      requestPermission: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { decision: "allow", reason: "ok", resolvedAt: new Date() };
      },
    });
    await waitFor(() => core.requests.some((r) => r.method === "v4/command"));
    calls.length = 0;

    // AskUserQuestion → question wizard。
    core.sendRequest("srv-q", "interaction/requestUserInput", {
      prompt: "need clarification",
      requestId: "req-port-q",
      schema: { toolName: "AskUserQuestion" },
      sessionId: SID,
      toolName: "AskUserQuestion",
    });
    await waitFor(() => calls.some((c) => c.kind === "blocked"));
    release?.();
    await waitFor(() => core.responses.some((r) => r.id === "srv-q"));
    await waitFor(() => calls.some((c) => c.kind === "resolved"));

    // ExitPlanMode → plan_approval 走普通审批面板（kind=permission）。
    core.sendRequest("srv-p1", "interaction/requestUserInput", {
      requestId: "req-port-p1",
      schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
      sessionId: SID,
      toolName: "ExitPlanMode",
    });
    await waitFor(() => calls.filter((c) => c.kind === "blocked").length === 2);
    release?.();
    await waitFor(() => core.responses.some((r) => r.id === "srv-p1"));
    await waitFor(() => calls.filter((c) => c.kind === "resolved").length === 2);

    // 普通审批 → permission + "permission: <toolName>"。
    core.sendRequest("srv-p2", "interaction/requestPermission", {
      input: { command: "rm x" },
      options: PERMISSION_OPTIONS,
      reason: "Bash requires approval",
      requestId: "req-port-p2",
      riskLevel: "high",
      sessionId: SID,
      toolCallId: "tc-1",
      toolName: "Bash",
    });
    await waitFor(() => calls.filter((c) => c.kind === "blocked").length === 3);
    release?.();
    await waitFor(() => core.responses.some((r) => r.id === "srv-p2"));
    await waitFor(() => calls.filter((c) => c.kind === "resolved").length === 3);

    const blocked = calls.filter((c) => c.kind === "blocked");
    assert.deepEqual(
      blocked.map((c) => [c.blockedKind, c.message]),
      [
        ["question", "need clarification"],
        ["permission", "plan approval"],
        ["permission", "permission: Bash"],
      ],
    );

    // 无 handler 早退：面板从未渲染，端口不得触发（userInput 与 permission
    // 两条路由都要钉——早退守卫在端口调用之前是各自独立的）。
    const before = calls.length;
    core.sendRequest("srv-nh", "interaction/requestUserInput", {
      requestId: "req-port-nh",
      schema: { toolName: "AskUserQuestion" },
      sessionId: "other-session",
      toolName: "AskUserQuestion",
    });
    core.sendRequest("srv-nhp", "interaction/requestPermission", {
      input: {},
      options: PERMISSION_OPTIONS,
      reason: "approval",
      requestId: "req-port-nhp",
      riskLevel: "low",
      sessionId: "other-session",
      toolCallId: "tc-9",
      toolName: "Bash",
    });
    await waitFor(() => core.responses.some((r) => r.id === "srv-nh"));
    await waitFor(() => core.responses.some((r) => r.id === "srv-nhp"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, before, "no port calls without a rendered panel");

    finishTurn(core);
    await turn;
  } finally {
    release?.();
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// ── 自定义命令（commands/referenceCatalog）──
// 契约：目录经协议取（瘦客户端不本地重扫），展开留在 core 的 input facade ——
// 未知 `/name args` 必须原文转发 v4 sendText（客户端侧展开会砍 !`cmd` 动态语法）。

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
      !core.requests.some(
        (r) => r.method === "v4/command" && r.params.type === "sendText",
      ),
      "help must not reach the sendText command lane",
    );
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("/review 参数原文转发 v4 sendText（展开在 core 的 input facade，不在客户端）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request, notify) => {
    if (request.method === "commands/referenceCatalog") return commandCatalog;
    if (request.method === "v4/command") {
      return respondV4SendText(notify, request, { turnId: "t" });
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
    const sends = core.requests.filter(
      (r) => r.method === "v4/command" && r.params.type === "sendText",
    );
    assert.equal(sends.length, 1, "expected exactly one sendText command");
    // 逐字转发：客户端不做任何展开/改写 —— core 的 facade 负责并记 displayInput。
    assert.equal(
      (sends[0]?.params.payload as { text?: string }).text,
      "/review apps/cli/src/main.ts",
    );
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
  const socketPath = resolveSocketPath({ env: { ZCODE_DATA_BASE_DIR: dir } });
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
      { argv: [], stderr: process.stderr, stdin: process.stdin, stdout: { write: () => true } } as never,
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
    notify: (params: unknown) => void,
  ) => unknown = (request) => ({
    ...v4AckAccepted(String(request.params.commandId)),
    result: { delivery: "queue", inputId: request.params.commandId, type: "inputAccepted" },
  }),
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
    if (request.method === "v4/command") {
      if (request.params.type === "stop") return {};
      if (request.params.type === "sendText") {
        if ((request.params.payload as { requestedDelivery?: string }).requestedDelivery === "guide") {
          return respondSteer(request, notify);
        }
        const commandId = request.params.commandId as string;
        queueMicrotask(() => {
          notify(
            rawEvent({
              inputId: commandId,
              payload: {
                inputId: commandId,
                input: (request.params.payload as { text?: string }).text,
                turnNumber: 1,
              },
              seq: 1,
              turnId: "turn-busy",
              type: "turn_started",
            }),
          );
        });
        return v4AckAccepted(commandId);
      }
      return {};
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

test("busy sendInput delivery steer → v4 sendText guide，pendingInputId 客户端自算", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-steer-"));
  const { core, handle, runtime, settleFirstTurn } = await startBusyFixture(dir);
  const events: Array<{ payload: Record<string, unknown>; type: string }> = [];
  handle.addSink((event) => events.push(event as never));
  try {
    const result = await handle.sendInput("redirect please", { delivery: "steer" });
    assert.equal(result.kind, "queued");
    const steerSend = core.requests.find(
      (r) =>
        r.method === "v4/command" &&
        r.params.type === "sendText" &&
        (r.params.payload as { requestedDelivery?: string }).requestedDelivery === "guide",
    );
    assert.ok(steerSend, "expected v4 sendText with requestedDelivery guide");
    assert.equal((steerSend.params.payload as { text?: string }).text, "redirect please");
    assert.equal(steerSend.params.sessionId, SID);
    assert.equal(
      (steerSend.params.payload as { heldQueueDisposition?: string }).heldQueueDisposition,
      "keepQueueAndSend",
    );
    if (result.kind === "queued") {
      // core 以 queue_<commandId> 作队列项 id（intent.queueItemId → pendingInputId），
      // 客户端无需等回执即可对齐 TUI 队列行的幂等 upsert 键。
      assert.equal(result.pendingInputId, `queue_${steerSend.params.commandId}`);
      assert.equal(result.queueLength, 1);
    }
    // steer 不落本地 follow-up 队列：settle 后不得重放第二条 sendText。
    settleFirstTurn();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const sends = core.requests.filter(
      (r) => r.method === "v4/command" && r.params.type === "sendText",
    );
    assert.equal(
      sends.filter(
        (r) => (r.params.payload as { requestedDelivery?: string }).requestedDelivery !== "guide",
      ).length,
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

for (const eventsBeforeAck of [true, false]) {
  test(`guide admitted after idle returns a real started_turn (events ${eventsBeforeAck ? "before" : "after"} ACK)`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "attach-steer-idle-"));
    const { core, handle, runtime } = await startBusyFixture(dir, (request, notify) => {
      const notifyTurns = (): void => {
        notify(rawEvent({
          payload: { response: "old done", resultType: "completed" },
          seq: 2, turnId: "turn-busy", type: "turn_complete",
        }));
        notify(rawEvent({
          payload: { inputId: request.params.commandId, input: "new prompt", turnNumber: 2 },
          seq: 3, turnId: "turn-raced", type: "turn_started",
        }));
        notify(rawEvent({
          payload: { response: "new response", resultType: "completed" },
          seq: 4, turnId: "turn-raced", type: "turn_complete",
        }));
      };
      if (eventsBeforeAck) notifyTurns();
      else setTimeout(notifyTurns, 20);
      return v4AckAccepted(String(request.params.commandId));
    });
    const events: string[] = [];
    handle.addSink((event) => events.push(event.type));
    try {
      const outcome = await handle.sendInput("new prompt", { delivery: "steer" });
      assert.equal(outcome.kind, "started_turn", "accepted guide is not necessarily queued");
      if (outcome.kind === "started_turn") {
        assert.equal(outcome.result.turnId, "turn-raced");
        assert.equal(outcome.result.response, "new response");
      }
      assert.equal(events.includes("turn_steer_queued"), false, "no phantom steering row");
      assert.equal(events.includes("turn_steer_drained"), false, "TUI started_turn owns user echo");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(core.requests.filter((r) => r.method === "v4/command" && r.params.type === "sendText").length, 2,
        "the accepted input must never be replayed");
    } finally {
      await runtime.close();
      await core.close();
      await rm(dir, { force: true, recursive: true });
    }
  });
}

test("a late guide rejection still flushes its local fallback after the old turn settled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-steer-late-reject-"));
  const { core, handle, runtime } = await startBusyFixture(dir, async (request, notify) => {
    notify(rawEvent({
      payload: { response: "done", resultType: "completed" },
      seq: 2, turnId: "turn-busy", type: "turn_complete",
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      commandId: request.params.commandId, reasonCode: "fault.command.inputRejected",
      revisionAtDecision: 0, status: "rejected",
    };
  });
  try {
    const outcome = await handle.sendInput("fallback", { delivery: "steer" });
    assert.equal(outcome.kind, "queued");
    await waitFor(() => core.requests.filter((r) => r.method === "v4/command" && r.params.type === "sendText").length === 3);
    const replay = core.requests.filter((r) => r.method === "v4/command" && r.params.type === "sendText")[2];
    assert.equal((replay.params.payload as { text: string }).text, "fallback");
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("steer 被拒（ACK failed/rejected 族）回退本地 follow-up 队列", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-steer-reject-"));
  const rejectSteer = (request: Captured): unknown => ({
    commandId: request.params.commandId,
    reasonCode: "fault.command.inputRejected",
    revisionAtDecision: 0,
    status: "rejected",
  });
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

test("steer 协议级失败（传输/schema 错误，非 ACK 拒绝）如实上抛", async () => {
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

test("busy sendInput delivery queue → 本地 follow-up 队列，不触 v4 命令面", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-queue-"));
  const { core, handle, runtime, settleFirstTurn } = await startBusyFixture(dir);
  const events: Array<{ payload: Record<string, unknown>; type: string }> = [];
  handle.addSink((event) => events.push(event as never));
  try {
    const result = await handle.sendInput("after you finish", { delivery: "queue" });
    assert.equal(result.kind, "queued");
    assert.equal(
      core.requests.some(
        (r) =>
          r.method === "v4/command" &&
          r.params.type === "sendText" &&
          (r.params.payload as { requestedDelivery?: string }).requestedDelivery === "guide",
      ),
      false,
      "explicit queue must not touch the v4 steer lane",
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
    if (request.method === "v4/command") {
      const commandId = String(request.params.commandId);
      queueMicrotask(() => {
        core.notify(
          rawEvent({
            inputId: commandId,
            payload: {
              inputId: commandId,
              input: (request.params.payload as { text?: string }).text,
              turnNumber: 1,
            },
            seq: 1,
            turnId: "turn-busy",
            type: "turn_started",
          }),
        );
      });
      return v4AckAccepted(commandId);
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

// 回归证据（2026-11-02）：attach 曾缺 CommandCenterDeps.listSessions，TUI 裸
// /resume 落到 resumeApp 按 updatedAt 猜"最近会话"——刚绑定的当前会话往往
// 最新，picker 意图被静默降级成恢复自己。现与 monolith 同规走 composer
// picker：列表按 updatedAt 降序、剔除当前会话，选定前零 resume/create。
test("TUI 裸 /resume 打开会话 picker：按 updatedAt 降序且剔除当前会话", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-resume-picker-"));
  const socketPath = join(dir, "core.sock");
  // 故意混排，并掺入比已保存会话更新的当前会话：picker 只列已保存会话，
  // 当前绑定不能成为"恢复自己"的条目。
  const listed = [
    sessionInfo("sess-stale", { title: "stale session", updatedAt: 100 }),
    sessionInfo(SID, { title: "current draft", updatedAt: 999 }),
    sessionInfo("sess-newest", { title: "newest session", updatedAt: 300 }),
    sessionInfo("sess-fork", {
      parentSessionId: "sess-parent-0001",
      title: "forked session",
      updatedAt: 200,
    }),
  ];
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/list") {
      return { sessions: listed };
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
    const result = await handler("/resume", {});
    const selection = result.selection;
    assert.equal(selection?.title, "Resume Session");
    assert.equal(selection?.placement, "composer");
    assert.deepEqual(
      selection?.items.map((item) => item.id),
      ["sess-newest", "sess-fork", "sess-stale"],
    );
    assert.equal(selection?.items[0]?.command, "/resume sess-newest");
    assert.equal(selection?.items[0]?.primary, "newest session");
    assert.match(selection?.items[0]?.secondary ?? "", /\/tmp\/ws/);
    assert.match(selection?.items[1]?.meta ?? "", /fork of sess-parent-0001/);
    // 列表请求必须携带 workspace ref（core 按它定界）。
    const listCall = core.requests.find((r) => r.method === "session/list");
    assert.deepEqual(listCall?.params.workspace, {
      workspaceKey: "/tmp/ws",
      workspacePath: "/tmp/ws",
    });
    // picker 展示期间不做任何绑定变更或 resume/create。
    assert.equal(handler.getMainSessionId?.(), SID);
    assert.ok(!core.requests.some((r) => r.method === "session/resume"));
    assert.ok(!core.requests.some((r) => r.method === "session/create"));
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 选定项的 command（/resume <full id>）走与入口同一 resolver：
// session/resume 携带 workspace ref，绑定/换 transcript 到目标会话。
test("picker 选定项经 /resume <id> 恢复目标会话并携带 workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-resume-pick-"));
  const socketPath = join(dir, "core.sock");
  const listed = [
    sessionInfo("sess-alpha", { title: "alpha", updatedAt: 300 }),
    sessionInfo("sess-beta", { title: "beta", updatedAt: 200 }),
  ];
  const restored = [
    {
      info: {
        agent: "main",
        messageId: "m1",
        role: "user",
        sessionId: "sess-alpha",
        time: { created: 1 },
      },
      parts: [
        {
          messageId: "m1",
          partId: "p1",
          sessionId: "sess-alpha",
          text: "restored transcript",
          type: "text",
        },
      ],
    },
  ];
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return {
        eventSeq: 0,
        events: [],
        rawEvents: [],
        sessionId: request.params.sessionId,
      };
    }
    if (request.method === "session/list") {
      return { sessions: listed };
    }
    if (request.method === "session/resume") {
      return { sessionId: request.params.sessionId };
    }
    if (request.method === "session/messages") {
      return { messages: restored };
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
    const first = await handler("/resume", {});
    const command = first.selection?.items[0]?.command;
    assert.equal(command, "/resume sess-alpha");
    const result = await handler(command!, {});
    assert.equal(handler.getMainSessionId?.(), "sess-alpha");
    assert.match(result.response ?? "", /Resumed session sess-alpha/);
    const resumeCall = core.requests.find((r) => r.method === "session/resume");
    assert.equal(resumeCall?.params.sessionId, "sess-alpha");
    assert.deepEqual(resumeCall?.params.workspace, {
      workspaceKey: "/tmp/ws",
      workspacePath: "/tmp/ws",
    });
    assert.deepEqual(result.restoredMessages?.[0]?.parts, [
      { text: "restored transcript", type: "text" },
    ]);
    assert.ok(!core.requests.some((r) => r.method === "session/create"));
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 空列表分支：渲染 picker 既有空态（不再退回 resumeApp 猜最近会话），
// 绑定不变、零 resume/create。
test("TUI 裸 /resume 空列表渲染 picker 空态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-resume-empty-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/list") {
      return { sessions: [] };
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
    const result = await handler("/resume", {});
    assert.equal(result.selection?.title, "Resume Session");
    assert.deepEqual(result.selection?.items, []);
    assert.equal(result.selection?.emptyMessage, "No saved sessions found for this directory.");
    assert.equal(handler.getMainSessionId?.(), SID);
    assert.ok(!core.requests.some((r) => r.method === "session/resume"));
    assert.ok(!core.requests.some((r) => r.method === "session/create"));
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 列表传输失败必须原样抛错：退回"猜最近会话"会在 core 半挂时静默恢复
// 陈旧会话——picker 意图不允许降级成猜测。
test("TUI 裸 /resume 列表传输失败原样抛错，不回退猜测", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-resume-listfail-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/list") {
      // 同步 throw 会逃出假 core 的 data handler（不落地成 error 应答）；
      // 传输失败要回一个 rejected promise，让 server 侧 catch 成协议错误。
      return Promise.reject(new Error("core gone"));
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
    await assert.rejects(handler("/resume", {}), /core gone/);
    assert.equal(handler.getMainSessionId?.(), SID);
    assert.ok(!core.requests.some((r) => r.method === "session/resume"));
    assert.ok(!core.requests.some((r) => r.method === "session/create"));
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 畸形列表载荷必须显式抛错（全量 schema 校验）：残缺会话进入 picker 会
// 产出缺 id/目录的"幽灵"条目，比直接失败更难排查。
test("TUI 裸 /resume 畸形列表载荷显式抛错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-resume-malformed-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/list") {
      // 缺 sessionId/workspace/title 等必需字段：过不了 zcodeSessionInfoSchema。
      return { sessions: [{ id: "sess-legacy", updatedAt: 100 }] };
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
    await assert.rejects(handler("/resume", {}));
    assert.equal(handler.getMainSessionId?.(), SID);
    assert.ok(!core.requests.some((r) => r.method === "session/resume"));
    assert.ok(!core.requests.some((r) => r.method === "session/create"));
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// /resume <id> 在 TUI 内走与入口同一前缀裁决：唯一短前缀展开成完整 id，
// 歧义前缀在任何绑定/resume 之前报错。
test("TUI /resume <唯一前缀> 展开为完整 id 恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-resume-prefix-"));
  const socketPath = join(dir, "core.sock");
  const fullId = "sess_99f180d5-a07d-4424-87d7-5dda4402a881";
  const listed = [
    sessionInfo(fullId, { title: "target", updatedAt: 200 }),
    sessionInfo("sess_3852f4bf", { title: "other", updatedAt: 100 }),
  ];
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return {
        eventSeq: 0,
        events: [],
        rawEvents: [],
        sessionId: request.params.sessionId,
      };
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
    const result = await handler("/resume sess_99f180d5", {});
    assert.match(result.response ?? "", new RegExp(`Resumed session ${fullId}`));
    assert.equal(handler.getMainSessionId?.(), fullId);
    const resumeCall = core.requests.find((r) => r.method === "session/resume");
    assert.equal(resumeCall?.params.sessionId, fullId);
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("TUI /resume <歧义前缀> 在任何绑定或 resume 前报错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-resume-ambig-"));
  const socketPath = join(dir, "core.sock");
  const listed = [
    sessionInfo("sess_dup_aaaa", { updatedAt: 200 }),
    sessionInfo("sess_dup_bbbb", { updatedAt: 100 }),
  ];
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/list") {
      return { sessions: listed };
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
    await assert.rejects(handler("/resume sess_dup", {}), /ambiguous: matches 2 sessions/);
    assert.equal(handler.getMainSessionId?.(), SID);
    assert.ok(!core.requests.some((r) => r.method === "session/resume"));
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

// ── /goal 与 /dwf 的 handle wire 面（goalCommand / workflowRuns / resumeWorkflowRun）──

test("goalCommand 校验回包并合并快照 settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const snapshot = makeSnapshot();
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/goal") {
      return {
        response: "Goal active\nObjective: ship it",
        snapshot: {
          ...snapshot,
          settings: {
            ...snapshot.settings,
            model: { ...snapshot.settings.model, current: { modelId: "glm-5.3", providerId: "zai" } },
          },
        },
        startedTurn: true,
      };
    }
    throw new Error(`unexpected request: ${request.method}`);
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    const result = await handle.goalCommand({
      action: "set",
      inputId: "acp-goal-1",
      objective: "ship it",
    });
    assert.equal(result.response, "Goal active\nObjective: ship it");
    assert.equal(result.startedTurn, true);
    const call = core.requests.find((r) => r.method === "session/goal");
    assert.deepEqual(call?.params, {
      action: "set",
      inputId: "acp-goal-1",
      objective: "ship it",
      sessionId: SID,
    });
    assert.equal(handle.getModel(), "zai/glm-5.3", "回包快照必须并入 handle");
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("goalCommand 不透传空 objective，schema 外字段被拒", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/goal") {
      return { response: "ok", snapshot: makeSnapshot() };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    await handle.goalCommand({ action: "show", inputId: "acp-goal-2" });
    const call = core.requests.find((r) => r.method === "session/goal");
    assert.deepEqual(call?.params, { action: "show", inputId: "acp-goal-2", sessionId: SID });
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("listDynamicWorkflowRuns 走 v4 workflowRuns query 并校验条目", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "v4/conversation/workflowRuns") {
      return {
        runs: [
          { label: "deploy check", resumable: true, runId: "dwfrun_1", status: "stopped", updatedAt: 1_700_000_000_000 },
          { resumable: false, runId: "dwfrun_2", status: "running" },
        ],
      };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    const runs = await handle.listDynamicWorkflowRuns({ limit: 20 });
    assert.equal(runs.length, 2);
    assert.equal(runs[0]?.label, "deploy check");
    assert.equal(runs[0]?.resumable, true);
    const call = core.requests.find((r) => r.method === "v4/conversation/workflowRuns");
    assert.deepEqual(call?.params, { limit: 20, sessionId: SID });
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("resumeWorkflowRun：accepted → ok；业务拒绝还原结构化 reason；其它 fault 上抛", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  let ack: Record<string, unknown> = {
    commandId: "stub",
    revisionAtDecision: 1,
    status: "accepted",
  };
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "v4/command") {
      const payload = (request.params as { payload?: { workId?: string } }).payload;
      assert.equal((request.params as { type?: string }).type, "resumeWorkflowRun");
      return { ...ack, commandId: (request.params as { commandId: string }).commandId, workId: payload?.workId };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    const ok = await handle.resumeWorkflowRun({ workId: "dwfrun_1" });
    assert.deepEqual(ok, { ok: true, runId: "dwfrun_1" });

    ack = {
      commandId: "stub",
      message: "only a stopped run can be resumed",
      reasonCode: "fault.command.workflowRunResumeRejected.not_resumable",
      revisionAtDecision: 1,
      status: "rejected",
    };
    const rejected = await handle.resumeWorkflowRun({ workId: "dwfrun_2" });
    assert.deepEqual(rejected, {
      message: "only a stopped run can be resumed",
      ok: false,
      reason: "not_resumable",
    });

    ack = {
      commandId: "stub",
      reasonCode: "fault.command.capabilityUnsupported",
      revisionAtDecision: 1,
      status: "rejected",
    };
    await assert.rejects(
      handle.resumeWorkflowRun({ workId: "dwfrun_3" }),
      /capabilityUnsupported/,
    );
    const commands = core.requests.filter((r) => r.method === "v4/command");
    assert.deepEqual(
      commands.map((r) => (r.params as { payload?: { workId?: string } }).payload?.workId),
      ["dwfrun_1", "dwfrun_2", "dwfrun_3"],
    );
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("cancelBackgroundTask 发严格 schema 的 taskId 键并校验回包", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, (request) => {
    if (request.method === "session/cancelBackgroundTask") {
      // 回包按共享 strict schema 校验：缺 taskId/status 会被拒。
      return { cancelled: true, status: "cancelled", taskId: "dwfrun_live" };
    }
    return {};
  });
  const { client, handle } = await makeHandle(socketPath);
  try {
    const result = await handle.cancelBackgroundTask("dwfrun_live");
    assert.deepEqual(result, { cancelled: true, status: "cancelled", taskId: "dwfrun_live" });
    const call = core.requests.find((r) => r.method === "session/cancelBackgroundTask");
    // wire 键是 taskId（strict params schema）；早年误发 backgroundTaskId 会被 core
    // -32602 拒掉每一次 /dwf cancel——deepEqual 保证没有多余键。
    assert.deepEqual(call?.params, { sessionId: SID, taskId: "dwfrun_live" });
  } finally {
    client.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});

// 冷恢复的 session/resume（core 重启后 subscribe 找不到 record → recoverSession
// 冷物化）也要带入口解析出的灰度参数：runtime 重建时服务端重读灰度门，不带就
// 丢回进程级结论（fail-closed），onDemand 会话的工作流工具面会静默丢失。
test("onDemand：断线冷恢复的 session/resume 携带灰度参数", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attach-adapter-"));
  const socketPath = join(dir, "core.sock");
  let cold = false;
  let resumed = false;
  const responder = (request: Captured): unknown => {
    if (request.method === "session/subscribe") {
      if (cold && !resumed) {
        return Promise.reject(
          Object.assign(new Error("session unavailable"), {
            code: zcodeProtocolErrorCodes.sessionUnavailable,
          }),
        );
      }
      return { eventSeq: 0, events: [], rawEvents: [], sessionId: SID };
    }
    if (request.method === "session/resume") {
      resumed = true;
      return {};
    }
    return {};
  };
  let core = await startFakeCore(socketPath, responder);
  const runtime = new AttachRuntime({
    socketPath,
    workflowMode: "onDemand",
    workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
  });
  const handle = new AttachSessionHandle({
    client: () => runtime.currentClient(),
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  runtime.registerSession(handle);
  const client = await runtime.connect();
  try {
    await handle.subscribe();
    await core.kill();
    await client.closed;
    cold = true;
    core = await startFakeCore(socketPath, responder);
    // 第一轮重连退避 1s；resubscribe 先撞 sessionUnavailable 再走 session/resume。
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const resumes = core.requests.filter((r) => r.method === "session/resume");
    assert.equal(resumes.length, 1, "cold recovery must resume the session once");
    assert.equal(resumes[0]?.params.sessionId, SID);
    assert.equal(resumes[0]?.params.dynamicWorkflowEnabled, true);
    assert.equal(resumes[0]?.params.dynamicWorkflowMode, "onDemand");
  } finally {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  }
});
