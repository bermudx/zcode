// core 反向交互 → ACP 请求/应答的翻译层。
//
// 两条独立通道，不能混：
// - interaction/requestPermission（普通工具审批）→ session/request_permission。
//   应答面必须是 core 已算好的 option.response 原文：deny reason、
//   project permissionUpdates 都在里面，ACP 侧重算只会把规则算错。
// - interaction/requestUserInput（AskUserQuestion / ExitPlanMode，elicitation
//   语义）→ elicitation/create form。它们走不了 request_permission：ExitPlanMode
//   在 ACP 里只有一个"批准"选项时，编辑器的 Auto/Full access 会自动选
//   allow_once，计划就被静默批准了；AskUserQuestion 的选项约束（≥2）也对不上
//   ACP permission 的 kind 语义。
//
// 无法渲染的 kind（MCP elicitation、未知 schema）→ 如实 decline。
import {
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  AskUserQuestionInputSchema,
  ExitPlanModeInputSchema,
  type AskUserQuestionInput,
} from "@zcode/contracts";
import type {
  ZCodePermissionOption,
  ZCodePermissionRequestParams,
  ZCodePermissionResponse,
  ZCodeUserInputRequestParams,
  ZCodeUserInputResponse,
} from "@zcode/shared";
import type {
  AcpElicitationCreateParams,
  AcpElicitationProperty,
  AcpElicitationResult,
  AcpPermissionOption,
  AcpPermissionOptionKind,
  AcpPermissionOutcome,
} from "./acp-protocol.js";
import { toolKindFor } from "./acp-updates.js";

/** "批准计划"在 core 侧的应答契约（attach-interactions.ts 同款）。 */
const PLAN_APPROVED_ANSWER = "approve";
const PLAN_REJECTED_ANSWER = "reject";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function permissionKindOf(option: ZCodePermissionOption): AcpPermissionOptionKind {
  if (option.kind === "allow_always") return "allow_always";
  if (option.kind === "allow_once") return "allow_once";
  // core 只有 deny 一种拒绝；ACP 区分 once/always，这里统一按"这一次拒绝"表达。
  return "reject_once";
}

/** core 选项顺序即稳定 id 来源：opt-0/opt-1…。 */
export function optionIdFor(index: number): string {
  return `opt-${index}`;
}

export type TranslatedPermissionRequest = {
  params: {
    sessionId: string;
    toolCall: {
      toolCallId: string;
      title: string;
      kind: ReturnType<typeof toolKindFor>;
      status: "pending";
      rawInput: unknown;
    };
    options: AcpPermissionOption[];
  };
  /** optionId → core 权威应答原文。 */
  responsesByOptionId: Map<string, ZCodePermissionResponse>;
  denyResponse: ZCodePermissionResponse;
};

export function permissionRequestToAcp(
  params: ZCodePermissionRequestParams,
  acpSessionId: string,
): TranslatedPermissionRequest {
  const responsesByOptionId = new Map<string, ZCodePermissionResponse>();
  const options: AcpPermissionOption[] = params.options.map((option, index) => {
    const optionId = optionIdFor(index);
    responsesByOptionId.set(optionId, option.response as ZCodePermissionResponse);
    return { kind: permissionKindOf(option), name: option.name, optionId };
  });
  const denyOption = params.options.find((option) => option.kind === "deny");
  return {
    denyResponse: (denyOption?.response ?? {
      decision: "deny",
      reason: "Denied by ACP client",
    }) as ZCodePermissionResponse,
    params: {
      options,
      sessionId: acpSessionId,
      toolCall: {
        kind: toolKindFor(params.toolName),
        rawInput: params.input,
        status: "pending",
        title: params.reason?.trim()
          ? `${params.toolName}: ${params.reason.trim().slice(0, 120)}`
          : params.toolName,
        toolCallId: params.toolCallId,
      },
    },
    responsesByOptionId,
  };
}

/**
 * ACP -> core。selected 且 id 命中：回该项 option.response 原文。
 * cancelled / 未知 id：回 deny 选项原文（如实拒绝，不伪造批准）。
 */
export function acpOutcomeToCoreResponse(
  outcome: AcpPermissionOutcome,
  translated: TranslatedPermissionRequest,
): ZCodePermissionResponse {
  if (outcome.outcome === "selected") {
    const matched = translated.responsesByOptionId.get(outcome.optionId);
    if (matched) return matched;
  }
  return translated.denyResponse;
}

export type TranslatedUserInput =
  | {
      kind: "ask_user_question";
      input: AskUserQuestionInput;
      params: AcpElicitationCreateParams;
    }
  | {
      kind: "plan_approval";
      plan: string;
      params: AcpElicitationCreateParams;
    };

