// issue #31：client 声明 MCP 的 runtime 测试共用的 port 替身。
import type {
  McpConnectOptions,
  McpConnectionSnapshot,
  McpToolDescriptor,
  McpServerConfig,
  McpServerToolSnapshot,
} from "@zcode/contracts";
import { createSnapshotMcpPort, mcpStatus } from "./mcp-runtime-fixture.js";

export const CLIENT_SERVER: McpServerConfig = {
  type: "stdio",
  command: "node",
  args: ["server.js"],
};

export interface PortCall {
  servers: Record<string, McpServerConfig>;
  options?: McpConnectOptions;
}

interface HeldConnect {
  serverName: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface FakePortInput {
  /** 点名的 server 握手挂起：等 release()（迟到成功），或 poolAborts 时被后续重配移除。 */
  gate?: (serverName: string) => boolean;
  /** 按 pool 的重配契约：被移除的 server 立即关闭，它在飞的握手随连接一起作废。 */
  poolAborts?: boolean;
  toolsFor?: (serverName: string) => McpToolDescriptor[];
  onConnect?: (serverName: string) => void;
  onSettled?: (serverName: string) => void;
}

/**
 * 上游 McpSession 只读 port 的内存快照（getToolSnapshot），连接结果由 adapter 发布。
 * 这里按 pool 的契约（adapters/src/mcp/pool.ts）模拟这两件事：重配时不在新快照里的
 * server 立即离开快照，其余 server 的行只在它自己连上后更新；status / listTools
 * 与快照同源。runtime 一侧不替换任何东西。
 */
export function createClientMcpPort(input: FakePortInput = {}) {
  const snapshot: Record<string, McpServerToolSnapshot> = {};
  const calls: PortCall[] = [];
  const closed: string[] = [];
  const held: HeldConnect[] = [];
  let leased = new Set<string>();
  const port = createSnapshotMcpPort(snapshot, {
    status: async () =>
      Object.fromEntries(Object.entries(snapshot).map(([name, row]) => [name, row.status])),
    listTools: async () => Object.values(snapshot).flatMap((row) => row.tools ?? []),
    connectConfiguredServers: async (servers, options) => {
      calls.push({ servers, options });
      const next = new Set(Object.keys(servers));
      for (const name of leased) {
        if (next.has(name)) continue;
        closed.push(name);
        delete snapshot[name];
        if (!input.poolAborts) continue;
        for (const connect of held) {
          if (connect.serverName === name) connect.reject(new Error("MCP connection closed"));
        }
      }
      leased = next;
      const statuses: McpConnectionSnapshot["statuses"] = {};
      const tools: McpToolDescriptor[] = [];
      await Promise.all(
        Object.keys(servers).map(async (name) => {
          input.onConnect?.(name);
          if (input.gate?.(name)) {
            await new Promise<void>((resolve, reject) => {
              held.push({ serverName: name, resolve, reject });
              const signal = options?.signal;
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          input.onSettled?.(name);
          statuses[name] = mcpStatus("connected", { toolCount: 1 });
          tools.push(...(input.toolsFor?.(name) ?? []));
        }),
      );
      // 已被后续重配移除的 server：迟到的成功不回到快照。
      for (const [name, status] of Object.entries(statuses)) {
        if (!leased.has(name)) continue;
        snapshot[name] = {
          status,
          tools: tools.filter((tool) => tool.serverName === name),
          toolsVersion: "1",
        };
      }
      return { statuses, tools };
    },
  });
  const release = () => {
    for (const connect of held.splice(0)) connect.resolve();
  };
  return {
    port,
    calls,
    closed,
    release,
    /** 每次 connectConfiguredServers 收到的 server 名（排序）。 */
    names: () => calls.map((call) => Object.keys(call.servers).sort()),
  };
}
