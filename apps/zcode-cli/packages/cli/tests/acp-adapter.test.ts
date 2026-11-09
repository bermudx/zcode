// `zcode-attach acp` 的端到端回归：真实 stdio + 真实 unix socket + 假 core。
//
// 覆盖 ACP v1 的主要路径：initialize 能力声明、session/new、session/prompt
// 的流式 update、session/request_permission 的 option.response 原文往返、
// elicitation（AskUserQuestion / ExitPlanMode）、session/cancel、
// session/close（真停止）与 session/resume。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { connectAttachClient } from "../src/attach/attach-client.js";
import { runAcpCommand } from "../src/acp/acp-command.js";
import {
  makeSnapshot,
  rawEvent,
  startFakeCore,
  v4AckAccepted,
  type FakeCore,
} from "./fixtures/acp-fake-core.js";

const SID = "sess-acp";

/** 轮询等待某个条件成立（不是所有事实都会产生 ACP 帧，例如 core 侧的 stop）。 */
async function until(
  predicate: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

type AcpMessage = {
  error?: { code: number; message: string };
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

type AcpHarness = {
  core: FakeCore;
  /** agent → client 的全部帧（请求、通知、对 client 请求的应答）。 */
  incoming: AcpMessage[];
  updates: AcpMessage[];
  stderr: () => string;
  /** client → agent 请求。 */
  request: (method: string, params: unknown) => Promise<Record<string, unknown>>;
  /** client → agent 通知（无应答）。 */
  notify: (method: string, params: unknown) => void;
  /** 应答 agent 发来的请求（permission / elicitation）。 */
  respond: (id: string | number, result: unknown) => void;
  waitFor: (predicate: (message: AcpMessage) => boolean) => Promise<AcpMessage>;
  close: () => Promise<void>;
};

async function startAcp(
  responder: Parameters<typeof startFakeCore>[1],
): Promise<AcpHarness> {
  const dir = await mkdtemp(join(tmpdir(), "acp-e2e-"));
  const socketPath = join(dir, "core.sock");
  const core = await startFakeCore(socketPath, responder);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr: string[] = [];
  let counter = 0;
  const incoming: AcpMessage[] = [];
  const updates: AcpMessage[] = [];
  const waiters = new Set<() => void>();

  const collect = (line: string): void => {
    if (line.trim().length === 0) return;
    const message = JSON.parse(line) as AcpMessage;
    incoming.push(message);
    if (message.method === "session/update") updates.push(message);
    for (const waiter of [...waiters]) waiter();
  };
  let buffer = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      collect(line);
    }
  });

  const done = runAcpCommand({
    connect: (path) => connectAttachClient(path),
    ensureCore: async () => ({ socketPath }),
    env: {},
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    stdin,
    stdout: stdout as unknown as Writable,
    version: "9.9.9",
  });
  void done.catch(() => undefined);

  // 轮询 + 帧到即查：有的条件（core 收到 v4/command）不产生 ACP 帧，
  // 只在 collect() 时复查会永远等不到。
  const waitFor = (predicate: (message: AcpMessage) => boolean): Promise<AcpMessage> =>
    new Promise<AcpMessage>((resolve) => {
      const timer = setInterval(check, 5);
      timer.unref();
      function check(): void {
        const found = incoming.find(predicate);
        if (!found) return;
        clearInterval(timer);
        waiters.delete(check);
        resolve(found);
      }
      waiters.add(check);
      check();
    });

  return {
    close: async () => {
      stdin.end();
      await done.catch(() => undefined);
      await core.close();
      await rm(dir, { force: true, recursive: true });
    },
    core,
    notify: (method, params) => {
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    request: async (method, params) => {
      const id = `c-${++counter}`;
      stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
      const response = await waitFor((message) => message.id === id);
      if (response.error) {
        throw Object.assign(new Error(response.error.message), {
          code: response.error.code,
        });
      }
      return response.result ?? {};
    },
    incoming,
    respond: (id, result) => {
      stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", result })}\n`);
    },
    stderr: () => stderr.join(""),
    updates,
    waitFor,
  };
}

