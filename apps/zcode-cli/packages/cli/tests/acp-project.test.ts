// ACP 纯映射层的回归：prompt 文本、模式/模型选项、权限/计划/提问表单与事件投影。
// 这些是协议形状的唯一定义处，漂移必须在这里先红。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACP_BUILD_MODE,
  ACP_MODEL_CONFIG_ID,
  ACP_PLAN_MODE,
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
  promptBlocksToText,
  summarizeToolResult,
  toolKindForName,
} from "../src/acp/acp-project.js";

test("prompt blocks: text and resource links become one prompt", () => {
  const text = promptBlocksToText([
    { text: "Fix the bug", type: "text" },
    { name: "a.ts", type: "resource_link", uri: "file:///w/a.ts" },
  ]);
  assert.equal(text, "Fix the bug\n\n@/w/a.ts");
});

test("prompt blocks: images are rejected instead of silently dropped", () => {
  assert.throws(
    () =>
      promptBlocksToText([
        {
          data: "AAAA",
          mimeType: "image/png",
          type: "image",
        },
      ]),
    /does not accept image content/,
  );
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
