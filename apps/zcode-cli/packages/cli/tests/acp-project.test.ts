// ACP 纯映射层的回归：prompt 文本、模式/模型选项、权限/计划/提问表单与事件投影。
// 这些是协议形状的唯一定义处，漂移必须在这里先红。
import assert from "node:assert/strict";
import test from "node:test";
import { RequestError, type ContentBlock } from "@agentclientprotocol/sdk";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  ACP_BUILD_MODE,
  ACP_MODEL_CONFIG_ID,
  ACP_PLAN_MODE,
  ACP_THOUGHT_LEVEL_CONFIG_ID,
  AcpEventProjector,
  answersFromElicitationContent,
  buildConfigOptions,
  buildModeState,
  buildPlanApprovalForm,
  buildQuestionForm,
  coreModeToAcpMode,
  isAskUserQuestionInput,
  permissionOptionsForCore,
  permissionResultForAcpOption,
  planApprovalResult,
  promptBlocksToInput,
  summarizeToolResult,
  toolKindForName,
} from "../src/acp/acp-project.js";

test("prompt blocks: text and resource links become one prompt", () => {
  const input = promptBlocksToInput([
    { text: "Fix the bug", type: "text" },
    { name: "a.ts", type: "resource_link", uri: "file:///w/a.ts" },
  ]);
  assert.deepEqual(input, { attachments: [], text: "Fix the bug\n\n@/w/a.ts" });
});

test("prompt blocks: inline images preserve order beside text and embedded resources", () => {
  const data = Buffer.from("transport fixture, not decoded image").toString("base64");
  const formats = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
  const input = promptBlocksToInput([
    { text: "inspect", type: "text" },
    ...formats.map((mimeType) => ({ data, mimeType, type: "image" as const, uri: "file:///not-opened" })),
    { resource: { text: "extra context", uri: "file:///context.txt" }, type: "resource" },
    { name: "code.ts", type: "resource_link", uri: "file:///code.ts" },
  ]);
  assert.equal(input.text, "inspect\n\nextra context\n\n@/code.ts");
  assert.deepEqual(input.attachments, formats.map((mime, index) => ({
    content: `data:${mime};base64,${data}`,
    path: `@acp-image-${index + 1}.${["png", "jpg", "gif", "webp"][index]}`,
    type: "image",
  })));
  assert.equal(promptBlocksToInput([{ data, mimeType: "image/png", type: "image" }]).text, "");
});

test("prompt blocks: invalid image data and audio fail as invalid params without leaking data", () => {
  const badBlocks: ContentBlock[] = [
    { data: "", mimeType: "image/png", type: "image" },
    { data: "private-image-sentinel", mimeType: "image/png", type: "image" },
    { data: "YQ", mimeType: "image/png", type: "image" },
    { data: "YR==", mimeType: "image/png", type: "image" },
    { data: "YQ==\n", mimeType: "image/png", type: "image" },
    { data: "YQ==", mimeType: "text/plain", type: "image" },
    { data: "YQ==", mimeType: "image/svg+xml", type: "image" },
    { data: "YQ==", mimeType: "audio/wav", type: "audio" },
  ];
  for (const block of badBlocks) {
    assert.throws(() => promptBlocksToInput([block]), (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32602);
      assert.doesNotMatch(error.message, /private-image-sentinel/);
      return true;
    });
  }
});

test("prompt blocks: shared byte cap rejects oversized images before uploads", () => {
  const maxBytes = PROTOCOL_V4_LIMITS.attachmentMaxBytes;
  const maxEncoded = Math.ceil(maxBytes / 3) * 4;
  // 两种边界：编码长度已超限，或编码长度刚好但解码后多一字节。
  for (const data of ["A".repeat(maxEncoded + 4), Buffer.alloc(maxBytes + 1).toString("base64")]) {
    assert.throws(() => promptBlocksToInput([{ data, mimeType: "image/png", type: "image" }]),
      (error: unknown) => error instanceof RequestError && error.code === -32602);
  }
});

test("modes: only plan is distinct, everything else is build", () => {
  assert.equal(coreModeToAcpMode("plan"), ACP_PLAN_MODE);
  assert.equal(coreModeToAcpMode("yolo"), ACP_BUILD_MODE);
  const state = buildModeState("plan");
  assert.equal(state.currentModeId, ACP_PLAN_MODE);
  assert.deepEqual(
    state.availableModes.map((mode) => mode.id),
    [ACP_PLAN_MODE, ACP_BUILD_MODE],
  );
});