/** agent → client 的请求（permission/elicitation）在 updates 里。 */
async function nextAgentRequest(
  acp: AcpHarness,
  method: string,
): Promise<AcpMessage> {
  return await acp.waitFor((message) => message.method === method);
}

test("initialize 只声明真实支持的能力", async () => {
  const acp = await startAcp(() => ({}));
  try {
    const result = await acp.request("initialize", {
      clientCapabilities: { elicitation: { form: {} } },
      clientInfo: { name: "t3", version: "1" },
      protocolVersion: 1,
    });
    assert.equal(result.protocolVersion, 1);
    const capabilities = result.agentCapabilities as Record<string, unknown>;
    assert.deepEqual(capabilities.sessionCapabilities, { close: {}, resume: {} });
    assert.equal(capabilities.loadSession, undefined, "loadSession 不声明：我们不重放历史");
    assert.equal(capabilities.mcpCapabilities, undefined, "无插件模式不声明 MCP");
    assert.deepEqual(result.authMethods, []);
    assert.deepEqual(result.agentInfo, { name: "piz", version: "9.9.9" });
  } finally {
    await acp.close();
  }
});

test("session/new 开 core 草稿会话，回 modes 与模型 configOptions", async () => {
  const acp = await startAcp((request) => {
    if (request.method === "session/create") return makeSnapshot(SID, { eventSeq: 7 });
    if (request.method === "session/subscribe") {
      return { eventSeq: 7, events: [], sessionId: SID };
    }
    return {};
  });
  try {
    await acp.request("initialize", { clientCapabilities: {}, protocolVersion: 1 });
    const result = await acp.request("session/new", {
      cwd: "/tmp/ws",
      mcpServers: [{ args: [], command: "t3-mcp", env: [], name: "t3" }],
    });
    assert.equal(result.sessionId, SID);

    const modes = result.modes as { availableModes: Array<{ id: string }>; currentModeId: string };
    assert.equal(modes.currentModeId, "build");
    assert.deepEqual(
      modes.availableModes.map((mode) => mode.id),
      ["plan", "build"],
    );

    const configOptions = result.configOptions as Array<Record<string, unknown>>;
    const modelOption = configOptions.find((option) => option.id === "model");
    assert.ok(modelOption, "模型以 configOption 暴露（v1 现行形状）");
    assert.equal(modelOption.category, "model");
    assert.equal(modelOption.currentValue, "zai/glm-4.6");
    const modelChoices = modelOption.options as Array<{ value: string }>;
    assert.deepEqual(
      modelChoices.map((choice) => choice.value),
      ["zai/glm-4.6", "zai/glm-4.7", "zai/glm-5.3"],
    );
    // GLM 的压缩上限走 _meta（v1 没有独立字段）。
    assert.deepEqual(modelOption._meta, { piz: { compactContextWindow: 262000 } });

    const thought = configOptions.find((option) => option.id === "thought_level");
    assert.equal(thought?.currentValue, "max");

    const create = acp.core.findRequests("session/create")[0];
    assert.equal(create?.params.persistence, "deferred");
    // 真 core 的 session/create schema 要求 workspace.workspaceKey；
    // 假 core 会按同一 schema 拒绝，缺了这里就跑不出结果。
    assert.deepEqual(create?.params.workspace, {
      workspaceKey: "/tmp/ws",
      workspacePath: "/tmp/ws",
    });
    // subscribe 从快照 eventSeq 之后开始：ACI 不重放历史。
    const subscribe = acp.core.findRequests("session/subscribe")[0];
    assert.equal(subscribe?.params.afterSeq, 7);
    // MCP 被忽略这件事要有日志（否则用户以为 MCP 工具可用）。
    assert.match(acp.stderr(), /ignored client mcp servers/);
  } finally {
    await acp.close();
  }
});

