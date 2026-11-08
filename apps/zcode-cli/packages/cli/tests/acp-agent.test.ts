// ACP agent 的协议回归：用 SDK 自己的 client app 与我们的 agent app 直连，
// 覆盖 initialize / session 生命周期 / prompt / 权限 / 提问 / 计划审批。
// core 由 fake port 承担——这里验的是 ACP 边界，不是 core 行为。
import assert from "node:assert/strict";
import test from "node:test";
import {
  client,
  methods,
  type SessionConfigOption,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { PermissionBrokerRequest, PermissionBrokerResult } from "@zcode/contracts";
import { createAcpAgentApp } from "../src/acp/acp-agent.js";
import type { AcpCorePort, AcpSession } from "../src/acp/acp-sessions.js";
import type { AttachSessionHandle } from "../src/attach/attach-session.js";

type FakeModel = { modelId: string; providerId: string };

function fakeSession(sessionId: string): {
  handle: AttachSessionHandle;
  results: PermissionBrokerResult[];
  mode: string;
  model: FakeModel;
  text?: string;
  thoughtCalls: string[];
  emit: (event: unknown) => void;
} {
  const sinks = new Set<(event: unknown) => void>();
  const state = {
    mode: "build",
    model: { modelId: "glm-5", providerId: "zhipu" },
    results: [] as PermissionBrokerResult[],
    text: undefined as string | undefined,
    thoughtCalls: [] as string[],
  };
  const reasoningFor = (modelId: string) =>
    modelId === "glm-5"
      ? { defaultLevel: "high", levels: [
          { label: "Low", value: "low" },
          { label: "High", value: "high" },
        ] }
      : { defaultLevel: "max", levels: [
          { label: "Max", value: "max" },
        ] };
  const modelEntry = (ref: FakeModel, label: string) => ({
    label,
    reasoning: reasoningFor(ref.modelId),
    ref,
  });
  const snapshot = {
    settings: {
      model: {
        available: [
          modelEntry(state.model, "GLM-5"),
          modelEntry({ modelId: "glm-4", providerId: "zhipu" }, "GLM-4"),
        ],
        current: state.model,
      },
      thoughtLevel: {
        available: [
          { label: "Low", value: "low" },
          { label: "High", value: "high" },
        ],
        current: undefined as string | undefined,
        enabled: true,
      },
    },
    todos: [],
  };
  const handle = {
    addSink: (sink: (event: unknown) => void) => {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    getMode: () => state.mode,
    sessionId,
    snapshot,
    stopActiveTurn: async () => undefined,
    submitPrompt: async (
      text: string,
      _options?: {
        requestPermission?: (
          request: PermissionBrokerRequest,
          extra?: { signal?: AbortSignal },
        ) => Promise<PermissionBrokerResult>;
      },
    ) => {
      state.text = text;
      for (const sink of sinks) {
        sink({
          payload: { delta: "hello", kind: "text_delta" },
          type: "model_streaming",
        });
      }
      return { response: text };
    },
    setMode: async (mode: string) => {
      state.mode = mode;
      return { mode };
    },
    setModel: async (value: string) => {
      state.model = { modelId: value.split("/")[1] ?? value, providerId: value.split("/")[0] ?? "zhipu" };
      snapshot.settings.model.current = state.model;
      snapshot.settings.thoughtLevel = {
        ...snapshot.settings.thoughtLevel,
        available: [
          ...snapshot.settings.thoughtLevel.available,
          ...reasoningFor(state.model.modelId).levels,
        ].filter((entry, index, all) =>
          all.findIndex((other) => other.value === entry.value) === index,
        ),
        current: undefined,
      };
      return { model: value };
    },
    setThoughtLevel: async (level: string) => {
      state.thoughtCalls.push(level);
      snapshot.settings.thoughtLevel.current = level;
      // 与真实句柄一致：mergeSettings 在回包合并期间就会向 sink 补发 model_selected。
      for (const sink of sinks) sink({ payload: { modelSelection: state.model }, type: "model_selected" });
      return { thoughtLevel: level };
    },
  } as unknown as AttachSessionHandle;
  return Object.assign(state, {
    emit: (event: unknown) => { for (const sink of sinks) sink(event); },
    handle,
  });
}

class FakeCore implements AcpCorePort {
  readonly sessions = new Map<string, ReturnType<typeof fakeSession>>();

  get(sessionId: string): AcpSession | undefined {
    const fake = this.sessions.get(sessionId);
    if (!fake) return undefined;
    return { cwd: "/workspace", handle: fake.handle, workspace: { workspaceKey: "/workspace", workspacePath: "/workspace" } };
  }

  async open(_cwd: string): Promise<AcpSession> {
    const id = `sess_${this.sessions.size + 1}`;
    this.sessions.set(id, fakeSession(id));
    return this.get(id)!;
  }

  async resume(input: { cwd: string; sessionId: string }): Promise<AcpSession> {
    this.sessions.set(input.sessionId, fakeSession(input.sessionId));
    return this.get(input.sessionId)!;
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    this.sessions.clear();
  }
}

function clientApp(onPermission: () => string, onElicitation: () => unknown) {
  return client({ name: "test-client" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const optionId = onPermission() || params.options[0]?.optionId || "";
      return {
        outcome:
          optionId === "cancel"
            ? { outcome: "cancelled" as const }
            : { optionId, outcome: "selected" as const },
      };
    })
    .onRequest(methods.client.elicitation.create, () => onElicitation() as never);
}

test("acp agent: initialize advertises resume/close and no loadSession", async () => {
  const app = createAcpAgentApp({ sessions: new FakeCore(), version: "1.2.3" });
  await clientApp(() => "", () => ({ action: "decline" })).connectWith(app, async (ctx) => {
    const init = await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentInfo?.name, "piz");
    assert.equal(init.agentCapabilities?.loadSession, false);
    assert.deepEqual(init.agentCapabilities?.sessionCapabilities, {
      close: {},
      resume: {},
    });
    assert.equal(init.agentCapabilities?.mcpCapabilities?.http, false);
  });
});

test("acp agent: session/new exposes plan/build and a model config option", async () => {
  const core = new FakeCore();
  const app = createAcpAgentApp({ sessions: core, version: "1.2.3" });
  await clientApp(() => "", () => ({ action: "decline" })).connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    assert.equal(created.sessionId, "sess_1");
    assert.equal(created.modes?.currentModeId, "build");
    const model = created.configOptions?.find((option) => option.id === "model");
    assert.equal(model?.type, "select");
    if (model?.type === "select") {
      assert.equal(model.currentValue, "zhipu/glm-5");
    }
    await ctx.request(methods.agent.session.setMode, {
      modeId: "plan",
      sessionId: created.sessionId,
    });
    assert.equal(core.sessions.get("sess_1")?.mode, "plan");
    await ctx.request(methods.agent.session.setConfigOption, {
      configId: "model",
      sessionId: created.sessionId,
      value: "zhipu/glm-4",
    });
    assert.equal(core.sessions.get("sess_1")?.model.modelId, "glm-4");
  });
});