function answerKeyFor(index: number): string {
  // 属性名要与问题原文解耦：problem 原文可能包含任意字符，而 ACP form 的
  // property 名是 JSON key。q0/q1 稳定，回填时按 index 映射回问题原文。
  return `q${index}`;
}

export function userInputRequestToAcp(
  params: ZCodeUserInputRequestParams,
  acpSessionId: string,
): TranslatedUserInput | undefined {
  const schema = asRecord(params.schema);
  const toolName =
    params.toolName ?? (typeof schema.toolName === "string" ? schema.toolName : undefined);

  if (toolName === ASK_USER_QUESTION_TOOL_NAME) {
    const parsed = AskUserQuestionInputSchema.safeParse(params.input);
    // 非法 input 在 TUI 侧也是自动 deny（不渲染）；这里不猜问题。
    if (!parsed.success) return undefined;
    const properties: Record<string, AcpElicitationProperty> = {};
    parsed.data.questions.forEach((question, index) => {
      const description = question.multiSelect
        ? `${question.question}\n\nMultiple selections: separate them with commas.`
        : question.question;
      properties[answerKeyFor(index)] = question.multiSelect
        ? { type: "string", title: question.header, description }
        : {
            type: "string",
            title: question.header,
            description,
            enum: question.options.map((option) => option.label),
          };
    });
    return {
      input: parsed.data,
      kind: "ask_user_question",
      params: {
        message: params.prompt?.trim() || "The agent needs your input to continue.",
        mode: "form",
        requestedSchema: {
          properties,
          required: parsed.data.questions.map((_question, index) => answerKeyFor(index)),
          type: "object",
        },
        sessionId: acpSessionId,
      },
    };
  }

  const interaction = typeof schema.interaction === "string" ? schema.interaction : undefined;
  if (interaction === "plan_approval" || toolName === EXIT_PLAN_MODE_TOOL_NAME) {
    const parsedPlan = ExitPlanModeInputSchema.safeParse(params.input);
    const plan = parsedPlan.success
      ? parsedPlan.data.plan
      : (params.prompt?.trim() || "The agent proposed a plan.");
    return {
      kind: "plan_approval",
      params: {
        // 计划正文放 message：T3 会把它当作 elicitation 的说明文字展示。
        message: `Approve this plan?\n\n${plan}`,
        mode: "form",
        requestedSchema: {
          properties: {
            decision: {
              description: "Approve the plan and continue, or reject and keep planning.",
              enum: [PLAN_APPROVED_ANSWER, PLAN_REJECTED_ANSWER],
              title: "Plan approval",
              type: "string",
            },
          },
          required: ["decision"],
          type: "object",
        },
        sessionId: acpSessionId,
      },
      plan,
    };
  }
  return undefined;
}

/** ACP elicitation 应答 → core userInput 应答。 */
export function acpResultToCoreUserInput(
  result: AcpElicitationResult,
  translated: TranslatedUserInput,
): ZCodeUserInputResponse {
  if (result.action !== "accept") {
    return { action: result.action === "cancel" ? "cancel" : "decline" };
  }
  const content = asRecord(result.content);

  if (translated.kind === "plan_approval") {
    const decision = typeof content.decision === "string" ? content.decision.trim() : "";
    if (decision !== PLAN_APPROVED_ANSWER) {
      // 拒绝/其它值：不给 core 一个"已批准"的形状。
      return { action: "decline", reason: "Plan rejected in ACP client" };
    }
    return { action: "accept", content: { answer: PLAN_APPROVED_ANSWER } };
  }

  // core 以问题原文为 key；多选按 TUI 同款 ", " 拼接。
  const answers: Record<string, string> = {};
  const annotations: Record<string, unknown> = {};
  translated.input.questions.forEach((question, index) => {
    const raw = content[answerKeyFor(index)];
    if (raw === undefined || raw === null) return;
    const text = typeof raw === "string" ? raw : String(raw);
    const normalized = question.multiSelect
      ? text
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .join(", ")
      : text.trim();
    if (normalized.length === 0) return;
    answers[question.question] = normalized;
    // 选项带 preview 时 core 的 annotation 契约要求回填 preview 文本。
    const option = question.options.find((candidate) => candidate.label === normalized);
    if (option?.preview) annotations[question.question] = { preview: option.preview };
  });
  if (Object.keys(answers).length === 0) {
    // accept 但一个答案都没有 = 用户什么都没填，按取消处理，不给 core 空答案。
    return { action: "decline", reason: "No answers submitted" };
  }
  return {
    action: "accept",
    content: {
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
  };
}
