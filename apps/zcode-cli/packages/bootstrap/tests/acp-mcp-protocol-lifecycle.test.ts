// issue #31 CMCP02/03/04/05/06/07/08/09/12(+13 扫描半)：真实 socket 协议 core
// （ZCodeProtocolAgentServer + createRegistryBackedTestApp + disposable stdio
// fixture），client 端是真实 unix socket 上的最小 NDJSON client。会话创建/
// resume/fork/close 全部走协议请求——不是直接 runtime 拼装。
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type Logger,
  type LoggerFactory,
  type LogContext,
  type ModelRequest,
  type ModelResult,
  type SessionId,
} from "@zcode/contracts";
import { zcodeProtocolMethods, zcodeSessionMessagesResultSchema } from "@zcode/shared";
import { projectIdFromDirectory } from "../src/app/paths.js";
import {
  createAcpMcpCoreFixture,
  type AcpMcpCoreFixture,
  type AcpMcpRawClient,
} from "./helpers/acp-mcp-core-fixture.js";
import type { RegistryBackedTestModelExecutor } from "./helpers/registry-backed-test-app.js";
import { startAuthenticatedMcpHttpFixture } from "../../adapters/tests/fixtures/mcp-http-sse.js";
import type { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";

const FIXTURE = fileURLToPath(
  new URL("../../adapters/tests/fixtures/mcp-echo-server.mjs", import.meta.url),
);
const NODE = process.execPath;
const SENTINEL_CRED = "FAKE_SENTINEL_CRED_b7c3d1e9";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

async function waitForExit(pid: number, attempts = 300): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processAlive(pid);
}

