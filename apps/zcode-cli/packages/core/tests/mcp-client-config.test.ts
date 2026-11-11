import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  type McpConnectionSnapshot,
  type McpPort,
  type McpServerConfig,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";

// issue #31 评审 R2/R3/R5/R6/R7：client 注入 MCP 的 runtime 语义——
// attach epoch 挡迟到 commit、detach 中止在飞 connect、生效配置在边界提交、
// getter 只暴露 client override 克隆、借用 port 不被显式清空关闭。

const CLIENT_SERVER: McpServerConfig = {
  type: "stdio",
  command: "node",
  args: ["server.js"],
};

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function emptyMcpSnapshot(): McpConnectionSnapshot {
  return { statuses: {}, tools: [] };
}

function createMockMcpPort(overrides: Partial<McpPort> = {}): McpPort {
  return {
    connectConfiguredServers: async () => emptyMcpSnapshot(),
    connectServer: async () => ({
      status: "connected",
      transport: "stdio",
      toolCount: 1,
      updatedAt: "now",
    }),
    disconnectServer: async () => undefined,
    status: async () => ({}),
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    close: async () => {},
    ...overrides,
  };
}

describe("client MCP runtime configuration", () => {
  it("exposes no client override until one exists, then returns an independent clone (R6)", async () => {
    const sessionId = createSessionId("runtime-mcp-getter");
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build", mcp: { enabled: true, servers: { builtin: CLIENT_SERVER } } },
      { eventStore: createTestSessionEventStore(), mcpPort: createMockMcpPort() },
    );
    // 未注入过：undefined（不是空集）——facade 据此回落默认完整清单。
    expect(runtime.getConfiguredMcpServers()).toBeUndefined();
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    const snapshot = runtime.getConfiguredMcpServers();
    expect(snapshot?.s1?.type).toBe("stdio");
    // 返回必须是克隆：改外部返回值不能污染 internal desired。
    if (snapshot?.s1?.type === "stdio") snapshot.s1.command = "tampered";
    const after = runtime.getConfiguredMcpServers()?.s1;
    expect(after?.type === "stdio" ? after.command : undefined).toBe("node");
    await runtime.close();
  });

  it("late injection lazily creates the session port, connects, and commits effective config (R5)", async () => {
    const sessionId = createSessionId("runtime-mcp-late");
    const config = { mode: "build" as const, mcp: { enabled: false as const, servers: {} } };
    let factoryCalls = 0;
    let connectedWith: Record<string, McpServerConfig> | undefined;
    const port = createMockMcpPort({
      connectConfiguredServers: async (servers) => {
        connectedWith = servers;
        return emptyMcpSnapshot();
      },
    });
    const runtime = createTestAgentRuntime(sessionId, config, {
      eventStore: createTestSessionEventStore(),
      createMcpPort: () => {
        factoryCalls += 1;
        return port;
      },
    });
    expect(runtime.getMcpPort()).toBeUndefined();
    expect(factoryCalls).toBe(0);
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    expect(factoryCalls).toBe(1);
    expect(runtime.getMcpPort()).toBe(port);
    expect(connectedWith?.s1?.type).toBe("stdio");
    // 生效配置在边界提交：subagent/startup 读 internal config.mcp 必须看到
    // enabled+servers（runtime 持有 config 的浅拷贝——这里直读内部快照验证提交）。
    const committed = (runtime as unknown as { config: { mcp?: { enabled?: boolean; servers?: Record<string, McpServerConfig> } } }).config.mcp;
    expect(committed?.enabled).toBe(true);
    expect(committed?.servers?.s1?.type).toBe("stdio");
    await runtime.close();
  });

  it("explicit empty set disconnects, closes the owned port, and reinjection rebuilds (R5/R7)", async () => {
    const sessionId = createSessionId("runtime-mcp-clear");
    const config = { mode: "build" as const };
    let factoryCalls = 0;
    const ports: McpPort[] = [];
    const closeCalls: number[] = [];
    const runtime = createTestAgentRuntime(sessionId, config, {
      eventStore: createTestSessionEventStore(),
      createMcpPort: () => {
        factoryCalls += 1;
        const generation = factoryCalls;
        const port = createMockMcpPort({ close: async () => void closeCalls.push(generation) });
        ports.push(port);
        return port;
      },
    });
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    expect(runtime.getMcpPort()).toBe(ports[0]);
    await runtime.configureMcpServers({});
    // 显式清空：断开 + 关闭 session 自有 port，memo 复位。
    expect(closeCalls).toEqual([1]);
    expect(runtime.getMcpPort()).toBeUndefined();
    await runtime.configureMcpServers({ s2: { ...CLIENT_SERVER } });
    // 再注入拿全新 port，不是复用已关的旧代。
    expect(factoryCalls).toBe(2);
    expect(runtime.getMcpPort()).toBe(ports[1]);
    expect(runtime.getMcpPort()).not.toBe(ports[0]);
    await runtime.close();
  });

  it("borrowed injected port is disconnected but never closed on explicit clear (R7)", async () => {
    const sessionId = createSessionId("runtime-mcp-borrowed");
    let closeCalls = 0;
    const connectCalls: (Record<string, McpServerConfig> | undefined)[] = [];
    const borrowed = createMockMcpPort({
      connectConfiguredServers: async (servers) => {
        connectCalls.push(servers);
        return emptyMcpSnapshot();
      },
      close: async () => {
        closeCalls += 1;
      },
    });
    const runtime = createTestAgentRuntime(sessionId, { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: borrowed,
    });
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    await runtime.configureMcpServers({});
    // 显式清空经 connectConfiguredServers({}) 收缩连接面——
    // 注入方拥有的 port 绝不能替注入方 close。
    expect(connectCalls.length).toBe(2);
    expect(connectCalls[1]).toEqual({});
    expect(closeCalls).toBe(0);
    expect(runtime.getMcpPort()).toBe(borrowed);
    await runtime.close();
  });

  it("stale connect completion cannot commit after detach; same-config configure reconnects (R2)", async () => {
    const sessionId = createSessionId("runtime-mcp-epoch");
    const connect = deferred<McpConnectionSnapshot>();
    let connectCalls = 0;
    const disconnects: string[] = [];
    const port = createMockMcpPort({
      connectConfiguredServers: async () => {
        connectCalls += 1;
        if (connectCalls === 1) return connect.promise;
        return emptyMcpSnapshot();
      },
      disconnectServer: async (name) => void disconnects.push(name),
    });
    const runtime = createTestAgentRuntime(sessionId, { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
    });
    const configuring = runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    await Promise.resolve(); // 让 apply 进入 connect await
    const detaching = runtime.setMcpClientAttached(false);
    // 即使 mock 不听 abort（迟到 resolve），epoch 也必须挡住这代结果。
    connect.resolve(emptyMcpSnapshot());
    await configuring;
    await detaching;
    expect(disconnects).toContain("s1");
    await runtime.setMcpClientAttached(true);
    // 同配置 configure 不能因 applied==desired 而跳过欠着的重连。
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    expect(connectCalls).toBe(2);
    await runtime.close();
  });

  it("detach aborts an in-flight connect instead of waiting for it (R3)", async () => {
    const sessionId = createSessionId("runtime-mcp-abort");
    const observedSignals: AbortSignal[] = [];
    const disconnects: string[] = [];
    const port = createMockMcpPort({
      connectConfiguredServers: (_servers, options) =>
        new Promise<McpConnectionSnapshot>((_resolve, reject) => {
          const signal = options?.signal;
          if (signal) {
            observedSignals.push(signal);
            if (signal.aborted) reject(new Error("aborted"));
            else signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        }),
      disconnectServer: async (name) => void disconnects.push(name),
    });
    const runtime = createTestAgentRuntime(sessionId, { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
    });
    const configuring = runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    await Promise.resolve();
    expect(observedSignals.length).toBe(1);
    // detach 不等整个 connect tail：abort 一到位 suspend 就能跑 teardown。
    await runtime.setMcpClientAttached(false);
    expect(observedSignals[0]!.aborted).toBe(true);
    await configuring;
    expect(disconnects).toContain("s1");
    await runtime.close();
  });

  it("a revoked apply exits on rapid detach+adopt instead of looping on a dead signal (S1)", async () => {
    const sessionId = createSessionId("runtime-mcp-revoked-apply");
    let connectCalls = 0;
    const disconnects: string[] = [];
    const port = createMockMcpPort({
      // abort-aware 的阻塞 connect：被废的申请拿的是永久 aborted signal——
      // 若旧实现 continue 复用它，这里会无限重入；上限兜底保护测试进程不饿死。
      connectConfiguredServers: (_servers, options) => {
        connectCalls += 1;
        // 第一次拿的是被废的申请（永久 aborted signal）——只让它阻塞到 abort；
        // 之后准入的重连立即成功，否则测试自己会挂死。
        if (connectCalls > 1) return Promise.resolve(emptyMcpSnapshot());
        return new Promise<McpConnectionSnapshot>((_resolve, reject) => {
          const signal = options?.signal;
          const rejectOnAbort = () => reject(new Error("aborted"));
          if (!signal) return;
          if (signal.aborted) rejectOnAbort();
          else signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
      },
      disconnectServer: async (name) => void disconnects.push(name),
    });
    const runtime = createTestAgentRuntime(sessionId, { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
    });
    const configuring = runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    await Promise.resolve();
    expect(connectCalls).toBe(1);
    // detach 与 adopt 都不先 await——adopt 排队在 suspend 之后的 tail 上。
    const detaching = runtime.setMcpClientAttached(false);
    const attaching = runtime.setMcpClientAttached(true);
    await configuring;
    await detaching;
    await attaching;
    // 三个承诺全部落定；被废的 old-owner 申请没有拿死信号再做任何一次尝试。
    expect(connectCalls).toBe(1);
    expect(disconnects).toContain("s1");
    // 后续同配置边界重连恰好一次（reconnect debt 被下一个准入操作接住）。
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    expect(connectCalls).toBe(2);
    await runtime.close();
  });

  it("detach suspends the union of applied and in-flight server names (S2)", async () => {
    const sessionId = createSessionId("runtime-mcp-suspend-union");
    const disconnects: string[] = [];
    const pendingConnect = deferred<McpConnectionSnapshot>();
    const port = createMockMcpPort({
      connectConfiguredServers: async (servers) =>
        "b" in servers ? pendingConnect.promise : {
          statuses: {
            a: { status: "connected", transport: "stdio", toolCount: 0, updatedAt: "now" },
          },
          tools: [],
        },
      disconnectServer: async (name) => void disconnects.push(name),
    });
    const runtime = createTestAgentRuntime(sessionId, { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
    });
    // applied A 落地；随后 B 的 apply 卡在 connect——detach 不能只看见 applied 里的 a。
    await runtime.configureMcpServers({ a: { ...CLIENT_SERVER } });
    const configuring = runtime.configureMcpServers({
      a: { ...CLIENT_SERVER },
      b: { ...CLIENT_SERVER },
    });
    await Promise.resolve();
    const detaching = runtime.setMcpClientAttached(false);
    // 卡在握手的 b 也被列入 suspend——它的 stdio 子进程不是 detach 的漏网之鱼。
    pendingConnect.reject(new Error("aborted"));
    await configuring;
    await detaching;
    expect(disconnects.sort()).toEqual(["a", "b"]);
    await runtime.close();
  });

  it("startup/apply overlap: detach union disconnects a replaced in-flight apply op (F1)", async () => {
    const sessionId = createSessionId("runtime-mcp-inflight-overlap");
    const gates: Array<{
      resolve: (snapshot: McpConnectionSnapshot) => void;
      reject: (error: unknown) => void;
    }> = [];
    const connectCalls: (Record<string, McpServerConfig> | undefined)[] = [];
    const disconnects: string[] = [];
    const port = createMockMcpPort({
      connectConfiguredServers: (servers, options) => {
        connectCalls.push(servers);
        const signal = options?.signal;
        // 前两次 connect（startup A / apply B）挂起等闸门；之后准入的重连立即
        // 成功，否则测试自己挂死。
        if (connectCalls.length > 2) return Promise.resolve(emptyMcpSnapshot());
        return new Promise<McpConnectionSnapshot>((resolve, reject) => {
          gates.push({ resolve, reject });
          const rejectOnAbort = () => reject(new Error("aborted"));
          if (!signal) return;
          if (signal.aborted) rejectOnAbort();
          else signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
      },
      disconnectServer: async (name) => void disconnects.push(name),
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build", mcp: { enabled: true, servers: { a: { ...CLIENT_SERVER } } } },
      { eventStore: createTestSessionEventStore(), mcpPort: port },
    );
    try {
      // 构造即发出 startup connect {a}——第一条在飞登记记录。
      await new Promise((resolve) => setImmediate(resolve));
      expect(connectCalls.length).toBe(1);

      // 并发 apply {b}——第二条登记记录，两条必须共存互不覆盖。
      const applyB = runtime.configureMcpServers({ b: { ...CLIENT_SERVER } });
      await new Promise((resolve) => setImmediate(resolve));
      expect(connectCalls.length).toBe(2);

      // A 的 startup 先收尾：它的 finally 只能删自己的登记，不得抹掉 B 的记录。
      gates[0]!.resolve(emptyMcpSnapshot());
      await new Promise((resolve) => setImmediate(resolve));

      // desired 推进到 {c}：apply tail 仍卡在 B 的 connect。
      const stageC = runtime.configureMcpServers({ c: { ...CLIENT_SERVER } });

      // detach 并集 = applied/desired(c)/config(a)/全部在飞登记(b)——
      // 单标量实现此时已把 B 的记录抹掉，disconnect 漏 b、被替换的握手泄漏。
      await runtime.setMcpClientAttached(false);
      await applyB;
      await stageC;
      expect(disconnects).toContain("b");
      // 被废的 apply 已退出：没有第三次 connect 尝试（B 不得复活）。
      expect(connectCalls.length).toBe(2);

      // adopt + 下一边界：只有当前 desired C 补连一次。
      await runtime.setMcpClientAttached(true);
      await runtime.configureMcpServers({ c: { ...CLIENT_SERVER } });
      expect(connectCalls.length).toBe(3);
      expect(Object.keys(connectCalls[2] ?? {})).toEqual(["c"]);
    } finally {
      for (const gate of gates) gate.resolve(emptyMcpSnapshot());
      await runtime.close();
    }
  });

  it("a late initializeMcp cannot overwrite a newer boundary apply registration (F1)", async () => {
    const sessionId = createSessionId("runtime-mcp-stale-init");
    const traceContext = createRootTraceContext({ sessionId });
    const startupGate = deferred<McpConnectionSnapshot>();
    let connectCalls = 0;
    const port = createMockMcpPort({
      connectConfiguredServers: () => {
        connectCalls += 1;
        if (connectCalls === 1) return startupGate.promise;
        return Promise.resolve({
          statuses: {},
          tools: [{ serverName: "new", toolName: "echo", inputSchema: { type: "object" } }],
        });
      },
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build", mcp: { enabled: true, servers: { old: { ...CLIENT_SERVER } } } },
      { eventStore: createTestSessionEventStore(), mcpPort: port, traceContext },
    );
    try {
      // initializeMcp 卡在旧 startup snapshot 上。
      const initializing = (
        runtime as unknown as { initializeMcp(trace: typeof traceContext): Promise<void> }
      ).initializeMcp(traceContext);
      await new Promise((resolve) => setImmediate(resolve));

      // 更新的 boundary apply 先完成：注册 new、消费 one-shot、换掉 startupPromise。
      await runtime.configureMcpServers({ new: { ...CLIENT_SERVER } });
      expect(runtime.getToolRegistry().get("mcp__new__echo")).toBeDefined();

      // 旧 startup 迟到放行——结果必须被丢弃，old 工具绝不能塞回注册表。
      startupGate.resolve({
        statuses: {},
        tools: [{ serverName: "old", toolName: "echo", inputSchema: { type: "object" } }],
      });
      await initializing;
      expect(runtime.getToolRegistry().get("mcp__new__echo")).toBeDefined();
      expect(runtime.getToolRegistry().get("mcp__old__echo")).toBeUndefined();
      expect(connectCalls).toBe(2);
    } finally {
      startupGate.resolve(emptyMcpSnapshot());
      await runtime.close();
    }
  });
});