test("model config option: current ref and enabled models only", () => {
  const options = buildConfigOptions({
    available: [
      {
        label: "GLM-5",
        ref: { modelId: "glm-5", providerId: "zhipu" },
      },
      {
        disabledReason: "unavailable",
        label: "Broken",
        ref: { modelId: "broken", providerId: "zhipu" },
      },
    ],
    current: { modelId: "glm-5", providerId: "zhipu" },
  });
  assert.equal(options.length, 1);
  const option = options[0];
  assert.equal(option.id, ACP_MODEL_CONFIG_ID);
  assert.equal(option.type, "select");
  if (option.type !== "select") return;
  assert.equal(option.currentValue, "zhipu/glm-5");
  assert.deepEqual(
    option.options.map((entry) => entry.value),
    ["zhipu/glm-5"],
  );
});

const reasoning = (values: string[], defaultLevel?: string) => ({
  defaultLevel,
  levels: values.map((value) => ({ label: value.toUpperCase(), value })),
});

test("thought level config: current model reasoning drives choices, not the union", () => {
  const options = buildConfigOptions(
    {
      available: [
        {
          label: "GLM-5",
          reasoning: {
            defaultLevel: "high",
            levels: [
              { description: "Light reasoning", label: "Low", value: "low" },
              { label: "High", value: "high" },
            ],
          },
          ref: { modelId: "glm-5", providerId: "zhipu" },
        },
      ],
      current: { modelId: "glm-5", providerId: "zhipu" },
    },
    {
      available: [
        { label: "LOW", value: "low" },
        { label: "HIGH", value: "high" },
        { label: "TURBO", value: "turbo" },
      ],
      current: "high",
      enabled: true,
    },
  );
  const effort = options.find((option) => option.id === ACP_THOUGHT_LEVEL_CONFIG_ID);
  assert.equal(effort?.type, "select");
  assert.equal(effort?.category, "thought_level");
  assert.equal(effort?.name, "Reasoning effort");
  if (effort?.type !== "select") return;
  assert.equal(effort.currentValue, "high");
  assert.deepEqual(
    effort.options.map((entry) => "value" in entry && entry.value),
    ["low", "high"],
  );
  assert.deepEqual(
    effort.options.map((entry) => "value" in entry && [entry.name, entry.description]),
    [
      ["Low", "Light reasoning"],
      ["High", undefined],
    ],
  );
});

test("thought level config: current falls back through snapshot then model defaults", () => {
  const model = {
    label: "GLM-5",
    reasoning: reasoning(["low", "medium", "high"], "medium"),
    ref: { modelId: "glm-5", providerId: "zhipu" },
  };
  const settings = { available: [model], current: model.ref };
  const effortValue = (thought: { current?: string; defaultLevel?: string }) =>
    buildConfigOptions(settings, { available: [], enabled: true, ...thought })
      .find((option) => option.id === ACP_THOUGHT_LEVEL_CONFIG_ID);
  const currentOf = (thought: { current?: string; defaultLevel?: string }) => {
    const option = effortValue(thought);
    return option?.type === "select" ? option.currentValue : undefined;
  };
  assert.equal(currentOf({ current: "low" }), "low");
  assert.equal(currentOf({ defaultLevel: "high" }), "high");
  assert.equal(currentOf({}), "medium");
  assert.equal(currentOf({ current: "stale", defaultLevel: "gone" }), "medium");
});

test("thought level config: a sole supported level becomes the current value", () => {
  const options = buildConfigOptions(
    {
      available: [
        {
          label: "Tiny",
          reasoning: reasoning(["only"]),
          ref: { modelId: "tiny", providerId: "local" },
        },
      ],
      current: { modelId: "tiny", providerId: "local" },
    },
    { available: [], enabled: true },
  );
  const effort = options.find((option) => option.id === ACP_THOUGHT_LEVEL_CONFIG_ID);
  if (effort?.type !== "select") throw new Error("expected a select option");
  assert.equal(effort.currentValue, "only");
});

