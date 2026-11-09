// ACP v1 线格式一致性：官方 SDK（@zed-industries/agent-client-protocol）的 zod
// schema 当裁判，检查我们**发出**的每个形状，以及我们**接受**的应答形状。
//
// SDK 只作为 devDependency 的"参照实现"使用，不参与运行时（见 docs/design/v2/
// acp-frontend.md 的 SDK 评估：0.4.5 缺 resume/close/elicitation/set_config_option，
// 且 AgentSideConnection 只把 `_` 前缀方法路由给扩展）。
//
// 这个文件的价值在回归：扁平 { outcome: "selected" } 曾经看起来完全合理，但 v1 的
// RequestPermissionResponse 是双层 { outcome: { outcome: "selected", optionId } }。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contentBlockSchema,
  initializeResponseSchema,
  newSessionResponseSchema,
  promptRequestSchema,
  promptResponseSchema,
  requestPermissionRequestSchema,
  requestPermissionResponseSchema,
  sessionNotificationSchema,
} from "@zed-industries/agent-client-protocol";
import {
  ACP_PROTOCOL_VERSION,
  acpElicitationResultSchema,
  acpPermissionResponseSchema,
} from "../src/acp/acp-protocol.js";
import { AcpUpdateProjector } from "../src/acp/acp-updates.js";
import {
  acpOutcomeToCoreResponse,
  permissionRequestToAcp,
} from "../src/acp/acp-interactions.js";
import type { SessionEvent } from "../src/attach/attach-session.js";

type Zodish = { safeParse: (value: unknown) => { success: boolean; error?: unknown } };

function expectValid(schema: Zodish, value: unknown, label: string): void {
  const result = schema.safeParse(value);
  assert.ok(
    result.success,
    `${label} 不符合 ACP v1 schema: ${JSON.stringify(result.error)?.slice(0, 800)}`,
  );
}

const sessionId = "sess-1";

function event(overrides: Record<string, unknown> & { type: string }): SessionEvent {
  return {
    id: `evt-${String(overrides.seq ?? 0)}`,
    payload: {},
    sessionId,
    ...overrides,
  } as unknown as SessionEvent;
}

/** 用投影器把一串 core 事件变成 update，并逐条按 v1 schema 校验。 */
function projectEvents(events: SessionEvent[]): Array<Record<string, unknown>> {
  const emitted: Array<Record<string, unknown>> = [];
  const projector = new AcpUpdateProjector((update) => {
    emitted.push(update as unknown as Record<string, unknown>);
  });
  for (const item of events) projector.ingest(item);
  for (const update of emitted) {
    expectValid(
      sessionNotificationSchema,
      { sessionId, update },
      `session/update ${String(update.sessionUpdate)}`,
    );
  }
  return emitted;
}

test("session/update 的每个变体都符合 v1 schema", () => {
  const updates = projectEvents([
    event({ seq: 1, turnId: "turn-1", type: "turn_started" }),
    event({
      payload: { delta: "planning", kind: "reasoning_delta" },
      seq: 2,
      turnId: "turn-1",
      type: "model_streaming",
    }),
    event({
      payload: { delta: "hello", kind: "text_delta" },
      seq: 3,
      turnId: "turn-1",
      type: "model_streaming",
    }),
    event({
      payload: {
        input: { command: "ls" },
        toolCallId: "tool-1",
        toolName: "Bash",
      },
      seq: 4,
      turnId: "turn-1",
      type: "tool_call_scheduled",
    }),
    event({
      payload: { toolCallId: "tool-1", toolName: "Bash" },
      seq: 5,
      turnId: "turn-1",
      type: "tool_call_started",
    }),
    event({
      payload: {
        result: { content: "ok", success: true },
        toolCallId: "tool-1",
        toolName: "Bash",
      },
      seq: 6,
      turnId: "turn-1",
      type: "tool_call_result",
    }),
  ]);
  const kinds = updates.map((update) => update.sessionUpdate);
  assert.deepEqual(kinds, [
    "agent_thought_chunk",
    "agent_message_chunk",
    "tool_call",
    "tool_call_update",
    "tool_call_update",
  ]);
  // 工具块必须带 kind/status，否则编辑器只能显示一个空壳。
  const toolCall = updates[2];
  assert.equal(toolCall?.kind, "execute");
  assert.equal(toolCall?.status, "pending");
  assert.equal(toolCall?.title, "Bash: ls");
});