test("session/prompt：流式 update、工具块、权限往返与停因", async () => {
  const authoritativeAllow = {
    decision: "allow" as const,
    permissionUpdates: [
      {
        behavior: "allow",
        destination: "projectSettings",
        rules: [{ ruleContent: "Bash(ls:*)", toolName: "Bash" }],
        type: "addRules",
      },
    ],
  };
  const acpRef: { current?: AcpHarness } = {};
  const acp = await startAcp((request, helpers) => {
    if (request.method === "session/create") return makeSnapshot(SID);
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], sessionId: SID };
    }
    if (request.method === "v4/command") {
      const commandId = String(request.params.commandId);
      const type = String(request.params.type);
      if (type !== "sendText") return v4AckAccepted(commandId);
      const turnId = "turn-1";
      queueMicrotask(() => {
        const emit = (payload: Record<string, unknown>, seq: number, eventType: string): void =>
          helpers.notify(
            rawEvent({ payload, seq, sessionId: SID, turnId, type: eventType }),
          );
        emit({ inputId: commandId, input: "hi", turnNumber: 1 }, 1, "turn_started");
        emit({ delta: "thinking…", done: false, kind: "reasoning_delta" }, 2, "model_streaming");
        emit({ delta: "hello ", done: false, kind: "text_delta" }, 3, "model_streaming");
        emit(
          { input: { command: "ls" }, toolCallId: "tool-1", toolName: "Bash" },
          4,
          "tool_call_scheduled",
        );
        void helpers
          .request("srv-1", "interaction/requestPermission", {
            input: { command: "ls" },
            options: [
              {
                kind: "allow_once",
                label: "Allow once",
                name: "Allow once",
                response: authoritativeAllow,
              },
              {
                kind: "deny",
                label: "Deny",
                name: "Deny",
                response: { decision: "deny", reason: "Denied" },
              },
            ],
            reason: "Bash needs approval",
            requestId: "perm-1",
            riskLevel: "low",
            sessionId: SID,
            toolCallId: "tool-1",
            toolName: "Bash",
            turnId,
          })
          .then(() => {
            emit(
              {
                result: { content: "ls output", success: true },
                toolCallId: "tool-1",
              },
              5,
              "tool_call_result",
            );
            emit({ delta: "world", done: false, kind: "text_delta" }, 6, "model_streaming");
            emit(
              {
                response: "hello world",
                resultType: "completed",
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              },
              7,
              "turn_complete",
            );
            void acpRef.current;
          });
      });
      return v4AckAccepted(commandId);
    }
    return {};
  });
  acpRef.current = acp;
  try {
    await acp.request("initialize", { clientCapabilities: { elicitation: { form: {} } }, protocolVersion: 1 });
    await acp.request("session/new", { cwd: "/tmp/ws", mcpServers: [] });

    const promptPromise = acp.request("session/prompt", {
      prompt: [{ text: "hi", type: "text" }],
      sessionId: SID,
    });

    const permission = await nextAgentRequest(acp, "session/request_permission");
    const permissionParams = permission.params as {
      options: Array<{ kind: string; name: string; optionId: string }>;
      sessionId: string;
      toolCall: { kind: string; title: string; toolCallId: string };
    };
    assert.equal(permissionParams.sessionId, SID);
    assert.equal(permissionParams.toolCall.toolCallId, "tool-1");
    assert.equal(permissionParams.toolCall.kind, "execute");
    assert.deepEqual(
      permissionParams.options.map((option) => option.kind),
      ["allow_once", "reject_once"],
    );
    // ACP v1 的应答是双层的：result.outcome.outcome。
    acp.respond(permission.id ?? "", {
      outcome: { optionId: permissionParams.options[0]?.optionId, outcome: "selected" },
    });

    const result = await promptPromise;
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(result.usage, {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    // core 收到的是 option.response 原文（含服务端算好的 permissionUpdates）。
    const permissionResponse = acp.core.responses.at(-1);
    assert.deepEqual(permissionResponse?.result, authoritativeAllow);

    const updateKinds = acp.updates
      .filter((message) => message.method === "session/update")
      .map((message) => (message.params?.update as { sessionUpdate: string }).sessionUpdate);
    assert.ok(updateKinds.includes("agent_thought_chunk"));
    assert.ok(updateKinds.includes("tool_call"));
    assert.ok(updateKinds.includes("tool_call_update"));
    assert.ok(updateKinds.includes("usage_update"));
    // agent_message_chunk 是增量：拼起来正好是完整回复。
    const text = acp.updates
      .filter((message) => message.method === "session/update")
      .map((message) => message.params?.update as { content?: { text?: string }; sessionUpdate: string })
      .filter((update) => update.sessionUpdate === "agent_message_chunk")
      .map((update) => update.content?.text ?? "")
      .join("");
    assert.equal(text, "hello world");
    // tool_call 必须先于 tool_call_update（ACP 的硬要求）。
    assert.ok(
      updateKinds.indexOf("tool_call") < updateKinds.indexOf("tool_call_update"),
      "tool_call 必须先于 tool_call_update",
    );
  } finally {
    await acp.close();
  }
});

