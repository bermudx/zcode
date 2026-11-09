// ACP 测试用的"假 core"：真实 unix socket 上的 ZCode Protocol 服务端子集。
//
// 为什么不是 mock 掉 socket：ACP 前端的价值全在"两跳协议之间"的翻译上，
// 把其中一跳换成函数桩就测不到 id 关联、反向请求、事件顺序这些真正会坏的地方。
// 这里的 server 与 attach-adapter.test.ts 同款，只是额外支持主动发起
// interaction/* 反向请求并收集客户端应答。
import { createServer, type Server, type Socket } from "node:net";
import {
  ZCODE_PROTOCOL_VERSION,
  zcodeProtocolMethods,
  zcodeSessionCloseParamsSchema,
  zcodeSessionCreateParamsSchema,
  zcodeSessionResumeParamsSchema,
  zcodeSessionSetCompactContextWindowParamsSchema,
  zcodeSessionSetModeParamsSchema,
  zcodeSessionSetModelParamsSchema,
  zcodeSessionSubscribeParamsSchema,
} from "@zcode/shared";

export const ACP_TEST_CORE_VERSION = ZCODE_PROTOCOL_VERSION;

export type Captured = { method: string; params: Record<string, unknown> };
export type CapturedResponse = { error?: unknown; id: string; result?: unknown };

export type FakeCore = {
  requests: Captured[];
  responses: CapturedResponse[];
  socketPath: string;
  /** 向所有连接推 session/rawEvent 通知。 */
  notify: (params: unknown) => void;
  /** 以 core 身份发起反向请求（interaction/*），返回客户端应答。 */
  request: (id: string, method: string, params: unknown) => Promise<CapturedResponse>;
  /** 原样写一行，用于注入畸形帧。 */
  raw: (line: string) => void;
  close: () => Promise<void>;
  findRequests: (method: string) => Captured[];
};

/**
 * 入站参数校验：真 core 会按 schema 拒绝错形状的请求（`session/create` 缺
 * `workspace.workspaceKey` 就是这么暴露的）。假 core 若全盘接受，测试就会
 * 放过一类"只有接上真 core 才炸"的 bug，所以这里与真 core 同样严格：
 * 不合法即回 -32602，且不进 responder。
 */
const INBOUND_SCHEMAS: Record<string, { safeParse: (value: unknown) => { success: boolean } }> = {
  [zcodeProtocolMethods.sessionClose]: zcodeSessionCloseParamsSchema,
  [zcodeProtocolMethods.sessionCreate]: zcodeSessionCreateParamsSchema,
  [zcodeProtocolMethods.sessionResume]: zcodeSessionResumeParamsSchema,
  [zcodeProtocolMethods.sessionSetCompactContextWindow]:
    zcodeSessionSetCompactContextWindowParamsSchema,
  [zcodeProtocolMethods.sessionSetMode]: zcodeSessionSetModeParamsSchema,
  [zcodeProtocolMethods.sessionSetModel]: zcodeSessionSetModelParamsSchema,
  [zcodeProtocolMethods.sessionSubscribe]: zcodeSessionSubscribeParamsSchema,
};

export type FakeResponder = (
  request: Captured,
  helpers: {
    notify: (params: unknown) => void;
    request: (id: string, method: string, params: unknown) => Promise<CapturedResponse>;
  },
) => unknown;

export function modelOption(modelId: string, providerId = "zai") {
  return {
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
  };
}