test("thought level config: omitted when disabled, unlevelled, or the current model is absent", () => {
  const model = {
    label: "GLM-5",
    reasoning: reasoning(["low", "high"]),
    ref: { modelId: "glm-5", providerId: "zhipu" },
  };
  const settings = { available: [model], current: model.ref };
  const ids = (options: ReturnType<typeof buildConfigOptions>) =>
    options.map((option) => option.id);
  assert.deepEqual(
    ids(buildConfigOptions(settings, { available: [], enabled: false, current: "low" })),
    [ACP_MODEL_CONFIG_ID],
  );
  assert.deepEqual(
    ids(buildConfigOptions({ available: [{ ...model, reasoning: undefined }], current: model.ref },
      { available: [], enabled: true })),
    [ACP_MODEL_CONFIG_ID],
  );
  assert.deepEqual(
    ids(buildConfigOptions({ available: [{ ...model, reasoning: reasoning([]) }], current: model.ref },
      { available: [], enabled: true })),
    [ACP_MODEL_CONFIG_ID],
  );
  assert.deepEqual(
    ids(buildConfigOptions({ available: [model], current: undefined },
      { available: [], enabled: true, current: "low" })),
    [ACP_MODEL_CONFIG_ID],
  );
  assert.deepEqual(
    ids(buildConfigOptions(settings, undefined)),
    [ACP_MODEL_CONFIG_ID],
  );
  const multi = buildConfigOptions(
    {
      available: [
        { ...model, reasoning: reasoning(["a", "b"]) },
      ],
      current: model.ref,
    },
    { available: [], current: "nope", enabled: true },
  );
  const effort = multi.find((option) => option.id === ACP_THOUGHT_LEVEL_CONFIG_ID);
  assert.equal(effort?.type === "select" ? effort.currentValue : "missing", "a");
});

test("thought level config: same modelId on another provider picks the exact catalog entry", () => {
  const options = buildConfigOptions(
    {
      available: [
        {
          label: "GLM-5 zhipu",
          reasoning: reasoning(["low", "high"], "high"),
          ref: { modelId: "glm-5", providerId: "zhipu" },
        },
        {
          label: "GLM-5 other",
          reasoning: reasoning(["x"], "x"),
          ref: { modelId: "glm-5", providerId: "other" },
        },
      ],
      current: { modelId: "glm-5", providerId: "other" },
    },
    { available: [], enabled: true },
  );
  const effort = options.find((option) => option.id === ACP_THOUGHT_LEVEL_CONFIG_ID);
  if (effort?.type !== "select") throw new Error("expected a select option");
  assert.deepEqual(
    effort.options.map((entry) => "value" in entry && entry.value),
    ["x"],
  );
  assert.equal(effort.currentValue, "x");
});

test("permissions: option ids round-trip to core decisions", () => {
  const core = [
    { kind: "allow_once" },
    { kind: "allow_always", response: { permissionUpdates: [{ kind: "rule" }] } },
    { kind: "deny" },
  ];
  const options = permissionOptionsForCore(core);
  assert.deepEqual(
    options.map((option) => [option.optionId, option.kind]),
    [
      ["core-option-0", "allow_once"],
      ["core-option-1", "allow_always"],
      ["core-option-2", "reject_once"],
    ],
  );
  assert.deepEqual(permissionResultForAcpOption(core, "core-option-0"), {
    decision: "allow",
  });
  assert.deepEqual(permissionResultForAcpOption(core, "core-option-1"), {
    decision: "allow",
    permissionUpdates: [{ kind: "rule" }],
  });
  assert.equal(permissionResultForAcpOption(core, "core-option-2").decision, "deny");
  assert.equal(permissionResultForAcpOption(core, undefined).decision, "deny");
});

test("questions: single select uses a string enum, multi select is typed text", () => {
  const form = buildQuestionForm({
    questions: [
      {
        header: "Scope",
        options: [
          { description: "Only this file", label: "Single file", preview: "Example change" },
          { description: "All files", label: "Whole repo" },
        ],
        question: "Which scope?",
      },
      {
        header: "Checks",
        multiSelect: true,
        options: [
          { description: "Run tests", label: "Tests" },
          { description: "Run lint", label: "Lint" },
        ],
        question: "Which checks?",
      },
    ],
  });
  const schema = form.requestedSchema;
  assert.deepEqual(schema.required, ["q0", "q1"]);
  const single = schema.properties?.q0 as Record<string, unknown>;
  assert.deepEqual(single.enum, ["Single file", "Whole repo"]);
  assert.match(String(single.description), /Single file: Only this file\nExample change/);
  assert.equal(single.type, "string");
  assert.equal(single.title, "Scope");
  const multi = schema.properties?.q1 as Record<string, unknown>;
  assert.equal(multi.type, "string");
  assert.equal(multi.enum, undefined);
  assert.match(String(multi.description), /Comma-separated values/);
  assert.match(String(multi.description), /Tests: Run tests/);
  assert.equal(form.questions[0]?.multiSelect, false);
  assert.deepEqual(answersFromElicitationContent(form.questions, { q0: "Whole repo", q1: "Tests, Lint" }), {
    "Which checks?": "Tests, Lint",
    "Which scope?": "Whole repo",
  });
});

