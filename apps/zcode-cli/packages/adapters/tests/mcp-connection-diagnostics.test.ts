// issue #31 / CMCP13（rework 5）：客户端供给的 MCP 连接诊断文本属不可信输入——
// command 路径/args/env 值、子进程 stderr 都可能含未标注敏感值。会话自有
// noPlugins 路径用 `connectionDiagnostics: "structural"`：status/log 只发
// failureKind 与数值/结构字段。以下三个用例都用真实 spawn：
// 1) structural + ENOENT（sentinel 藏在 command 路径与 env 值里）；
// 2) structural + 真实 stdio server 启动即把未标注 sentinel 写 stderr、再让
//    initialize 失败——stderr 尾部与逐块 debug 都不能带回文本；
// 3) standard（缺省）对照：普通缺命令诊断仍保留（无害 marker，不用凭据）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { createMcpAdapter } from "../src/mcp/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
const NODE = process.execPath;
const SENTINEL = "FAKE_SENTINEL_CRED_b7c3d1e9";
const MARKER = "mcp-missing-binary-marker";
const STRUCTURAL_ERROR_MESSAGE = "MCP server connection failed";

interface CapturedLog {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

function createCapturingLogger(): { logger: Logger; records: CapturedLog[] } {
  const records: CapturedLog[] = [];
  const record =
    (level: string) =>
    (message: string, contextOrError?: Record<string, unknown> | Error, context?: Record<string, unknown>) => {
      records.push({
        level,
        message,
        context:
          context ??
          (contextOrError instanceof Error ? { error: contextOrError.message } : contextOrError),
      });
    };
  const logger: Logger = {
    child: () => logger,
    debug: record("debug"),
    error: record("error"),
    info: record("info"),
    warn: record("warn"),
  } as unknown as Logger;
  return { logger, records };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-diag-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("MCP connection diagnostics modes (issue #31 CMCP13)", () => {
  it("structural: missing-command failure emits only classification + structural fields", async () => {
    await withTempDir(async (dir) => {
      const { logger, records } = createCapturingLogger();
      const adapter = createMcpAdapter({
        connectionDiagnostics: "structural",
        env: {},
        logger,
        workingDirectory: dir,
      });
      try {
        // sentinel 藏在 command 路径本体与 env 值里——ENOENT 的 error.message
        // 会带整条路径，standard 模式下这正是曾经的泄露通道。
        const snapshot = await adapter.connectConfiguredServers(
          {
            missing: {
              type: "stdio",
              command: join(dir, `missing-${SENTINEL}`),
              env: { FAKE_TOKEN: SENTINEL },
            },
          },
          {},
        );
        const status = snapshot.statuses.missing;
        expect(status?.status).toBe("failed");
        expect(status?.error).toBe(STRUCTURAL_ERROR_MESSAGE);
        expect(status?.failureKind).toBeTruthy();
        expect(JSON.stringify(status)).not.toContain(SENTINEL);

        const failedLog = records.find((r) => r.context?.event === "mcp.server.failed");
        expect(failedLog).toBeDefined();
        expect(failedLog?.context?.error).toBe(STRUCTURAL_ERROR_MESSAGE);
        expect(failedLog?.context?.failureKind).toBe(status?.failureKind);
        expect(failedLog?.context?.stderr).toBeUndefined();
        expect(JSON.stringify(records)).not.toContain(SENTINEL);
      } finally {
        await adapter.close();
      }
    });
  }, 30_000);

  it("structural: real stdio server writing unlabeled sentinel to stderr leaks nothing", async () => {
    await withTempDir(async (dir) => {
      const { logger, records } = createCapturingLogger();
      const adapter = createMcpAdapter({
        connectionDiagnostics: "structural",
        env: {},
        logger,
        workingDirectory: dir,
      });
      try {
        // fixture 启动即把未标注 sentinel 写 stderr，随后 initialize 返回错误——
        // 真实子进程文本走 attachStdioLogging + recent-stderr 回调两条通道。
        const snapshot = await adapter.connectConfiguredServers(
          {
            noisy: {
              type: "stdio",
              command: NODE,
              args: [FIXTURE],
              env: {
                MCP_FIXTURE_STDERR_TEXT: `unlabeled child output ${SENTINEL}`,
                MCP_FIXTURE_FAIL_INITIALIZE: "1",
              },
            },
          },
          {},
        );
        const status = snapshot.statuses.noisy;
        expect(status?.status).toBe("failed");
        expect(status?.error).toBe(STRUCTURAL_ERROR_MESSAGE);
        expect(JSON.stringify(status)).not.toContain(SENTINEL);

        const stderrEvents = records.filter((r) => r.context?.event === "mcp.stdio.stderr");
        // 子进程确实写了 stderr——事件必须存在，但只允许带 byteCount 等结构字段。
        expect(stderrEvents.length).toBeGreaterThan(0);
        for (const event of stderrEvents) {
          expect(event.context?.stderr).toBeUndefined();
          expect(typeof event.context?.byteCount).toBe("number");
        }
        const failedLog = records.find((r) => r.context?.event === "mcp.server.failed");
        expect(failedLog).toBeDefined();
        expect(failedLog?.context?.stderr).toBeUndefined();
        expect(JSON.stringify(records)).not.toContain(SENTINEL);
      } finally {
        await adapter.close();
      }
    });
  }, 30_000);

  it("standard (default): ordinary missing-command diagnostic stays available", async () => {
    await withTempDir(async (dir) => {
      const { logger, records } = createCapturingLogger();
      // 不显式传 connectionDiagnostics —— 缺省必须是 standard，普通文件/插件
      // 路径的诊断行为不得变化。
      const adapter = createMcpAdapter({ env: {}, logger, workingDirectory: dir });
      try {
        const snapshot = await adapter.connectConfiguredServers(
          {
            missing: {
              type: "stdio",
              command: join(dir, MARKER),
            },
          },
          {},
        );
        const status = snapshot.statuses.missing;
        expect(status?.status).toBe("failed");
        // 设置页/日志仍能看到"哪个命令没找到"——诊断价值不回退。
        expect(status?.error).toContain(MARKER);
        expect(status?.failureKind).toBeTruthy();

        const failedLog = records.find((r) => r.context?.event === "mcp.server.failed");
        expect(failedLog).toBeDefined();
        expect(String(failedLog?.context?.error)).toContain(MARKER);
      } finally {
        await adapter.close();
      }
    });
  }, 30_000);
});
