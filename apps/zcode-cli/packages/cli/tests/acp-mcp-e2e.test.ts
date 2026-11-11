// issue #31 CMCP01/04/11 end-to-end：真实 ACP client ↔ createAcpAgentApp
// 走真实 NDJSON transport（不是 connectWith 内存直连），client 侧
// AcpCoreSessions 经 fixture 的真实 unix socket 接到真实 core
// （ZCodeProtocolAgentServer + createRegistryBackedTestApp + disposable
// stdio/HTTP/SSE fixture）。唯一 fake 是 provider model executor；
// transport/attach/handle/registry/permissions/MCP adapter 全部真实。
// 双向 wire 字节逐行 JSON.parse——任何非 JSON 输出直接爆，守住 JSON-only。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  client,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { ModelRequest, ModelResult } from "@zcode/contracts";
import { createAcpAgentApp } from "../src/acp/acp-agent.js";
import { AcpCoreSessions } from "../src/acp/acp-sessions.js";
import { createAcpMcpCoreFixture } from "../../bootstrap/tests/helpers/acp-mcp-core-fixture.js";
import {
  startAuthenticatedMcpHttpFixture,
  startAuthenticatedMcpSseFixture,
} from "../../adapters/tests/fixtures/mcp-http-sse.js";
import type { RegistryBackedTestModelExecutor } from "../../bootstrap/tests/helpers/registry-backed-test-app.js";

const FIXTURE = fileURLToPath(
  new URL("../../adapters/tests/fixtures/mcp-echo-server.mjs", import.meta.url),
);
const NODE = process.execPath;
const HTTP_TOKEN = "fake-http-token-31ac";
const SSE_TOKEN = "fake-sse-token-91bd";

async function waitForFile(path: string, attempts = 400): Promise<number> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return Number((await readFile(path, "utf8")).trim());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`fixture pid file never appeared: ${path}`);
}

/** 真实字节 transport：双向 NDJSON，入站字节逐行 parse，非 JSON 立即抛。 */
function createGuardedAcpTransport() {
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();
  for (const [label, pipe] of [
    ["c→a", clientToAgent],
    ["a→c", agentToClient],
  ] as const) {
    let buffer = "";
    pipe.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          JSON.parse(line);
        } catch (error) {
          throw new Error(
            `ACP transport ${label} emitted non-JSON output: ${String(error)}`,
          );
        }
      }
    });
  }
  const clientStream = ndJsonStream(
    Writable.toWeb(clientToAgent) as WritableStream<Uint8Array>,
    Readable.toWeb(agentToClient) as ReadableStream<Uint8Array>,
  );
  const agentStream = ndJsonStream(
    Writable.toWeb(agentToClient) as WritableStream<Uint8Array>,
    Readable.toWeb(clientToAgent) as ReadableStream<Uint8Array>,
  );
  return { agentStream, clientStream };
}

function stdioAcpServer(
  name: string,
  dir: string,
  label: string,
): Record<string, unknown> {
  return {
    name,
    command: NODE,
    args: [FIXTURE],
    env: [
      { name: "MCP_FIXTURE_PID_FILE", value: join(dir, `${name}.pid`) },
      { name: "MCP_FIXTURE_LABEL", value: label },
    ],
  };
}
// ACP wire 没有 protocolVersion 字段——stdio probe 由 adapter auto 协商处理，
// pid 断言只读最终 live 代（见 CMCP04 测试内 stable-pid 轮询）。

/** 首个请求对目标工具发 tool-call；后续请求 stop。记录全部 ModelRequest。 */
function createEchoExecutor(
  toolName: string,
  requests: ModelRequest[],
): RegistryBackedTestModelExecutor {
  return {
    generateText: async (request) => {
      requests.push(request);
      const offered = request.tools?.some((tool) => tool.name === toolName);
      // tool 结果在当前请求自己的 messages 里——切片必须包含当前请求，
      // 否则第二个请求会再发一次 tool-call 形成调用环。
      const alreadyCalled = requests
        .flatMap((r) => r.messages)
        .some((m) => m.role === "tool");
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      if (offered && !alreadyCalled) {
        return {
          finishReason: "tool-calls",
          toolCalls: [
            { id: "call-1", name: toolName, input: { text: "hello-acp" } },
          ],
          usage,
        } as ModelResult;
      }
      return { finishReason: "stop", text: "done", usage } as ModelResult;
    },
  };
}

function pickOptionByKind(
  options: readonly { kind?: string; optionId: string }[],
  kind: string,
): string {
  const option = options.find((entry) => entry.kind === kind);
  assert.ok(option, `no permission option of kind ${kind}`);
  return option.optionId;
}

