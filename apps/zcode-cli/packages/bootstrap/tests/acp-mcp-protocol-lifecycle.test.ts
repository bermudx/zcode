// issue #31 CMCP02/03/04/05/06/07/08/09/12(+13 扫描半)：真实 socket 协议 core
// （ZCodeProtocolAgentServer + createRegistryBackedTestApp + disposable stdio
// fixture），client 端是真实 unix socket 上的最小 NDJSON client。会话创建/
// resume/fork/close 全部走协议请求——不是直接 runtime 拼装。
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ModelRequest,
  type ModelResult,
  type SessionId,
} from "@zcode/contracts";
import { zcodeProtocolMethods } from "@zcode/shared";
import { projectIdFromDirectory } from "../src/app/paths.js";
import {
  createAcpMcpCoreFixture,
  type AcpMcpCoreFixture,
  type AcpMcpRawClient,
} from "./helpers/acp-mcp-core-fixture.js";
import type { RegistryBackedTestModelExecutor } from "./helpers/registry-backed-test-app.js";

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
  options: { label?: string; hold?: boolean; pidDir?: string; env?: Record<string, string> } = {},
): Record<string, unknown> {
  const env = [
    { name: "MCP_FIXTURE_PID_FILE", value: join(dir, `${name}.pid`) },
    ...(options.pidDir ? [{ name: "MCP_FIXTURE_PID_DIR", value: options.pidDir }] : []),
    ...(options.label ? [{ name: "MCP_FIXTURE_LABEL", value: options.label }] : []),
    ...(options.hold ? [{ name: "MCP_FIXTURE_HOLD_INITIALIZE", value: "1" }] : []),
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

/** 让真实 turn 流过：首个请求要 tool-call（若工具在面），随后 stop 并回显 tool 结果文本。 */
function createToolCallingExecutor(
  toolName: string,
  requests: ModelRequest[],
): RegistryBackedTestModelExecutor {
  return {
    generateText: async (request) => {
      requests.push(request);
      const priorCalls = requests
        .flatMap((r) => r.messages)
        .filter((m) => m.role === "tool").length;
      const offered = request.tools?.some((tool) => tool.name === toolName);
      if (offered && priorCalls === 0) {
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

  it("CMCP08 transport detach kills children; adopted resume without mcpServers reconnects the same session/history", async () => {
    const fixture = await createAcpMcpCoreFixture();
    const dir = await mkdtemp(join(tmpdir(), "cmcp08-"));
    const client1 = await fixture.connectRawClient();
    allowAllPermissions(client1);
    try {
      const sessionId = await createSession(client1, fixture, {
        mcpServers: [stdioWireServer("s1", dir, { label: "v1" })],
      });
      const pid = await waitForFile(join(dir, "s1.pid"));
      expect(processAlive(pid)).toBe(true);
      const appBefore = fixture.apps.get(sessionId);

      // client socket 断开 = transport detach：软 detach 触发 client MCP suspend，
      // session 隔离 stdio 子进程必须死。
      client1.close();
      expect(await waitForExit(pid)).toBe(true);

      // 新 client 连接 + resume 省略 mcpServers → 收养同 session（同 app、同
      // 声明）并按 reconnect debt 补连——不是重建 runtime。
      const client2 = await fixture.connectRawClient();
      allowAllPermissions(client2);
      try {
        await client2.request(zcodeProtocolMethods.sessionResume, {
          sessionId,
          workspace: workspaceRef(fixture),
        });
        expect(fixture.apps.get(sessionId)).toBe(appBefore);
        const pid2 = await waitForFile(join(dir, "s1.pid"), 400);
        expect(processAlive(pid2)).toBe(true);
        expect(pid2).not.toBe(pid);
      } finally {
        client2.close();
      }
    } finally {
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
          // tool 结果落在当前请求的 messages 里——必须连当前请求一起数，
          // 否则第二个请求会再次发 tool-calls 形成无限调用环。
          const alreadyCalled = requests
            .flatMap((r) => r.messages)
            .some((m) => m.role === "tool");
          if (tools.some((t) => t.name === "mcp__fork__echo") && !alreadyCalled) {
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

      // parent 轮取消闸门放行 → 正常跑完；child 已存在。
      gate();
      await send2;
      await waitIdle(client, sessionId);
      expect(processAlive(parentPid)).toBe(true);

      // child 的 accepted 声明是 pending v2（落在 config.mcp.servers，
      // 不是 desired——fork 物化时直接盖进 runtimeConfig）。
      const childApp = fixture.apps.get(String(childId));
      expect(childApp).toBeDefined();
      const childServers = childApp!.runtime.getEffectiveMcpConfig()?.servers;
      expect(childServers?.fork?.type).toBe("stdio");
      // 继承的是 pending v2 声明，不是 parent 连接的 v1 快照。
      expect(childServers?.fork?.env?.MCP_FIXTURE_LABEL).toBe("v2");
      // child 经真实协议 resume/send 调用工具：结果带 v2 标签（独立连接）。
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId: childId,
        workspace: workspaceRef(fixture),
      });
      const childResult = await childApp!.runtime.getMcpPort()?.callTool({
        serverName: "fork",
        toolName: "echo",
        arguments: { text: "child" },
      });
      expect(childResult).toBeDefined();
      expect(JSON.stringify(childResult)).toContain("echo[v2@");

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

  it("CMCP05 goal continuation: continueActiveTargetIfIdle with a persisted target runs a real turn on the post-apply toolset", async () => {
    const requests: ModelRequest[] = [];
    const fixture = await createAcpMcpCoreFixture({
      modelExecutor: {
        generateText: async (request: ModelRequest) => {
          requests.push(request);
          return {
            finishReason: "stop",
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as ModelResult;
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "cmcp05-"));
    const client = await fixture.connectRawClient();
    allowAllPermissions(client);
    try {
      const sessionId = await createSession(client, fixture, {
        mcpServers: [stdioWireServer("s1", dir, { label: "v1" })],
      });
      await waitForFile(join(dir, "s1.pid"));
      await client.request(zcodeProtocolMethods.sessionSend, {
        sessionId,
        content: "seed",
        inputId: "in-1",
      });
      await waitTurnRequests(requests, 1);
      await waitIdle(client, sessionId);
      // turn 1 看到的是 v1 工具面。
      expect(requests.at(-1)!.tools?.some((t) => t.name === "mcp__s1__echo")).toBe(true);

      // 会话空转时换成 v2（换 server 名使工具名可区分代际）。
      await client.request(zcodeProtocolMethods.sessionResume, {
        sessionId,
        mcpServers: [stdioWireServer("s2", dir, { label: "v2" })],
      });
      await waitForFile(join(dir, "s2.pid"));

      // 持久化 active target，经真实 continueActiveTargetIfIdle → 目标续跑命令
      // → 新 turn admission；续跑的 ModelRequest 必须看见 apply 后的 v2 工具面。
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
      expect(continuation.tools?.some((t) => t.name === "mcp__s2__echo")).toBe(true);
      expect(continuation.tools?.some((t) => t.name === "mcp__s1__echo")).toBe(false);
    } finally {
      client.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