test("acp agent: new and resume advertise the thought_level config option", async () => {
  const core = new FakeCore();
  const app = createAcpAgentApp({ sessions: core, version: "1.2.3" });
  await clientApp(() => "", () => ({ action: "decline" })).connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const effortOf = (
      configOptions: readonly SessionConfigOption[] | null | undefined,
    ) => configOptions?.find((option) => option.id === "thought_level");
    const advertised = effortOf(created.configOptions);
    assert.equal(advertised?.type, "select");
    if (advertised?.type === "select") {
      assert.deepEqual(
        advertised.options.map((entry) => "value" in entry && entry.value),
        ["low", "high"],
      );
      assert.equal(advertised.currentValue, "high");
    }
    const resumed = await ctx.request(methods.agent.session.resume, {
      cwd: "/workspace",
      sessionId: "sess_resumed",
    });
    assert.equal(effortOf(resumed.configOptions)?.type, "select");
  });
});

test("acp agent: setting thought_level calls core once and returns confirmed options", async () => {
  const core = new FakeCore();
  const app = createAcpAgentApp({ sessions: core, version: "1.2.3" });
  await clientApp(() => "", () => ({ action: "decline" })).connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const response = await ctx.request(methods.agent.session.setConfigOption, {
      configId: "thought_level",
      sessionId: created.sessionId,
      value: "low",
    });
    assert.deepEqual(core.sessions.get(created.sessionId)?.thoughtCalls, ["low"]);
    const effort = response.configOptions.find((option) => option.id === "thought_level");
    if (effort?.type !== "select") throw new Error("expected a select option");
    assert.equal(effort.currentValue, "low");
  });
});

