// ACP → 共享协议 MCP 映射（issue #31 / acp-frontend.md CMCP01/12）：
// T3 等 ACP client 下发的 stdio/http/sse 定义转成 ZCodeProtocolMcpServer。
// scope:'user' 表示显式 owning-client provenance（不是 file/workspace 来源），
// isolation:'session' 把连接与 stdio 子进程绑到本 session，stdio cwd 固定为
// 会话 cwd。边界校验只报类别/序号/数量，绝不回显 env/header/URL/command 值。
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  zcodeProtocolMcpServerSchema,
  type ZCodeProtocolMcpServer,
} from "@zcode/shared";

export type AcpMcpMapErrorReason = "duplicate_name" | "malformed_server";

/** 脱敏的边界错误：message 只含序号/类别，调用方直接转成 invalid_params。 */
export class AcpMcpMapError extends Error {
  readonly reason: AcpMcpMapErrorReason;

  constructor(reason: AcpMcpMapErrorReason, message: string) {
    super(message);
    this.name = "AcpMcpMapError";
    this.reason = reason;
  }
}

/**
 * ACP `mcpServers` → 协议声明数组。`undefined` 输入表示未声明（保留现状），
 * `[]` 是显式清空——调用方必须原样转发，不能折叠成 undefined。
 */
export function mapAcpMcpServers(
  servers: McpServer[] | undefined,
  cwd: string,
): ZCodeProtocolMcpServer[] | undefined {
  if (servers === undefined) return undefined;
  const names = new Set<string>();
  return servers.map((server, index) => {
    const candidate = toProtocolCandidate(server, cwd);
    if (candidate === undefined) {
      throw new AcpMcpMapError(
        "malformed_server",
        `mcpServers[${index}] is not a valid stdio/http/sse definition`,
      );
    }
    const parsed = zcodeProtocolMcpServerSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new AcpMcpMapError(
        "malformed_server",
        `mcpServers[${index}] failed protocol schema validation`,
      );
    }
    if (names.has(parsed.data.name)) {
      throw new AcpMcpMapError(
        "duplicate_name",
        `mcpServers[${index}] duplicates an earlier server name`,
      );
    }
    names.add(parsed.data.name);
    return parsed.data;
  });
}

function toProtocolCandidate(
  server: McpServer,
  cwd: string,
): Record<string, unknown> | undefined {
  if ("type" in server && (server.type === "http" || server.type === "sse")) {
    return {
      name: server.name,
      type: server.type,
      url: server.url,
      headers: (server.headers ?? []).map(({ name, value }) => ({ name, value })),
      scope: "user",
      isolation: "session",
    };
  }
  if ("command" in server) {
    return {
      name: server.name,
      command: server.command,
      args: server.args ?? [],
      env: (server.env ?? []).map(({ name, value }) => ({ name, value })),
      cwd,
      scope: "user",
      isolation: "session",
    };
  }
  return undefined;
}
