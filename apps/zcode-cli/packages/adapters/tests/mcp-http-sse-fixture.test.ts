// issue #31 / CMCP13（adapter 侧证据）：真实 loopback MCP HTTP + SSE server，
// 假 Bearer auth 经真实 adapter 完成 tools/list 与 tools/call；假凭据/URL 不得
// 出现在 adapter 诊断输出里。错误路径也走一遍（错 token → 连接失败，
// 诊断不回显 secret 文本）。
import { describe, expect, it } from "vitest";
import type { Logger } from "@zcode/contracts";
import { createMcpAdapter } from "../src/mcp/index.js";
import {
  startAuthenticatedMcpHttpFixture,
  startAuthenticatedMcpSseFixture,
} from "./fixtures/mcp-http-sse.js";

const GOOD_TOKEN = "FAKE_SENTINEL_TOKEN_9f8e7d6c";
const WRONG_TOKEN = "FAKE_SENTINEL_WRONG_1a2b3c4d";

function createCapturingLogger(): { logger: Logger; output: () => string } {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (message: string, context?: Record<string, unknown>) => {
      lines.push(`${level} ${message} ${context ? JSON.stringify(context) : ""}`);
    };
  const logger: Logger = {
    child: () => logger,
    debug: record("debug"),
    error: record("error"),
    info: record("info"),
    warn: record("warn"),
  } as unknown as Logger;
  return { logger, output: () => lines.join("\n") };
}

describe("real loopback MCP HTTP/SSE fixtures through the adapter (CMCP13)", () => {
  it("discovers and executes a tool over authenticated streamable HTTP", async () => {
    const fixture = await startAuthenticatedMcpHttpFixture({
      token: GOOD_TOKEN,
      label: "v1",
    });
    const { logger, output } = createCapturingLogger();
    const adapter = createMcpAdapter({ env: {}, logger });
    try {
      const snapshot = await adapter.connectConfiguredServers(
        {
          h: {
            type: "http",
            url: fixture.url,
            headers: { Authorization: `Bearer ${GOOD_TOKEN}` },
          },
        },
        { workingDirectory: "/tmp" },
      );
      expect(snapshot.statuses.h?.status).toBe("connected");
      expect(snapshot.tools.some((tool) => tool.serverName === "h")).toBe(true);

      const result = await adapter.callTool({
        serverName: "h",
        toolName: "echo",
        arguments: { text: "ping" },
      });
      expect(JSON.stringify(result)).toContain("echo[v1@http]:ping");
      expect(fixture.acceptedToolCalls()).toBe(1);
      // 诊断不回显假凭据：header 值与 URL 里的 secret 段都不该进日志。
      expect(output()).not.toContain(GOOD_TOKEN);
      expect(output()).not.toContain(fixture.url);
    } finally {
      await adapter.close();
      await fixture.close();
    }
  }, 30_000);

  it("discovers and executes a tool over authenticated SSE", async () => {
    const fixture = await startAuthenticatedMcpSseFixture({
      token: GOOD_TOKEN,
      label: "v2",
    });
    const { logger, output } = createCapturingLogger();
    const adapter = createMcpAdapter({ env: {}, logger });
    try {
      const snapshot = await adapter.connectConfiguredServers(
        {
          s: {
            type: "sse",
            url: fixture.url,
            headers: { Authorization: `Bearer ${GOOD_TOKEN}` },
          },
        },
        { workingDirectory: "/tmp" },
      );
      expect(snapshot.statuses.s?.status).toBe("connected");
      const result = await adapter.callTool({
        serverName: "s",
        toolName: "echo",
        arguments: { text: "pong" },
      });
      expect(JSON.stringify(result)).toContain("echo[v2@sse]:pong");
      expect(fixture.acceptedToolCalls()).toBe(1);
      expect(output()).not.toContain(GOOD_TOKEN);
    } finally {
      await adapter.close();
      await fixture.close();
    }
  }, 30_000);

  it("auth failure path: wrong token cannot connect and diagnostics keep the secret out", async () => {
    const fixture = await startAuthenticatedMcpHttpFixture({
      token: GOOD_TOKEN,
      label: "v1",
    });
    const { logger, output } = createCapturingLogger();
    const adapter = createMcpAdapter({ env: {}, logger });
    try {
      // 客户端拿的是错误凭据：连接失败是正常路径（per-server failed），
      // 不得泄露两边任何 token。
      const snapshot = await adapter.connectConfiguredServers(
        {
          h: {
            type: "http",
            url: fixture.url,
            headers: { Authorization: `Bearer ${WRONG_TOKEN}` },
          },
        },
        { workingDirectory: "/tmp" },
      );
      expect(snapshot.statuses.h?.status).toBe("failed");
      expect(snapshot.tools).toEqual([]);
      expect(fixture.rejectedRequests()).toBeGreaterThan(0);
      expect(fixture.acceptedToolCalls()).toBe(0);
      expect(output()).not.toContain(GOOD_TOKEN);
      expect(output()).not.toContain(WRONG_TOKEN);
      expect(output()).not.toContain(fixture.url);
    } finally {
      await adapter.close();
      await fixture.close();
    }
  }, 30_000);
});