test("initialize / session/new / session/prompt 的应答符合 v1 schema", () => {
  expectValid(
    initializeResponseSchema,
    {
      agentCapabilities: {
        promptCapabilities: { audio: false, embeddedContext: false, image: false },
        sessionCapabilities: { close: {}, resume: {} },
      },
      agentInfo: { name: "piz", version: "1.2.3" },
      authMethods: [],
      protocolVersion: ACP_PROTOCOL_VERSION,
    },
    "initialize",
  );

  expectValid(
    newSessionResponseSchema,
    {
      configOptions: [
        {
          category: "model",
          currentValue: "zai/glm-4.6",
          id: "model",
          name: "Model",
          options: [{ name: "glm-4.6", value: "zai/glm-4.6" }],
          type: "select",
        },
      ],
      modes: {
        availableModes: [
          { description: "Plan before you build", id: "plan", name: "Plan" },
          { description: "Edit files", id: "build", name: "Build" },
        ],
        currentModeId: "build",
      },
      sessionId,
    },
    "session/new",
  );

  for (const stopReason of ["end_turn", "cancelled", "max_tokens", "refusal"]) {
    expectValid(
      promptResponseSchema,
      {
        stopReason,
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
      `session/prompt ${stopReason}`,
    );
  }
});

test("v1 的 prompt 参数（含非文本块）能被我们的 schema 接受", () => {
  // 客户端发来的 prompt：文本块正常，图片/音频块拒绝（我们声明不支持）。
  expectValid(
    promptRequestSchema,
    { prompt: [{ text: "hi", type: "text" }], sessionId },
    "prompt request",
  );
  expectValid(contentBlockSchema, { text: "hi", type: "text" }, "text block");
});

test("权限请求：我们发出的 request 与接受的 response 都是 v1 双层形状", () => {
  const translated = permissionRequestToAcp(
    {
      options: [
        {
          kind: "allow_once",
          label: "Allow once",
          name: "Allow once",
          response: { decision: "allow" },
        },
        {
          kind: "deny",
          label: "Deny",
          name: "Deny",
          response: { decision: "deny" },
        },
      ],
      requestId: "perm-1",
      riskLevel: "low",
      sessionId,
      toolCallId: "tool-1",
      toolName: "Bash",
      turnId: "turn-1",
    } as unknown as Parameters<typeof permissionRequestToAcp>[0],
    sessionId,
  );
  expectValid(requestPermissionRequestSchema, translated.params, "session/request_permission");

  // 应答：result = { outcome: { outcome: "selected", optionId } }。
  expectValid(
    requestPermissionResponseSchema,
    { outcome: { optionId: "opt-0", outcome: "selected" } },
    "permission response (nested)",
  );
  const parsed = acpPermissionResponseSchema.safeParse({
    outcome: { optionId: "opt-0", outcome: "selected" },
  });
  assert.ok(parsed.success);
  assert.deepEqual(
    acpOutcomeToCoreResponse(parsed.data.outcome, translated),
    { decision: "allow" },
  );

  // 扁平形状不合规，必须被判为"没选"→ core 的 deny 选项（拒绝方向）。
  assert.equal(
    acpPermissionResponseSchema.safeParse({ optionId: "opt-0", outcome: "selected" }).success,
    false,
  );
  assert.deepEqual(acpOutcomeToCoreResponse({ outcome: "cancelled" }, translated), {
    decision: "deny",
  });
});

test("elicitation 应答 schema 与 v1 一致", () => {
  for (const action of ["accept", "decline", "cancel"]) {
    assert.ok(acpElicitationResultSchema.safeParse({ action }).success, action);
  }
  // 未知 action 不能猜成 accept。
  assert.equal(acpElicitationResultSchema.safeParse({ action: "ok" }).success, false);
});
