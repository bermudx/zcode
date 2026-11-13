import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { McpPort, McpServerConfig } from "@zcode/contracts";
import { createSessionId } from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import { createMcpConnectionPool } from "@zcode/adapters/mcp";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

// issue #31 评审 S2/S3/S4：runtime detach/close 必须杀掉「在飞连接」的真实
// stdio 子进程（applied+desired+in-flight 的并集），owned port close 代际安全，
// 子会话借用的是父 runtime 已落地的生效配置而不是物化快照。全部用真实
// AgentRuntime + 真实连接池 + disposable stdio fixture，不 mock 连接层。

const FIXTURE = fileURLToPath(
  new URL("../../adapters/tests/fixtures/mcp-echo-server.mjs", import.meta.url),
);
const NODE = process.execPath;

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

async function waitForExit(pid: number, attempts = 200): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processAlive(pid);
}

function serverConfig(dir: string, name: string, hold: boolean): McpServerConfig {
  return {
    type: "stdio",
    command: NODE,
    args: [FIXTURE],
    env: {
      MCP_FIXTURE_PID_FILE: join(dir, `${name}.pid`),
      ...(hold ? { MCP_FIXTURE_HOLD_INITIALIZE: "1" } : {}),
    },
    isolation: "session",
  };
}

function createRuntimeWithLease(
  key: string,
  lease: McpPort,
  mcpConfig?: { enabled: boolean; servers: Record<string, McpServerConfig> },
): AgentRuntime {
  return new AgentRuntime(
    createSessionId(key),
    {
      mode: "build",
      modelSelection: { providerId: "test", modelId: "test-model" },
      ...(mcpConfig ? { mcp: mcpConfig } : {}),
    },
    {
      eventStore: createInMemorySessionEventStore(),
      fileSystemPort: createNodeFileSystemAdapter(),
      modelFactory: createTestModelFactory({}),
      mcpPort: lease,
      createMcpPort: () => lease,
    } as never,
  );
}

