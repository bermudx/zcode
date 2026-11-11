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
import { borrowedMcpConfig } from "../src/app/script-workflow-child-runtime.js";

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
    try {
      expect(borrowedMcpConfig(runtime)).toMatchObject({ enabled: false, servers: {} });
      const injected = { s1: { type: "stdio", command: "node", args: ["s.js"] } as McpServerConfig };
      await runtime.configureMcpServers(injected);
      // 子会话构造读到的是 applied 生效配置 + servers 置空——借连接，不接生命周期。
      expect(borrowedMcpConfig(runtime)).toMatchObject({ enabled: true, servers: {} });
      await runtime.configureMcpServers({});
      expect(borrowedMcpConfig(runtime)).toMatchObject({ enabled: false, servers: {} });
      await runtime.configureMcpServers(injected);
      expect(borrowedMcpConfig(runtime)).toMatchObject({ enabled: true, servers: {} });
    } finally {
      await runtime.close();
    }
  });
});