test("questions: malformed core input fails loudly before creating an elicitation", () => {
  const question = {
    header: "Scope",
    options: [
      { description: "One file", label: "Single" },
      { description: "All files", label: "Repo" },
    ],
    question: "Which scope?",
  };
  assert.equal(isAskUserQuestionInput({ questions: [question] }), true);
  const invalidInputs: unknown[] = [
    null,
    {},
    { questions: [] },
    { questions: [null] },
    { questions: [{ ...question, options: undefined }] },
    { questions: [{ ...question, options: [question.options[0]] }] },
    { questions: [{ ...question, options: [{ label: "Single" }, { label: "Repo" }] }] },
    { questions: [{ ...question, options: question.options.map((option) => ({ ...option, value: "old" })) }] },
    { questions: [{ ...question, options: [question.options[0], question.options[0]] }] },
    { questions: [question, question] },
    { questions: [{ ...question, multiSelect: "yes" }] },
    { questions: [{ ...question, options: [
      { ...question.options[0], preview: "<script>alert(1)</script>" },
      question.options[1],
    ] }] },
  ];
  for (const input of invalidInputs) {
    assert.equal(isAskUserQuestionInput(input), false);
    assert.throws(() => buildQuestionForm(input), /Invalid AskUserQuestion input:/);
  }
});

test("plan approval: explicit approve/reject only", () => {
  const form = buildPlanApprovalForm("Do the thing");
  assert.deepEqual(form.requestedSchema.properties?.decision, {
    description:
      "Approve the plan to start implementing it, or reject to keep planning.",
    enum: ["approve", "reject"],
    title: "Plan approval",
    type: "string",
  });
  assert.deepEqual(planApprovalResult({ decision: "approve" }), { decision: "allow" });
  assert.equal(planApprovalResult({ decision: "reject" }).decision, "deny");
  assert.equal(planApprovalResult({}).decision, "deny");
});

test("tool kinds map to ACP categories", () => {
  assert.equal(toolKindForName("Bash"), "execute");
  assert.equal(toolKindForName("Read"), "read");
  assert.equal(toolKindForName("Grep"), "search");
  assert.equal(toolKindForName("UnknownTool"), "other");
});

