import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ZCodeProtocolNdjsonConnection } from "./transport.js";

describe("MCP App NDJSON admission", () => {
  it("admits cancellation, close and another app while a real wire request is pending", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    const order: string[] = [];
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      async handleMessage(message) {
        if (!("method" in message) || !("id" in message)) return;
        order.push(message.method);
        if (message.method === "mcp/uiCallTool") {
          entered.resolve();
          await finish.promise;
        }
        if (message.method === "mcp/uiCloseInstance") received.resolve();
        return { id: message.id, result: {} };
      },
    });
    transport.start();
    try {
      input.write(JSON.stringify({ id: 1, method: "mcp/uiCallTool" }) + "\n");
      await entered.promise;
      for (const [index, method] of [
        "mcp/uiValidateInstance",
        "mcp/uiCancelCall",
        "mcp/uiCloseInstance",
      ].entries())
        input.write(JSON.stringify({ id: index + 2, method }) + "\n");
      await received.promise;
      expect(order).toEqual([
        "mcp/uiCallTool",
        "mcp/uiValidateInstance",
        "mcp/uiCancelCall",
        "mcp/uiCloseInstance",
      ]);
    } finally {
      finish.resolve();
      input.end();
      await transport.waitForClose();
    }
  });

  it("preserves ordinary request order and starts app control only after earlier admission", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const controls = Promise.withResolvers<void>();
    const order: string[] = [];
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      async handleMessage(message) {
        if (!("method" in message) || !("id" in message)) return;
        order.push(message.method);
        if (message.method === "session/create") {
          started.resolve();
          await finish.promise;
        }
        if (message.method === "mcp/uiCancelCall") controls.resolve();
        return { id: message.id, result: {} };
      },
    });
    transport.start();
    input.write(
      '{"id":1,"method":"session/create"}\n{"id":2,"method":"mcp/uiCancelCall"}\n{"id":3,"method":"session/read"}\n',
    );
    await started.promise;
    await controls.promise;
    expect(order).toEqual(["session/create", "mcp/uiCancelCall"]);
    finish.resolve();
    input.end();
    await transport.waitForClose();
    expect(order).toEqual(["session/create", "mcp/uiCancelCall", "session/read"]);
  });
});

describe("auth/* NDJSON admission", () => {
  it("admits session/create while a slow auth/loginComplete is pending", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const loginEntered = Promise.withResolvers<void>();
    const finishLogin = Promise.withResolvers<void>();
    const order: string[] = [];
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      async handleMessage(message) {
        if (!("method" in message) || !("id" in message)) return;
        if (message.method === "auth/loginComplete") {
          order.push("login:start");
          loginEntered.resolve();
          await finishLogin.promise;
          order.push("login:done");
        }
        if (message.method === "session/create") order.push("create:start");
        return { id: message.id, result: {} };
      },
    });
    transport.start();
    input.write(
      '{"id":1,"method":"auth/loginComplete"}\n{"id":2,"method":"session/create"}\n',
    );
    await loginEntered.promise;
    finishLogin.resolve();
    input.end();
    await transport.waitForClose();
    // loginComplete 的 OAuth 轮询可达 5 分钟：走串行队列时 session/create 只能
    // 等它完成才进入 handler，队列外并发执行则立即开始。
    expect(order).toEqual(["login:start", "create:start", "login:done"]);
  });
});
