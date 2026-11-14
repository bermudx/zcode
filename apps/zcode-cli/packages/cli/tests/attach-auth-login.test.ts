import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { ZCODE_PROTOCOL_VERSION, zcodeProtocolMethods } from "@zcode/shared";
import { AttachSessionHandle } from "../src/attach/attach-session.js";
import {
  AttachRuntime,
  createAttachPromptHandler,
} from "../src/attach/attach-tui-options.js";
import {
  configureApiKeyViaAttachProtocol,
  loginViaAttachProtocol,
  logoutViaAttachProtocol,
  openThinAuthUrl,
} from "../src/attach/attach-auth.js";

const SID = "sess-1";
const AUTHORIZE_URL = "https://login.example.test/authorize?state=test-state";

function makeSnapshot() {
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
    protocol: { name: "ZCode Protocol", version: ZCODE_PROTOCOL_VERSION },
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
        available: [
          {
            label: "glm-4.6",
            properties: {},
            providerLabel: "Z.AI",
            reasoning: { defaultLevel: "max", levels: [] },
            ref: { modelId: "glm-4.6", providerId: "zai" },
          },
        ],
        current: { modelId: "glm-4.6", providerId: "zai" },
      },
      thoughtLevel: { available: [], current: "medium", enabled: true },
    },
  };
}

type Captured = { method: string; params: Record<string, unknown> };

