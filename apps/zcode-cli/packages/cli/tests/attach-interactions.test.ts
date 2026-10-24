import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionBrokerResult } from "@zcode/contracts";
import {
  zcodePermissionResponseSchema,
  zcodeUserInputResponseSchema,
  type ZCodePermissionOption,
  type ZCodePermissionRequestParams,
  type ZCodeUserInputRequestParams,
} from "@zcode/shared";
import {
  brokerResultToPermissionResponse,
  brokerResultToUserInputResponse,
  permissionParamsToBrokerRequest,
  userInputParamsToBrokerRequest,
} from "../src/attach/attach-interactions.js";

const ALLOW_ONCE_OPTION: ZCodePermissionOption = {
  kind: "allow_once",
  name: "Allow once",
  optionId: "allow_once",
  response: { decision: "allow", reason: "Approved once" },
};
const DENY_OPTION: ZCodePermissionOption = {
  kind: "deny",
  name: "Deny",
  optionId: "deny",
  response: {
    decision: "deny",
    reason: "The user doesn't want to proceed with this tool use.",
  },
};
const ALLOW_ALWAYS_OPTION: ZCodePermissionOption = {
  description: "Do not ask again for matching requests in this project",
  kind: "allow_always",
  name: "Always allow in this project",
  optionId: "allow_project",
  response: {
    decision: "allow",
    permissionUpdates: [
      {
        behavior: "allow",
        rules: [{ ruleContent: "ls", toolName: "Bash" }],
        type: "addRules",
      },
    ],
    reason: "Approved for this project",
  },
};

const PERMISSION_PARAMS: ZCodePermissionRequestParams = {
  input: { command: "rm -rf /tmp/x" },
  options: [ALLOW_ONCE_OPTION, ALLOW_ALWAYS_OPTION, DENY_OPTION],
  reason: "Bash requires approval",
  requestId: "req-1",
  riskLevel: "high",
  sessionId: "sess-1",
  toolCallId: "tool-1",
  toolName: "Bash",
  turnId: "turn-1",
};

test("permissionParamsToBrokerRequest: 全量选项 → 无 approvalMode", () => {
  const request = permissionParamsToBrokerRequest(PERMISSION_PARAMS, "build");
  assert.equal(request.approvalMode, undefined);
  assert.equal(request.toolName, "Bash");
  assert.equal(request.requestId, "req-1");
  assert.equal(request.riskLevel, "high");
  assert.deepEqual(request.suggestedPermissionUpdates, [
    {
      behavior: "allow",
      rules: [{ ruleContent: "ls", toolName: "Bash" }],
      type: "addRules",
    },
  ]);
});

test("permissionParamsToBrokerRequest: 仅 allow_once+deny → user-once", () => {
  const request = permissionParamsToBrokerRequest(
    { ...PERMISSION_PARAMS, options: [ALLOW_ONCE_OPTION, DENY_OPTION] },
    "plan",
  );
  assert.equal(request.approvalMode, "user-once");
  assert.equal(request.suggestedPermissionUpdates, undefined);
});

test("brokerResultToPermissionResponse: deny → 回 deny option 原文", () => {
  const result: PermissionBrokerResult = {
    decision: "deny",
    reason: "Denied in TUI",
    resolvedAt: new Date(),
  };
  const response = brokerResultToPermissionResponse(result, PERMISSION_PARAMS.options);
  assert.deepEqual(response, DENY_OPTION.response);
  // strict schema：resolvedAt 等内部字段绝不能进应答。
  assert.equal(zcodePermissionResponseSchema.safeParse(response).success, true);
});

test("brokerResultToPermissionResponse: allow_once → 回 allow_once option 原文", () => {
  const result: PermissionBrokerResult = {
    decision: "allow",
    reason: "Approved in TUI",
    resolvedAt: new Date(),
  };
  const response = brokerResultToPermissionResponse(result, PERMISSION_PARAMS.options);
  assert.deepEqual(response, ALLOW_ONCE_OPTION.response);
  assert.equal(zcodePermissionResponseSchema.safeParse(response).success, true);
});

test("brokerResultToPermissionResponse: allow_project → 回 allow_always option 原文（含服务端 permissionUpdates）", () => {
  const result: PermissionBrokerResult = {
    decision: "allow",
    permissionUpdates: [
      // 客户端本地猜的规则；wire 应答必须回服务端的权威版本。
      { behavior: "allow", rules: [{ toolName: "Bash" }], type: "addRules" },
    ],
    reason: "Approved for this project in TUI",
    resolvedAt: new Date(),
  };
  const response = brokerResultToPermissionResponse(result, PERMISSION_PARAMS.options);
  assert.deepEqual(response, ALLOW_ALWAYS_OPTION.response);
  assert.equal(zcodePermissionResponseSchema.safeParse(response).success, true);
});

test("brokerResultToPermissionResponse: options 缺匹配时降级为 schema 合法应答", () => {
  const result: PermissionBrokerResult = {
    decision: "deny",
    reason: "Denied in TUI",
    resolvedAt: new Date(),
  };
  const response = brokerResultToPermissionResponse(result, [ALLOW_ONCE_OPTION]);
  assert.deepEqual(response, { decision: "deny", reason: "Denied in TUI" });
  assert.equal(zcodePermissionResponseSchema.safeParse(response).success, true);
});