describe("client MCP lifecycle teardown (real runtime + pool + stdio children)", () => {
  it("detach kills the connected server AND a held-initialize in-flight connect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-lifecycle-"));
    const pool = createMcpConnectionPool({
      createAdapter: () => createMcpAdapter({ workingDirectory: dir }),
      idleGraceMs: 0,
    });
    const lease = pool.acquireLease({ sessionId: "detach-union" });
    const runtime = createRuntimeWithLease("detach-union", lease);
    try {
      await runtime.configureMcpServers({ a: serverConfig(dir, "a", false) });
      const pidA = await waitForFile(join(dir, "a.pid"));
      expect(processAlive(pidA)).toBe(true);

      // B 的握手永远挂起——connect 在飞时 detach，spawned 子进程不能漏网。
      const pending = runtime.configureMcpServers({
        a: serverConfig(dir, "a", false),
        b: serverConfig(dir, "b", true),
      });
      const pidB = await waitForFile(join(dir, "b.pid"));
      expect(processAlive(pidB)).toBe(true);

      await runtime.setMcpClientAttached(false);
      await pending;
      // suspend 并集覆盖 in-flight b：两个子进程在 teardown await 结束时都死。
      expect(processAlive(pidA)).toBe(false);
      expect(processAlive(pidB)).toBe(false);
    } finally {
      await runtime.close();
      await lease.close();
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("detach during a blocked initial startup connect kills the spawned child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-lifecycle-"));
    const pool = createMcpConnectionPool({
      createAdapter: () => createMcpAdapter({ workingDirectory: dir }),
      idleGraceMs: 0,
    });
    const lease = pool.acquireLease({ sessionId: "startup-detach" });
    // 构造即启动 startup connect——held 握手 + attachment 闸门。
    const runtime = createRuntimeWithLease("startup-detach", lease, {
      enabled: true,
      servers: { c: serverConfig(dir, "c", true) },
    });
    try {
      const pidC = await waitForFile(join(dir, "c.pid"));
      expect(processAlive(pidC)).toBe(true);
      await runtime.setMcpClientAttached(false);
      expect(await waitForExit(pidC)).toBe(true);
    } finally {
      await runtime.close();
      await lease.close();
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("close during a blocked connect kills the spawned child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-lifecycle-"));
    const pool = createMcpConnectionPool({
      createAdapter: () => createMcpAdapter({ workingDirectory: dir }),
      idleGraceMs: 0,
    });
    const lease = pool.acquireLease({ sessionId: "close-while-connect" });
    const runtime = createRuntimeWithLease("close-while-connect", lease);
    const configuring = runtime.configureMcpServers({ d: serverConfig(dir, "d", true) });
    try {
      const pidD = await waitForFile(join(dir, "d.pid"));
      expect(processAlive(pidD)).toBe(true);
      await runtime.close();
      await configuring;
      // close 不等死握手的 connect（apply signal 被 abort）；owner lease 收尾时
      // 在飞 entry 的 controller 被 abort——子进程必须死在 teardown 内。
      await lease.close();
      expect(await waitForExit(pidD)).toBe(true);
    } finally {
      await lease.close().catch(() => undefined);
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("owned session MCP port close semantics (real noPlugins app, S3/F2)", () => {
  it("clear -> reinject allocates a new generation; stale close cannot touch it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-owned-"));
    const storageRoot = await mkdtemp(join(tmpdir(), "mcp-storage-"));
    const app = await createRegistryBackedTestApp({
      env: { ZCODE_STORAGE_DIR: storageRoot },
      skipUserConfig: true,
      noPlugins: true,
      eventStore: createInMemorySessionEventStore(),
      runtimeConfig: { workingDirectory: dir },
      modelExecutor: {
        generateText: async () => ({ finishReason: "stop", text: "ok" }),
      },
    });
    try {
      const runtime = app.runtime;
      await runtime.configureMcpServers({ a: serverConfig(dir, "a", false) });
      const port1 = runtime.getMcpPort();
      expect(port1).toBeDefined();
      const pidA = await waitForFile(join(dir, "a.pid"));
      expect(processAlive(pidA)).toBe(true);
      // `.close` 属性读幂等：每次读都是同一个函数、共享一份 closePromise。
      expect(port1!.close).toBe(port1!.close);
      const staleClose = port1!.close;

      // 显式清空 → apply 内关掉旧代（子进程死、memo 复位、port 置空）。
      await runtime.configureMcpServers({});
      expect(await waitForExit(pidA)).toBe(true);
      expect(runtime.getMcpPort()).toBeUndefined();

      // 再注入 → 全新代际：新 port 对象、新 pool、新子进程、新工具面。
      await runtime.configureMcpServers({ b: serverConfig(dir, "b", false) });
      const port2 = runtime.getMcpPort();
      expect(port2).toBeDefined();
      expect(port2).not.toBe(port1);
      const pidB = await waitForFile(join(dir, "b.pid"));
      expect(processAlive(pidB)).toBe(true);
      expect((await port2!.listTools()).some((tool) => tool.serverName === "b")).toBe(true);

      // 迟到的旧 close 是 no-op——绝不能杀掉新代子进程或断开新连接。
      await staleClose();
      expect(processAlive(pidB)).toBe(true);
      const echo = await port2!.callTool({ serverName: "b", toolName: "echo", arguments: { text: "x" } });
      expect(JSON.stringify(echo)).toContain(`@${pidB}]:x`);
    } finally {
      await app.close?.();
      await rm(dir, { recursive: true, force: true });
      await rm(storageRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("workflow child borrows parent applied MCP state (S4)", () => {
  it("reflects empty -> inject -> clear -> reinject via the parent's applied config", async () => {
    const sessionId = createSessionId("borrowed-mcp-effective");
    const runtime = new AgentRuntime(
      sessionId,
      {
        mode: "build",
        modelSelection: { providerId: "test", modelId: "test-model" },
        mcp: { enabled: false, servers: {} },
      },
      {
        eventStore: createInMemorySessionEventStore(),
        fileSystemPort: createNodeFileSystemAdapter(),
        modelFactory: createTestModelFactory({}),
        mcpPort: {
          connectConfiguredServers: async (servers: Record<string, McpServerConfig>) => ({
            statuses: Object.fromEntries(
              Object.keys(servers).map((name) => [
                name,
                { status: "connected", transport: "stdio", toolCount: 0, updatedAt: "now" },
              ]),
            ),
            tools: [],
          }),
          connectServer: async () => ({
            status: "connected",
            transport: "stdio",
            toolCount: 0,
            updatedAt: "now",
          }),
          disconnectServer: async () => undefined,
          status: async () => ({}),
          listTools: async () => [],
          callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
          close: async () => {},
        } as unknown as McpPort,
      } as never,
    );
    const borrowConfig = async () =>
      (
        await runtime.prepareBorrowedMcp({
          traceContext: { traceId: "borrow-check" } as never,
          signal: new AbortController().signal,
        })
      ).config;
    try {
      // 借用入口返回的是父 APPLIED 配置（评审 R3）：servers 由 child runtime
      // 在自己 startup 内置空——这里只验证 apply 代际被借用方看到。
      expect(await borrowConfig()).toMatchObject({ enabled: false });
      const injected = { s1: { type: "stdio", command: "node", args: ["s.js"] } as McpServerConfig };
      await runtime.configureMcpServers(injected);
      expect(await borrowConfig()).toMatchObject({ enabled: true });
      await runtime.configureMcpServers({});
      expect(await borrowConfig()).toMatchObject({ enabled: false });
      await runtime.configureMcpServers(injected);
      expect(await borrowConfig()).toMatchObject({ enabled: true });
    } finally {
      await runtime.close();
    }
  });
});

// 评审 R3-返工：借用快照的最后一步（status/listTools）必须在同一代际栅栏内——
// 读期间发生 queued apply 或 detach+adopt，返回的 config/port/status 会混代。
describe("borrowed MCP access discovery fence (R3-rework)", () => {
  function gatedPort(): {
    port: McpPort;
    armGate: () => void;
    releaseGate: () => void;
    statusSeen: Promise<void>;
    statusCalls: () => number;
    connectCalls: () => number;
    resetConnectCalls: () => void;
  } {
    let armed = false;
    let calls = 0;
    let connects = 0;
    let release!: () => void;
    const gatePromise = new Promise<void>((r) => (release = r));
    let seen!: () => void;
    const statusSeen = new Promise<void>((r) => (seen = r));
    const port = {
      connectConfiguredServers: async (servers: Record<string, McpServerConfig>) => {
        connects += 1;
        return {
          statuses: Object.fromEntries(
            Object.keys(servers).map((name) => [
              name,
              { status: "connected", transport: "stdio", toolCount: 0, updatedAt: "t" },
            ]),
          ),
          tools: [],
        };
      },
      connectServer: async () => ({
        status: "connected",
        transport: "stdio",
        toolCount: 0,
        updatedAt: "t",
      }),
      disconnectServer: async () => undefined,
      status: async () => {
        calls += 1;
        // 一次性闸门：只挂起第一个被 arm 的 status 读——别处意外的 status
        // 调用照常通过，不会把并发 apply 死锁在闸门上。
        if (armed) {
          armed = false;
          seen();
          await gatePromise;
        }
        return {};
      },
      listTools: async () => [],
      callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
      close: async () => {},
    } as unknown as McpPort;
    return {
      port,
      armGate: () => {
        armed = true;
      },
      releaseGate: release,
      statusSeen,
      statusCalls: () => calls,
      connectCalls: () => connects,
      resetConnectCalls: () => {
        connects = 0;
      },
    };
  }

  const borrow = (runtime: AgentRuntime) =>
    runtime.prepareBorrowedMcp({
      traceContext: { traceId: "borrow-fence" } as never,
      signal: new AbortController().signal,
    });

  it("queued apply during the final status read returns the NEW applied face, not a stale mix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-borrow-fence-"));
    const { port, armGate, releaseGate, statusSeen, statusCalls } = gatedPort();
    const runtime = createRuntimeWithLease("borrow-fence-gen", port, {
      enabled: true,
      servers: { s1: serverConfig(dir, "s1", false) },
    });
    try {
      const warm = await borrow(runtime);
      expect(Object.keys(warm.config?.servers ?? {})).toEqual(["s1"]);

      armGate();
      const pending = borrow(runtime);
      await statusSeen; // status() 已进入并挂起——确定性卡在发现读上。
      // 读期间落地新一代 applied：config.mcp 换对象、appliedVersion 递增。
      await runtime.configureMcpServers({ s2: serverConfig(dir, "s2", false) });
      releaseGate();
      const access = await pending;
      // 修后面向新代际返回 s2；修前返回被卡住的 s1 混合快照。
      expect(Object.keys(access.config?.servers ?? {})).toEqual(["s2"]);
      expect(statusCalls()).toBeGreaterThanOrEqual(3); // warm + 被卡 + 重读
    } finally {
      releaseGate();
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("detach+adopt during the final status read re-reads instead of returning the stale snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-borrow-fence-"));
    const { port, armGate, releaseGate, statusSeen, statusCalls } = gatedPort();
    const runtime = createRuntimeWithLease("borrow-fence-owner", port, {
      enabled: true,
      servers: { s1: serverConfig(dir, "s1", false) },
    });
    try {
      await borrow(runtime); // warm：startup/tail 落定。
      armGate();
      const pending = borrow(runtime);
      await statusSeen;
      // 读期间 owner 换代：epoch/tail 都变——attached 复位后也不得交还旧读。
      await runtime.setMcpClientAttached(false);
      await runtime.setMcpClientAttached(true);
      releaseGate();
      const access = await pending;
      expect(statusCalls()).toBeGreaterThanOrEqual(3); // warm + 被卡 + 重读
      expect(Object.keys(access.config?.servers ?? {})).toEqual(["s1"]);
    } finally {
      releaseGate();
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("concurrent configure: a stale identical-resume health probe cannot retry over a newer desired", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-borrow-fence-"));
    const { port, armGate, releaseGate, statusSeen, connectCalls, resetConnectCalls } =
      gatedPort();
    const runtime = createRuntimeWithLease("borrow-fence-desired", port, {
      enabled: true,
      servers: { s1: serverConfig(dir, "s1", false) },
    });
    try {
      await borrow(runtime); // 落定 ctor startup；之后 connect 计数清零。
      resetConnectCalls();
      armGate();
      // identical 声明命中 unchanged → status 健康探针被闸门卡住。
      const stale = runtime.configureMcpServers({ s1: serverConfig(dir, "s1", false) });
      await statusSeen;
      // 探针等待期间另一个 configure 换了声明：desired 换代并立即 apply。
      await runtime.configureMcpServers({ s2: serverConfig(dir, "s2", false) });
      expect(connectCalls()).toBe(1); // 只有 s2 的 apply
      releaseGate(); // status 返回 {}——s1 missing，陈旧探针本会判 retry。
      await stale;
      // 修前：陈旧探针立 reconnectNeeded 并再 apply 一次（第二次 connect）。
      expect(connectCalls()).toBe(1);
    } finally {
      releaseGate();
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
