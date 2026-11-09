// 权限与 elicitation 的映射回归：这两条路径决定了"编辑器里点一下"到底
// 落在 core 的哪个决定上，弄错方向就是安全问题（把拒绝读成批准）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acpOutcomeToCoreResponse,
  acpResultToCoreUserInput,
  permissionRequestToAcp,
  userInputRequestToAcp,
} from "../src/acp/acp-interactions.js";

const sessionId = "sess-1";

const allowOnceResponse = {
  decision: "allow" as const,
  permissionUpdates: [
    {
      behavior: "allow",
      destination: "sessionSettings",
      rules: [{ ruleContent: "Bash(ls:*)", toolName: "Bash" }],
      type: "addRules",
    },
  ],
};
const denyResponse = { decision: "deny" as const, reason: "User said no" };

function permissionParams(
  overrides: Record<string, unknown> = {},
): Parameters<typeof permissionRequestToAcp>[0] {
  return {
    input: { command: "rm -rf build" },
    options: [
      { kind: "allow_always", label: "Always", name: "Always", response: { decision: "allow" } },
      { kind: "allow_once", label: "Once", name: "Once", response: allowOnceResponse },
      { kind: "deny", label: "Deny", name: "Deny", response: denyResponse },
    ],
    reason: "Bash needs approval",
    requestId: "perm-1",
    riskLevel: "high",
    sessionId,
    toolCallId: "tool-1",
    toolName: "Bash",
    turnId: "turn-1",
    ...overrides,
  } as unknown as Parameters<typeof permissionRequestToAcp>[0];
}

test("core 权限选项 → ACP：稳定 optionId，kind 只表达 allow/reject", () => {
  const translated = permissionRequestToAcp(permissionParams(), "acp-sess");
  assert.deepEqual(
    translated.params.options.map((option) => [option.optionId, option.kind]),
    [
      ["opt-0", "allow_always"],
      ["opt-1", "allow_once"],
      ["opt-2", "reject_once"],
    ],
  );
  assert.equal(translated.params.sessionId, "acp-sess");
  assert.equal(translated.params.toolCall.kind, "execute");
  assert.equal(translated.params.toolCall.status, "pending");
  assert.equal(translated.params.toolCall.title, "Bash: Bash needs approval");
  assert.deepEqual(translated.params.toolCall.rawInput, { command: "rm -rf build" });
});

test("选中的 optionId 回 core 的 option.response 原文（不重新解释）", () => {
  const translated = permissionRequestToAcp(permissionParams(), sessionId);
  const response = acpOutcomeToCoreResponse(
    { optionId: "opt-1", outcome: "selected" },
    translated,
  );
  assert.deepEqual(response, allowOnceResponse);
  assert.equal(response, allowOnceResponse, "必须是同一个对象，不能重建");
});

test("cancelled 与未知 optionId 落到 core 的 deny 选项原文", () => {
  const translated = permissionRequestToAcp(permissionParams(), sessionId);
  assert.deepEqual(acpOutcomeToCoreResponse({ outcome: "cancelled" }, translated), denyResponse);
  assert.deepEqual(
    acpOutcomeToCoreResponse({ optionId: "opt-99", outcome: "selected" }, translated),
    denyResponse,
  );
});

test("core 只给 allow 没有 deny 时，取消仍拒绝而不是放行", () => {
  const translated = permissionRequestToAcp(
    permissionParams({
      options: [{ kind: "allow_once", label: "Once", name: "Once", response: allowOnceResponse }],
    }),
    sessionId,
  );
  const response = acpOutcomeToCoreResponse({ outcome: "cancelled" }, translated);
  assert.notEqual(response, allowOnceResponse);
  assert.equal(response.decision, "deny");
});

const askUserQuestion = {
  input: {
    questions: [
      {
        header: "Runtime",
        multiSelect: false,
        options: [
          { description: "Ship on the runtime CI already has", label: "node", preview: "node --version" },
          { description: "Try the newer runtime", label: "bun" },
        ],
        question: "Which runtime?",
      },
      {
        header: "Checks",
        multiSelect: true,
        options: [
          { description: "Formatting check", label: "fmt" },
          { description: "Lint check", label: "lint" },
        ],
        question: "Which checks?",
      },
    ],
  },
  prompt: "Pick a runtime and checks",
  requestId: "ui-1",
  schema: { toolName: "AskUserQuestion" },
  sessionId,
  toolName: "AskUserQuestion",
  turnId: "turn-1",
};
type UserInputParams = Parameters<typeof userInputRequestToAcp>[0];

