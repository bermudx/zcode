import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpPort } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  zcodeMcpListResultSchema,
  zcodeMcpListParamsSchema,
  zcodeProtocolMethods,
  zcodeProtocolSessionMethodContracts,
} from "@zcode/shared";
import { listMcpServers } from "../src/zcode-protocol/mcp.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

describe("mcp protocol contracts", () => {
  it("registers mcp/list", () => {
    expect(zcodeProtocolMethods.mcpList).toBe("mcp/list");
    expect(zcodeProtocolSessionMethodContracts[zcodeProtocolMethods.mcpList]).toBeDefined();
  });

  it("parses an MCP status snapshot", () => {
    const parsed = zcodeMcpListResultSchema.parse({
      statuses: {
        filesystem: {
          status: "disconnected",
          transport: "stdio",
          toolCount: 0,
          updatedAt: "2026-06-23T00:00:00.000Z",
        },
      },
    });

    expect(parsed.statuses.filesystem?.status).toBe("disconnected");
  });

  it("defaults mcp/list mode to connect and accepts status-only mode", () => {
    expect(
      zcodeMcpListParamsSchema.parse({
        workspace: {
          workspaceKey: "/tmp/project",
          workspacePath: "/tmp/project",
        },
      }).mode,
    ).toBe("connect");

    expect(
      zcodeMcpListParamsSchema.parse({
        workspace: {
          workspaceKey: "/tmp/project",
          workspacePath: "/tmp/project",
        },
        mode: "status",
      }).mode,
    ).toBe("status");
  });

  it("rejects invalid MCP status values", () => {
    expect(() =>
      zcodeMcpListResultSchema.parse({
        statuses: {
          broken: {
            status: "unknown",
            transport: "stdio",
            toolCount: 0,
            updatedAt: "2026-06-23T00:00:00.000Z",
          },
        },
      }),
    ).toThrow();
  });

  it("parses HTTP MCP OAuth client credentials in protocol params", () => {
    const parsed = zcodeMcpListParamsSchema.parse({
      workspace: {
        workspaceKey: "/tmp/project",
        workspacePath: "/tmp/project",
      },
      mcpServers: [
        {
          name: "protected",
          type: "http",
          url: "https://mcp.example.test/mcp",
          headers: [],
          oauth: {
            type: "client_credentials",
            clientId: "zcode-client",
            clientSecret: "secret",
            scope: "mcp:tools",
          },
        },
      ],
    });

    expect(parsed.mcpServers?.[0]).toMatchObject({
      name: "protected",
      oauth: {
        type: "client_credentials",
        clientId: "zcode-client",
      },
    });
  });

  it("parses HTTP MCP OAuth authorization code in protocol params", () => {
    const parsed = zcodeMcpListParamsSchema.parse({
      workspace: {
        workspaceKey: "/tmp/project",
        workspacePath: "/tmp/project",
      },
      mcpServers: [
        {
          name: "figma",
          type: "http",
          url: "https://mcp.figma.com/mcp",
          headers: [],
          oauth: {
            type: "authorization_code",
            clientName: "ZCode",
            redirectPath: "/oauth/callback/mcp/figma",
            scope: "mcp:connect",
          },
        },
      ],
    });

    expect(parsed.mcpServers?.[0]).toMatchObject({
      name: "figma",
      oauth: {
        type: "authorization_code",
        clientName: "ZCode",
        redirectPath: "/oauth/callback/mcp/figma",
        scope: "mcp:connect",
      },
    });
  });
});

// Bugfix 回归：设置页刷新的 mcp/list 必须带 revalidate，否则进程级 `protocol-settings` lease
// 会命中连接池里的旧 entry 并回放陈旧快照（见 adapters/src/mcp/pool.ts revalidateEntry）。
describe("mcp/list connection revalidation", () => {
  it("asks the pool to revalidate on the default connect mode and skips it for status mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-mcp-list-revalidate-"));
    const previousStorageDir = process.env.ZCODE_STORAGE_DIR;
    process.env.ZCODE_STORAGE_DIR = join(root, "cli");
    const connectConfiguredServers = vi.fn(async () => ({ statuses: {}, tools: [] }));
    const status = vi.fn(async () => ({}));
    const mcpPort = {
      callTool: vi.fn(),
      close: vi.fn(async () => undefined),
      connectConfiguredServers,
      connectServer: vi.fn(),
      disconnectServer: vi.fn(),
      listTools: vi.fn(async () => []),
      status,
    } as unknown as McpPort;
    const context = {
      deps: { env: process.env, mcpPort },
    } as unknown as ZCodeProtocolAgentServerContext;
    const params = {
      mcpServers: [],
      workspace: { workspaceKey: root, workspacePath: root },
    };

    try {
      await listMcpServers(context, params);
      expect(connectConfiguredServers).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ revalidate: true }),
      );

      connectConfiguredServers.mockClear();
      await listMcpServers(context, { ...params, mode: "status" });
      expect(connectConfiguredServers).not.toHaveBeenCalled();
    } finally {
      if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
      await rm(root, { force: true, recursive: true });
    }
  });
});

