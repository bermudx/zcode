// issue #31：workflow child 借用父 MCP port/生效配置的真实链路回归。
// 父会话是 createRegistryBackedTestApp 出的真 AgentRuntime + 真 session 隔离
// stdio 子进程；child 由 createScriptWorkflowAgentRuntime 构造（生产路径，
// 不是 prepareBorrowedMcp 单测）。每个配置代际各起一个 child 跑一次真
// executeTurn，断言 child ModelRequest.tools 反映当时父的 APPLIED 面；
// child close 不得触碰父连接的子进程/工具生命周期。
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { PermissionService, defaultPermissionConfig } from "@zcode/core";
import { createModelTelemetry } from "@zcode/telemetry";
import {
  createSessionId,
  type ModelRequest,
  type ModelResult,
  type SessionStorePort,
} from "@zcode/contracts";

import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "../src/app/script-workflow-child-runtime.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";
import { createTestModelFactoryFromAdapter } from "./helpers/test-agent-runtime.js";

const FIXTURE = fileURLToPath(
  new URL("../../adapters/tests/fixtures/mcp-echo-server.mjs", import.meta.url),
);

beforeEach(() => {
  process.env.TEMPDIAG_TEST = expect.getState().currentTestName ?? "unknown";
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, attempts = 200): Promise<number> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {
      // 文件尚未写入
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pid file never appeared: ${path}`);
}

describe("workflow child borrows parent's live MCP port and effective config", () => {
  let tempRoot = "";
  let sessionStore: SessionStorePort | undefined;

  afterEach(async () => {
    await (sessionStore as unknown as { close?: () => Promise<void> } | undefined)?.close?.();
    sessionStore = undefined;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  it("empty → inject → clear → reinject: each generation's child sees the parent's APPLIED tool face; child close leaves the parent's connection alive", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "workflow-child-mcp-"));
    const requests: ModelRequest[] = [];
    sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const modelFactory = createTestModelFactoryFromAdapter({
      async generateText(request: ModelRequest) {
        requests.push(request);
        return {
          finishReason: "stop",
          text: "child done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as ModelResult;
      },
    });
    const app = await createRegistryBackedTestApp({
      env: { ZCODE_STORAGE_DIR: join(tempRoot, "storage") },
      noPlugins: true,
      skipUserConfig: true,
      modelExecutor: {
        generateText: async (request) => {
          requests.push(request);
          return {
            finishReason: "stop",
            text: "parent done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as ModelResult;
        },
      },
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: createSessionId("wf-parent"),
    });
    const parent = app.runtime;
    const mcpEnv = (label: string) => ({
      MCP_FIXTURE_PID_FILE: join(tempRoot, `${label}.pid`),
      MCP_FIXTURE_LABEL: label,
    });
    const stdioServer = (label: string) => ({
      type: "stdio" as const,
      command: process.execPath,
      args: [FIXTURE],
      env: mcpEnv(label),
      isolation: "session" as const,
      protocolVersion: "legacy" as const,
    });

    try {
      const deps = (): ScriptWorkflowAgentRuntimeDeps =>
        ({
          agentTelemetry: createModelTelemetry().agentExecution,
          appOptions: { env: {} },
          appVersion: "0.0.0-test",
          configResult: {
            config: {
              features: { skill: false },
              modelStream: { idleTimeoutMs: 0 },
              network: {},
              skillOverrides: {},
              skills: { enabled: false, roots: [] },
            },
          },
          fileSystemPort: createNodeFileSystemAdapter(),
          imageProcessorPort: {},
          logger: undefined,
          modelFactory,
          permissionService: new PermissionService(defaultPermissionConfig),
          runtime: parent,
          runtimeConfig: { workingDirectory: tempRoot },
          sessionId: app.sessionId,
          sessionStore,
          storageRoot: tempRoot,
          workingDirectory: tempRoot,
        }) as unknown as ScriptWorkflowAgentRuntimeDeps;

      let childOrdinal = 0;
      const runChild = async (): Promise<ModelRequest> => {
        childOrdinal += 1;
        const before = requests.length;
        const child = createScriptWorkflowAgentRuntime({
          childSessionId: createSessionId(`wf-child-${childOrdinal}`),
          deps: deps(),
          request: { opts: {} } as never,
          traceContext: {
            traceId: `wf-child-${childOrdinal}`,
          } as never,
        });
        try {
          await child.executeTurn("child turn");
        } finally {
          await child.close().catch(() => undefined);
        }
        const request = requests[before];
        if (!request) throw new Error("child produced no model request");
        return request;
      };
      const toolNames = (request: ModelRequest): string[] =>
        (request.tools ?? []).map((tool) => tool.name);

      // 代 1：父会话无 MCP——child 的工具面不含任何 mcp__ 工具。
      const emptyChildRequest = await runChild();
      expect(toolNames(emptyChildRequest).some((name) => name.startsWith("mcp__"))).toBe(
        false,
      );

      // 代 2：父会话迟到注入 stdio server——新 child 借到 port 并看见已注册的
      // mcp__s1__echo（借用 config servers:{} ⇒ 只做 discovery，不自连）。
      await parent.configureMcpServers({ s1: stdioServer("v1") });
      const pid = await waitForFile(join(tempRoot, "v1.pid"));
      const injectedChildRequest = await runChild();
      expect(toolNames(injectedChildRequest)).toContain("mcp__s1__echo");

      // child 关闭后父连接仍活：pid 存活、父 callTool 仍通。
      expect(processAlive(pid)).toBe(true);
      const parentEcho = await parent.getMcpPort()?.callTool({
        serverName: "s1",
        toolName: "echo",
        arguments: { text: "parent" },
      });
      expect(JSON.stringify(parentEcho)).toContain("echo[v1@");

      // 代 3：显式清空——child 看不到 mcp 工具。
      await parent.configureMcpServers({});
      const clearedChildRequest = await runChild();
      expect(toolNames(clearedChildRequest).some((name) => name.startsWith("mcp__"))).toBe(
        false,
      );

      // 代 4：再注入——child 再次看见新代工具。
      await parent.configureMcpServers({ s1: stdioServer("v2") });
      const pid2 = await waitForFile(join(tempRoot, "v2.pid"));
      const reinjectedChildRequest = await runChild();
      expect(toolNames(reinjectedChildRequest)).toContain("mcp__s1__echo");
      expect(processAlive(pid2)).toBe(true);
      const echo2 = await parent.getMcpPort()?.callTool({
        serverName: "s1",
        toolName: "echo",
        arguments: { text: "again" },
      });
      expect(JSON.stringify(echo2)).toContain("echo[v2@");
    } finally {
      await app.close?.();
    }
  }, 60_000);

  // 4(a)：正常 workflow facade runner（app.runWorkflow → expert 装配线 →
  // createWorkflowChildRuntime）与 script 构造器走同一条 borrowMcpAccess /
  // prepareBorrowedMcp 就绪快照；runWorkflow 自身可能因 fake 模型输出在 phase 层失败，但
  // child 的 ModelRequest 已经真实发出，足够断言工具面。
  it("normal workflow facade runner (runWorkflow): child ModelRequest sees the parent's APPLIED MCP face per generation", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "workflow-facade-mcp-"));
    const requests: ModelRequest[] = [];
    sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createRegistryBackedTestApp({
      env: { ZCODE_STORAGE_DIR: join(tempRoot, "storage") },
      noPlugins: true,
      skipUserConfig: true,
      modelExecutor: {
        generateText: async (request) => {
          requests.push(request);
          return {
            finishReason: "stop",
            text: "child done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as ModelResult;
        },
      },
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: createSessionId("wf-facade-parent"),
      sessionStore,
    });
    const parent = app.runtime;
    const stdioServer = (label: string) => ({
      type: "stdio" as const,
      command: process.execPath,
      args: [FIXTURE],
      env: {
        MCP_FIXTURE_PID_FILE: join(tempRoot, `${label}.pid`),
        MCP_FIXTURE_LABEL: label,
      },
      isolation: "session" as const,
      protocolVersion: "legacy" as const,
    });
    const runFacadeChild = async (): Promise<ModelRequest[]> => {
      const before = requests.length;
      // expert workflow 可能跑多 phase 或因 fake 输出中断；断言只需要
      // 每次 run 至少一个 child ModelRequest。
      await app.runWorkflow?.({ task: "borrow check" }).catch(() => undefined);
      const produced = requests.slice(before);
      if (produced.length === 0)
        throw new Error("runWorkflow produced no child model request");
      return produced;
    };
    const hasMcpTool = (rs: ModelRequest[]): boolean =>
      rs.some((r) => (r.tools ?? []).some((t) => t.name.startsWith("mcp__")));

    try {
      // 代 1：无 MCP——facade child 工具面无 mcp__。
      expect(hasMcpTool(await runFacadeChild())).toBe(false);

      // 代 2：注入——facade child 看见 mcp__s1__echo。
      await parent.configureMcpServers({ s1: stdioServer("v1") });
      const pid = await waitForFile(join(tempRoot, "v1.pid"));
      const injected = await runFacadeChild();
      expect(hasMcpTool(injected)).toBe(true);
      expect(
        injected.some((r) =>
          (r.tools ?? []).some((t) => t.name === "mcp__s1__echo"),
        ),
      ).toBe(true);
      // 父连接不受影响。
      expect(processAlive(pid)).toBe(true);
      const parentEcho = await parent.getMcpPort()?.callTool({
        serverName: "s1",
        toolName: "echo",
        arguments: { text: "parent" },
      });
      expect(JSON.stringify(parentEcho)).toContain("echo[v1@");

      // 代 3：清空——facade child 看不到 mcp 工具。
      await parent.configureMcpServers({});
      expect(hasMcpTool(await runFacadeChild())).toBe(false);

      // 代 4：再注入——facade child 再看见新代工具。
      await parent.configureMcpServers({ s1: stdioServer("v2") });
      const pid2 = await waitForFile(join(tempRoot, "v2.pid"));
      expect(hasMcpTool(await runFacadeChild())).toBe(true);
      expect(processAlive(pid2)).toBe(true);
    } finally {
      await app.close?.();
    }
  }, 60_000);

  // 4(a) 加强：facade child 与 script child 都只借 APPLIED 快照——父 turn
  // 阻塞期间 staged 的配置（含 pending 注入）对两者均不可见。
  it("active parent turn stages config: both child constructors see the OLD applied face, not the pending one", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "workflow-staged-mcp-"));
    const requests: ModelRequest[] = [];
    let releaseParentTurn: (() => void) | undefined;
    const parentGate = new Promise<void>((resolve) => {
      releaseParentTurn = resolve;
    });
    sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const modelFactory = createTestModelFactoryFromAdapter({
      async generateText(request: ModelRequest) {
        requests.push(request);
        return {
          finishReason: "stop",
          text: "child done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as ModelResult;
      },
    });
    const app = await createRegistryBackedTestApp({
      env: { ZCODE_STORAGE_DIR: join(tempRoot, "storage") },
      noPlugins: true,
      skipUserConfig: true,
      modelExecutor: {
        generateText: async (request) => {
          requests.push(request);
          if (requests.length === 1) await parentGate; // 阻塞父 turn 首个请求
          return {
            finishReason: "stop",
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as ModelResult;
        },
      },
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: createSessionId("wf-staged-parent"),
      sessionStore,
    });
    const parent = app.runtime;
    const stdioServer = (label: string) => ({
      type: "stdio" as const,
      command: process.execPath,
      args: [FIXTURE],
      env: {
        MCP_FIXTURE_PID_FILE: join(tempRoot, `${label}.pid`),
        MCP_FIXTURE_LABEL: label,
      },
      isolation: "session" as const,
      protocolVersion: "legacy" as const,
    });

    try {
      // 父 turn 挂起期间注入 s1——必须 staged，不进本轮。
      const parentTurn = parent.executeTurn("parent turn");
      for (let i = 0; i < 200 && requests.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(requests.length).toBe(1);
      await parent.configureMcpServers({ s1: stdioServer("staged") });

      // script child（构造器路径）：mid-turn 构造只看到 OLD applied（空）。
      const scriptChild = createScriptWorkflowAgentRuntime({
        childSessionId: createSessionId("wf-staged-script"),
        deps: {
          agentTelemetry: createModelTelemetry().agentExecution,
          appOptions: { env: {} },
          appVersion: "0.0.0-test",
          configResult: {
            config: {
              features: { skill: false },
              modelStream: { idleTimeoutMs: 0 },
              network: {},
              skillOverrides: {},
              skills: { enabled: false, roots: [] },
            },
          },
          fileSystemPort: createNodeFileSystemAdapter(),
          imageProcessorPort: {},
          logger: undefined,
          modelFactory,
          permissionService: new PermissionService(defaultPermissionConfig),
          runtime: parent,
          runtimeConfig: { workingDirectory: tempRoot },
          sessionId: app.sessionId,
          sessionStore,
          storageRoot: tempRoot,
          workingDirectory: tempRoot,
        } as unknown as ScriptWorkflowAgentRuntimeDeps,
        request: { opts: {} } as never,
        traceContext: { traceId: "wf-staged-script" } as never,
      });
      const scriptBefore = requests.length;
      try {
        await scriptChild.executeTurn("script child turn");
      } finally {
        await scriptChild.close().catch(() => undefined);
      }
      const scriptRequest = requests[scriptBefore];
      expect(scriptRequest).toBeTruthy();
      expect(
        (scriptRequest.tools ?? []).some((t) => t.name.startsWith("mcp__")),
      ).toBe(false);

      // facade child（runWorkflow 装配线）：同样只看 OLD applied。
      const facadeBefore = requests.length;
      await app.runWorkflow?.({ task: "staged borrow check" }).catch(() => undefined);
      const facadeRequests = requests.slice(facadeBefore);
      expect(facadeRequests.length).toBeGreaterThan(0);
      expect(
        facadeRequests.some((r) =>
          (r.tools ?? []).some((t) => t.name.startsWith("mcp__")),
        ),
      ).toBe(false);

      // 放行父 turn → 边界处 staged apply 落地，子进程真实拉起。
      releaseParentTurn!();
      await parentTurn;
      const pid = await waitForFile(join(tempRoot, "staged.pid"));
      expect(processAlive(pid)).toBe(true);

      // 边界后的新 child（script 路径）看见新 applied 面。
      const afterBefore = requests.length;
      const afterChild = createScriptWorkflowAgentRuntime({
        childSessionId: createSessionId("wf-staged-after"),
        deps: {
          agentTelemetry: createModelTelemetry().agentExecution,
          appOptions: { env: {} },
          appVersion: "0.0.0-test",
          configResult: {
            config: {
              features: { skill: false },
              modelStream: { idleTimeoutMs: 0 },
              network: {},
              skillOverrides: {},
              skills: { enabled: false, roots: [] },
            },
          },
          fileSystemPort: createNodeFileSystemAdapter(),
          imageProcessorPort: {},
          logger: undefined,
          modelFactory,
          permissionService: new PermissionService(defaultPermissionConfig),
          runtime: parent,
          runtimeConfig: { workingDirectory: tempRoot },
          sessionId: app.sessionId,
          sessionStore,
          storageRoot: tempRoot,
          workingDirectory: tempRoot,
        } as unknown as ScriptWorkflowAgentRuntimeDeps,
        request: { opts: {} } as never,
        traceContext: { traceId: "wf-staged-after" } as never,
      });
      try {
        await afterChild.executeTurn("after boundary child");
      } finally {
        await afterChild.close().catch(() => undefined);
      }
      const afterRequest = requests[afterBefore];
      expect(afterRequest).toBeTruthy();
      expect(
        (afterRequest.tools ?? []).some((t) => t.name === "mcp__s1__echo"),
      ).toBe(true);
    } finally {
      releaseParentTurn?.();
      await app.close?.();
    }
  }, 60_000);

  // 评审 R3：父 apply/startup 未落定时 child 不得把空工具面当事实——借用入口
  // 异步等父侧已排队 MCP 工作。真实 stdio + release-file 闸门扣住握手。
  const makeDeps = (overrides: {
    parent: Parameters<typeof createScriptWorkflowAgentRuntime>[0]["deps"]["runtime"];
    app: { sessionId: string };
    modelFactory: ScriptWorkflowAgentRuntimeDeps["modelFactory"];
  }): ScriptWorkflowAgentRuntimeDeps =>
    ({
      agentTelemetry: createModelTelemetry().agentExecution,
      appOptions: { env: {} },
      appVersion: "0.0.0-test",
      configResult: {
        config: {
          features: { skill: false },
          modelStream: { idleTimeoutMs: 0 },
          network: {},
          skillOverrides: {},
          skills: { enabled: false, roots: [] },
        },
      },
      fileSystemPort: createNodeFileSystemAdapter(),
      imageProcessorPort: {},
      logger: undefined,
      modelFactory: overrides.modelFactory,
      permissionService: new PermissionService(defaultPermissionConfig),
      runtime: overrides.parent,
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: overrides.app.sessionId,
      sessionStore,
      storageRoot: tempRoot,
      workingDirectory: tempRoot,
    }) as unknown as ScriptWorkflowAgentRuntimeDeps;

  it("late port apply in-flight: script child waits the parent's handshake; first ModelRequest carries the inherited tool; exactly one MCP child PID", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "workflow-borrow-wait-"));
    const requests: ModelRequest[] = [];
    sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    // child 模型执行器：工具在面就调一次，验证借到的连接真的可调用。
    const modelFactory = createTestModelFactoryFromAdapter({
      async generateText(request: ModelRequest) {
        requests.push(request);
        const lastRole = request.messages.at(-1)?.role;
        if (request.tools?.some((t) => t.name === "mcp__s1__echo") && lastRole !== "tool") {
          return {
            finishReason: "tool-calls",
            text: "",
            toolCalls: [{ id: "c1", name: "mcp__s1__echo", input: { text: "borrowed" } }],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as ModelResult;
        }
        return {
          finishReason: "stop",
          text: "child done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as ModelResult;
      },
    });
    const app = await createRegistryBackedTestApp({
      env: { ZCODE_STORAGE_DIR: join(tempRoot, "storage") },
      noPlugins: true,
      skipUserConfig: true,
      modelExecutor: {
        generateText: async (request) => {
          requests.push(request);
          return {
            finishReason: "stop",
            text: "parent done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as ModelResult;
        },
      },
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: createSessionId("wf-wait-parent"),
      sessionStore,
    });
    const parent = app.runtime;
    const releaseFile = join(tempRoot, "init.release");
    const pidDir = join(tempRoot, "pids");
    try {
      // 迟到注入 + release 闸门：apply tail 在飞、真实子进程扣在 initialize。
      void parent.configureMcpServers({
        s1: {
          type: "stdio",
          command: process.execPath,
          args: [FIXTURE],
          env: {
            MCP_FIXTURE_PID_FILE: join(tempRoot, "s1.pid"),
            MCP_FIXTURE_PID_DIR: pidDir,
            MCP_FIXTURE_LABEL: "held",
            MCP_FIXTURE_INITIALIZE_RELEASE_FILE: releaseFile,
          },
          isolation: "session",
          protocolVersion: "legacy",
        },
      });
      // 屏障：子进程已 spawn、握手被扣 = 父 apply 确实在飞。
      const pid = await waitForFile(join(tempRoot, "s1.pid"));

      const child = createScriptWorkflowAgentRuntime({
        childSessionId: createSessionId("wf-wait-child"),
        deps: makeDeps({ parent, app, modelFactory }),
        request: { opts: {} } as never,
        traceContext: { traceId: "wf-wait-child" } as never,
      });
      const before = requests.length;
      const childTurn = child.executeTurn("child waits parent");
      // 闸门还扣着（release 文件不存在是确定事实）：借用方不得抢跑——
      // 有界负向轮询只确认「没有偷发」，正向证明靠 release 后的请求内容。
      for (let i = 0; i < 15 && requests.length === before; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(requests.length).toBe(before);

      await writeFile(releaseFile, "go");
      try {
        await childTurn;
      } finally {
        await child.close().catch(() => undefined);
      }
      const childRequest = requests[before];
      expect(childRequest).toBeTruthy();
      expect(
        (childRequest!.tools ?? []).some((t) => t.name === "mcp__s1__echo"),
      ).toBe(true);
      // 真实 echo 经父连接执行——tool 消息里带父 fixture 的 label。
      const toolMessages = requests
        .slice(before)
        .flatMap((r) => r.messages)
        .filter((m) => m.role === "tool")
        .map((m) => JSON.stringify(m));
      expect(toolMessages.some((m) => m.includes("echo[held@"))).toBe(true);

      // 全程只有父那一条 stdio 子进程：借用方绝不 spawn 自己的。
      expect((await readdir(pidDir)).filter((f) => f.endsWith(".pid")).length).toBe(1);
      expect(processAlive(pid)).toBe(true);
      // child 已 close：父连接仍活。
      const parentEcho = await parent.getMcpPort()?.callTool({
        serverName: "s1",
        toolName: "echo",
        arguments: { text: "parent-after" },
      });
      expect(JSON.stringify(parentEcho)).toContain("echo[held@");
    } finally {
      await writeFile(releaseFile, "go").catch(() => undefined);
      await app.close?.();
    }
  }, 60_000);

  it("facade constructor (app.runWorkflow) during held handshake: child waits for parent readiness, then sees the tool", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "workflow-borrow-facade-"));
    const requests: ModelRequest[] = [];
    sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createRegistryBackedTestApp({
      env: { ZCODE_STORAGE_DIR: join(tempRoot, "storage") },
      noPlugins: true,
      skipUserConfig: true,
      modelExecutor: {
        generateText: async (request) => {
          requests.push(request);
          return {
            finishReason: "stop",
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as ModelResult;
        },
      },
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: createSessionId("wf-facade-wait"),
      sessionStore,
    });
    const parent = app.runtime;
    const releaseFile = join(tempRoot, "init.release");
    try {
      void parent.configureMcpServers({
        s1: {
          type: "stdio",
          command: process.execPath,
          args: [FIXTURE],
          env: {
            MCP_FIXTURE_PID_FILE: join(tempRoot, "s1.pid"),
            MCP_FIXTURE_LABEL: "facade-held",
            MCP_FIXTURE_INITIALIZE_RELEASE_FILE: releaseFile,
          },
          isolation: "session",
          protocolVersion: "legacy",
        },
      });
      const pid = await waitForFile(join(tempRoot, "s1.pid"));

      const before = requests.length;
      const workflow = app.runWorkflow?.({ task: "borrow wait" });
      for (let i = 0; i < 15 && requests.length === before; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(requests.length).toBe(before);

      await writeFile(releaseFile, "go");
      await workflow?.catch(() => undefined);
      const produced = requests.slice(before);
      expect(produced.length).toBeGreaterThan(0);
      expect(
        produced.some((r) =>
          (r.tools ?? []).some((t) => t.name === "mcp__s1__echo"),
        ),
      ).toBe(true);
      expect(processAlive(pid)).toBe(true);
    } finally {
      await writeFile(releaseFile, "go").catch(() => undefined);
      await app.close?.();
    }
  }, 60_000);

  it("child cancellation while waiting settles promptly and does not abort the parent's handshake", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "workflow-borrow-cancel-"));
    const requests: ModelRequest[] = [];
    sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const modelFactory = createTestModelFactoryFromAdapter({
      async generateText(request: ModelRequest) {
        requests.push(request);
        return {
          finishReason: "stop",
          text: "child done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as ModelResult;
      },
    });
    const app = await createRegistryBackedTestApp({
      env: { ZCODE_STORAGE_DIR: join(tempRoot, "storage") },
      noPlugins: true,
      skipUserConfig: true,
      modelExecutor: {
        generateText: async (request) => {
          requests.push(request);
          return {
            finishReason: "stop",
            text: "parent done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as ModelResult;
        },
      },
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: createSessionId("wf-cancel-parent"),
      sessionStore,
    });
    const parent = app.runtime;
    const releaseFile = join(tempRoot, "init.release");
    try {
      void parent.configureMcpServers({
        s1: {
          type: "stdio",
          command: process.execPath,
          args: [FIXTURE],
          env: {
            MCP_FIXTURE_PID_FILE: join(tempRoot, "s1.pid"),
            MCP_FIXTURE_LABEL: "cancel-held",
            MCP_FIXTURE_INITIALIZE_RELEASE_FILE: releaseFile,
          },
          isolation: "session",
          protocolVersion: "legacy",
        },
      });
      const pid = await waitForFile(join(tempRoot, "s1.pid"));

      const child = createScriptWorkflowAgentRuntime({
        childSessionId: createSessionId("wf-cancel-child"),
        deps: makeDeps({ parent, app, modelFactory }),
        request: { opts: {} } as never,
        traceContext: { traceId: "wf-cancel-child" } as never,
      });
      const turn = child.executeTurn("child cancelled mid-wait");
      // 等待中的 child 直接 close：借用等待必须立刻 settle——只取消「等待」，
      // 不取消父侧握手。
      await child.close().catch(() => undefined);
      // settle 有界：turn 不挂死。
      await Promise.race([
        turn.then(() => undefined, () => undefined),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("child turn did not settle")), 10_000),
        ),
      ]);
      // 父握手未被波及：放行后照常连上。
      await writeFile(releaseFile, "go");
      for (let i = 0; i < 400; i += 1) {
        const statuses: Record<string, { status?: string }> | undefined = await parent
          .getMcpPort()
          ?.status()
          .catch(() => ({}));
        if (statuses?.s1?.status === "connected") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect((await parent.getMcpPort()!.status()).s1?.status).toBe("connected");
      expect(processAlive(pid)).toBe(true);
    } finally {
      await writeFile(releaseFile, "go").catch(() => undefined);
      await app.close?.();
    }
  }, 60_000);
});