test("session/cancel 让 prompt 以 cancelled 收口并停掉 core 回合", async () => {
  const acp = await startAcp((request) => {
    if (request.method === "session/create") return makeSnapshot(SID);
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], sessionId: SID };
    }
    if (request.method === "v4/command") {
      return v4AckAccepted(String(request.params.commandId));
    }
    return {};
  });
  try {
    await acp.request("initialize", { clientCapabilities: {}, protocolVersion: 1 });
    await acp.request("session/new", { cwd: "/tmp/ws", mcpServers: [] });
    const prompt = acp.request("session/prompt", {
      prompt: [{ text: "long task", type: "text" }],
      sessionId: SID,
    });
    // 等 core 收到 sendText，确保回合真的开起来了。
    await acp.waitFor(() => acp.core.findRequests("v4/command").length > 0);
    acp.notify("session/cancel", { sessionId: SID });
    const result = await prompt;
    assert.equal(result.stopReason, "cancelled");
    // stop 是 abort 路径里的 fire-and-forget，断言前等它落地。
    await until(
      () =>
        acp.core
          .findRequests("v4/command")
          .filter((request) => request.params.type === "stop").length === 1,
      2000,
      "core stop command",
    );
  } finally {
    await acp.close();
  }
});

test("session/close 是真停止：取消在跑回合并释放 core 会话", async () => {
  const acp = await startAcp((request) => {
    if (request.method === "session/create") return makeSnapshot(SID);
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], sessionId: SID };
    }
    if (request.method === "session/close") return { closed: true };
    if (request.method === "v4/command") return v4AckAccepted(String(request.params.commandId));
    return {};
  });
  try {
    await acp.request("initialize", { clientCapabilities: {}, protocolVersion: 1 });
    await acp.request("session/new", { cwd: "/tmp/ws", mcpServers: [] });
    const prompt = acp.request("session/prompt", {
      prompt: [{ text: "long task", type: "text" }],
      sessionId: SID,
    });
    await acp.waitFor(() => acp.core.findRequests("v4/command").length > 0);
    await acp.request("session/close", { sessionId: SID });
    const result = await prompt;
    assert.equal(result.stopReason, "cancelled");
    assert.equal(acp.core.findRequests("session/close").length, 1);
  } finally {
    await acp.close();
  }
});

test("session/resume 复用 core 会话 id，并回 modes/configOptions", async () => {
  const acp = await startAcp((request) => {
    if (request.method === "session/resume") {
      return makeSnapshot(SID, { eventSeq: 42, mode: "plan" });
    }
    if (request.method === "session/subscribe") {
      return { eventSeq: 42, events: [], sessionId: SID };
    }
    return {};
  });
  try {
    await acp.request("initialize", { clientCapabilities: {}, protocolVersion: 1 });
    const result = await acp.request("session/resume", {
      cwd: "/tmp/ws",
      mcpServers: [],
      sessionId: SID,
    });
    const modes = result.modes as { currentModeId: string };
    assert.equal(modes.currentModeId, "plan", "plan 模式要如实回给编辑器");
    const resume = acp.core.findRequests("session/resume")[0];
    assert.equal(resume?.params.sessionId, SID);
    const subscribe = acp.core.findRequests("session/subscribe")[0];
    assert.equal(subscribe?.params.afterSeq, 42, "resume 不重放历史");
    // 没有 session/load：我们不声明 loadSession，也不发这个方法。
    assert.equal(acp.core.findRequests("session/load").length, 0);
  } finally {
    await acp.close();
  }
});

