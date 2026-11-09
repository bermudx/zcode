// ACP stdio 传输层的单元回归：坏帧、双向 id 空间、并发分发、关闭语义。
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AcpWireError, createAcpWire } from "../src/acp/acp-wire.js";

type Frame = Record<string, unknown>;

function makeWire(): {
  frames: Frame[];
  input: PassThrough;
  lines: string[];
  send: (line: string) => void;
  sendJson: (payload: Frame) => void;
  warnings: string[];
  wire: ReturnType<typeof createAcpWire>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Frame[] = [];
  const warnings: string[] = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      frames.push(JSON.parse(buffer.slice(0, index)) as Frame);
      buffer = buffer.slice(index + 1);
    }
  });
  const wire = createAcpWire({
    input,
    logger: { warn: (message) => warnings.push(message) },
    output,
  });
  return {
    frames,
    input,
    lines: [],
    send: (line) => input.write(`${line}\n`),
    sendJson: (payload) => input.write(`${JSON.stringify(payload)}\n`),
    warnings,
    wire,
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("坏帧不影响后续帧：非 JSON、缺 method 都被 warn 掉", async () => {
  const env = makeWire();
  const calls: string[] = [];
  env.wire.setRequestHandler(async (method) => {
    calls.push(method);
    return { ok: true };
  });
  env.send("this is not json");
  env.sendJson({ jsonrpc: "2.0", id: "a" }); // 无 method，无 result：不是合法请求
  env.sendJson({ id: "b", jsonrpc: "2.0", method: "ping", params: {} });
  await until(() => env.frames.some((frame) => "id" in frame && frame.id === "b"), "ping reply");
  assert.deepEqual(calls, ["ping"]);
  assert.ok(env.warnings.length >= 1, "坏帧要留下诊断");
  const reply = env.frames.find((frame) => frame.id === "b");
  assert.deepEqual(reply?.result, { ok: true });
});

test("handler 抛 AcpWireError 时原样回错误码；其它异常收敛成 internal", async () => {
  const env = makeWire();
  env.wire.setRequestHandler(async (method) => {
    if (method === "bad") throw new AcpWireError(-32602, "invalid params");
    if (method === "boom") throw new Error("kaboom");
    return {};
  });
  env.sendJson({ id: 1, jsonrpc: "2.0", method: "bad" });
  env.sendJson({ id: 2, jsonrpc: "2.0", method: "boom" });
  await until(() => env.frames.filter((frame) => frame.error).length === 2, "two errors");
  const byId = new Map(env.frames.map((frame) => [String(frame.id), frame]));
  assert.equal((byId.get("1")?.error as { code: number }).code, -32602);
  const internal = byId.get("2")?.error as { code: number; message: string };
  assert.equal(internal.code, -32603);
  // 内部异常细节不外泄（编辑器会把 message 展示给用户），但要有 stderr 诊断。
  assert.equal(internal.message, "Internal error");
  assert.ok(
    env.warnings.some((warning) => warning === "acp request handler failed"),
    "未分类异常必须留下诊断",
  );
});

test("并发分发：慢请求不阻塞后续请求（prompt 期间要能 cancel）", async () => {
  const env = makeWire();
  const order: string[] = [];
  let releasePrompt: (() => void) | undefined;
  env.wire.setRequestHandler(async (method) => {
    if (method === "session/prompt") {
      order.push("prompt:start");
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      order.push("prompt:end");
      return { stopReason: "end_turn" };
    }
    order.push(method);
    return {};
  });
  env.sendJson({ id: "p", jsonrpc: "2.0", method: "session/prompt", params: {} });
  await until(() => order.includes("prompt:start"), "prompt start");
  env.sendJson({ id: "c", jsonrpc: "2.0", method: "session/cancel", params: {} });
  await until(() => order.includes("session/cancel"), "cancel handled");
  assert.ok(
    !order.includes("prompt:end"),
    "cancel 必须在 prompt 还没返回时就被处理",
  );
  releasePrompt?.();
  await until(() => env.frames.some((frame) => frame.id === "p"), "prompt reply");
});

test("出站请求：应答按 id 配对，错误包装成 AcpWireError", async () => {
  const env = makeWire();
  const ok = env.wire.request("elicitation/create", { sessionId: "s" });
  const failed = env.wire.request("session/request_permission", { sessionId: "s" });
  await until(() => env.frames.length === 2, "two outbound requests");
  const [first, second] = env.frames;
  assert.equal(first?.method, "elicitation/create");
  assert.ok(String(first?.id).startsWith("acp-"), "出站 id 与 client 的 id 空间分开");
  env.sendJson({ id: first?.id, jsonrpc: "2.0", result: { action: "accept" } });
  env.sendJson({
    error: { code: -32603, message: "client exploded" },
    id: second?.id,
    jsonrpc: "2.0",
  });
  assert.deepEqual(await ok, { action: "accept" });
  await assert.rejects(failed, (error: unknown) => {
    assert.ok(error instanceof AcpWireError);
    assert.equal(error.code, -32603);
    return true;
  });
});

test("通知走通知处理器，且不回帧", async () => {
  const env = makeWire();
  const seen: string[] = [];
  env.wire.setNotificationHandler((method) => seen.push(method));
  env.sendJson({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } });
  await until(() => seen.length === 1, "notification");
  assert.deepEqual(seen, ["session/cancel"]);
  assert.equal(env.frames.length, 0, "通知没有 id，不该回帧");
});

test("stdin EOF：closed 兑现，未决请求被 reject，之后的写被丢弃", async () => {
  const env = makeWire();
  const inflight = env.wire.request("elicitation/create", {});
  env.input.end();
  const reason = await env.wire.closed;
  assert.equal(reason, undefined);
  await assert.rejects(inflight, /transport closed/);
  const before = env.frames.length;
  env.wire.notify("session/update", {});
  assert.equal(env.frames.length, before, "关闭后不再写 stdout");
});