/** 假 core：按 method 查应答表，记录全部请求供断言。 */
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
        const message = JSON.parse(line) as {
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (!message.method || message.id === undefined) continue;
        const request: Captured = { method: message.method, params: message.params ?? {} };
        requests.push(request);
        Promise.resolve(responder(request))
          .then((value) =>
            socket.write(`${JSON.stringify({ id: message.id, result: value ?? {} })}\n`),
          )
          .catch((error: Error & { code?: number }) =>
            socket.write(
              `${JSON.stringify({
                error: { code: typeof error.code === "number" ? error.code : -32000, message: error.message },
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
    requests,
  };
}

const loginStartResult = {
  authorizeUrl: AUTHORIZE_URL,
  expiresAt: 1_800_000_000,
  flowId: "flow-1",
  pollIntervalSec: 1,
};
const loginCompleteOk = {
  configPath: "/x/provider_config.json",
  credentialsPath: "/x/credentials.json",
  model: "glm-5",
  ok: true,
  provider: "zai",
  user: { user_id: "u-1", name: "Tester" },
};

test("loginViaAttachProtocol: start → 本地开浏览器 → complete；URL 永远先回传", async () => {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const urls: string[] = [];
  const request = async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === zcodeProtocolMethods.authLoginStart) return loginStartResult;
    if (method === zcodeProtocolMethods.authLoginComplete) return loginCompleteOk;
    throw new Error(`unexpected ${method}`);
  };
  let authorizeData: unknown;
  const result = await loginViaAttachProtocol({
    providerId: "zai",
    request,
    onAuthorizeUrl: (data) => {
      authorizeData = data;
    },
    openBrowser: async (url) => {
      urls.push(url);
      return { command: "xdg-open", opened: true };
    },
  });
  assert.deepEqual(
    calls.map((c) => c.method),
    [zcodeProtocolMethods.authLoginStart, zcodeProtocolMethods.authLoginComplete],
  );
  assert.deepEqual(calls[0]?.params, { provider: "zai" });
  assert.deepEqual(calls[1]?.params, { flowId: "flow-1" });
  assert.deepEqual(authorizeData, {
    authorize_url: AUTHORIZE_URL,
    expires_at: 1_800_000_000,
    flow_id: "flow-1",
    poll_interval_sec: 1,
  });
  assert.deepEqual(urls, [AUTHORIZE_URL]);
  assert.equal(result.model, "glm-5");
  assert.equal(result.providerId, "zai");
  assert.equal(result.user.user_id, "u-1");
});

test("loginViaAttachProtocol: core 报 ok:false → 以 error 文本抛出", async () => {
  const request = async (method: string) =>
    method === zcodeProtocolMethods.authLoginStart
      ? loginStartResult
      : { error: "Authorization timed out. Please retry login.", ok: false };
  await assert.rejects(
    loginViaAttachProtocol({
      providerId: "bigmodel",
      request,
      openBrowser: async () => ({ command: "xdg-open", opened: true }),
    }),
    /Authorization timed out/,
  );
});

test("loginViaAttachProtocol: 已 abort 的 signal 不发任何请求", async () => {
  let called = 0;
  const request = async () => {
    called++;
    return loginStartResult;
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loginViaAttachProtocol({ providerId: "zai", request, abortSignal: controller.signal }),
  );
  assert.equal(called, 0);
});

test("configureApiKeyViaAttachProtocol / logoutViaAttachProtocol 的 wire 形状", async () => {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const request = async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === zcodeProtocolMethods.authConfigureApiKey) {
      return { configPath: "/x/cfg", model: "glm-5", ok: true, provider: "bigmodel" };
    }
    return { credentialsPath: "/x/creds", ok: true };
  };
  const configured = await configureApiKeyViaAttachProtocol({
    apiKey: "sk-secret",
    providerId: "bigmodel",
    request,
  });
  assert.deepEqual(calls[0], {
    method: zcodeProtocolMethods.authConfigureApiKey,
    params: { apiKey: "sk-secret", provider: "bigmodel" },
  });
  assert.equal(configured.providerId, "bigmodel");
  const loggedOut = await logoutViaAttachProtocol({ request });
  assert.equal(loggedOut.credentialsPath, "/x/creds");
  await assert.rejects(
    configureApiKeyViaAttachProtocol({
      apiKey: "sk-x",
      providerId: "zai",
      request: async () => ({ error: "write failed", ok: false }),
    }),
    /write failed/,
  );
});

test("openThinAuthUrl: 平台命令选择与失败不阻断", async () => {
  const spawned: Array<{ args: readonly string[]; file: string; options?: object }> = [];
  const spawnStub = ((file: string, args: readonly string[], options?: object) => {
    spawned.push({ args, file, options });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as never;
  const linux = await openThinAuthUrl(AUTHORIZE_URL, {
    platform: "linux",
    spawnProcess: spawnStub,
  });
  assert.equal(linux.opened, true);
  assert.equal(spawned[0]?.file, "xdg-open");
  assert.deepEqual(spawned[0]?.args, [AUTHORIZE_URL]);
  const darwin = await openThinAuthUrl(AUTHORIZE_URL, {
    platform: "darwin",
    spawnProcess: spawnStub,
  });
  assert.equal(darwin.command, "open");
  const win = await openThinAuthUrl(AUTHORIZE_URL, {
    platform: "win32",
    spawnProcess: spawnStub,
  });
  assert.equal(win.command, "cmd.exe");
  assert.deepEqual(spawned.at(-1)?.args, ["/c", "start", "", AUTHORIZE_URL]);
  const failing = await openThinAuthUrl(AUTHORIZE_URL, {
    platform: "linux",
    spawnProcess: (() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => {};
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    }) as never,
  });
  assert.equal(failing.opened, false);
  assert.match(failing.reason ?? "", /ENOENT/);
});

/** attach TUI 端到端：fake core 应答 auth/*，断言协议序列与可见 URL。 */
async function attachSession(
  t: { after: (fn: () => unknown) => void },
  responder: (request: Captured) => unknown,
) {
  const dir = await mkdtemp(join(tmpdir(), "attach-auth-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, responder);
  const runtime = new AttachRuntime({ socketPath });
  const client = await runtime.connect();
  const handle = new AttachSessionHandle({
    client,
    sessionId: SID,
    snapshot: makeSnapshot() as never,
  });
  client.onNotification((method, params) => {
    if (method === "session/rawEvent") handle.ingestRawEvent(params as never);
  });
  t.after(async () => {
    await runtime.close();
    await core.close();
    await rm(dir, { force: true, recursive: true });
  });
  return { core, handle, runtime };
}

const authResponder = (request: Captured): unknown => {
  if (request.method === zcodeProtocolMethods.authLoginStart) return loginStartResult;
  if (request.method === zcodeProtocolMethods.authLoginComplete) return loginCompleteOk;
  if (request.method === zcodeProtocolMethods.authConfigureApiKey) {
    return {
      configPath: "/x/provider_config.json",
      model: "glm-5",
      ok: true,
      provider: (request.params as { provider?: string }).provider ?? "zai",
    };
  }
  if (request.method === zcodeProtocolMethods.authLogout) {
    return { credentialsPath: "/x/credentials.json", ok: true };
  }
  return {};
};

test("attach TUI /login zai-coding-plan：走 core auth/*，URL 可见，不再报 not available", async (t) => {
  const { core, handle, runtime } = await attachSession(t, authResponder);
  const openedUrls: string[] = [];
  const events: Array<{ payload?: { content?: string }; type?: string }> = [];
  const handler = createAttachPromptHandler({
    client: runtime.currentClient(),
    initialHandle: handle,
    runtime,
    openBrowser: async (url) => {
      openedUrls.push(url);
      return { command: "xdg-open", opened: true };
    },
    workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
  });
  const result = await handler("/login zai-coding-plan", {
    abortSignal: new AbortController().signal,
    onEvent: async (event) => {
      events.push(event as never);
    },
  });
  const response = String((result as { response?: string }).response ?? "");
  assert.match(response, /Configured Z\.AI Coding Plan/);
  assert.doesNotMatch(response, /not available in this client/);
  assert.deepEqual(openedUrls, [AUTHORIZE_URL]);
  // URL 必须经 onEvent 展示（emitLoginAuthorizeMessage 的 assistant_message 事件）。
  assert.ok(
    events.some(
      (event) =>
        event.type === "assistant_message" && String(event.payload?.content ?? "").includes(AUTHORIZE_URL),
    ),
    "expected authorize URL to surface via onEvent assistant_message",
  );
  assert.deepEqual(
    core.requests.filter((r) => r.method.startsWith("auth/")).map((r) => r.method),
    [zcodeProtocolMethods.authLoginStart, zcodeProtocolMethods.authLoginComplete],
  );
});

test("attach TUI /login bigmodel-coding-plan 与 api-key 变体", async (t) => {
  const { core, handle, runtime } = await attachSession(t, authResponder);
  const handler = createAttachPromptHandler({
    client: runtime.currentClient(),
    initialHandle: handle,
    runtime,
    openBrowser: async () => ({ command: "xdg-open", opened: true }),
    workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
  });
  const bigmodel = await handler("/login bigmodel-coding-plan", {
    abortSignal: new AbortController().signal,
  });
  assert.match(String((bigmodel as { response?: string }).response ?? ""), /Configured BigModel/);
  const startRequest = core.requests.find((r) => r.method === zcodeProtocolMethods.authLoginStart);
  assert.deepEqual(startRequest?.params, { provider: "bigmodel" });
  core.requests.length = 0;
  const apiKey = await handler("/login zai-coding-plan-api-key sk-live", {
    abortSignal: new AbortController().signal,
  });
  assert.match(String((apiKey as { response?: string }).response ?? ""), /Configured Z\.AI/);
  const configure = core.requests.find((r) => r.method === zcodeProtocolMethods.authConfigureApiKey);
  assert.deepEqual(configure?.params, { apiKey: "sk-live", provider: "zai" });
});

test("attach TUI /logout 与 core 失败的 fallback 文案", async (t) => {
  const { core, handle, runtime } = await attachSession(t, authResponder);
  const handler = createAttachPromptHandler({
    client: runtime.currentClient(),
    initialHandle: handle,
    runtime,
    openBrowser: async () => ({ command: "xdg-open", opened: true }),
    workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
  });
  const logout = await handler("/logout", { abortSignal: new AbortController().signal });
  assert.match(String((logout as { response?: string }).response ?? ""), /Logged out/);
  assert.ok(core.requests.some((r) => r.method === zcodeProtocolMethods.authLogout));
});

test("attach TUI /login 失败时回复以 standalone fallback 收尾", async (t) => {
  const { handle, runtime } = await attachSession(t, (request) =>
    request.method === zcodeProtocolMethods.authLoginStart
      ? loginStartResult
      : request.method === zcodeProtocolMethods.authLoginComplete
        ? { error: "Authorization timed out. Please retry login.", ok: false }
        : {},
  );
  const handler = createAttachPromptHandler({
    client: runtime.currentClient(),
    initialHandle: handle,
    runtime,
    openBrowser: async () => ({ command: "xdg-open", opened: true }),
    workspace: { workspaceKey: "/tmp/ws", workspacePath: "/tmp/ws" },
  });
  const result = await handler("/login zai-coding-plan", {
    abortSignal: new AbortController().signal,
  });
  const response = String((result as { response?: string }).response ?? "");
  assert.match(response, /Authorization timed out/);
  assert.match(response, /zcode login zai$/);
});