test("acp agent: invalid or unknown effort values never reach the core setter", async () => {
  const core = new FakeCore();
  const app = createAcpAgentApp({ sessions: core, version: "1.2.3" });
  await clientApp(() => "", () => ({ action: "decline" })).connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const session = core.sessions.get(created.sessionId)!;
    for (const params of [
      { configId: "thought_level", sessionId: created.sessionId, value: "" },
      { configId: "thought_level", sessionId: created.sessionId, value: "max" },
      { configId: "nonsense", sessionId: created.sessionId, value: "low" },
    ]) {
      await assert.rejects(
        ctx.request(methods.agent.session.setConfigOption, params),
        (error: unknown) => {
          assert.equal((error as { code?: number }).code, -32602);
          return true;
        },
      );
    }
    await assert.rejects(
      ctx.request(methods.agent.session.setConfigOption, {
        configId: "thought_level",
        sessionId: created.sessionId,
        value: 3,
      } as never),
    );
    (session.handle.snapshot as { settings: { thoughtLevel: { enabled: boolean } } })
      .settings.thoughtLevel.enabled = false;
    await assert.rejects(
      ctx.request(methods.agent.session.setConfigOption, {
        configId: "thought_level",
        sessionId: created.sessionId,
        value: "low",
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, -32602);
        return true;
      },
    );
    assert.deepEqual(session.thoughtCalls, []);
  });
});

test("acp agent: model switch replaces effort choices despite the merged union catalog", async () => {
  const core = new FakeCore();
  const updates: SessionUpdate[] = [];
  const app = createAcpAgentApp({ sessions: core, version: "1.2.3" });
  const testClient = client({ name: "test-client" }).onNotification(
    methods.client.session.update, ({ params }) => { updates.push(params.update); },
  );
  await testClient.connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const session = core.sessions.get(created.sessionId)!;
    const switched = await ctx.request(methods.agent.session.setConfigOption, {
      configId: "model",
      sessionId: created.sessionId,
      value: "zhipu/glm-4",
    });
    const effort = switched.configOptions.find((option) => option.id === "thought_level");
    if (effort?.type !== "select") throw new Error("expected a select option");
    assert.deepEqual(
      effort.options.map((entry) => "value" in entry && entry.value),
      ["max"],
      "union thoughtLevel.available must not leak other-model levels",
    );
    assert.equal(effort.currentValue, "max");
    session.emit({
      payload: { modelSelection: session.model },
      type: "model_selected",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pushed = updates.find(
      (update) => update.sessionUpdate === "config_option_update",
    );
    const pushedEffort = pushed?.configOptions.find(
      (option) => option.id === "thought_level",
    );
    if (pushedEffort?.type !== "select") throw new Error("expected pushed select option");
    assert.deepEqual(
      pushedEffort.options.map((entry) => "value" in entry && entry.value),
      ["max"],
    );
    await assert.rejects(
      ctx.request(methods.agent.session.setConfigOption, {
        configId: "thought_level",
        sessionId: created.sessionId,
        value: "low",
      }),
      /Unsupported reasoning effort/,
    );
    assert.deepEqual(session.thoughtCalls, []);
  });
});

