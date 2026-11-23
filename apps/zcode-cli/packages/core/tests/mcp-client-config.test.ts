import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  type McpConfigurationSource,
  type McpServerConfig,
} from "@zcode/contracts";
import {
  createMcpClientConfigSource,
  type McpClientConfigSource,
} from "../src/runtime/mcp-client-session.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { deferred, tool } from "./mcp-runtime-fixture.js";
import { CLIENT_SERVER, createClientMcpPort } from "./mcp-client-port-fixture.js";

// issue #31（评审 R2/R3/R5/R6/R7、S1/S2、F1）：client 声明 MCP 的 runtime 语义。
// 上游 v4.0.0 起声明骑在上游 McpSession 的配置源上：声明 / detach / adoption 只是
// 发布新快照，连接、工具登记与撤销由 McpSession 收敛。断言只看两件事——port 收到
// 哪些快照（connectConfiguredServers 的入参与 getToolSnapshot）、runtime 对外交付了什么。

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) await tick();
  if (!condition()) throw new Error(`not reached: ${label}`);
}

const server = (command: string): McpServerConfig => ({ type: "stdio", command, args: [] });

/** 上游配置源（磁盘 / plugin）的替身：publish 模拟一次热更新。 */
function recordingBase(initial: Record<string, McpServerConfig>) {
  let snapshot = { enabled: true, servers: initial };
  let closed = false;
  const listeners = new Set<() => void>();
  const source: McpConfigurationSource = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
  };
  return {
    source,
    isClosed: () => closed,
    publish: (servers: Record<string, McpServerConfig>) => {
      snapshot = { enabled: true, servers };
      for (const listener of [...listeners]) listener();
    },
  };
}

/** 订阅 view 并记下每次通知看到的快照（只在通知时记录）。 */
function trackView(source: McpClientConfigSource) {
  const view = source.view();
  const seen: string[] = [];
  view.subscribe(() => {
    const snapshot = view.getSnapshot();
    seen.push(
      `${snapshot.enabled === false ? "off" : "on"}:${Object.keys(snapshot.servers ?? {}).sort().join(",")}`,
    );
  });
  return { view, seen };
}

describe("client MCP configuration source", () => {
  it("passes the base configuration through, including its hot reloads, until a client declares", () => {
    const base = recordingBase({ disk: server("disk") });
    const source = createMcpClientConfigSource(base.source);
    const { seen } = trackView(source);
    base.publish({ disk: server("disk-v2"), plugin: server("plugin") });
    expect(seen).toEqual(["on:disk,plugin"]);
    source.close();
    expect(base.isClosed()).toBe(true);
  });

  it("a client declaration is a complete override: base changes stop at it, detach publishes the empty set, adoption restores the declaration", () => {
    const base = recordingBase({ disk: server("disk") });
    const source = createMcpClientConfigSource(base.source);
    const { seen } = trackView(source);
    expect(
      source.update({
        suspended: false,
        override: { enabled: true, servers: { client: server("client") } },
      }),
    ).toBe(true);
    base.publish({ disk: server("disk-v3") });
    expect(source.update({ suspended: true })).toBe(true);
    // 同一份快照不重复通知：session 不会为它再收敛一轮连接。
    expect(source.update({ suspended: true })).toBe(false);
    // override 省略 = 沿用当前声明。
    expect(source.update({ suspended: false })).toBe(true);
    expect(seen).toEqual(["on:client", "off:", "on:client"]);
    source.close();
  });

  it("a session without a base source (noPlugins) passes the create-time declaration through", () => {
    const declared = createMcpClientConfigSource(undefined, {
      enabled: true,
      servers: { created: server("created") },
    });
    expect(declared.view().getSnapshot()).toEqual({
      enabled: true,
      servers: { created: server("created") },
    });
    // 空会话：create 时没有声明就是「启用、无 server」——view 按契约给字段齐全的快照。
    const empty = createMcpClientConfigSource(undefined);
    expect(empty.view().getSnapshot()).toEqual({ enabled: true, servers: {} });
    declared.close();
    empty.close();
  });

  it("closing a session view keeps the override for a late-rebuilt session; closing the source ends notifications", () => {
    const source = createMcpClientConfigSource(undefined);
    source.update({ suspended: false, override: { enabled: false, servers: {} } });
    const first = trackView(source);
    // 显式清空后 runtime 释放 session（session.close()）：只摘掉这一个 view 的订阅。
    first.view.close();
    expect(
      source.update({
        suspended: false,
        override: { enabled: true, servers: { late: server("late") } },
      }),
    ).toBe(true);
    expect(first.seen).toEqual([]);
    expect(Object.keys(source.view().getSnapshot().servers ?? {})).toEqual(["late"]);
    const last = trackView(source);
    source.close();
    expect(
      source.update({
        suspended: false,
        override: { enabled: true, servers: { after: server("after") } },
      }),
    ).toBe(false);
    expect(last.seen).toEqual([]);
  });
});

