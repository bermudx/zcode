import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  AttachProtocolError,
  connectAttachClient,
  type AttachClient,
  type AttachClientLogger,
} from "../src/attach/attach-client.js";

type FakeServer = {
  server: Server;
  socketPath: string;
  respond: (socket: Socket, id: string | number, result: unknown) => void;
  respondError: (socket: Socket, id: string | number, code: number, message: string) => void;
  sendNotification: (method: string, params: unknown) => void;
  sendRequest: (id: string, method: string, params?: unknown) => void;
  onMessage: (handler: (message: Record<string, unknown>, socket: Socket) => void) => void;
  connections: () => Socket[];
  close: () => Promise<void>;
};

async function startFakeServer(dir: string): Promise<FakeServer> {
  const socketPath = join(dir, "fake.sock");
  const sockets = new Set<Socket>();
  const handlers = new Set<
    (message: Record<string, unknown>, socket: Socket) => void
  >();
  const server = createServer((socket) => {
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
        const message = JSON.parse(line) as Record<string, unknown>;
        for (const handler of handlers) handler(message, socket);
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
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    connections: () => [...sockets],
    onMessage: (handler) => handlers.add(handler),
    respond: (socket, id, result) => {
      socket.write(`${JSON.stringify({ id, result })}\n`);
    },
    respondError: (socket, id, code, message) => {
      socket.write(`${JSON.stringify({ error: { code, message }, id })}\n`);
    },
    sendNotification: (method, params) => write({ method, params }),
    sendRequest: (id, method, params) => write({ id, method, params }),
    server,
    socketPath,
  };
}

async function withFakeServer(
  run: (fake: FakeServer, client: AttachClient) => Promise<void>,
  clientOptions: { logger?: AttachClientLogger } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "attach-client-test-"));
  const fake = await startFakeServer(dir);
  const client = await connectAttachClient(fake.socketPath, clientOptions);
  try {
    await run(fake, client);
  } finally {
    client.close();
    await fake.close();
    await rm(dir, { force: true, recursive: true });
  }
}

test("request/response 往返", async () => {
  await withFakeServer(async (fake, client) => {
    fake.onMessage((message, socket) => {
      if (message.method === "runtime/capabilities") {
        fake.respond(socket, message.id as string, { historyFirst: true });
      }
    });
    const result = await client.request<{ historyFirst: boolean }>(
      "runtime/capabilities",
    );
    assert.equal(result.historyFirst, true);
  });
});

test("error response 拒绝并携带 code", async () => {
  await withFakeServer(async (fake, client) => {
    fake.onMessage((message, socket) => {
      fake.respondError(socket, message.id as string, -32010, "boom");
    });
    await assert.rejects(
      client.request("session/send", { content: "x", sessionId: "s" }),
      (error: unknown) => {
        assert.ok(error instanceof AttachProtocolError);
        assert.equal(error.code, -32010);
        assert.equal(error.message, "boom");
        return true;
      },
    );
  });
});

test("notification 分发", async () => {
  await withFakeServer(async (fake, client) => {
    const received: Array<{ method: string; params: unknown }> = [];
    client.onNotification((method, params) => received.push({ method, params }));
    fake.sendNotification("session/rawEvent", { sequenceNumber: 1, sessionId: "s1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.length, 1);
    assert.equal(received[0]!.method, "session/rawEvent");
  });
});

test("server 反向请求由 handler 应答", async () => {
  await withFakeServer(async (fake, client) => {
    client.setRequestHandler(async (method) => {
      if (method === "session/requestRuntimePreferences") {
        return { nativeSearchEnhancementsEnabled: false };
      }
      throw new Error(`unhandled ${method}`);
    });
    fake.onMessage((message) => {
      if (message.id === "rev-1") return;
    });
    fake.sendRequest("rev-1", "session/requestRuntimePreferences");
    const answered = await new Promise<Record<string, unknown>>((resolve) => {
      fake.onMessage((message) => {
        if (message.id === "rev-1") resolve(message);
      });
    });
    assert.deepEqual(answered.result, { nativeSearchEnhancementsEnabled: false });
  });
});

// 回归证据（P004-F6，2026-10-26 评审）：对端长时间不发换行时，入站 NDJSON
// buffer 曾无上限增长——卡死的 core 可以把瘦客户端 RSS 撑爆。超上限必须
// 显式失败连接（closed 带 error、pending 全拒），而不是无声挂着继续膨胀。
test("超长无换行流触发行上限显式失败", async () => {
  await withFakeServer(async (fake, client) => {
    // 5MB 无换行：超过 4MB 上限；socket 保持打开，模拟卡死但不关流的 core。
    for (const socket of fake.connections()) {
      socket.write("x".repeat(5 * 1024 * 1024));
    }
    const settled = await Promise.race([
      client.closed.then((error) => error),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
    ]);
    assert.ok(
      settled instanceof Error,
      "connection must fail with an explicit error once the line cap is exceeded",
    );
    assert.match(settled.message, /exceeded/);
    await assert.rejects(client.request("session/send", {}), /closed|exceeded/i);
  });
});

// P004-F4：注入 logger 时传输级诊断（丢畸形行等）必须产生 warn，且连接继续。
test("malformed line 产生 logger.warn 诊断且连接继续", async () => {
  const warnings: string[] = [];
  await withFakeServer(
    async (fake, client) => {
      const received: string[] = [];
      client.onNotification((method) => received.push(method));
      for (const socket of fake.connections()) {
        socket.write("{{{not json\n");
        socket.write(`${JSON.stringify({ method: "session/rawEvent", params: {} })}\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(warnings, ["attach client dropped malformed line"]);
      assert.deepEqual(received, ["session/rawEvent"], "connection must continue after a dropped line");
    },
    {
      logger: {
        warn: (message) => {
          warnings.push(message);
        },
      },
    },
  );
});

test("socket 关闭拒绝 pending 并 settle closed", async () => {
  await withFakeServer(async (fake, client) => {
    fake.onMessage(() => {
      // 故意不应答：制造 pending 请求，再断 socket。
    });
    const pending = client.request("session/send", {
      content: "x",
      sessionId: "s",
    });
    for (const socket of fake.connections()) socket.destroy();
    await assert.rejects(pending, /closed|ECONNRESET/i);
    await client.closed;
  });
});
