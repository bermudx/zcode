import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { createMcpAdapter } from "../src/mcp/index.js";
import { createMcpConnectionPool } from "../src/mcp/pool.js";

// issue #31 CMCP10/13：session 隔离 + zero-grace 池的真实进程证据——
// disposable stdio server 把自己的 PID 落盘，disconnect/detach 语义下
// 子进程必须在 await 结束时死掉，而不是留在 idle grace 里。

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
const NODE = process.execPath;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, attempts = 200): Promise<string> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`fixture pid file never appeared: ${path}`);
}

async function waitForExit(pid: number, attempts = 200): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processAlive(pid);
}

describe("session-isolated MCP teardown (real disposable stdio)", () => {
  it("connects, executes a tool, and disconnect kills the child immediately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-fixture-"));
    const pidFile = join(dir, "child.pid");
    try {
      const adapter = createMcpAdapter({ workingDirectory: dir });
      const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
      const lease = pool.acquireLease({ sessionId: "session-a" });
      const config: McpServerConfig = {
        type: "stdio",
        command: NODE,
        args: [FIXTURE],
        env: { MCP_FIXTURE_PID_FILE: pidFile },
        isolation: "session",
      };
      const status = await lease.connectServer("fixture-echo", config);
      expect(status.status).toBe("connected");
      const tools = await lease.listTools();
      expect(tools.some((tool) => tool.name.includes("echo"))).toBe(true);
      const result = await lease.callTool({
        serverName: "fixture-echo",
        toolName: "echo",
        arguments: { text: "ping" },
      });
      expect(JSON.stringify(result)).toContain("echo[unlabeled@");

      const pid = Number((await waitForFile(pidFile)).trim());
      expect(processAlive(pid)).toBe(true);
      await lease.disconnectServer("fixture-echo");
      // disconnect 返回时子进程必须已退出——zero-grace session 池没有 30s 宽限。
      expect(processAlive(pid)).toBe(false);
      await lease.close();
      await pool.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("disconnect during a blocked initialize kills the pending child without waiting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-fixture-hold-"));
    const pidFile = join(dir, "child.pid");
    try {
      const adapter = createMcpAdapter({ workingDirectory: dir });
      const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
      const lease = pool.acquireLease({ sessionId: "session-a" });
      const config: McpServerConfig = {
        type: "stdio",
        command: NODE,
        args: [FIXTURE],
        env: {
          MCP_FIXTURE_PID_FILE: pidFile,
          MCP_FIXTURE_HOLD_INITIALIZE: "1",
        },
        isolation: "session",
      };
      const connecting = lease.connectServer("fixture-echo", config);
      const pid = Number((await waitForFile(pidFile)).trim());
      // 握手被 fixture 卡住时 disconnect 必须中止 pending connect 并收掉子进程，
      // 不能排在连接超时后面（评审 R3）。
      const start = Date.now();
      await lease.disconnectServer("fixture-echo");
      expect(Date.now() - start).toBeLessThan(20_000);
      expect(await waitForExit(pid)).toBe(true);
      await connecting.catch(() => undefined);
      await lease.close();
      await pool.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 45_000);
});
