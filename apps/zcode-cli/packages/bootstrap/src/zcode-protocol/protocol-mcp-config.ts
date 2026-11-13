import type { McpServerConfig } from "@zcode/contracts";
import type { ZCodeProtocolMcpServer } from "@zcode/shared";

export function protocolMcpServersToRuntimeMcpConfig(
  servers: ZCodeProtocolMcpServer[] | undefined,
): { enabled: true; servers: Record<string, McpServerConfig> } | undefined {
  // undefined = 客户端没有 override（沿用现有配置面）；[] = 显式空 override——
  // 「客户端声明没有任何 MCP server」，必须压制 file/plugin 回落，不能折叠成 undefined。
  if (servers === undefined) {
    return undefined;
  }
  if (servers.length === 0) {
    return { enabled: true, servers: {} };
  }

  const runtimeServers: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    if ("command" in server) {
      runtimeServers[server.name] = {
        type: "stdio",
        ...(server.scope ? { source: { kind: server.scope } } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
        // ZCode Protocol 的 mcpServers 是 session/runtime 和状态查询的完整覆盖配置。
        // 这里如果不还原 timeoutMs，UI 保存的超时会在真实工具初始化或 mcp/list 探测前丢失。
        ...(server.alwaysLoad !== undefined ? { alwaysLoad: server.alwaysLoad } : {}),
        ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
        ...(server.isolation !== undefined ? { isolation: server.isolation } : {}),
        ...(server.protocolVersion !== undefined
          ? { protocolVersion: server.protocolVersion }
          : {}),
      };
      continue;
    }
    runtimeServers[server.name] = {
      type: server.type,
      ...(server.scope ? { source: { kind: server.scope } } : {}),
      url: server.url,
      headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
      ...(server.oauth !== undefined ? { oauth: server.oauth } : {}),
      ...(server.alwaysLoad !== undefined ? { alwaysLoad: server.alwaysLoad } : {}),
      // HTTP/SSE MCP 也复用同一条 protocol 覆盖链路，需和 stdio 一样保留超时。
      ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
      ...(server.isolation !== undefined ? { isolation: server.isolation } : {}),
      ...(server.protocolVersion !== undefined ? { protocolVersion: server.protocolVersion } : {}),
    };
  }

  return { enabled: true, servers: runtimeServers };
}

/**
 * record 持有的 client MCP 声明是 in-memory 来源事实（resume 比对 / fork 继承），
 * 与传入数组解除引用：客户端之后再改同一数组不能穿透 record。
 * 该字段永不进入持久化、事件或诊断——凭据只能留在内存里。
 */
export function cloneClientMcpServers(
  servers: ZCodeProtocolMcpServer[] | undefined,
): ZCodeProtocolMcpServer[] | undefined {
  return servers === undefined ? undefined : structuredClone(servers);
}