export function makeSnapshot(
  sessionId: string,
  overrides: {
    eventSeq?: number;
    contextUsed?: number;
    contextWindow?: number;
    mode?: string;
    modelId?: string;
  } = {},
) {
  return {
    messages: [],
    projection: {
      activeToolCalls: [],
      backgroundJobs: [],
      contextUsed: overrides.contextUsed ?? 1234,
      contextWindow: overrides.contextWindow ?? 200_000,
      mode: overrides.mode ?? "build",
      pendingPermissions: [],
      sessionId,
      status: "idle",
      totalTokenCount: 0,
      turnCount: 0,
    },
    protocol: { name: "ZCode Protocol", version: ACP_TEST_CORE_VERSION },
    runtime: { eventSeq: overrides.eventSeq ?? 0, pendingRequestIds: [], stateRevision: 1 },
    session: {
      createdAt: 1_700_000_000_000,
      mode: overrides.mode ?? "build",
      sessionId,
      sessionKind: "interactive",
      status: "idle",
      title: "acp test",
      traceId: `trace-${sessionId}`,
      updatedAt: 1_700_000_000_000,
      workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
    },
    settings: {
      mode: { current: overrides.mode ?? "build" },
      model: {
        available: [
          modelOption("glm-4.6"),
          modelOption("glm-4.7"),
          {
            ...modelOption("glm-5.3"),
            contextWindow: 200_000,
          },
        ],
        current: { modelId: overrides.modelId ?? "glm-4.6", providerId: "zai" },
      },
      thoughtLevel: {
        available: [
          { label: "Medium", value: "medium" },
          { label: "Max", value: "max" },
        ],
        current: "max",
        enabled: true,
      },
    },
  };
}

export function rawEvent(params: {
  inputId?: string;
  payload?: Record<string, unknown>;
  seq: number;
  sessionId: string;
  turnId?: string;
  type: string;
}) {
  return {
    id: `evt-${params.seq}`,
    payload: params.payload ?? {},
    sequenceNumber: params.seq,
    sessionId: params.sessionId,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    traceId: `trace-${params.sessionId}`,
    turnId: params.turnId,
    type: params.type,
  };
}

export async function startFakeCore(
  socketPath: string,
  responder: FakeResponder,
): Promise<FakeCore> {
  const requests: Captured[] = [];
  const responses: CapturedResponse[] = [];
  const sockets = new Set<Socket>();
  const waiters = new Map<string, (response: CapturedResponse) => void>();

  const broadcast = (payload: Record<string, unknown>): void => {
    for (const socket of sockets) socket.write(`${JSON.stringify(payload)}\n`);
  };
  const notify = (params: unknown): void => {
    broadcast({ method: "session/rawEvent", params });
  };
  const request = (id: string, method: string, params: unknown): Promise<CapturedResponse> => {
    broadcast({ id, method, params });
    return new Promise<CapturedResponse>((resolve) => {
      waiters.set(id, resolve);
    });
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
        if (message.method === undefined && message.id !== undefined) {
          const response: CapturedResponse = {
            error: message.error,
            id: String(message.id),
            result: message.result,
          };
          responses.push(response);
          waiters.get(String(message.id))?.(response);
          waiters.delete(String(message.id));
          continue;
        }
        if (!message.method || message.id === undefined) continue;
        const captured: Captured = { method: message.method, params: message.params ?? {} };
        requests.push(captured);
        const inbound = INBOUND_SCHEMAS[message.method];
        if (inbound && !inbound.safeParse(captured.params).success) {
          socket.write(
            `${JSON.stringify({
              error: { code: -32602, message: `invalid params for ${message.method}` },
              id: message.id,
            })}\n`,
          );
          continue;
        }
        Promise.resolve(
          responder(captured, { notify, request: (id, method, params) => request(id, method, params) }),
        )
          .then((value) => {
            if (value === undefined) return;
            socket.write(`${JSON.stringify({ id: message.id, result: value })}\n`);
          })
          .catch((error: Error) =>
            socket.write(
              `${JSON.stringify({
                error: { code: -32000, message: error.message },
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
    findRequests: (method) => requests.filter((entry) => entry.method === method),
    notify,
    raw,
    request: (id, method, params) => request(id, method, params),
    requests,
    responses,
    socketPath,
  };
}

/** v4/command ACK：shared commandAckSchema 允许的成功形状。 */
export function v4AckAccepted(commandId: string) {
  return {
    commandId,
    revisionAtDecision: 1,
    result: { delivery: "startNow", inputId: commandId, type: "inputAccepted" },
    status: "accepted",
  };
}