const ASK_QUESTION_PARAMS: ZCodeUserInputRequestParams = {
  input: {
    questions: [
      {
        header: "Auth method",
        options: [
          { description: "JWT tokens", label: "JWT" },
          { description: "Session cookies", label: "Session" },
        ],
        question: "Which auth method?",
      },
    ],
  },
  prompt: "The agent needs clarification",
  questions: [
    {
      header: "Auth method",
      options: [
        { description: "JWT tokens", label: "JWT", value: "JWT" },
        { description: "Session cookies", label: "Session", value: "Session" },
      ],
      question: "Which auth method?",
    },
  ],
  requestId: "req-q1",
  schema: { toolName: "AskUserQuestion" },
  sessionId: "sess-1",
  toolCallId: "tool-q1",
  toolName: "AskUserQuestion",
};

test("userInputParamsToBrokerRequest: AskUserQuestion → question wizard 请求", () => {
  const translated = userInputParamsToBrokerRequest(ASK_QUESTION_PARAMS, "build");
  assert.equal(translated?.kind, "ask_user_question");
  assert.equal(translated?.request.toolName, "AskUserQuestion");
  assert.deepEqual(translated?.request.input, ASK_QUESTION_PARAMS.input);
  assert.equal(translated?.request.reason, "The agent needs clarification");
});

test("userInputParamsToBrokerRequest: plan_approval → 普通审批面板（user-once）", () => {
  const translated = userInputParamsToBrokerRequest(
    {
      input: { plan: "do x" },
      prompt: "Review this plan",
      questions: [
        {
          header: "Plan",
          options: [
            {
              description: "Exit plan mode and start implementation.",
              label: "Approve",
              value: "approve",
            },
          ],
          question: "Review this implementation plan.",
        },
      ],
      requestId: "req-p1",
      schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
      sessionId: "sess-1",
      toolName: "ExitPlanMode",
    },
    "plan",
  );
  assert.equal(translated?.kind, "plan_approval");
  assert.equal(translated?.request.toolName, "ExitPlanMode");
  assert.equal(translated?.request.approvalMode, "user-once");
});

test("userInputParamsToBrokerRequest: MCP elicitation / 未知 kind → undefined", () => {
  for (const params of [
    {
      requestId: "req-m1",
      schema: {
        interaction: "mcp_elicitation",
        requestedSchema: {},
        serverName: "srv",
      },
      sessionId: "sess-1",
      toolName: "mcp_elicitation",
    },
    {
      requestId: "req-x1",
      schema: {},
      sessionId: "sess-1",
    },
  ] satisfies ZCodeUserInputRequestParams[]) {
    assert.equal(userInputParamsToBrokerRequest(params, "build"), undefined);
  }
});

test("brokerResultToUserInputResponse: wizard modify → accept + answers/annotations", () => {
  const translated = userInputParamsToBrokerRequest(ASK_QUESTION_PARAMS, "build");
  assert.ok(translated);
  const result: PermissionBrokerResult = {
    decision: "modify",
    modifiedInput: {
      annotations: { "Which auth method?": { preview: "jwt flow" } },
      answers: { "Which auth method?": "JWT" },
      // questions 字段由服务端 normalizer 丢弃；客户端只回它认识的键。
      questions: ASK_QUESTION_PARAMS.input,
    },
    reason: "Answered in TUI",
    resolvedAt: new Date(),
  };
  const response = brokerResultToUserInputResponse(result, translated);
  assert.deepEqual(response, {
    action: "accept",
    content: {
      annotations: { "Which auth method?": { preview: "jwt flow" } },
      answers: { "Which auth method?": "JWT" },
    },
  });
  assert.equal(zcodeUserInputResponseSchema.safeParse(response).success, true);
});

test("brokerResultToUserInputResponse: wizard deny(Esc) → decline", () => {
  const translated = userInputParamsToBrokerRequest(ASK_QUESTION_PARAMS, "build");
  assert.ok(translated);
  const response = brokerResultToUserInputResponse(
    { decision: "deny", reason: "Denied in TUI", resolvedAt: new Date() },
    translated,
  );
  assert.deepEqual(response, { action: "decline", reason: "Denied in TUI" });
  assert.equal(zcodeUserInputResponseSchema.safeParse(response).success, true);
});

test("brokerResultToUserInputResponse: plan_approval allow → accept approve", () => {
  const translated = userInputParamsToBrokerRequest(
    {
      requestId: "req-p1",
      schema: { interaction: "plan_approval" },
      sessionId: "sess-1",
      toolName: "ExitPlanMode",
    },
    "plan",
  );
  assert.ok(translated);
  const response = brokerResultToUserInputResponse(
    { decision: "allow", reason: "Approved in TUI", resolvedAt: new Date() },
    translated,
  );
  // content.answer 必须是服务端 normalizePlanApprovalAnswer 认识的 "approve"。
  assert.deepEqual(response, { action: "accept", content: { answer: "approve" } });
  assert.equal(zcodeUserInputResponseSchema.safeParse(response).success, true);
});