test("acp agent: effort changed by another client is pushed once, own changes are not duplicated", async () => {
  const core = new FakeCore();
  const updates: SessionUpdate[] = [];
  const app = createAcpAgentApp({ sessions: core, version: "1.2.3" });
  const testClient = client({ name: "test-client" }).onNotification(
    methods.client.session.update, ({ params }) => { updates.push(params.update); },
  );
  const pushedEffort = () =>
    updates
      .filter((update) => update.sessionUpdate === "config_option_update")
      .map((update) =>
        update.configOptions.find((option) => option.id === "thought_level"),
      );
  await testClient.connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const session = core.sessions.get(created.sessionId)!;
    // T3 自己改档位：只有请求回包，没有额外推送。
    const own = await ctx.request(methods.agent.session.setConfigOption, {
      configId: "thought_level",
      sessionId: created.sessionId,
      value: "low",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pushedEffort().length, 0, "own change must not be pushed again");
    const ownEffort = own.configOptions.find((option) => option.id === "thought_level");
    assert.equal(ownEffort?.type === "select" && ownEffort.currentValue, "low");
    // 其他客户端改档位：core 状态先变，句柄再补发 model_selected。
    (session.handle.snapshot as { settings: { thoughtLevel: { current?: string } } })
      .settings.thoughtLevel.current = "high";
    session.emit({ payload: { modelSelection: session.model }, type: "model_selected" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pushed = pushedEffort();
    assert.equal(pushed.length, 1);
    const effort = pushed[0];
    if (effort?.type !== "select") throw new Error("expected pushed select option");
    assert.equal(effort.currentValue, "high");
  });
});

test("acp agent: a rejected core effort change surfaces without claiming success", async () => {
  const core = new FakeCore();
  const app = createAcpAgentApp({ sessions: core, version: "1.2.3" });
  await clientApp(() => "", () => ({ action: "decline" })).connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const session = core.sessions.get(created.sessionId)!;
    session.handle.setThoughtLevel = async () => {
      throw new Error("injected effort failure");
    };
    await assert.rejects(
      ctx.request(methods.agent.session.setConfigOption, {
        configId: "thought_level",
        sessionId: created.sessionId,
        value: "low",
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, -32603);
        return true;
      },
    );
    const snapshot = session.handle.snapshot as {
      settings: { thoughtLevel: { current?: string } };
    };
    assert.equal(snapshot.settings.thoughtLevel.current, undefined);
  });
});

