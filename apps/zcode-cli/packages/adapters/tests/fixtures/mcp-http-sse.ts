// issue #31 / CMCP01+CMCP13 共享基座：loopback 上的真实 MCP HTTP/SSE server
// （@modelcontextprotocol/sdk 官方 server 导出），假 Bearer auth、真实
// tools/list + tools/call。echo 结果只带 label/transport/输入——
// Authorization 值永不进结果或响应。close 收 transport/server/socket。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

export interface McpLoopbackFixture {
  /** `type:"http"` 或 `type:"sse"` 配置应指向的 URL。 */
  readonly url: string;
  /** 成功通过 auth 后实际到达 handler 的 tools/call 次数。 */
  acceptedToolCalls(): number;
  /** 因 auth 不符被 401 拒绝的请求次数。 */
  rejectedRequests(): number;
  close(): Promise<void>;
}

export interface McpLoopbackFixtureOptions {
  /** 假凭据：只有 `Authorization: Bearer <token>` 才被放行。 */
  token: string;
  /** 无害标签——进 echo 结果，用来分辨是哪条连接回答的。 */
  label?: string;
}

function createFixtureMcpServer(
  label: string,
  transportKind: "http" | "sse",
  onToolCall: () => void,
): McpServer {
  const server = new McpServer({ name: "fixture-mcp-http-sse", version: "0.0.1" });
  server.registerTool(
    "echo",
    {
      description: "fixture echo tool",
      inputSchema: { text: z.string().optional() },
    },
    async (args) => {
      onToolCall();
      return {
        content: [
          {
            type: "text",
            text: `echo[${label}@${transportKind}]:${args.text ?? ""}`,
          },
        ],
      };
    },
  );
  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(req: IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

export async function startAuthenticatedMcpHttpFixture(
  options: McpLoopbackFixtureOptions,
): Promise<McpLoopbackFixture> {
  const label = options.label ?? "unlabeled";
  let acceptedToolCalls = 0;
  let rejectedRequests = 0;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Set<McpServer>();

  const httpServer = createServer((req, res) => {
    void (async () => {
      if (!authorized(req, options.token)) {
        rejectedRequests += 1;
        res.writeHead(401).end();
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      let transport =
        typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (!transport) {
          if (typeof sessionId === "string") {
            res.writeHead(404).end();
            return;
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });
          const fixture = transport;
          fixture.onclose = () => {
            if (fixture.sessionId) transports.delete(fixture.sessionId);
          };
          const server = createFixtureMcpServer(label, "http", () => {
            acceptedToolCalls += 1;
          });
          servers.add(server);
          await server.connect(transport);
        }
        await transport.handleRequest(req, res, body);
        if (transport.sessionId) transports.set(transport.sessionId, transport);
        return;
      }
      if (!transport) {
        res.writeHead(400).end();
        return;
      }
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const port = await listen(httpServer);

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    acceptedToolCalls: () => acceptedToolCalls,
    rejectedRequests: () => rejectedRequests,
    close: async () => {
      for (const transport of transports.values()) await transport.close().catch(() => undefined);
      transports.clear();
      for (const server of servers) await server.close().catch(() => undefined);
      servers.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

export async function startAuthenticatedMcpSseFixture(
  options: McpLoopbackFixtureOptions,
): Promise<McpLoopbackFixture> {
  const label = options.label ?? "unlabeled";
  let acceptedToolCalls = 0;
  let rejectedRequests = 0;
  const transports = new Map<string, SSEServerTransport>();
  const servers = new Set<McpServer>();

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (!authorized(req, options.token)) {
        rejectedRequests += 1;
        res.writeHead(401).end();
        return;
      }
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && requestUrl.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        transport.onclose = () => transports.delete(transport.sessionId);
        const server = createFixtureMcpServer(label, "sse", () => {
          acceptedToolCalls += 1;
        });
        servers.add(server);
        await server.connect(transport);
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/messages") {
        const sessionId = requestUrl.searchParams.get("sessionId");
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(404).end();
          return;
        }
        const body = await readJsonBody(req);
        await transport.handlePostMessage(req, res, body);
        return;
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const port = await listen(httpServer);

  return {
    url: `http://127.0.0.1:${port}/sse`,
    acceptedToolCalls: () => acceptedToolCalls,
    rejectedRequests: () => rejectedRequests,
    close: async () => {
      for (const transport of transports.values()) await transport.close().catch(() => undefined);
      transports.clear();
      for (const server of servers) await server.close().catch(() => undefined);
      servers.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