describe("client MCP runtime configuration", () => {
  it("exposes no client override until one exists, then returns an independent clone (R6)", async () => {
    const { port, names } = createClientMcpPort();
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-mcp-getter"),
      { mode: "build", mcp: { enabled: true, servers: { builtin: CLIENT_SERVER } } },
      { eventStore: createTestSessionEventStore(), mcpPort: port },
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
    // client 声明是完整的会话 override：create 时的 builtin 让位，port 只收到 s1。
    expect(names()).toEqual([["builtin"], ["s1"]]);
    await runtime.close();
  });

  it("late injection lazily creates the session port, connects, and commits effective config (R5)", async () => {
    let factoryCalls = 0;
    const { port, names } = createClientMcpPort();
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-mcp-late"),
      { mode: "build", mcp: { enabled: false, servers: {} } },
      {
        eventStore: createTestSessionEventStore(),
        createMcpPort: () => {
          factoryCalls += 1;
          return port;
        },
      },
    );
    expect(runtime.getMcpPort()).toBeUndefined();
    expect(factoryCalls).toBe(0);
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    expect(factoryCalls).toBe(1);
    expect(runtime.getMcpPort()).toBe(port);
    // 迟到补建的 session 先按 create 时的空配置启动，再收到声明。
    expect(names()).toEqual([[], ["s1"]]);
    const committed = runtime.getEffectiveMcpConfig();
    expect(committed?.enabled).toBe(true);
    expect(committed?.servers?.s1?.type).toBe("stdio");
    await runtime.close();
  });

  it("explicit empty set closes the owned port, and reinjection rebuilds a new generation (R5/R7)", async () => {
    const generations: Array<ReturnType<typeof createClientMcpPort>> = [];
    const closeCalls: number[] = [];
    const runtime = createTestAgentRuntime(createSessionId("runtime-mcp-clear"), { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      createMcpPort: () => {
        const generation = createClientMcpPort();
        const index = generations.push(generation);
        return { ...generation.port, close: async () => void closeCalls.push(index) };
      },
    });
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    const first = runtime.getMcpPort();
    expect(first).toBeDefined();
    await runtime.configureMcpServers({});
    // 显式清空：session 收敛到空集后关闭 session 自有 port，工厂 memo 复位。
    expect(generations[0]?.names()).toEqual([[], ["s1"], []]);
    expect(closeCalls).toEqual([1]);
    expect(runtime.getMcpPort()).toBeUndefined();
    await runtime.configureMcpServers({ s2: { ...CLIENT_SERVER } });
    // 再注入拿全新 port，不是复用已关的旧代。
    expect(generations).toHaveLength(2);
    expect(runtime.getMcpPort()).not.toBe(first);
    expect(generations[1]?.names()).toEqual([[], ["s2"]]);
    await runtime.close();
  });

  it("a borrowed injected port converges to the empty set on explicit clear but is never closed (R7)", async () => {
    let closeCalls = 0;
    const { port, names } = createClientMcpPort();
    const borrowed = { ...port, close: async () => void (closeCalls += 1) };
    const runtime = createTestAgentRuntime(createSessionId("runtime-mcp-borrowed"), { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: borrowed,
    });
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    await runtime.configureMcpServers({});
    // 注入方拥有的 port 绝不能替注入方 close。
    expect(names()).toEqual([[], ["s1"], []]);
    expect(closeCalls).toBe(0);
    expect(runtime.getMcpPort()).toBe(borrowed);
    await runtime.close();
    expect(closeCalls).toBe(0);
  });

  it("a client declaration replaces the disk configuration until the client clears it; it never falls back", async () => {
    const { port, names } = createClientMcpPort();
    const base = recordingBase({ disk: { ...CLIENT_SERVER } });
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-mcp-override"),
      { mode: "build", mcp: { enabled: true, servers: { disk: { ...CLIENT_SERVER } } } },
      { eventStore: createTestSessionEventStore(), mcpPort: port, mcpConfigurationSource: base.source },
    );
    expect(names()).toEqual([["disk"]]);
    // base 热更新：没有 client 声明时 McpSession 照上游方式自己收敛。
    base.publish({ disk: { ...CLIENT_SERVER, args: ["v2.js"] } });
    await until(() => names().length === 2, "base hot reload reaches the port");
    await runtime.configureMcpServers({ client: { ...CLIENT_SERVER } });
    expect(names().at(-1)).toEqual(["client"]);
    // 声明期间 base 的变化不改变本会话的快照。
    base.publish({ disk: { ...CLIENT_SERVER, args: ["v3.js"] } });
    await tick();
    expect(names().at(-1)).toEqual(["client"]);
    // 显式清空是空集，不是回退到磁盘配置。
    await runtime.configureMcpServers({});
    expect(names().at(-1)).toEqual([]);
    await runtime.close();
  });

  it("a stale connect completion cannot commit after detach; the same declaration reconnects after adoption (R2)", async () => {
    let gateOpen = true;
    const { port, names, release } = createClientMcpPort({
      gate: (name) => name === "s1" && gateOpen,
    });
    const runtime = createTestAgentRuntime(createSessionId("runtime-mcp-epoch"), { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
    });
    const configuring = runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    await tick();
    expect(names()).toEqual([[], ["s1"]]);
    const detaching = runtime.setMcpClientAttached(false);
    // detach 同步发布空集：port 立即收到，不等在飞的 connect。
    expect(names()).toEqual([[], ["s1"], []]);
    gateOpen = false;
    release(); // 即使 connect 不听 abort（迟到成功），这代结果也不能落地。
    await configuring;
    await detaching;
    expect(runtime.getEffectiveMcpConfig()?.servers?.s1).toBeUndefined();
    await runtime.setMcpClientAttached(true);
    // 同配置声明不能因 applied == desired 而跳过欠着的重连。
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    expect(names()).toEqual([[], ["s1"], [], ["s1"]]);
    expect(runtime.getEffectiveMcpConfig()?.servers?.s1?.type).toBe("stdio");
    await runtime.close();
  });

  it("detach converges to the empty set without waiting for the hung handshake; the in-flight server is closed (R3)", async () => {
    const { port, names, closed } = createClientMcpPort({
      gate: (name) => name === "s1",
      poolAborts: true,
    });
    const runtime = createTestAgentRuntime(createSessionId("runtime-mcp-abort"), { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
    });
    const configuring = runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    await tick();
    expect(names()).toEqual([[], ["s1"]]);
    // 不先放行握手：detach 只等「收敛到空集」这一次重配。
    await runtime.setMcpClientAttached(false);
    expect(closed).toEqual(["s1"]);
    await configuring;
    expect(names()).toEqual([[], ["s1"], []]);
    await runtime.close();
  });

  it("a revoked apply exits on rapid detach+adopt instead of committing over the round trip (S1)", async () => {
    let gateOpen = true;
    const { port, names, release } = createClientMcpPort({
      gate: (name) => name === "s1" && gateOpen,
    });
    const runtime = createTestAgentRuntime(createSessionId("runtime-mcp-revoked-apply"), { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
    });
    const configuring = runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    await tick();
    expect(names()).toEqual([[], ["s1"]]);
    // detach 与 adopt 都不先 await——adopt 排在 suspend 之后的 tail 上。
    const detaching = runtime.setMcpClientAttached(false);
    const attaching = runtime.setMcpClientAttached(true);
    expect(names()).toEqual([[], ["s1"], []]);
    gateOpen = false;
    release();
    await configuring;
    await detaching;
    await attaching;
    // 被废的 apply 没有再发布任何快照；标志位已复原也不能把结果提交到空连接上。
    expect(names()).toEqual([[], ["s1"], []]);
    expect(runtime.getEffectiveMcpConfig()?.servers?.s1).toBeUndefined();
    // 后续同配置声明恰好补连一次（补连欠账由下一个准入操作接住）。
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    expect(names()).toEqual([[], ["s1"], [], ["s1"]]);
    await runtime.close();
  });

  it("detach suspends the applied and the in-flight server alike (S2)", async () => {
    const { port, names, closed } = createClientMcpPort({
      gate: (name) => name === "b",
      poolAborts: true,
    });
    const runtime = createTestAgentRuntime(createSessionId("runtime-mcp-suspend-union"), { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
    });
    // applied A 落地；随后 B 的 apply 卡在 connect——detach 不能只看见 applied 里的 a。
    await runtime.configureMcpServers({ a: { ...CLIENT_SERVER } });
    const configuring = runtime.configureMcpServers({
      a: { ...CLIENT_SERVER },
      b: { ...CLIENT_SERVER },
    });
    await tick();
    expect(names()).toEqual([[], ["a"], ["a", "b"]]);
    await runtime.setMcpClientAttached(false);
    await configuring;
    // 卡在握手的 b 也被收敛——它的 stdio 子进程不是 detach 的漏网之鱼。
    expect(names()).toEqual([[], ["a"], ["a", "b"], []]);
    expect([...closed].sort()).toEqual(["a", "b"]);
    await runtime.close();
  });

  it("startup/apply overlap: the replaced in-flight connects are closed, never revived (F1)", async () => {
    const { port, names, closed } = createClientMcpPort({
      gate: (name) => name === "a" || name === "b",
      poolAborts: true,
    });
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-mcp-inflight-overlap"),
      { mode: "build", mcp: { enabled: true, servers: { a: { ...CLIENT_SERVER } } } },
      { eventStore: createTestSessionEventStore(), mcpPort: port },
    );
    // 构造即发出 startup connect {a}。
    await tick();
    expect(names()).toEqual([["a"]]);
    // apply {b}：client 声明是完整 override，a 的在飞握手随替换关闭，b 在飞。
    const applyB = runtime.configureMcpServers({ b: { ...CLIENT_SERVER } });
    await tick();
    expect(names()).toEqual([["a"], ["b"]]);
    // desired 推进到 {c}：apply tail 仍卡在 B 的 connect。
    const stageC = runtime.configureMcpServers({ c: { ...CLIENT_SERVER } });
    await runtime.setMcpClientAttached(false);
    await applyB;
    await stageC;
    // 被废的 apply 已退出：没有为 B 再发一次 connect；detach 期间 staged 的 c 不落地。
    expect(names()).toEqual([["a"], ["b"], []]);
    expect([...closed].sort()).toEqual(["a", "b"]);
    expect(runtime.getEffectiveMcpConfig()?.servers?.c).toBeUndefined();
    // adopt + 下一次声明：只有当前的 c 连一次。
    await runtime.setMcpClientAttached(true);
    await runtime.configureMcpServers({ c: { ...CLIENT_SERVER } });
    expect(names()).toEqual([["a"], ["b"], [], ["c"]]);
    expect(Object.keys(runtime.getEffectiveMcpConfig()?.servers ?? {})).toEqual(["c"]);
    await runtime.close();
  });

  it("a late initializeMcp cannot overwrite a newer boundary apply registration (F1)", async () => {
    const { port, names, release } = createClientMcpPort({
      gate: (name) => name === "old",
      toolsFor: (name) => [tool(name, "echo")],
    });
    const sessionId = createSessionId("runtime-mcp-stale-init");
    const traceContext = createRootTraceContext({ sessionId });
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build", mcp: { enabled: true, servers: { old: { ...CLIENT_SERVER } } } },
      { eventStore: createTestSessionEventStore(), mcpPort: port, traceContext },
    );
    // initializeMcp 卡在旧 startup 上。
    const initializing = (
      runtime as unknown as { initializeMcp(trace: typeof traceContext): Promise<void> }
    ).initializeMcp(traceContext);
    await tick();
    // 更新的 boundary apply 先完成：注册 new 的工具。
    await runtime.configureMcpServers({ new: { ...CLIENT_SERVER } });
    expect(runtime.getToolRegistry().get("mcp__new__echo")).toBeDefined();
    // 旧 startup 迟到放行：工具只来自 port 的当前快照，old 的工具不回到注册表。
    release();
    await initializing;
    expect(runtime.getToolRegistry().get("mcp__new__echo")).toBeDefined();
    expect(runtime.getToolRegistry().get("mcp__old__echo")).toBeUndefined();
    expect(names()).toEqual([["old"], ["new"]]);
    await runtime.close();
  });

  it("a session without a client declaration never waits for MCP at the apply boundary (upstream background startup)", async () => {
    // startup connect 一直挂起：上游 background 策略下首条请求不等它。
    const { port, release } = createClientMcpPort({ gate: () => true });
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-mcp-no-declaration"),
      { mode: "build", mcp: { enabled: true, servers: { slow: { ...CLIENT_SERVER } } } },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: port,
        mcpStartupPolicy: "background",
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = Promise.race([
      runtime.applyPendingMcpServers(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("apply boundary waited for MCP startup")), 2_000);
      }),
    ]);
    try {
      // 整轮边界与空闲 drain 都会调用：没有声明、没有欠账就必须立刻返回。
      await bounded;
    } finally {
      clearTimeout(timer);
      release();
      await runtime.close();
    }
  });

  it("a child created during an in-flight apply borrows the face that apply publishes (R3)", async () => {
    const { port, release } = createClientMcpPort({ gate: (name) => name === "s2" });
    const runtime = createTestAgentRuntime(createSessionId("runtime-mcp-borrow-wait"), { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
    });
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    const applying = runtime.configureMcpServers({ s2: { ...CLIENT_SERVER } });
    await tick();
    const borrowing = runtime.createChildMcpAccess();
    release();
    const [access] = await Promise.all([borrowing, applying]);
    expect(Object.keys(access.config.servers ?? {})).toEqual(["s2"]);
    expect(access.deps.mcpPort).toBeDefined();
    await runtime.close();
  });

  it("a child created after detach borrows nothing until the client declares again", async () => {
    const { port } = createClientMcpPort();
    const runtime = createTestAgentRuntime(createSessionId("runtime-mcp-borrow-detached"), { mode: "build" }, {
      eventStore: createTestSessionEventStore(),
      mcpPort: port,
    });
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    expect(Object.keys((await runtime.createChildMcpAccess()).config.servers ?? {})).toEqual(["s1"]);
    await runtime.setMcpClientAttached(false);
    const detached = await runtime.createChildMcpAccess();
    expect(detached.config).toEqual({ enabled: false });
    expect(detached.deps.mcpPort).toBeUndefined();
    await runtime.setMcpClientAttached(true);
    await runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    expect(Object.keys((await runtime.createChildMcpAccess()).config.servers ?? {})).toEqual(["s1"]);
    await runtime.close();
  });

  it("a stale identical-declaration health probe cannot retry over a newer declaration (R3-rework)", async () => {
    const fake = createClientMcpPort();
    const statusEntered = deferred<void>();
    const statusGate = deferred<void>();
    const port = {
      ...fake.port,
      status: async () => {
        statusEntered.resolve();
        await statusGate.promise;
        return fake.port.status();
      },
    };
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-mcp-stale-probe"),
      { mode: "build", mcp: { enabled: true, servers: { s1: { ...CLIENT_SERVER } } } },
      { eventStore: createTestSessionEventStore(), mcpPort: port },
    );
    // identical 声明命中 unchanged → 健康探针被闸门卡住。
    const stale = runtime.configureMcpServers({ s1: { ...CLIENT_SERVER } });
    await statusEntered.promise;
    // 探针等待期间另一个 configure 换了声明：立即 apply。
    await runtime.configureMcpServers({ s2: { ...CLIENT_SERVER } });
    expect(fake.names()).toEqual([["s1"], ["s2"]]);
    statusGate.resolve(); // 快照里 s1 已不在：陈旧探针本会判 retry。
    await stale;
    // 修前：陈旧探针立 reconnectNeeded 并再连一次。
    expect(fake.names()).toEqual([["s1"], ["s2"]]);
    await runtime.close();
  });
});