test("AskUserQuestion → 单选 enum、多选自由文本", () => {
  const translated = userInputRequestToAcp(askUserQuestion as UserInputParams, "acp-sess");
  assert.ok(translated && translated.kind === "ask_user_question");
  const properties = translated.params.requestedSchema.properties;
  assert.deepEqual(properties.q0?.enum, ["node", "bun"]);
  assert.equal(properties.q1?.enum, undefined);
  assert.match(String(properties.q1?.description), /commas/);
  assert.deepEqual(translated.params.requestedSchema.required, ["q0", "q1"]);
  assert.equal(translated.params.mode, "form");
  assert.equal(translated.params.message, "Pick a runtime and checks");
  assert.equal(translated.params.sessionId, "acp-sess");
});

test("多选答案按 TUI 同款 \", \" 归一，并回填 preview 注解", () => {
  const translated = userInputRequestToAcp(askUserQuestion as UserInputParams, sessionId);
  assert.ok(translated);
  const response = acpResultToCoreUserInput(
    {
      action: "accept",
      content: { q0: " node ", q1: "fmt ,,  lint ," },
    },
    translated,
  );
  assert.deepEqual(response, {
    action: "accept",
    content: {
      annotations: { "Which runtime?": { preview: "node --version" } },
      answers: { "Which checks?": "fmt, lint", "Which runtime?": "node" },
    },
  });
});

test("elicitation decline/cancel 直通 core，不编造答案", () => {
  const translated = userInputRequestToAcp(askUserQuestion as UserInputParams, sessionId);
  assert.ok(translated);
  assert.deepEqual(acpResultToCoreUserInput({ action: "decline" }, translated), {
    action: "decline",
  });
  assert.deepEqual(acpResultToCoreUserInput({ action: "cancel" }, translated), {
    action: "cancel",
  });
  // accept 但空内容 = 用户没填：按 decline 处理，不给 core 空 answers。
  assert.deepEqual(acpResultToCoreUserInput({ action: "accept", content: {} }, translated), {
    action: "decline",
    reason: "No answers submitted",
  });
});

test("ExitPlanMode → approve/reject，只有 approve 传得进 core", () => {
  const translated = userInputRequestToAcp(
    {
      input: { plan: "1. add flag\n2. test it" },
      prompt: "Plan ready",
      requestId: "plan-1",
      schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
      sessionId,
      toolName: "ExitPlanMode",
      turnId: "turn-1",
    } as UserInputParams,
    sessionId,
  );
  assert.ok(translated && translated.kind === "plan_approval");
  assert.deepEqual(translated.params.requestedSchema.properties.decision?.enum, [
    "approve",
    "reject",
  ]);
  assert.match(translated.params.message, /add flag/);

  assert.deepEqual(
    acpResultToCoreUserInput({ action: "accept", content: { decision: "approve" } }, translated),
    { action: "accept", content: { answer: "approve" } },
  );
  for (const decision of ["reject", "APPROVE", "", "yes"]) {
    assert.deepEqual(
      acpResultToCoreUserInput({ action: "accept", content: { decision } }, translated),
      { action: "decline", reason: "Plan rejected in ACP client" },
      `${JSON.stringify(decision)} 不能被当成批准`,
    );
  }
  assert.deepEqual(acpResultToCoreUserInput({ action: "cancel" }, translated), {
    action: "cancel",
  });
});

test("无法渲染的 interaction 返回 undefined（调用方 decline）", () => {
  assert.equal(
    userInputRequestToAcp(
      {
        input: { questions: [{ header: "x", options: [], question: "?" }] },
        requestId: "bad",
        sessionId,
        toolName: "AskUserQuestion",
        turnId: "turn-1",
      } as unknown as UserInputParams,
      sessionId,
    ),
    undefined,
    "非法 AskUserQuestion input 不猜问题",
  );
  assert.equal(
    userInputRequestToAcp(
      {
        input: { url: "https://example.com/auth" },
        requestId: "other",
        schema: { interaction: "mcp_elicitation" },
        sessionId,
        toolName: "SomeMcpTool",
        turnId: "turn-1",
      } as unknown as UserInputParams,
      sessionId,
    ),
    undefined,
    "MCP elicitation 不接管",
  );
});