test("session/set_mode 与 set_config_option 落到 core 的 setMode/setModel", async () => {
  const acp = await startAcp((request) => {
    if (request.method === "session/create") return makeSnapshot(SID);
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], sessionId: SID };
    }
    if (request.method === "session/setMode") {
      return { snapshot: makeSnapshot(SID, { mode: "plan" }) };
    }
    if (request.method === "session/setModel") {
      return { snapshot: makeSnapshot(SID, { modelId: "glm-4.7" }) };
    }
    if (request.method === "session/setCompactContextWindow") return {};
    return {};
  });
  try {
    await acp.request("initialize", { clientCapabilities: {}, protocolVersion: 1 });
    await acp.request("session/new", { cwd: "/tmp/ws", mcpServers: [] });

    await acp.request("session/set_mode", { modeId: "plan", sessionId: SID });
    assert.equal(acp.core.findRequests("session/setMode")[0]?.params.mode, "plan");
    const modeUpdate = acp.updates.find(
      (message) =>
        (message.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate ===
        "current_mode_update",
    );
    assert.equal(
      (modeUpdate?.params?.update as { currentModeId?: string } | undefined)?.currentModeId,
      "plan",
    );

    await acp.request("session/set_config_option", {
      configId: "model",
      sessionId: SID,
      value: "zai/glm-4.7",
    });
    assert.equal(
      acp.core.findRequests("session/setModel")[0]?.params.model &&
        (acp.core.findRequests("session/setModel")[0]?.params.model as { modelId?: string }).modelId,
      "glm-4.7",
    );
    const configUpdate = acp.updates.find(
      (message) =>
        (message.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate ===
        "config_option_update",
    );
    assert.ok(configUpdate, "切模型后重发 configOptions（压缩上限随模型变）");
  } finally {
    await acp.close();
  }
});

test("AskUserQuestion 走 elicitation form：enum 选项、多选退化为自由文本", async () => {
  const asked: Array<Record<string, unknown>> = [];
  const acp = await startAcp((request, helpers) => {
    if (request.method === "session/create") return makeSnapshot(SID);
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], sessionId: SID };
    }
    if (request.method === "v4/command") {
      const commandId = String(request.params.commandId);
      queueMicrotask(() => {
        helpers.notify(
          rawEvent({
            payload: { inputId: commandId, input: "ask", turnNumber: 1 },
            seq: 1,
            sessionId: SID,
            turnId: "turn-ask",
            type: "turn_started",
          }),
        );
        void helpers
          .request("srv-ask", "interaction/requestUserInput", {
            input: {
              questions: [
                {
                  header: "Library",
                  multiSelect: false,
                  options: [
                    { description: "date-fns is smaller", label: "date-fns" },
                    { description: "moment is familiar", label: "moment" },
                  ],
                  question: "Which date library should we use?",
                },
                {
                  header: "Features",
                  multiSelect: true,
                  options: [
                    { description: "Clamp min/max", label: "clamp" },
                    { description: "Add parsing", label: "parse" },
                  ],
                  question: "Which features do you want?",
                },
              ],
            },
            prompt: "Answer these to continue",
            requestId: "ui-1",
            sessionId: SID,
            toolName: "AskUserQuestion",
            turnId: "turn-ask",
          })
          .then((response) => {
            asked.push(response.result as Record<string, unknown>);
            helpers.notify(
              rawEvent({
                payload: { response: "ok", resultType: "completed" },
                seq: 2,
                sessionId: SID,
                turnId: "turn-ask",
                type: "turn_complete",
              }),
            );
          });
      });
      return v4AckAccepted(commandId);
    }
    return {};
  });
  try {
    await acp.request("initialize", {
      clientCapabilities: { elicitation: { form: {} } },
      protocolVersion: 1,
    });
    await acp.request("session/new", { cwd: "/tmp/ws", mcpServers: [] });
    const prompt = acp.request("session/prompt", {
      prompt: [{ text: "ask me", type: "text" }],
      sessionId: SID,
    });

    const elicitation = await nextAgentRequest(acp, "elicitation/create");
    const params = elicitation.params as {
      message: string;
      mode: string;
      requestedSchema: {
        properties: Record<string, { description?: string; enum?: string[]; title?: string; type: string }>;
      };
      sessionId: string;
    };
    assert.equal(params.mode, "form");
    assert.equal(params.sessionId, SID);
    assert.equal(params.message, "Answer these to continue");
    const first = params.requestedSchema.properties.q0;
    assert.equal(first?.title, "Library");
    assert.equal(first?.description, "Which date library should we use?");
    assert.deepEqual(first?.enum, ["date-fns", "moment"]);
    const second = params.requestedSchema.properties.q1;
    // 多选没有数组形态：给 enum 就变成单选题，只能退化成自由文本。
    assert.equal(second?.enum, undefined);
    assert.equal(second?.type, "string");
    assert.match(second?.description ?? "", /separate them with commas/i);

    acp.respond(elicitation.id ?? "", {
      action: "accept",
      content: { q0: "date-fns", q1: "clamp, parse" },
    });

    const result = await prompt;
    assert.equal(result.stopReason, "end_turn");
    // core 的 answers 以问题原文为 key，多选按 TUI 同款 ", " 拼接。
    assert.deepEqual((asked[0] as { content?: unknown }).content, {
      answers: {
        "Which date library should we use?": "date-fns",
        "Which features do you want?": "clamp, parse",
      },
    });
  } finally {
    await acp.close();
  }
});