import { convertToZCodeAgentMcpServer, zcodeProtocolMcpServerSchema } from "@zcode/shared";
import { protocolMcpServersToRuntimeMcpConfig } from "../src/zcode-protocol/protocol-mcp-config.js";

it("preserves workspace provenance and cwd from Host DTO to runtime; rejects arbitrary runtime source", () => {
  const dto = convertToZCodeAgentMcpServer(
    "probe",
    { type: "stdio", command: "node", cwd: "tools", args: ["server.mjs"], env: { TEST: "1" } },
    "workspace",
  );
  const parsed = zcodeProtocolMcpServerSchema.parse(dto);
  expect(protocolMcpServersToRuntimeMcpConfig([parsed])?.servers.probe).toMatchObject({
    source: { kind: "workspace" },
    cwd: "tools",
    env: { TEST: "1" },
  });
  expect(zcodeProtocolMcpServerSchema.safeParse({ ...dto, source: { kind: "user" } }).success).toBe(
    false,
  );
});

// issue #31 CMCP01/02/06：client 声明的 wire 语义——undefined 与 [] 不可混淆，
// scope/isolation 透传到 runtime 配置，record 克隆与外部数组解除引用。
import { cloneClientMcpServers } from "../src/zcode-protocol/protocol-mcp-config.js";

it("keeps undefined (no client override) distinct from an explicit empty override", () => {
  expect(protocolMcpServersToRuntimeMcpConfig(undefined)).toBeUndefined();
  // 显式 [] 必须产生 enabled:true + 空 servers——压制 file/plugin 回落，不是折叠成未声明。
  expect(protocolMcpServersToRuntimeMcpConfig([])).toEqual({ enabled: true, servers: {} });
});

it("maps client-declared stdio/http/sse servers preserving scope, isolation and credentials", () => {
  const stdio = zcodeProtocolMcpServerSchema.parse({
    name: "client-stdio",
    scope: "user",
    command: "node",
    cwd: "/session",
    args: ["srv.mjs"],
    env: [{ name: "TOKEN", value: "fake-credential-sentinel" }],
    isolation: "session",
  });
  const http = zcodeProtocolMcpServerSchema.parse({
    name: "client-http",
    scope: "user",
    type: "http",
    url: "http://127.0.0.1:9/mcp",
    headers: [{ name: "Authorization", value: "Bearer fake-credential-sentinel" }],
    isolation: "session",
  });
  const mapped = protocolMcpServersToRuntimeMcpConfig([stdio, http]);
  expect(mapped?.servers["client-stdio"]).toMatchObject({
    type: "stdio",
    source: { kind: "user" },
    isolation: "session",
    env: { TOKEN: "fake-credential-sentinel" },
  });
  expect(mapped?.servers["client-http"]).toMatchObject({
    type: "http",
    source: { kind: "user" },
    isolation: "session",
    headers: { Authorization: "Bearer fake-credential-sentinel" },
  });
});

it("cloneClientMcpServers detaches record provenance from the caller array", () => {
  const original = [
    zcodeProtocolMcpServerSchema.parse({
      name: "client-srv",
      command: "node",
      args: [],
      env: [{ name: "K", value: "fake-credential-sentinel" }],
    }),
  ];
  const clone = cloneClientMcpServers(original);
  original[0]!.args.push("tampered");
  (original[0] as { env: { value: string }[] }).env[0]!.value = "tampered";
  expect(clone?.[0] && "args" in clone[0] ? clone[0].args : undefined).toEqual([]);
  expect(
    clone?.[0] && "env" in clone[0] ? clone[0].env[0]?.value : undefined,
  ).toBe("fake-credential-sentinel");
  expect(cloneClientMcpServers(undefined)).toBeUndefined();
});