test("acp agent: prompt streams updates and bridges tool permission", async () => {
  const core = new FakeCore();
  const app = createAcpAgentApp({ sessions: core, version: "1.2.3" });
  const updates: unknown[] = [];
  const seenPermission: string[] = [];
  const testClient = client({ name: "test-client" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      seenPermission.push(params.toolCall.toolCallId);
      return { outcome: { optionId: params.options[0]?.optionId ?? "", outcome: "selected" as const } };
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });
  await testClient.connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const result = await ctx.request(methods.agent.session.prompt, {
      prompt: [{ text: "hello", type: "text" }],
      sessionId: created.sessionId,
    });
    assert.equal(result.stopReason, "end_turn");
    assert.equal(core.sessions.get(created.sessionId)?.text, "hello");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(updates.some((update) => (update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk"));
  // prompt 里的 fake 回合没有触发权限；权限由下一个用例直接覆盖。
  assert.deepEqual(seenPermission, []);
});

test("acp agent: AskUserQuestion uses form elicitation and returns answers", async () => {
  const core = new FakeCore();
  const app = createAcpAgentApp({ sessions: core, version: "1.2.3" });
  const answers: Record<string, unknown>[] = [];
  const testClient = client({ name: "test-client" })
    .onRequest(methods.client.elicitation.create, ({ params }) => {
      assert.equal(params.mode, "form");
      return {
        action: "accept" as const,
        content: { q0: "Repo" },
      };
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => ({
      outcome: { optionId: params.options[0]?.optionId ?? "", outcome: "selected" as const },
    }));
  await testClient.connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const session = core.sessions.get(created.sessionId)!;
    const handle = session.handle as unknown as {
      submitPrompt: (
        text: string,
        options: {
          requestPermission: (
            request: PermissionBrokerRequest,
          ) => Promise<PermissionBrokerResult>;
        },
      ) => Promise<unknown>;
    };
    handle.submitPrompt = async (_text, options) => {
      const result = await options.requestPermission({
        input: {
          questions: [
            {
              header: "Scope",
              options: [
                { label: "Single", description: "One file" },
                { label: "Repo", description: "Whole repository" },
              ],
              question: "Which scope?",
            },
          ],
        },
        requestId: "r1",
        sessionId: created.sessionId,
        toolCallId: "t1",
        toolName: "AskUserQuestion",
      } as unknown as PermissionBrokerRequest);
      answers.push((result as { modifiedInput?: { answers?: Record<string, unknown> } }).modifiedInput?.answers ?? {});
      return { response: "" };
    };
    await ctx.request(methods.agent.session.prompt, {
      prompt: [{ text: "go", type: "text" }],
      sessionId: created.sessionId,
    });
  });
  assert.deepEqual(answers, [{ "Which scope?": "Repo" }]);
});

test("acp agent: ExitPlanMode cannot be auto-approved without an explicit answer", async () => {
  const core = new FakeCore();
  const app = createAcpAgentApp({ sessions: core, version: "1.2.3" });
  const results: PermissionBrokerResult[] = [];
  const testClient = client({ name: "test-client" })
    .onRequest(methods.client.elicitation.create, () => ({ action: "decline" as const }))
    .onRequest(methods.client.session.requestPermission, ({ params }) => ({
      outcome: { optionId: params.options[0]?.optionId ?? "", outcome: "selected" as const },
    }));
  await testClient.connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const handle = core.sessions.get(created.sessionId)!.handle as unknown as {
      submitPrompt: (
        text: string,
        options: {
          requestPermission: (request: PermissionBrokerRequest) => Promise<PermissionBrokerResult>;
        },
      ) => Promise<unknown>;
    };
    handle.submitPrompt = async (_text, options) => {
      results.push(
        await options.requestPermission({
          requestId: "r1",
          sessionId: created.sessionId,
          toolCallId: "t1",
          toolName: "ExitPlanMode",
        } as unknown as PermissionBrokerRequest),
      );
      return { response: "" };
    };
    await ctx.request(methods.agent.session.prompt, {
      prompt: [{ text: "plan", type: "text" }],
      sessionId: created.sessionId,
    });
  });
  assert.equal(results[0]?.decision, "deny");
});

test("acp agent: session/close stops and forgets the session", async () => {
  const core = new FakeCore();
  const app = createAcpAgentApp({ sessions: core, version: "1.2.3" });
  await clientApp(() => "", () => ({ action: "decline" })).connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    await ctx.request(methods.agent.session.close, { sessionId: created.sessionId });
    assert.equal(core.sessions.size, 0);
  });
});

test("acp agent: failed core close returns an error and keeps the binding", async () => {
  const core = new FakeCore();
  core.closeSession = async () => { throw new Error("injected close failure"); };
  const app = createAcpAgentApp({ sessions: core, version: "test" });
  await clientApp(() => "", () => ({ action: "decline" })).connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, { cwd: "/workspace", mcpServers: [] });
    await assert.rejects(ctx.request(methods.agent.session.close, { sessionId: created.sessionId }), /injected close failure/);
    assert.ok(core.get(created.sessionId));
  });
});

type WireMessage = Stream["writable"] extends WritableStream<infer Message> ? Message : never;

async function blockedOutputFixture(t: test.TestContext) {
  const core = new FakeCore();
  const failures: Error[] = [];
  const writes: WireMessage[] = [];
  const releaseWrites: Array<() => void> = [];
  let input!: ReadableStreamDefaultController<WireMessage>;
  const app = createAcpAgentApp({
    onConnectionError: (error) => failures.push(error), sessions: core, version: "test",
  });
  const connection = app.connect({
    readable: new ReadableStream({ start(controller) { input = controller; } }),
    writable: new WritableStream({
      write(message) {
        writes.push(message);
        if ("method" in message && message.method === methods.client.session.update) {
          return new Promise<void>((resolve) => releaseWrites.push(resolve));
        }
      },
    }),
  });
  t.after(() => {
    connection.close();
    for (const release of releaseWrites) release();
  });
  input.enqueue({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: 1 } });
  await waitFor(() => writes.length === 1);
  input.enqueue({ id: 2, jsonrpc: "2.0", method: "session/new", params: { cwd: "/workspace", mcpServers: [] } });
  await waitFor(() => writes.length === 2);
  return { connection, core, failures, releaseWrites, writes };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for SDK transport");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("acp agent: stalled output has bounded admission and terminates on overload", async (t) => {
  const f = await blockedOutputFixture(t);
  const session = f.core.sessions.get("sess_1")!;
  const event = { payload: { delta: "x".repeat(1024), kind: "text_delta" }, type: "model_streaming" };
  session.emit(event);
  await waitFor(() => f.releaseWrites.length === 1);
  for (let index = 0; index < 1000; index++) session.emit(event);
  await f.connection.closed;
  assert.match(f.failures[0]!.message, /queue overloaded/);
  assert.equal(f.failures.length, 1);
  assert.equal(f.releaseWrites.length, 1, "only one update may enter the SDK write queue");
  assert.equal(f.writes.length, 3, "overload must not queue remaining updates in SDK");
});