test("CMCP01+CMCP11 allow: ACP new forwards stdio+http+sse; permission allow runs the real tool", async () => {
  const requests: ModelRequest[] = [];
  const permissionCalls: unknown[] = [];
  const fixture = await createAcpMcpCoreFixture({
    modelExecutor: createEchoExecutor("mcp__stdio1__echo", requests),
  });
  const dir = await mkdtemp(join(tmpdir(), "acp-mcp-e2e-"));
  const http = await startAuthenticatedMcpHttpFixture({
    label: "e2e-http",
    token: HTTP_TOKEN,
  });
  const sse = await startAuthenticatedMcpSseFixture({
    label: "e2e-sse",
    token: SSE_TOKEN,
  });
  const sessions = new AcpCoreSessions({
    env: {},
    ensureConnected: async () => ({ socketPath: fixture.socketPath }),
  });
  const app = createAcpAgentApp({ sessions, version: "1.2.3" });
  const { agentStream, clientStream } = createGuardedAcpTransport();
  const agentConnection = app.connect(agentStream);
  const testClient = client({ name: "e2e-client" }).onRequest(
    methods.client.session.requestPermission,
    ({ params }) => {
      permissionCalls.push(params);
      return {
        outcome: {
          outcome: "selected" as const,
          optionId: pickOptionByKind(params.options, "allow_once"),
        },
      };
    },
  );
  const clientConnection = testClient.connect(clientStream);
  try {
    const agent = clientConnection.agent;
    const init = await agent.request(methods.agent.initialize, {
      protocolVersion: 1,
    });
    assert.equal(init.agentCapabilities?.mcpCapabilities?.http, true);
    assert.equal(init.agentCapabilities?.mcpCapabilities?.sse, true);

    const created = await agent.request(methods.agent.session.new, {
      cwd: fixture.workspace,
      mcpServers: [
        stdioAcpServer("stdio1", dir, "e2e-stdio"),
        {
          name: "http1",
          type: "http",
          url: http.url,
          headers: [{ name: "Authorization", value: `Bearer ${HTTP_TOKEN}` }],
        },
        {
          name: "sse1",
          type: "sse",
          url: sse.url,
          headers: [{ name: "Authorization", value: `Bearer ${SSE_TOKEN}` }],
        },
      ],
    });
    const sessionId = created.sessionId;
    const coreApp = fixture.apps.get(sessionId);
    assert.ok(coreApp, "protocol create produced a real app");
    // 三种 transport 全部到达 core：stdio 子进程 + http/sse 真实连接。
    const pid = await waitForFile(join(dir, "stdio1.pid"));
    // ACP create 注入落在 config.mcp.servers（startup connect），不是 desired。
    const configured = coreApp.runtime.getEffectiveMcpConfig()?.servers;
    assert.deepEqual(Object.keys(configured ?? {}).sort(), [
      "http1",
      "sse1",
      "stdio1",
    ]);
    // 三条 transport 的连接在 create 返回后异步建立——轮询到三个 server 的工具面齐。
    let tools: Awaited<ReturnType<NonNullable<ReturnType<typeof coreApp.runtime.getMcpPort>>["listTools"]>> = [];
    for (let i = 0; i < 200; i += 1) {
      tools = (await coreApp.runtime.getMcpPort()?.listTools()) ?? [];
      if (["stdio1", "http1", "sse1"].every((s) => tools.some((t) => t.serverName === s))) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const server of ["stdio1", "http1", "sse1"]) {
      assert.ok(
        tools.some((tool) => tool.serverName === server),
        `tool for ${server} not discovered`,
      );
    }

    // prompt → fake model 调用 client 注入的工具 → ACP request_permission
    // allow_once → 真实 fixture 执行 → 结果回到第二个 ModelRequest。
    const prompt = await agent.request(methods.agent.session.prompt, {
      prompt: [{ text: "call the echo tool", type: "text" }],
      sessionId,
    });
    assert.equal(prompt.stopReason, "end_turn");
    assert.equal(permissionCalls.length, 1);
    const toolMessages = requests
      .slice(1)
      .flatMap((r) => r.messages)
      .filter((m) => m.role === "tool")
      .map((m) => JSON.stringify(m));
    assert.ok(
      toolMessages.some((m) => m.includes("echo[e2e-stdio@")),
      `MCP tool result missing from follow-up model request; requests=${requests.length} toolMsgs=${toolMessages.length} first=${toolMessages[0]?.slice(0, 300) ?? "none"}`,
    );
    assert.ok(pid > 0);
  } finally {
    await sessions.closeAll().catch(() => undefined);
    clientConnection.close();
    agentConnection.close();
    await Promise.all([http.close(), sse.close()]);
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CMCP11 reject: denied permission never reaches the MCP fixture and returns a normal rejected result", async () => {
  const requests: ModelRequest[] = [];
  const permissionCalls: unknown[] = [];
  const fixture = await createAcpMcpCoreFixture({
    modelExecutor: createEchoExecutor("mcp__http2__echo", requests),
  });
  const http = await startAuthenticatedMcpHttpFixture({
    label: "e2e-deny",
    token: HTTP_TOKEN,
  });
  const sessions = new AcpCoreSessions({
    env: {},
    ensureConnected: async () => ({ socketPath: fixture.socketPath }),
  });
  const app = createAcpAgentApp({ sessions, version: "1.2.3" });
  const { agentStream, clientStream } = createGuardedAcpTransport();
  const agentConnection = app.connect(agentStream);
  const testClient = client({ name: "e2e-client" }).onRequest(
    methods.client.session.requestPermission,
    ({ params }) => {
      permissionCalls.push(params);
      return {
        outcome: {
          outcome: "selected" as const,
          optionId: pickOptionByKind(params.options, "reject_once"),
        },
      };
    },
  );
  const clientConnection = testClient.connect(clientStream);
  try {
    const agent = clientConnection.agent;
    await agent.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await agent.request(methods.agent.session.new, {
      cwd: fixture.workspace,
      mcpServers: [
        {
          name: "http2",
          type: "http",
          url: http.url,
          headers: [{ name: "Authorization", value: `Bearer ${HTTP_TOKEN}` }],
        },
      ],
    });
    const prompt = await agent.request(methods.agent.session.prompt, {
      prompt: [{ text: "call the echo tool", type: "text" }],
      sessionId: created.sessionId,
    });
    assert.equal(prompt.stopReason, "end_turn");
    assert.equal(permissionCalls.length, 1);
    // 拒掉后 fixture 的 tools/call 计数是零；产品语义是 permission_denied →
    // 回合直接完成（拒绝结果进持久化 transcript，不折返第二个模型请求）。
    assert.equal(http.acceptedToolCalls(), 0);
    const raw = await fixture.connectRawClient();
    try {
      const snapshot = await raw.request<{ session?: { messages?: unknown } }>(
        "session/read",
        { sessionId: created.sessionId },
      );
      assert.match(
        JSON.stringify(snapshot.session?.messages ?? snapshot),
        /denied|reject|permission/i,
        "rejected tool result missing from persisted session transcript",
      );
    } finally {
      raw.close();
    }
  } finally {
    await sessions.closeAll().catch(() => undefined);
    clientConnection.close();
    agentConnection.close();
    await http.close();
    await fixture.close();
  }
});

test("CMCP04 bound resume forwards mcpServers to the warm session; unchanged entries keep their connection", async () => {
  const requests: ModelRequest[] = [];
  const fixture = await createAcpMcpCoreFixture({
    modelExecutor: {
      generateText: async (request) => {
        requests.push(request);
        return { finishReason: "stop", text: "done" } as ModelResult;
      },
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "acp-mcp-e2e-04-"));
  const sessions = new AcpCoreSessions({
    env: {},
    ensureConnected: async () => ({ socketPath: fixture.socketPath }),
  });
  const app = createAcpAgentApp({ sessions, version: "1.2.3" });
  const { agentStream, clientStream } = createGuardedAcpTransport();
  const agentConnection = app.connect(agentStream);
  const testClient = client({ name: "e2e-client" }).onRequest(
    methods.client.session.requestPermission,
    ({ params }) => ({
      outcome: "selected" as const,
      optionId: pickOptionByKind(params.options, "allow_once"),
    }),
  );
  const clientConnection = testClient.connect(clientStream);
  try {
    const agent = clientConnection.agent;
    await agent.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await agent.request(methods.agent.session.new, {
      cwd: fixture.workspace,
      mcpServers: [
        stdioAcpServer("keep", dir, "v1"),
        stdioAcpServer("swap", dir, "v1"),
      ],
    });
    const sessionId = created.sessionId;
    const keepPid = await waitForFile(join(dir, "keep.pid"));
    const swapPid = await waitForFile(join(dir, "swap.pid"));
    const coreApp = fixture.apps.get(sessionId)!;

    // bound resume：同 sessionId、keep 声明不变（数组顺序换）、swap 换 label。
    await agent.request(methods.agent.session.resume, {
      cwd: fixture.workspace,
      mcpServers: [
        stdioAcpServer("swap", dir, "v2"),
        stdioAcpServer("keep", dir, "v1"),
      ],
      sessionId,
    });
    // 同一 warm 会话——AcpCoreSessions 保留 handle，core 保留 app。
    assert.equal(sessions.get(sessionId)?.handle.sessionId, sessionId);
    assert.equal(fixture.apps.get(sessionId), coreApp);
    // 未变的 server 保活同 PID；变了 label 的重连出新 PID。
    await waitForFile(join(dir, "swap.pid"));
    const keepAlive = await coreApp.runtime
      .getMcpPort()!
      .callTool({ arguments: { text: "keep" }, serverName: "keep", toolName: "echo" });
    assert.ok(JSON.stringify(keepAlive).includes("echo[v1@"));
    const swapped = await coreApp.runtime
      .getMcpPort()!
      .callTool({ arguments: { text: "swap" }, serverName: "swap", toolName: "echo" });
    assert.ok(JSON.stringify(swapped).includes("echo[v2@"));
    assert.notEqual(swapPid, Number((await readFile(join(dir, "swap.pid"), "utf8")).trim()));
    assert.ok(keepPid > 0);
  } finally {
    await sessions.closeAll().catch(() => undefined);
    clientConnection.close();
    agentConnection.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});