test("tool results are summarized, not dumped unbounded", () => {
  assert.equal(summarizeToolResult({ content: "ok" }), "ok");
  assert.equal(summarizeToolResult([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(summarizeToolResult({}), undefined);
  assert.equal(summarizeToolResult("x".repeat(20), 5), "xxxxx…");
});

test("event projection: text streams, tool lifecycle, mode change", () => {
  const projector = new AcpEventProjector();
  assert.deepEqual(
    projector.project({
      payload: { delta: "hi", kind: "text_delta" },
      type: "model_streaming",
    }),
    [
      {
        content: { text: "hi", type: "text" },
        messageId: undefined,
        sessionUpdate: "agent_message_chunk",
      },
    ],
  );
  assert.deepEqual(
    projector.project({
      payload: { delta: "why", kind: "reasoning_delta" },
      type: "model_streaming",
    })[0]?.sessionUpdate,
    "agent_thought_chunk",
  );
  const scheduled = projector.project({
    payload: {
      input: { command: "ls" },
      toolCallId: "t1",
      toolName: "Bash",
    },
    type: "tool_call_scheduled",
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.sessionUpdate, "tool_call");
  const started = projector.project({
    payload: { toolCallId: "t1", toolName: "Bash" },
    type: "tool_call_started",
  });
  assert.equal(started[0]?.sessionUpdate, "tool_call_update");
  assert.deepEqual((started[0] as { rawInput?: unknown }).rawInput, { command: "ls" });
  const completed = projector.project({
    payload: { result: { content: "file.txt" }, toolCallId: "t1" },
    type: "tool_call_result",
  });
  assert.equal((completed[0] as { status?: string }).status, "completed");
  assert.deepEqual(
    projector.project({
      payload: { mode: "plan" },
      type: "session_mode_changed",
    }),
    [{ currentModeId: "plan", sessionUpdate: "current_mode_update" }],
  );
  assert.equal(
    projector.project({ payload: {}, type: "turn_error" })[0]?.sessionUpdate,
    "notice",
  );
});

test("mode events: the plan overlay overrides the collaboration mode", () => {
  const projector = new AcpEventProjector();
  for (const [payload, currentModeId] of [
    [{ mode: "default", planEnabled: true }, "plan"],
    [{ mode: "yolo", planEnabled: true }, "plan"],
    [{ mode: "default", planEnabled: false }, "build"],
    [{ mode: "yolo", planEnabled: false }, "build"],
    [{ mode: "plan" }, "plan"],
    [{ mode: "default" }, "build"],
  ] as const) {
    assert.deepEqual(projector.project({ payload, type: "session_mode_changed" }), [
      { currentModeId, sessionUpdate: "current_mode_update" },
    ]);
  }
});

const todo = { content: "Run checks", priority: "high", status: "in_progress" } as const;

function todoResult(todos: readonly (typeof todo)[]) {
  return {
    content: JSON.stringify({
      oldTodos: [],
      summary: { total: todos.length, pending: 0, inProgress: todos.length, completed: 0 },
      todos,
    }),
    success: true,
  };
}

function scheduleTodoWrite(projector: AcpEventProjector, toolCallId: string) {
  return projector.project({
    payload: {
      input: { todos: [{ ...todo, content: "Scheduled draft" }] },
      toolCallId,
      toolName: "TodoWrite",
    },
    type: "tool_call_scheduled",
  });
}

test("live TodoWrite: committed result projects a plan before turn completion", () => {
  const projector = new AcpEventProjector();
  assert.equal(scheduleTodoWrite(projector, "todo-1").length, 1);
  projector.project({ payload: { toolCallId: "todo-1" }, type: "tool_call_started" });
  const updates = projector.project({
    payload: { result: todoResult([todo]), toolCallId: "todo-1" },
    type: "tool_call_result",
  });
  assert.equal(updates[0]?.sessionUpdate, "tool_call_update");
  assert.deepEqual(updates[1], { entries: [todo], sessionUpdate: "plan" });
  assert.deepEqual(projector.projectTodos([todo]), []);
  scheduleTodoWrite(projector, "todo-same");
  assert.equal(projector.project({
    payload: { result: todoResult([todo]), toolCallId: "todo-same" },
    type: "tool_call_result",
  }).length, 1);

  scheduleTodoWrite(projector, "todo-2");
  const cleared = projector.project({
    payload: { result: todoResult([]), toolCallId: "todo-2" },
    type: "tool_call_result",
  });
  assert.deepEqual(cleared[1], { entries: [], sessionUpdate: "plan" });
  assert.deepEqual(projector.projectTodos([]), []);
  assert.deepEqual(projector.projectTodos([todo]), [{ entries: [todo], sessionUpdate: "plan" }]);
});

test("plan snapshots: absence is ignored, an explicit empty checklist is projected once", () => {
  const projector = new AcpEventProjector();
  assert.deepEqual(projector.projectTodos(undefined), []);
  assert.deepEqual(projector.projectTodos([]), [{ entries: [], sessionUpdate: "plan" }]);
  assert.deepEqual(projector.projectTodos(undefined), []);
  assert.deepEqual(projector.projectTodos([]), []);
});

test("live TodoWrite: malformed successful results fail loudly", () => {
  for (const result of [
    { content: "not JSON", success: true },
    { content: JSON.stringify({ todos: [{ ...todo, status: "invalid" }] }), success: true },
    { success: true },
  ]) {
    const projector = new AcpEventProjector();
    scheduleTodoWrite(projector, "todo-bad");
    assert.throws(() => projector.project({
      payload: { result, toolCallId: "todo-bad" },
      type: "tool_call_result",
    }));
  }
});

test("live TodoWrite: failed and unrelated results do not invent plan state", () => {
  const projector = new AcpEventProjector();
  for (const result of [
    { ...todoResult([todo]), success: false },
  ]) {
    scheduleTodoWrite(projector, "todo-bad");
    assert.equal(projector.project({
      payload: { result, toolCallId: "todo-bad" },
      type: "tool_call_result",
    }).length, 1);
  }
  scheduleTodoWrite(projector, "todo-error");
  assert.equal(projector.project({
    payload: { error: { message: "Failed" }, toolCallId: "todo-error" },
    type: "tool_call_error",
  }).length, 1);
  projector.project({
    payload: { toolCallId: "read", toolName: "Read" },
    type: "tool_call_scheduled",
  });
  for (const toolCallId of ["read", "unknown", "todo-error", "todo-bad"]) {
    assert.equal(projector.project({
      payload: { result: todoResult([todo]), toolCallId },
      type: "tool_call_result",
    }).length, 1);
  }
  assert.deepEqual(projector.projectTodos([todo]), [{ entries: [todo], sessionUpdate: "plan" }]);
});