test("acp agent: oversized single update fails the byte budget", async (t) => {
  const f = await blockedOutputFixture(t);
  f.core.sessions.get("sess_1")!.emit({
    payload: { delta: "x".repeat(1024 * 1024), kind: "text_delta" }, type: "model_streaming",
  });
  await f.connection.closed;
  assert.match(f.failures[0]!.message, /queue overloaded/);
  assert.equal(f.releaseWrites.length, 0);
});

test("acp agent: live plans replace and clear todos without re-emitting the stale snapshot", async () => {
  const core = new FakeCore();
  const updates: unknown[] = [];
  const app = createAcpAgentApp({ sessions: core, version: "test" });
  const testClient = client({ name: "test-client" }).onNotification(
    methods.client.session.update, ({ params }) => { updates.push(params.update); },
  );
  await testClient.connectWith(app, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion: 1 });
    const created = await ctx.request(methods.agent.session.new, { cwd: "/workspace", mcpServers: [] });
    const session = core.sessions.get(created.sessionId)!;
    const oldTodo = { content: "Old snapshot", priority: "low", status: "pending" } as const;
    session.handle.snapshot.todos = [oldTodo];
    const liveTodo = { content: "Committed live todo", priority: "high", status: "in_progress" } as const;
    session.handle.submitPrompt = async () => {
      for (const [index, todos] of [[0, [liveTodo]], [1, []]] as const) {
        const toolCallId = `todo-${index}`;
        session.emit({
          payload: { input: { todos: [] }, toolCallId, toolName: "TodoWrite" },
          type: "tool_call_scheduled",
        });
        session.emit({
          payload: {
            result: {
              content: JSON.stringify({
                oldTodos: [], todos,
                summary: { total: todos.length, pending: 0, inProgress: todos.length, completed: 0 },
              }),
              success: true,
            },
            toolCallId,
          },
          type: "tool_call_result",
        });
      }
      return { response: "" };
    };
    await ctx.request(methods.agent.session.prompt, {
      prompt: [{ text: "go", type: "text" }], sessionId: created.sessionId,
    });
    assert.deepEqual(updates.filter((update) =>
      (update as { sessionUpdate: string }).sessionUpdate === "plan"), [
      { entries: [liveTodo], sessionUpdate: "plan" },
      { entries: [], sessionUpdate: "plan" },
    ]);
    assert.deepEqual(session.handle.snapshot.todos, [oldTodo], "fixture snapshot deliberately stays stale");
  });
});

test("acp agent: invalid live TodoWrite JSON closes the connection instead of hiding the failure", async (t) => {
  const f = await blockedOutputFixture(t);
  const session = f.core.sessions.get("sess_1")!;
  session.emit({
    payload: { input: { todos: [] }, toolCallId: "bad-todo", toolName: "TodoWrite" },
    type: "tool_call_scheduled",
  });
  session.emit({
    payload: { result: { content: "broken JSON", success: true }, toolCallId: "bad-todo" },
    type: "tool_call_result",
  });
  await f.connection.closed;
  assert.match(f.failures[0]!.message, /projection failed/);
  assert.ok(f.failures[0]!.cause instanceof SyntaxError);
});