async function listPids(dir: string): Promise<number[]> {
  try {
    const pids: number[] = [];
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".pid")) continue;
      const pid = Number((await readFile(join(dir, file), "utf8")).trim());
      if (Number.isFinite(pid) && processAlive(pid)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

/** protocol wire 上的 stdio server 声明；env 走 [{name,value}] 数组。 */
function stdioWireServer(
  name: string,
  dir: string,
  options: {
    label?: string;
    hold?: boolean;
    holdCall?: boolean;
    callMarker?: string;
    pidDir?: string;
    versionEnv?: string;
    env?: Record<string, string>;
  } = {},
): Record<string, unknown> {
  const env = [
    { name: "MCP_FIXTURE_PID_FILE", value: join(dir, `${name}.pid`) },
    ...(options.pidDir ? [{ name: "MCP_FIXTURE_PID_DIR", value: options.pidDir }] : []),
    ...(options.label ? [{ name: "MCP_FIXTURE_LABEL", value: options.label }] : []),
    ...(options.hold ? [{ name: "MCP_FIXTURE_HOLD_INITIALIZE", value: "1" }] : []),
    ...(options.holdCall ? [{ name: "MCP_FIXTURE_HOLD_CALL", value: "1" }] : []),
    ...(options.callMarker
      ? [{ name: "MCP_FIXTURE_CALL_MARKER_FILE", value: options.callMarker }]
      : []),
    ...(options.versionEnv
      ? [{ name: "MCP_FIXTURE_VERSION_ENV", value: options.versionEnv }]
      : []),
    ...Object.entries(options.env ?? {}).map(([key, value]) => ({ name: key, value })),
  ];
  return {
    name,
    scope: "user",
    command: NODE,
    args: [FIXTURE],
    env,
    isolation: "session",
    // auto 协商会先起一个 disposable probe sibling 再真正连接，pid 文件会记到
    // 两代子进程；测试 pin legacy 让每次 connect 只 spawn 一次，pid 可读。
    protocolVersion: "legacy",
  };
}

function workspaceRef(fixture: AcpMcpCoreFixture) {
  return { workspacePath: fixture.workspace, workspaceKey: fixture.workspace };
}

async function createSession(
  client: AcpMcpRawClient,
  fixture: AcpMcpCoreFixture,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await client.request<{ session: { sessionId: string } }>(
    zcodeProtocolMethods.sessionCreate,
    {
      workspace: workspaceRef(fixture),
      ...extra,
    },
  );
  return result.session.sessionId;
}

async function waitIdle(
  client: AcpMcpRawClient,
  sessionId: string,
  attempts = 400,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const snapshot = await client.request<{ session: { status: string } }>(
      zcodeProtocolMethods.sessionRead,
      { sessionId },
    );
    if (snapshot.session.status === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${sessionId} never went idle`);
}

/** tools/list 在 connect 后异步完成；轮询直到目标 mcp__ 工具在 runtime 工具面可见。 */
async function waitForToolRegistered(
  fixture: AcpMcpCoreFixture,
  sessionId: string,
  serverName: string,
  toolName: string,
  attempts = 400,
): Promise<void> {
  const app = fixture.apps.get(sessionId)!;
  const fullName = `mcp__${serverName}__${toolName}`;
  for (let i = 0; i < attempts; i += 1) {
    const tools = (await app.runtime.getMcpPort()?.listTools()) ?? [];
    if (tools.some((t) => t.serverName === serverName && `mcp__${t.serverName}__${t.toolName}` === fullName)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`tool ${fullName} never registered for ${sessionId}`);
}

/** 让真实 turn 流过：首个请求要 tool-call（若工具在面），随后 stop 并回显 tool 结果文本。 */
function createToolCallingExecutor(
  toolName: string,
  requests: ModelRequest[],
): RegistryBackedTestModelExecutor {
  return {
    generateText: async (request) => {
      requests.push(request);
      // 工具批次的 user-role token-budget 提醒排在工具结果之后；它不代表新一轮输入。
      const lastRole = request.messages.findLast(
        (message) =>
          !(
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("<total_tokens>")
          ),
      )?.role;
      const offered = request.tools?.some((tool) => tool.name === toolName);
      if (offered && lastRole !== "tool") {
        return {
          finishReason: "tool-calls",
          text: "",
          toolCalls: [{ id: "call-1", name: toolName, input: { text: "hello" } }],
          usage: {},
        } as ModelResult;
      }
      return { finishReason: "stop", text: "done", usage: {} } as ModelResult;
    },
  };
}

/** session/send 是 ACK+后台回合：等第一个 ModelRequest 出现再等 idle。 */
async function waitTurnRequests(
  requests: ModelRequest[],
  count: number,
  attempts = 400,
): Promise<void> {
  for (let i = 0; i < attempts && requests.length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (requests.length < count) {
    throw new Error(`expected ${count} model requests, got ${requests.length}`);
  }
}

/** 允许一切 permission 反问；真实 broker 路径不变，只是测试应答 allow。 */
function allowAllPermissions(client: AcpMcpRawClient): void {
  client.onRequest((message) => {
    if (message.method === "interaction/requestPermission") {
      return { decision: "allow" };
    }
    if (message.method === "session/requestRuntimePreferences") {
      return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false };
    }
    return { decision: "deny" };
  });
}

async function scanDirForNeedle(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const info = await stat(path);
        if (info.size > 32 * 1024 * 1024) continue;
        const content = await readFile(path);
        if (content.includes(needle)) hits.push(path);
      }
    }
  };
  await walk(root);
  return hits;
}

describe("protocol-level client MCP lifecycle (real socket + real app)", () => {
  it("CMCP02 empty create allocates no MCP resources; injection allocates; clear releases; bait config never loads", async () => {
    const fixture = await createAcpMcpCoreFixture();
    const dir = await mkdtemp(join(tmpdir(), "cmcp02-"));
    // bait project config：一旦 auto-load，bait.pid 就会出现——它绝不能出现。
    await mkdir(join(fixture.workspace, ".zcode"), { recursive: true });
    await writeFile(
      join(fixture.workspace, ".zcode", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            bait: {
              type: "stdio",
              command: NODE,
              args: [FIXTURE],
              env: { MCP_FIXTURE_PID_FILE: join(dir, "bait.pid") },
            },
          },
        },
      }),
    );
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    try {
      const sessionId = await createSession(client, fixture);
      const app = fixture.apps.get(sessionId);
      expect(app).toBeDefined();
      // 空会话零 MCP：没有 port、没有池、没有子进程。
      expect(app!.runtime.getMcpPort()).toBeUndefined();
      expect(await listPids(dir)).toEqual([]);

      // 首个非空注入经 resume 落地：分配 port/pool，真实 stdio 子进程起来。
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        mcpServers: [stdioWireServer("s1", dir, { label: "v1" })],
      });
      const pid1 = await waitForFile(join(dir, "s1.pid"));
      expect(processAlive(pid1)).toBe(true);
      expect(app!.runtime.getMcpPort()).toBeDefined();
      // 注入仍不唤醒 bait 配置——零回退。
      expect(await listPids(dir)).toEqual([pid1]);

      // 显式清空：释放 port/池/子进程；bait 依旧不得加载。
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        mcpServers: [],
      });
      expect(app!.runtime.getMcpPort()).toBeUndefined();
      expect(await waitForExit(pid1)).toBe(true);
      expect(await listPids(dir)).toEqual([]);
    } finally {
      client.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("CMCP03 two live sessions on same cwd + identical config get independent PIDs; closing one does not affect the other", async () => {
    const fixture = await createAcpMcpCoreFixture();
    const dir = await mkdtemp(join(tmpdir(), "cmcp03-"));
    const pidDir = join(dir, "pids");
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    try {
      const sessionA = await createSession(client, fixture, {
        mcpServers: [stdioWireServer("s", dir, { pidDir })],
      });
      const sessionB = await createSession(client, fixture, {
        mcpServers: [stdioWireServer("s", dir, { pidDir })],
      });
      // 相同 cwd+同名同配置：两个并发会话必须各自持有独立子进程。
      let pids: number[] = [];
      for (let i = 0; i < 200 && pids.length < 2; i += 1) {
        pids = await listPids(pidDir);
        if (pids.length < 2) await new Promise((r) => setTimeout(r, 25));
      }
      expect(pids.length).toBe(2);

      // B 关闭后 A 的连接不受影响；B 的子进程必须死。
      const appA = fixture.apps.get(sessionA)!;
      const resultA = await appA.runtime.getMcpPort()!.callTool({
        serverName: "s",
        toolName: "echo",
        arguments: { text: "a" },
      });
      expect(JSON.stringify(resultA)).toContain("a");
      await client.request(zcodeProtocolMethods.sessionClose, { sessionId: sessionB });
      // 两池独立：B 的子进程死掉，A 的仍然活着。
      let remaining: number[] = pids;
      for (let i = 0; i < 200 && remaining.length > 1; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
        remaining = await listPids(pidDir);
      }
      expect(remaining.length).toBe(1);
      const stillA = await appA.runtime.getMcpPort()!.callTool({
        serverName: "s",
        toolName: "echo",
        arguments: { text: "still-a" },
      });
      expect(JSON.stringify(stillA)).toContain("still-a");
    } finally {
      client.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("CMCP04 resume with reordered identical list keeps the same PID; changed env reconnects only that server", async () => {
    const fixture = await createAcpMcpCoreFixture();
    const dir = await mkdtemp(join(tmpdir(), "cmcp04-"));
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    try {
      const sessionId = await createSession(client, fixture, {
        mcpServers: [
          stdioWireServer("one", dir, { label: "v1", env: { A_X: "1", B_Y: "2" } }),
          stdioWireServer("two", dir, { label: "u" }),
        ],
      });
      const pidOne = await waitForFile(join(dir, "one.pid"));
      const pidTwo = await waitForFile(join(dir, "two.pid"));
      // pid 文件出现 ≠ startup 全批 connect 收尾；等两条连接真正就绪再 resume，
      // 否则 apply 与 startup 并发，未变 server 的 lease 可能还没建立。
      for (let i = 0; i < 200; i += 1) {
        const statuses = await fixture.apps
          .get(sessionId)!
          .runtime.getMcpPort()!
          .status();
        if (statuses.one?.status === "connected" && statuses.two?.status === "connected") {
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      const appBefore = fixture.apps.get(sessionId);

      // 顺序不同 + env 数组顺序不同：同一份声明 → 同一条活连接，不重连。
      const reordered = [
        stdioWireServer("two", dir, { label: "u" }),
        stdioWireServer("one", dir, { label: "v1", env: { B_Y: "2", A_X: "1" } }),
      ];
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        mcpServers: reordered,
      });
      expect(processAlive(pidOne)).toBe(true);
      expect(processAlive(pidTwo)).toBe(true);
      expect(fixture.apps.get(sessionId)).toBe(appBefore);

      // 凭据变化：只重连那一个；未变的 server 保活同 PID。pid 文件重写有
      // 毫秒级滞后——先等 one 的旧 pid 死掉再读文件，避免拿到旧内容。
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        mcpServers: [
          stdioWireServer("one", dir, { label: "v2", env: { A_X: "9", B_Y: "2" } }),
          stdioWireServer("two", dir, { label: "u" }),
        ],
      });
      expect(await waitForExit(pidOne)).toBe(true);
      // 等新子进程覆盖写 pid 文件（内容不等于旧 pid）再断言。
      let pidOneV2 = pidOne;
      for (let i = 0; i < 400 && pidOneV2 === pidOne; i += 1) {
        try {
          pidOneV2 = Number((await readFile(join(dir, "one.pid"), "utf8")).trim());
        } catch { /* 重写窗口内文件短暂缺席 */ }
        if (pidOneV2 === pidOne) await new Promise((r) => setTimeout(r, 25));
      }
      // one.pid 被新子进程重写（pid 文件同路径；新实例覆盖写）。
      const pidTwoNow = Number((await readFile(join(dir, "two.pid"), "utf8")).trim());
      expect(pidTwoNow).toBe(pidTwo);
      expect(processAlive(pidTwo)).toBe(true);
      expect(pidOneV2).not.toBe(pidOne);
      expect(fixture.apps.get(sessionId)).toBe(appBefore);
    } finally {
      client.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("CMCP06 explicit empty list removes tools and never falls back to bait config", async () => {
    const fixture = await createAcpMcpCoreFixture();
    const dir = await mkdtemp(join(tmpdir(), "cmcp06-"));
    await mkdir(join(fixture.workspace, ".zcode"), { recursive: true });
    await writeFile(
      join(fixture.workspace, ".zcode", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            bait: {
              type: "stdio",
              command: NODE,
              args: [FIXTURE],
              env: { MCP_FIXTURE_PID_FILE: join(dir, "bait.pid") },
            },
          },
        },
      }),
    );
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    try {
      const sessionId = await createSession(client, fixture, {
        mcpServers: [stdioWireServer("s1", dir)],
      });
      const pid = await waitForFile(join(dir, "s1.pid"));
      const app = fixture.apps.get(sessionId)!;
      // tools/list 在连接建立后异步完成——轮询直到 s1 的工具面可见。
      let tools: Awaited<ReturnType<NonNullable<ReturnType<typeof app.runtime.getMcpPort>>["listTools"]>> = [];
      for (let i = 0; i < 200 && !tools.some((t) => t.serverName === "s1"); i += 1) {
        await new Promise((r) => setTimeout(r, 25));
        tools = await app.runtime.getMcpPort()!.listTools();
      }
      expect(tools.some((t) => t.serverName === "s1")).toBe(true);

      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        mcpServers: [],
      });
      // 显式空集是 provenance：零 tool、零回退 bait、子进程死。
      expect(await waitForExit(pid)).toBe(true);
      expect(app.runtime.getMcpPort()).toBeUndefined();
      expect(app.runtime.getConfiguredMcpServers()).toEqual({});
      expect(await listPids(dir)).toEqual([]);
    } finally {
      client.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("CMCP07 empty create then resume injection: tool reaches the actual ModelRequest and executes", async () => {
    const requests: ModelRequest[] = [];
    const fixture = await createAcpMcpCoreFixture({
      modelExecutor: createToolCallingExecutor("mcp__late__echo", requests),
    });
    const dir = await mkdtemp(join(tmpdir(), "cmcp07-"));
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    try {
      const sessionId = await createSession(client, fixture);
      await client.request(zcodeProtocolMethods.sessionSend, {
        sessionId,
        content: "first",
        inputId: "in-1",
      });
      await waitTurnRequests(requests, 1);
      await waitIdle(client, sessionId);
      // 注入前：模型请求不含任何 mcp__late__ 工具。
      expect(requests.at(-1)!.tools?.some((t) => t.name === "mcp__late__echo") ?? false).toBe(
        false,
      );

      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        mcpServers: [stdioWireServer("late", dir, { label: "inj" })],
      });
      const pid = await waitForFile(join(dir, "late.pid"));
      expect(processAlive(pid)).toBe(true);

      const before = requests.length;
      await client.request(zcodeProtocolMethods.sessionSend, {
        sessionId,
        content: "second",
        inputId: "in-2",
      });
      await waitTurnRequests(requests, before + 1);
      await waitIdle(client, sessionId);
      const post = requests.slice(before);
      // 工具真的出现在下一轮的 ModelRequest.tools，调用后结果回到后续请求。
      expect(post[0]?.tools?.some((t) => t.name === "mcp__late__echo")).toBe(true);
      const toolMessages = post
        .flatMap((r) => r.messages)
        .filter((m) => m.role === "tool")
        .map((m) => JSON.stringify(m));
      expect(toolMessages.some((m) => m.includes("echo[inj@"))).toBe(true);
    } finally {
      client.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("CMCP08 idle detach kills children; a different server owner adopts without mcpServers, keeping app+history and reconnecting", async () => {
    const requests: ModelRequest[] = [];
    const fixture = await createAcpMcpCoreFixture({
      modelExecutor: createToolCallingExecutor("mcp__s1__echo", requests),
    });
    const dir = await mkdtemp(join(tmpdir(), "cmcp08-"));
    const client1 = await fixture.connectRawClient();
    allowAllPermissions(client1);
    try {
      const sessionId = await createSession(client1, fixture, {
        mcpServers: [stdioWireServer("s1", dir, { label: "v1" })],
      });
      // 先跑一轮真 turn 把 history 落进 session——收养必须保住它。
      await client1.request(zcodeProtocolMethods.sessionSend, {
        sessionId,
        content: "seed-history-cmcp08",
        inputId: "in-1",
      });
      await waitTurnRequests(requests, 2);
      await waitIdle(client1, sessionId);
      const pid = await waitForFile(join(dir, "s1.pid"));
      expect(processAlive(pid)).toBe(true);
      const appBefore = fixture.apps.get(sessionId);
      const ownerA = fixture.ownerOf(sessionId);
      expect(ownerA).toBeDefined();

      // client socket 断开 = transport detach：软 detach 触发 client MCP suspend，
      // session 隔离 stdio 子进程必须死。
      client1.close();
      expect(await waitForExit(pid)).toBe(true);

      // 新 socket = 新 server（per-connection 生产语义）；resume 省略
      // mcpServers → 走 locateSessionOwner 收养 detached 旧 owner 的常驻
      // session，同一 app/runtime，不是重建。
      const client2 = await fixture.connectRawClient();
      allowAllPermissions(client2);
      try {
        await client2.request(zcodeProtocolMethods.sessionResume, {
          sessionId,
          workspace: workspaceRef(fixture),
        });
        expect(fixture.apps.get(sessionId)).toBe(appBefore);
        const ownerB = fixture.ownerOf(sessionId);
        expect(ownerB).toBeDefined();
        // owner 转移可观测：收养方是另一个 server 实例。
        expect(ownerB).not.toBe(ownerA);
        expect(ownerA!.isDetached()).toBe(true);
        expect(ownerB!.isDetached()).toBe(false);

        // history 保留：收养后的 session 仍带上一轮 seeded user 输入。
        const history = await client2.request<{ messages: unknown[] }>(
          zcodeProtocolMethods.sessionMessages,
          { sessionId },
        );
        expect(
          history.messages.some((m) =>
            JSON.stringify(m).includes("seed-history-cmcp08"),
          ),
        ).toBe(true);
        // #52 回归：真实 core 的 session/messages 必须满足客户端 strict 协议 schema。
        expect(() => zcodeSessionMessagesResultSchema.parse(history)).not.toThrow();

        // 收养 reconnect 起新代子进程，下一轮 tool call 真实走通。
        const pid2 = await waitForFile(join(dir, "s1.pid"), 400);
        expect(processAlive(pid2)).toBe(true);
        expect(pid2).not.toBe(pid);
        const before = requests.length;
        await client2.request(zcodeProtocolMethods.sessionSend, {
          sessionId,
          content: "post-adopt",
          inputId: "in-2",
        });
        await waitTurnRequests(requests, before + 1);
        await waitIdle(client2, sessionId);
        const post = requests.slice(before);
        const toolMessages = post
          .flatMap((r) => r.messages)
          .filter((m) => m.role === "tool")
          .map((m) => JSON.stringify(m));
        expect(toolMessages.some((m) => m.includes(`echo[v1@${pid2}]`))).toBe(true);
      } finally {
        client2.close();
      }
    } finally {
      client1.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("CMCP08 active detach: blocked in-flight tool call dies with the socket owner; the turn/session is not destroyed and adopts cleanly", async () => {
    const requests: ModelRequest[] = [];
    // 首轮模型要 echo；fixture HOLD_CALL 让真实 tools/call 永远挂起。
    const fixture = await createAcpMcpCoreFixture({
      modelExecutor: {
        generateText: async (request: ModelRequest) => {
          requests.push(request);
          if (requests.length === 1) {
            return {
              finishReason: "tool-calls",
              toolCalls: [
                { id: "call-blocked", name: "mcp__s1__echo", input: { text: "blocked" } },
              ],
              usage: {},
            } as ModelResult;
          }
          return {
            finishReason: "stop",
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as ModelResult;
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "cmcp08-active-"));
    const client1 = await fixture.connectRawClient();
    allowAllPermissions(client1);
    try {
      const callMarker = join(dir, "call.marker");
      const sessionId = await createSession(client1, fixture, {
        mcpServers: [
          stdioWireServer("s1", dir, { label: "v1", holdCall: true, callMarker }),
        ],
      });
      const pid = await waitForFile(join(dir, "s1.pid"));
      // 等工具注册完成再 send：未注册时 callTool 直接失败，调用永远到不了
      // 子进程（旧 300ms sleep 掩盖了这个竞态）。
      await waitForToolRegistered(fixture, sessionId, "s1", "echo");
      // send 在后台跑：模型请求已发出并返回 toolCalls，真实 tools/call 被
      // fixture 闸门挡住——detach 时该调用仍在飞行。
      void client1
        .request(zcodeProtocolMethods.sessionSend, {
          sessionId,
          content: "call-blocked-tool",
          inputId: "in-1",
        })
        .catch(() => undefined);
      await waitTurnRequests(requests, 1);
      // tools/call 真实到达子进程才有标记（fixture 在 holdCall 闸门之前写
      // 自身 pid）——不靠 sleep 猜 adapter 调度时序。
      const markerPid = await waitForFile(callMarker);
      expect(markerPid).toBe(pid);
      const appBefore = fixture.apps.get(sessionId);
      const ownerA = fixture.ownerOf(sessionId);

      client1.close();
      // session 隔离子进程必须随 detach 立即死。
      expect(await waitForExit(pid)).toBe(true);
      // 整个 turn/session 不被销毁：app 仍 resident 在旧 owner。
      expect(fixture.apps.get(sessionId)).toBe(appBefore);
      expect(fixture.ownerOf(sessionId)).toBe(ownerA);

      // 新 owner 收养 + resume：session 可用，下一轮正常完成（此轮不调工具）。
      const client2 = await fixture.connectRawClient();
      allowAllPermissions(client2);
      try {
        await client2.request(zcodeProtocolMethods.sessionResume, {
          sessionId,
          workspace: workspaceRef(fixture),
        });
        expect(fixture.apps.get(sessionId)).toBe(appBefore);
        expect(fixture.ownerOf(sessionId)).not.toBe(ownerA);
        const before = requests.length;
        await client2.request(zcodeProtocolMethods.sessionSend, {
          sessionId,
          content: "after-active-detach",
          inputId: "in-2",
        });
        await waitTurnRequests(requests, before + 1);
        await waitIdle(client2, sessionId);
      } finally {
        client2.close();
      }
    } finally {
      client1.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("CMCP09 V4 forkAssistant during an active parent turn inherits the pending client definition; legacy sessionFork stays guarded", async () => {
    const requests: ModelRequest[] = [];
    let gate!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      gate = resolve;
    });
    let requestCount = 0;
    const fixture = await createAcpMcpCoreFixture({
      modelExecutor: {
        generateText: async (request) => {
          requests.push(request);
          requestCount += 1;
          if (requestCount === 3) await turnGate; // 第二轮首个请求阻塞 → parent active
          const tools = request.tools ?? [];
          // 每轮一次调用：忽略工具结果后的预算提醒，检查最后一条实际对话消息；
          // parent/child 各自的 transcript 互不干扰。
          const lastRole = request.messages.findLast(
            (message) =>
              !(
                message.role === "user" &&
                typeof message.content === "string" &&
                message.content.includes("<total_tokens>")
              ),
          )?.role;
          if (tools.some((t) => t.name === "mcp__fork__echo") && lastRole !== "tool") {
            return {
              finishReason: "tool-calls",
              text: "",
              toolCalls: [{ id: "c1", name: "mcp__fork__echo", input: { text: "t1" } }],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            } as ModelResult;
          }
          return {
            finishReason: "stop",
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as ModelResult;
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "cmcp09-"));
    const pidDir = join(dir, "pids");
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    try {
      const sessionId = await createSession(client, fixture, {
        mcpServers: [
          stdioWireServer("fork", dir, { label: "v1", pidDir, env: { CRED: SENTINEL_CRED } }),
        ],
      });
      const parentPid = await waitForFile(join(dir, "fork.pid"));
      // 等工具注册完成再发第一轮，否则 req0 看不到 mcp__fork__echo。
      const app = fixture.apps.get(sessionId)!;
      for (let i = 0; i < 200; i += 1) {
        const listed = await app.runtime.getMcpPort()?.listTools();
        if (listed?.some((t) => t.name === "mcp__fork__echo")) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      // 第一轮完成 → 投影里有 assistant 行可 fork。
      await client.request(zcodeProtocolMethods.sessionSend, {
        sessionId,
        content: "first",
        inputId: "in-1",
      });
      await waitTurnRequests(requests, 2);
      await waitIdle(client, sessionId);

      // 订阅真实 conversation 投影，取 assistant 行的 rowId/entityId。
      // wire 形状：params={kind:"complete",frame:{payload:{kind:"snapshot"|"deltas"}}}；
      // 行既在 snapshot.rows.window，也在 deltas 的 row.appended/row.upserted。
      type ProjectionRow = { rowId: number; kind: string; entityId?: string };
      const frames: Array<{
        kind?: string;
        frame?: {
          payload?: {
            kind?: string;
            snapshot?: {
              logEpoch?: string;
              revision?: number;
              rows?: { window?: ProjectionRow[] };
            };
            deltas?: Array<{ op?: string; row?: ProjectionRow }>;
          };
        };
      }> = [];
      client.onNotification((message) => {
        if (message.method === "v4/conversation/frame") {
          frames.push(message.params as (typeof frames)[number]);
        }
      });
      const subscribe = await client.request<{ ack: { subscriptionId: string } }>(
        "v4/conversation/subscribe",
        {
          topic: `conversation/${sessionId}`,
          connectionId: "cmcp09",
          clientMode: "desktop-continuous",
          workspace: workspaceRef(fixture),
        },
      );
      expect(subscribe.ack.subscriptionId).toBeTruthy();
      let assistantRow: { rowId: number; entityId: string } | undefined;
      for (let i = 0; i < 200 && !assistantRow; i += 1) {
        const rows: ProjectionRow[] = frames.flatMap((f) => {
          const payload = f.frame?.payload;
          if (!payload) return [];
          return [
            ...(payload.snapshot?.rows?.window ?? []),
            ...(payload.deltas ?? [])
              .filter((d) => d.op === "row.appended" || d.op === "row.upserted")
              .map((d) => d.row!)
              .filter(Boolean),
          ];
        });
        const row = [...rows].reverse().find((r) => r.kind === "assistantText" && r.entityId);
        if (row) assistantRow = { rowId: row.rowId, entityId: row.entityId! };
        else await new Promise((r) => setTimeout(r, 25));
      }
      expect(assistantRow).toBeDefined();

      // parent 第二轮进入 active（首个模型请求被闸门挡住）。
      const send2 = client.request(zcodeProtocolMethods.sessionSend, {
        sessionId,
        content: "second",
        inputId: "in-2",
      });
      for (let i = 0; i < 200 && requestCount < 3; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(requestCount).toBe(3);

      // active turn 期间 resume 换凭据 → pending desired（不立即切连接）。
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        mcpServers: [
          stdioWireServer("fork", dir, { label: "v2", pidDir, env: { CRED: SENTINEL_CRED } }),
        ],
      });
      expect(processAlive(parentPid)).toBe(true);

      // legacy sessionFork 对 active parent 必须仍被 guard 拒。
      const legacyFork = await client.request(
        zcodeProtocolMethods.sessionFork,
        { sessionId, target: { kind: "message", messageId: "m-1" } },
      ).then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );
      expect(legacyFork.ok).toBe(false);

      // V4 forkAssistant：conversation-only，父轮不取消；child 立刻继承
      // 最新 accepted client 声明（pending v2）。CAS 命令需要投影的
      // baseRevision/baseLogEpoch——取调用瞬间最新一帧的 revision/logEpoch；
      // req3 阻塞期间投影不再前进，值在判决时仍新鲜。
      const latestBase = () => {
        let revision = 0;
        let logEpoch: string | undefined;
        for (const f of frames) {
          const snapshot = f.frame?.payload?.snapshot;
          if (typeof snapshot?.revision === "number" && snapshot.revision > revision) {
            revision = snapshot.revision;
          }
          if (snapshot?.logEpoch) logEpoch = snapshot.logEpoch;
          for (const d of f.frame?.payload?.deltas ?? []) {
            const patched = (d as { patch?: { revision?: number } }).patch?.revision;
            if (typeof patched === "number" && patched > revision) revision = patched;
          }
        }
        return { logEpoch, revision };
      };
      await new Promise((r) => setTimeout(r, 150));
      const base = latestBase();
      const forkAck = await client.request<{
        status: string;
        reasonCode?: string;
        result?: { sessionId?: string };
      }>("v4/command", {
        clientId: "cmcp09",
        commandId: "fork-1",
        issuedAt: Date.now(),
        sessionId,
        type: "forkAssistant",
        payload: { target: assistantRow },
        baseRevision: base.revision,
        baseLogEpoch: base.logEpoch,
      });
      expect(forkAck.status).toBe("accepted");
      const childId = forkAck.result?.sessionId;
      expect(childId).toBeTruthy();
      expect(childId).not.toBe(sessionId);

      // parent 轮取消闸门放行 → 正常跑完；child 已存在。整轮边界落地
      // pending v2：v1 连接（parentPid）此刻被替换——进程回收异步发生，
      // 这里只断回合正常完成、app 未取消。
      gate();
      await send2;
      await waitIdle(client, sessionId);

      // child 的 accepted 声明是 pending v2（落在 config.mcp.servers，
      // 不是 desired——fork 物化时直接盖进 runtimeConfig）。
      const childApp = fixture.apps.get(String(childId));
      expect(childApp).toBeDefined();
      const childServers = childApp!.runtime.getEffectiveMcpConfig()?.servers;
      expect(childServers?.fork?.type).toBe("stdio");
      // 继承的是 pending v2 声明，不是 parent 连接的 v1 快照。
      expect(
        (childServers?.fork as { env?: Record<string, string> } | undefined)?.env
          ?.MCP_FIXTURE_LABEL,
      ).toBe("v2");
      // child 经真实协议 resume/send 跑一轮：scripted model 调继承的
      // mcp__fork__echo，tool 结果回到下一个 child ModelRequest——全程不走
      // callTool 旁路。等 child 的 session 连接+工具注册完成再 send。
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId: childId,
        workspace: workspaceRef(fixture),
      });
      await waitForToolRegistered(fixture, String(childId), "fork", "echo");
      const childRequestsBefore = requests.length;
      await client.request(zcodeProtocolMethods.sessionSend, {
        sessionId: String(childId),
        content: "child turn",
        inputId: "child-in-1",
      });
      await waitTurnRequests(requests, childRequestsBefore + 2);
      await waitIdle(client, String(childId));
      // child 的 tool 结果：v2 标签 + 独立 pid（与 parent 连接不同进程）。
      const childToolText = requests
        .slice(childRequestsBefore)
        .flatMap((r) => r.messages)
        .filter((m) => m.role === "tool")
        .map((m) => JSON.stringify(m))
        .join("\n");
      expect(childToolText).toContain("echo[v2@");
      const childPid = Number(/echo\[v2@(\d+)\]/.exec(childToolText)?.[1]);
      expect(childPid).toBeGreaterThan(0);
      // parent 边界后已切到 v2 连接——child 必须是另一台进程（session 隔离）。
      const parentEcho = await app.runtime.getMcpPort()?.callTool({
        serverName: "fork",
        toolName: "echo",
        arguments: { text: "parent-alive" },
      });
      const parentLivePid = Number(
        /echo\[v2@(\d+)\]/.exec(JSON.stringify(parentEcho))?.[1],
      );
      expect(parentLivePid).toBeGreaterThan(0);
      expect(childPid).not.toBe(parentLivePid);
      expect(childPid).not.toBe(parentPid);

      // 凭据不落盘：全 rootDir 扫描 sentinel，除 pid/label 外不得出现 CRED 值。
      const hits = await scanDirForNeedle(fixture.rootDir, SENTINEL_CRED);
      expect(hits).toEqual([]);

      // child close 后 parent 仍可用。
      await client.request(zcodeProtocolMethods.sessionClose, { sessionId: childId });
      const stillAlive = await fixture.apps.get(sessionId)!.runtime.getMcpPort()?.callTool({
        serverName: "fork",
        toolName: "echo",
        arguments: { text: "parent" },
      });
      expect(JSON.stringify(stillAlive)).toContain("parent");
    } finally {
      gate();
      client.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("CMCP12 malformed mcpServers at the boundary return sanitized errors, not crashes", async () => {
    const fixture = await createAcpMcpCoreFixture();
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    try {
      // 缺 command 的 stdio 形状 → schema 拒绝，invalid params 而非 TypeError。
      const missingCommand = await client
        .request(zcodeProtocolMethods.sessionCreate, {
          workspace: workspaceRef(fixture),
          mcpServers: [{ name: "bad" }],
        })
        .then(() => ({ ok: true as const }), (error) => ({ ok: false as const, error }));
      expect(missingCommand.ok).toBe(false);
      if (!missingCommand.ok) {
        expect(JSON.stringify(missingCommand.error)).not.toContain("TypeError");
      }

      // env 形状非法（非数组）→ 同样被 schema 挡在边界。
      const badEnv = await client
        .request(zcodeProtocolMethods.sessionCreate, {
          workspace: workspaceRef(fixture),
          mcpServers: [{ name: "bad", command: NODE, args: [], env: { A: "1" } }],
        })
        .then(() => ({ ok: true as const }), (error) => ({ ok: false as const, error }));
      expect(badEnv.ok).toBe(false);

      // null headers 同理。
      const badHeaders = await client
        .request(zcodeProtocolMethods.sessionCreate, {
          workspace: workspaceRef(fixture),
          mcpServers: [{ name: "bad", type: "http", url: "http://127.0.0.1:1/mcp", headers: null }],
        })
        .then(() => ({ ok: true as const }), (error) => ({ ok: false as const, error }));
      expect(badHeaders.ok).toBe(false);
    } finally {
      client.close();
      await fixture.close();
    }
  }, 60_000);

  it("CMCP05 credential swap mid-turn: staged apply keeps OLD connection for the whole turn; queued next turn uses NEW", async () => {
    const requests: ModelRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createAcpMcpCoreFixture({
      modelExecutor: {
        generateText: async (request: ModelRequest) => {
          requests.push(request);
          const index = requests.length;
          const toolCalls = {
            finishReason: "tool-calls",
            text: "",
            toolCalls: [{ id: `call-${index}`, name: "mcp__s1__echo", input: { text: "ping" } }],
            usage: {},
          } as ModelResult;
          const stop = {
            finishReason: "stop",
            text: "done",
            usage: {},
          } as ModelResult;
          // turn 1: req1 调 echo → req2 被闸门挡住（apply 不得进入本轮）→ 放行后
          // 再调 echo → req3 stop。queued turn 2: req4 调 echo → req5 stop。
          if (index === 1) return toolCalls;
          if (index === 2) {
            await gate;
            return toolCalls;
          }
          if (index === 3) return stop;
          if (index === 4) return toolCalls;
          return stop;
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "cmcp05-swap-"));
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    const wire = (auth: string) =>
      stdioWireServer("s1", dir, {
        label: "gen",
        versionEnv: "FAKE_AUTH",
        env: { FAKE_AUTH: auth },
      });
    try {
      // 同名、同 command/args，只换 FAKE_AUTH——credential-only 配置漂移；
      // fixture 把 env 值映成无害代际标签（gen-v1/gen-v2），token 不回显。
      const sessionId = await createSession(client, fixture, {
        mcpServers: [wire("v1")],
      });
      const pidOld = await waitForFile(join(dir, "s1.pid"));
      await waitForToolRegistered(fixture, sessionId, "s1", "echo");

      await client.request(zcodeProtocolMethods.sessionSend, {
        sessionId,
        content: "turn-one",
        inputId: "in-1",
      });
      await waitTurnRequests(requests, 2, 120); // req2 已发出并阻塞在闸门

      // turn 活跃期间：下一 prompt 走真实 queue admission（steer lane →
      // steerTurn 排队），再 resume 仅改 FAKE_AUTH=v2——两处都必须等到整轮
      // 边界才生效。
      const steerAck = await client.request<{ steerQueued?: { queueLength: number } }>(
        zcodeProtocolMethods.sessionSend,
        {
          sessionId,
          content: "turn-two-queued",
          delivery: "steer",
          inputId: "in-2",
        },
      );
      expect(steerAck.steerQueued?.queueLength).toBe(1);
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        mcpServers: [wire("v2")],
      });
      // staged 证明：阻塞未放行前，queued turn 未启动、OLD 子进程仍存活。
      expect(requests.length).toBe(2);
      expect(processAlive(pidOld)).toBe(true);
      const appliedMidTurn =
        fixture.apps.get(sessionId)!.runtime.getEffectiveMcpConfig();
      expect(JSON.stringify(appliedMidTurn)).toContain('"FAKE_AUTH":"v1"');
      expect(JSON.stringify(appliedMidTurn)).not.toContain('"FAKE_AUTH":"v2"');

      release();
      // turn 1 跑完：本turn两次 echo 的 tool 结果逐条断言——分别落在 req2
      // （call-1 回包）与 req3（call-2 回包）末条 tool 消息上；拼接整段只验
      // 一条 gen-v1 会漏掉「第二次调用切到新连接」的漂移。
      await waitTurnRequests(requests, 3);
      const turnOneResults = [requests[1], requests[2]].map(
        (r) => r!.messages.filter((m) => m.role === "tool").at(-1),
      );
      expect(turnOneResults.every((m) => m !== undefined)).toBe(true);
      for (const result of turnOneResults) {
        const text = JSON.stringify(result);
        expect(text).toContain(`echo[gen-v1@${pidOld}]`);
        expect(text).not.toContain("gen-v2");
      }

      // 整轮边界：staged apply 落地（v2 新 PID），steer 队列项不会自动开新
      // turn（服务端不擅自开新回合，队列由客户端 flush）——idle 后客户端
      // flush 重发，turn 2 的 req4/req5 落在新代连接上。
      await waitIdle(client, sessionId);
      let pidNew = pidOld;
      for (let i = 0; i < 200 && pidNew === pidOld; i += 1) {
        pidNew = Number((await readFile(join(dir, "s1.pid"), "utf8")).trim());
        if (pidNew === pidOld) await new Promise((r) => setTimeout(r, 25));
      }
      expect(pidNew).not.toBe(pidOld);
      expect(processAlive(pidNew)).toBe(true);
      // 客户端 flush 队列项 → turn 2。
      await client.request(zcodeProtocolMethods.sessionSend, {
        sessionId,
        content: "turn-two-flush",
        inputId: "in-3",
      });
      await waitTurnRequests(requests, 5);
      await waitIdle(client, sessionId);
      // turn 2 新增的 tool 结果是新代——req5 的消息含整段 transcript（turn 1
      // 的 gen-v1 结果本就在其中），所以只取 turn 2 触发的最新一条。
      const turnTwoToolMessages = requests[4]!.messages.filter(
        (m) => m.role === "tool",
      );
      const latestToolText = JSON.stringify(turnTwoToolMessages.at(-1));
      expect(latestToolText).toContain(`echo[gen-v2@${pidNew}]`);
      expect(latestToolText).not.toContain("gen-v1");
      // 旧代子进程在整轮边界后才被回收。
      expect(await waitForExit(pidOld)).toBe(true);
    } finally {
      release();
      client.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("CMCP05 goal continuation: change staged during an active turn is picked up by continueActiveTargetIfIdle's next turn", async () => {
    const requests: ModelRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createAcpMcpCoreFixture({
      modelExecutor: {
        generateText: async (request: ModelRequest) => {
          requests.push(request);
          const index = requests.length;
          if (index === 1) {
            await gate;
            return {
              finishReason: "tool-calls",
              text: "",
              toolCalls: [
                { id: "call-g1", name: "mcp__s1__echo", input: { text: "seed" } },
              ],
              usage: {},
            } as ModelResult;
          }
          return {
            finishReason: "stop",
            text: "done",
            usage: {},
          } as ModelResult;
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "cmcp05-goal-"));
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    try {
      const sessionId = await createSession(client, fixture, {
        mcpServers: [stdioWireServer("s1", dir, { label: "v1" })],
      });
      await waitForFile(join(dir, "s1.pid"));
      await waitForToolRegistered(fixture, sessionId, "s1", "echo");
      void client
        .request(zcodeProtocolMethods.sessionSend, {
          sessionId,
          content: "seed",
          inputId: "in-1",
        })
        .catch(() => undefined);
      await waitTurnRequests(requests, 1); // req1 阻塞在闸门内，turn 活跃

      // turn 活跃期间 resume 换 server 名（s1→s2）：只能 staged，不能落地。
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        mcpServers: [stdioWireServer("s2", dir, { label: "v2" })],
      });
      const stagedEffective =
        fixture.apps.get(sessionId)!.runtime.getEffectiveMcpConfig()?.servers;
      expect(stagedEffective?.s1).toBeDefined();
      expect(stagedEffective?.s2).toBeUndefined();

      release();
      await waitTurnRequests(requests, 2);
      await waitIdle(client, sessionId);
      // 本轮的 tool 结果来自旧 s1 连接（staged 没有中途换连接）。
      const turnToolText = requests
        .slice(0, 2)
        .flatMap((r) => r.messages)
        .filter((m) => m.role === "tool")
        .map((m) => JSON.stringify(m))
        .join("\n");
      expect(turnToolText).toContain("echo[v1@");

      // 协议 create 经 resume 语义把 runtime.sessionPersisted 直接置真，sqlite
      // session 行并不写（registry 是 metadata 权威）；目标表 FK 需要该行，
      // 补写与 persistSession 同构的最小行后走真实 createTarget。
      await fixture.sessionStore.createSession({
        id: sessionId as SessionId,
        projectID: projectIdFromDirectory(fixture.workspace),
        slug: `cmcp05-${sessionId}`,
        directory: fixture.workspace,
        path: fixture.workspace,
        title: "cmcp05",
        titleSource: "first_input",
        version: "0.0.0-test",
        permission: { mode: "build" },
      });
      const target = await fixture.sessionStore.createTarget({
        objective: "finish the seeded goal",
        sessionID: sessionId as SessionId,
      });
      expect(target).not.toBeNull();
      const before = requests.length;
      const turn = await fixture.apps
        .get(sessionId)!
        .runtime.continueActiveTargetIfIdle();
      expect(turn).not.toBeNull();
      const continuation = requests.slice(before)[0];
      expect(continuation).toBeDefined();
      // staged 的 s2 在续跑 admission 边界落地——续跑 ModelRequest 看见新代。
      expect(continuation.tools?.some((t) => t.name === "mcp__s2__echo")).toBe(true);
      expect(continuation.tools?.some((t) => t.name === "mcp__s1__echo")).toBe(false);
    } finally {
      release();
      client.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // CMCP13：故意的连接失败把唯一 sentinel 塞进错误文本——spawn ENOENT 的
  // message 必然回显 command 路径；env/header 值也埋 sentinel。产品面
  // （logger 输出、session events、session/read 快照、持久化 transcript、
  // storage 落盘文件）只允许结构化类别/计数，不得回显任何 client 值。
  // 任一命中即 fail —— 命中处就是真实的凭据泄漏生产者。
  // 会话自有 noPlugins adapter 走 connectionDiagnostics:"structural"：失败
  // status/log 只发 failureKind 与数值/结构字段（rework5 落地）。
  it("CMCP13 connect-failure diagnostics never echo client-supplied values", async () => {
    const logs: Array<{
      level: string;
      message: string;
      error?: string;
      context?: unknown;
    }> = [];
    const makeCapturingLogger = (parent?: LogContext): Logger => {
      const capture = (level: string, message: string, error?: Error, context?: LogContext) => {
        logs.push({
          level,
          message,
          ...(error ? { error: `${error.name}: ${error.message}` } : {}),
          context: { ...parent, ...context },
        });
      };
      return {
        debug: (message, context) => capture("debug", message, undefined, context),
        info: (message, context) => capture("info", message, undefined, context),
        warn: (message, context) => capture("warn", message, undefined, context),
        error: (message, error, context) => capture("error", message, error, context),
        child: (context) => makeCapturingLogger({ ...parent, ...context }),
      };
    };
    const loggerFactory: LoggerFactory = {
      createLogger: () => makeCapturingLogger(),
      withContext: (context) => makeCapturingLogger(context),
      setLevel: () => undefined,
    };
    const fixture = await createAcpMcpCoreFixture({ loggerFactory });
    const dir = await mkdtemp(join(tmpdir(), "cmcp13-"));
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    const notifications: string[] = [];
    client.onNotification((message) => notifications.push(JSON.stringify(message)));
    try {
      // stdio command 指向不存在的 sentinel 路径：spawn ENOENT 文本里带路径；
      // env 值同样埋 sentinel——两个 client 值都必须被脱敏层挡住。
      const badCommand = join(dir, SENTINEL_CRED, "missing");
      const sessionId = await createSession(client, fixture, {
        mcpServers: [
          {
            name: "bad",
            scope: "user",
            command: badCommand,
            args: [],
            env: [
              { name: "FAKE_AUTH", value: SENTINEL_CRED },
              { name: "MCP_FIXTURE_PID_FILE", value: join(dir, "bad.pid") },
            ],
            isolation: "session",
            protocolVersion: "legacy",
          },
        ],
      });
      const app = fixture.apps.get(sessionId)!;
      // 等失败 settle：port 状态出现 bad=failed（或连接彻底缺席且 startup 完成）。
      let settled = false;
      for (let i = 0; i < 400 && !settled; i += 1) {
        const statuses = (await app.runtime.getMcpPort()?.status()) ?? {};
        const bad = (statuses as Record<string, { status?: string }>).bad;
        if (bad?.status === "failed" || bad?.status === "error") settled = true;
        else if (
          logs.some(
            (entry) =>
              (entry.context as { event?: string })?.event === "mcp.apply.connect_failed" ||
              (entry.context as { event?: string })?.event ===
                "mcp.startup.connect_failed",
          )
        )
          settled = true;
        else await new Promise((r) => setTimeout(r, 25));
      }
      expect(settled).toBe(true);

      // 五个面一次收齐再断言——单次运行给出完整泄漏面（face:命中明细）。
      const leaks: string[] = [];

      // 面 2：协议 notification 流（内存快照，顺序无关）。
      for (const n of notifications) {
        if (n.includes(SENTINEL_CRED)) {
          leaks.push(`notification:${n.slice(0, 80)}`);
        }
      }

      // 面 3：session/read 快照（消息/状态投影视图）——需要 live session，
      // 必须在 app.close 之前读。
      const snapshot = await client.request(
        zcodeProtocolMethods.sessionRead,
        { sessionId },
      );
      if (JSON.stringify(snapshot).includes(SENTINEL_CRED)) leaks.push("sessionRead");

      // 收尾 close/flush：先关掉 app，让 adapter 关闭路径日志（mcp.server.closed
      // 等）全部落进捕获器再扫——不扫迟到日志等于漏掉一个泄露面。
      // sessionStore 保留给面 4；fixture.rootDir 由 fixture.close 最后清理。
      await app.close?.();

      // 面 1：产品 logger 全部记录（含 close/flush 后的迟到记录）。
      for (const entry of logs) {
        if (JSON.stringify(entry).includes(SENTINEL_CRED)) {
          leaks.push(
            `logger:${(entry.context as { event?: string })?.event ?? "unknown"}:${entry.level}`,
          );
        }
      }

      // 面 4：持久化 transcript（sessionStore 是真实 SQLite）。
      const persisted = await fixture.sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      if (JSON.stringify(persisted).includes(SENTINEL_CRED)) leaks.push("sessionStore");

      // 面 5：storage/db/workspace 全部落盘文件。
      for (const hit of await scanDirForNeedle(fixture.rootDir, SENTINEL_CRED)) {
        leaks.push(`file:${hit}`);
      }

      expect(leaks).toEqual([]);
    } finally {
      client.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // 评审 R1：detach 到达在飞 session/create factory——attachment 信号先于
  // sessions 登记落下，迟到物化不得放行 stdio，也不得复活已死子进程。
  it("CMCP-R1a detach before construction: no stdio admitted, late registration stays detached, adoption reconnects", async () => {
    const requests: ModelRequest[] = [];
    let releaseFactory!: () => void;
    let factorySeenResolve!: () => void;
    const factorySeen = new Promise<void>((resolve) => (factorySeenResolve = resolve));
    const factoryGate = new Promise<void>((resolve) => (releaseFactory = resolve));
    const fixture = await createAcpMcpCoreFixture({
      modelExecutor: createToolCallingExecutor("mcp__s1__echo", requests),
      appFactoryHooks: {
        // 确定性屏障：factory 已进、真实 app 尚未构造。
        preCreate: () => {
          factorySeenResolve();
          return factoryGate;
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "cmcp-r1a-"));
    const client1 = await fixture.connectRawClient();
    allowAllPermissions(client1);
    try {
      const createPromise = client1.request(
        zcodeProtocolMethods.sessionCreate,
        {
          workspace: workspaceRef(fixture),
          mcpServers: [stdioWireServer("s1", dir, { label: "r1a" })],
        },
      );
      void createPromise.catch(() => undefined); // 死 socket 上响应无处投递
      await factorySeen;

      // 两条 detach 清理回调都在「无登记 record」的 sessions 表上跑完——
      // 物化窗口内的会话只能靠 attachment 信号收到 detach。
      client1.close();
      await client1.closed;
      // client 侧 close 完成 ≠ server EOF 已 drain——detach 标记是异步落下。
      // 用 owner 表轮询做确定性屏障：两条清理回调跑完后 server 才 isDetached。
      let ownerA: ZCodeProtocolAgentServer | undefined;
      for (let i = 0; i < 400; i += 1) {
        ownerA = [...fixture.servers].find((s) => s.isDetached());
        if (ownerA) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(ownerA).toBeDefined();
      expect(fixture.apps.size).toBe(0);

      releaseFactory();
      // 物化屏障：factory 返回 → sessions.set + attach reconcile 都已跑完。
      for (let i = 0; i < 400 && fixture.apps.size === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(fixture.apps.size).toBe(1);
      const [sessionId, app] = [...fixture.apps.entries()][0]!;
      // 屏障之后才查 PID：出生即 detached 的 runtime 没有放行任何 stdio。
      // （port 对象在装配期就建好了——准入证据看子进程与 status，不看 port 有无。）
      expect(await listPids(dir)).toEqual([]);
      expect(await app.runtime.getMcpPort()?.status()).toEqual({});
      expect(fixture.ownerOf(sessionId)).toBe(ownerA);

      // 真实 owner 收养 + prompt：零回合会话还没有持久化行，session/resume
      // 的血缘预检不收它——但 session-scoped 请求的 claimDetachedSession 会在
      // resolve 时把常驻 detached record 收养到本连接（server-types.ts:474）。
      const client2 = await fixture.connectRawClient();
      allowAllPermissions(client2);
      try {
        await client2.request(zcodeProtocolMethods.sessionSend, {
          sessionId,
          content: "adopted-r1a",
          inputId: "in-2",
        });
        await waitTurnRequests(requests, 2);
        await waitIdle(client2, sessionId);
        expect(fixture.apps.get(sessionId)).toBe(app);
        // owner 转移可观测：收养后挂在 client2 的 server 上。
        const ownerB = fixture.ownerOf(sessionId);
        expect(ownerB).toBeDefined();
        expect(ownerB).not.toBe(ownerA);
        const pid = await waitForFile(join(dir, "s1.pid"));
        expect(processAlive(pid)).toBe(true);
        const toolMessages = requests
          .flatMap((r) => r.messages)
          .filter((m) => m.role === "tool")
          .map((m) => JSON.stringify(m));
        expect(toolMessages.some((m) => m.includes(`echo[r1a@${pid}]`))).toBe(true);
      } finally {
        client2.close();
      }
    } finally {
      client1.close();
      await fixture.close();
      expect(await listPids(dir)).toEqual([]);
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("CMCP-R1b detach while record unregistered (app built, factory held): blocked-initialize child dies before release; late registration stays detached", async () => {
    let releaseFactory!: () => void;
    let constructedResolve!: () => void;
    const constructed = new Promise<void>((resolve) => (constructedResolve = resolve));
    const factoryGate = new Promise<void>((resolve) => (releaseFactory = resolve));
    const fixture = await createAcpMcpCoreFixture({
      appFactoryHooks: {
        // 确定性屏障：真实 app/runtime 已构造（startup 已在飞）、factory 未返回。
        postCreate: () => {
          constructedResolve();
          return factoryGate;
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "cmcp-r1b-"));
    const client1 = await fixture.connectRawClient();
    allowAllPermissions(client1);
    try {
      const createPromise = client1.request(
        zcodeProtocolMethods.sessionCreate,
        {
          workspace: workspaceRef(fixture),
          // HOLD_INITIALIZE：子进程已起、握手永远挂起——在飞连接的典型形态。
          mcpServers: [stdioWireServer("s1", dir, { hold: true })],
        },
      );
      void createPromise.catch(() => undefined);
      await constructed;
      // 被扣握手的真实 stdio 子进程存在。
      const pid = await waitForFile(join(dir, "s1.pid"));
      expect(processAlive(pid)).toBe(true);
      const sessionId = [...fixture.apps.keys()][0]!;

      // record 未登记时 detach：attachment 信号让在飞 connect 中止，
      // 子进程必须先于 factory 放行死掉。
      client1.close();
      await client1.closed;
      expect(await waitForExit(pid)).toBe(true);

      releaseFactory();
      // 迟到登记屏障：sessions.set 后 owner 表出现该 session。
      for (let i = 0; i < 400; i += 1) {
        if ([...fixture.servers].some((s) => s.hasResidentSession(sessionId))) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect([...fixture.servers].some((s) => s.hasResidentSession(sessionId))).toBe(true);
      const app = fixture.apps.get(sessionId)!;
      // 登记后 reconcile 复核 detached：不得复活已死的连接/子进程。
      for (let i = 0; i < 100; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
        if ((await listPids(dir)).length > 0) break;
      }
      expect(await listPids(dir)).toEqual([]);
      expect(processAlive(pid)).toBe(false);
      expect(app).toBeDefined();
    } finally {
      client1.close();
      await fixture.close();
      expect(await listPids(dir)).toEqual([]);
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // 评审 R2：相同声明 ≠ 活连接。endpoint 缺席起 failed， identical resume 必须
  // 经池 revalidate 原地重连；live sibling 的连接/PID 不受打扰。
  it("CMCP-R2 identical resume retries failed entry; live sibling keeps PID; fail→success; no per-turn retry", async () => {
    const requests: ModelRequest[] = [];
    const fixture = await createAcpMcpCoreFixture({
      // h1 上线后工具入面就优先调它（真实协议 ModelRequest 工具流）；
      // 下线期间只提供 mcp__sib__echo，普通回合照常走完。
      modelExecutor: {
        generateText: async (request) => {
          requests.push(request);
          // 工具批次的 user-role token-budget 提醒排在工具结果之后；它不代表新一轮输入。
          const lastRole = request.messages.findLast(
            (message) =>
              !(
                message.role === "user" &&
                typeof message.content === "string" &&
                message.content.includes("<total_tokens>")
              ),
          )?.role;
          const offered = ["mcp__h1__echo", "mcp__sib__echo"].find((name) =>
            request.tools?.some((tool) => tool.name === name),
          );
          if (offered && lastRole !== "tool") {
            return {
              finishReason: "tool-calls",
              text: "",
              toolCalls: [{ id: "call-1", name: offered, input: { text: "hello" } }],
              usage: {},
            } as ModelResult;
          }
          return { finishReason: "stop", text: "done", usage: {} } as ModelResult;
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "cmcp-r2-"));
    const TOKEN = "FAKE_R2_TOKEN";
    // 先占一个空端口再释放，再把 TCP 黑洞绑上去：真·下线 endpoint 上 SDK 的
    // 每次连接尝试都被计数——有界 attempt counter，不靠上线后的 initialize 数。
    const reserved = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    let attempts = 0;
    const blackhole = createServer((socket) => {
      attempts += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      blackhole.once("error", reject);
      blackhole.listen(reserved, "127.0.0.1", () => resolve());
    });
    const url = `http://127.0.0.1:${reserved}/mcp`;
    const declaration = () => [
      {
        name: "h1",
        type: "http",
        url,
        headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
      },
      stdioWireServer("sib", dir, { label: "sib" }),
    ];
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    const statusOf = async (sessionId: string, name: string) =>
      (await fixture.apps.get(sessionId)!.runtime.getMcpPort()!.status())[name]?.status;
    const waitStatus = async (sessionId: string, name: string, want: string) => {
      for (let i = 0; i < 400; i += 1) {
        if ((await statusOf(sessionId, name)) === want) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`${name} never reached status ${want}`);
    };
    try {
      const sessionId = await createSession(client, fixture, {
        mcpServers: declaration(),
      });
      // typed status 证据：sib 活、h1 死（endpoint 缺席的 startup 结果）。
      await waitStatus(sessionId, "sib", "connected");
      await waitStatus(sessionId, "h1", "failed");
      const pidSib = await waitForFile(join(dir, "sib.pid"));
      const attemptsAfterStartup = attempts;
      expect(attemptsAfterStartup).toBeGreaterThanOrEqual(1);

      // endpoint 仍缺席的 identical resume：显式 retry 真实发起（attempts 有界
      // 增长），仍 failed——versions 不吞掉下一次 retry。
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        workspace: workspaceRef(fixture),
        mcpServers: declaration(),
      });
      await waitStatus(sessionId, "h1", "failed");
      const attemptsAfterRetry = attempts;
      expect(attemptsAfterRetry).toBeGreaterThan(attemptsAfterStartup);
      expect(attemptsAfterRetry - attemptsAfterStartup).toBeLessThanOrEqual(4);

      // 普通回合（endpoint 仍缺席）：零新连接尝试——没有 per-turn 重试。
      await client.request(zcodeProtocolMethods.sessionSend, {
        sessionId,
        content: "turn-while-down",
        inputId: "in-1",
      });
      await waitTurnRequests(requests, 2);
      await waitIdle(client, sessionId);
      expect(attempts).toBe(attemptsAfterRetry);

      // 同一 URL 上线：identical resume 经 revalidate 原地重连成功。
      await new Promise<void>((resolve) => blackhole.close(() => resolve()));
      const http = await startAuthenticatedMcpHttpFixture({ token: TOKEN, port: reserved, label: "h1" });
      try {
        await client.request(zcodeProtocolMethods.sessionResume, {
          sessionId,
          workspace: workspaceRef(fixture),
          mcpServers: declaration(),
        });
        await waitStatus(sessionId, "h1", "connected");
        expect(http.initializeRequests()).toBe(1);

        // 真协议工具流：回合的 ModelRequest 拿到 mcp__h1__echo、真实调用、
        // tool 结果回到下一个 ModelRequest。
        await client.request(zcodeProtocolMethods.sessionSend, {
          sessionId,
          content: "call-h1",
          inputId: "in-2",
        });
        await waitTurnRequests(requests, 4);
        await waitIdle(client, sessionId);
        const toolMessages = requests
          .flatMap((r) => r.messages)
          .filter((m) => m.role === "tool")
          .map((m) => JSON.stringify(m));
        expect(toolMessages.some((m) => m.includes("echo[h1@http]"))).toBe(true);
        // live sibling：同一条连接同一个 PID，没被 retry 打扰。
        expect(Number((await readFile(join(dir, "sib.pid"), "utf8")).trim())).toBe(pidSib);
        expect(processAlive(pidSib)).toBe(true);
        expect((await statusOf(sessionId, "sib")) === "connected").toBe(true);
        // 健康回合后没有新手握——connected 的 entry 不重连。
        expect(http.initializeRequests()).toBe(1);
      } finally {
        await http.close();
      }
    } finally {
      client.close();
      await fixture.close();
      if (blackhole.listening) {
        await new Promise<void>((resolve) => blackhole.close(() => resolve()));
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("CMCP-R2b identical resume during held handshake does not respawn or disturb the pending connect", async () => {
    const fixture = await createAcpMcpCoreFixture();
    const dir = await mkdtemp(join(tmpdir(), "cmcp-r2b-"));
    const pidDir = join(dir, "pids");
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    try {
      const sessionId = await createSession(client, fixture, {
        mcpServers: [stdioWireServer("held", dir, { hold: true, pidDir })],
      });
      // 被扣握手的在飞连接：子进程已起、handshake 不完成。
      const pid = await waitForFile(join(dir, "held.pid"));
      expect(processAlive(pid)).toBe(true);

      // identical resume：connecting 条目不在 retry 范围——resume 正常返回，
      // 不生二胎、不拆在飞连接。
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        workspace: workspaceRef(fixture),
        mcpServers: [stdioWireServer("held", dir, { hold: true, pidDir })],
      });
      // 每次 spawn 都写自己的 pid 文件——文件数=spawn 次数，硬证据。
      expect((await readdir(pidDir)).filter((f) => f.endsWith(".pid")).length).toBe(1);
      expect(processAlive(pid)).toBe(true);
    } finally {
      client.close();
      await fixture.close();
      expect(await listPids(pidDir)).toEqual([]);
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