test("ExitPlanMode 走 approve/reject elicitation：reject 不会被当成批准", async () => {
  const responses: Array<Record<string, unknown>> = [];
  const acp = await startAcp((request, helpers) => {
    if (request.method === "session/create") return makeSnapshot(SID);
    if (request.method === "session/subscribe") {
      return { eventSeq: 0, events: [], sessionId: SID };
    }
    if (request.method === "v4/command") {
      const commandId = String(request.params.commandId);
      queueMicrotask(() => {
        helpers.notify(
          rawEvent({
            payload: { inputId: commandId, input: "plan", turnNumber: 1 },
            seq: 1,
            sessionId: SID,
            turnId: "turn-plan",
            type: "turn_started",
          }),
        );
        void helpers
          .request("srv-plan", "interaction/requestUserInput", {
            input: { plan: "1. add the flag\n2. cover it with a test" },
            requestId: "plan-1",
            schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
            sessionId: SID,
            toolName: "ExitPlanMode",
            turnId: "turn-plan",
          })
          .then((response) => {
            responses.push(response.result as Record<string, unknown>);
            helpers.notify(
              rawEvent({
                payload: { response: "plan settled", resultType: "completed" },
                seq: 2,
                sessionId: SID,
                turnId: "turn-plan",
                type: "turn_complete",
              }),
            );
          });
      });
      return v4AckAccepted(commandId);
    }
    return {};
  });
  try {
    await acp.request("initialize", {
      clientCapabilities: { elicitation: { form: {} } },
      protocolVersion: 1,
    });
    await acp.request("session/new", { cwd: "/tmp/ws", mcpServers: [] });
    const prompt = acp.request("session/prompt", {
      prompt: [{ text: "plan it", type: "text" }],
      sessionId: SID,
    });
    const elicitation = await nextAgentRequest(acp, "elicitation/create");
    const params = elicitation.params as {
      message: string;
      requestedSchema: { properties: Record<string, { enum?: string[] }> };
    };
    assert.match(params.message, /Approve this plan\?/);
    assert.match(params.message, /add the flag/, "计划正文要出现在 message 里");
    assert.deepEqual(params.requestedSchema.properties.decision?.enum, ["approve", "reject"]);

    // reject 必须是 decline：Auto/Full access 不能把"拒绝"读成批准。
    acp.respond(elicitation.id ?? "", {
      action: "accept",
      content: { decision: "reject" },
    });
    await prompt;
    assert.equal((responses[0] as { action?: string }).action, "decline");
  } finally {
    await acp.close();
  }
});
