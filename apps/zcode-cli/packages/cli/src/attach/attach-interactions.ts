// attach 反向请求的翻译层：interaction/requestPermission 与
// interaction/requestUserInput 的线上 params ↔ TUI PermissionBrokerRequest/Result。
//
// 关键约束：
// - 应答面是 strict zod schema（zcodePermissionResponseSchema /
//   zcodeUserInputResponseSchema）。PermissionBrokerResult 的 resolvedAt、
//   reasonSource、inputAdjustments 等内部字段原样回传会被服务端拒掉
//   （attach 曾直接回传 broker 结果，全线 "Permission request failed"）。
// - 线上 options 已携带权威 response 原文（allow_project 项内含服务端算好的
//   permissionUpdates），应答优先回 option.response，不重新组装。
// - AskUserQuestion / ExitPlanMode 不走 requestPermission，而是
//   requestUserInput（elicitation 语义）。前者由 TUI 的 question wizard 渲染；
//   后者 wire 上只有一个 "Approve" 选项，满足不了 AskUserQuestionInputSchema
//   的 min(2) 选项约束，只能走普通审批面板（Allow once / Deny）。
// - MCP elicitation 等未知 kind：如实 decline，不冒充用户输入。
import {
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type CollaborationMode,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
  type PermissionUpdate,
  type SessionId,
  type ToolCallId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import type {
  ZCodePermissionOption,
  ZCodePermissionRequestParams,
  ZCodePermissionResponse,
  ZCodeUserInputRequestParams,
  ZCodeUserInputResponse,
} from "@zcode/shared";

const PLAN_APPROVAL_INTERACTION = "plan_approval";
const EXIT_PLAN_APPROVED_ANSWER = "approve";

/** requestUserInput 的可渲染形态；其余一律 decline。 */
export type TranslatedUserInputRequest =
  | { kind: "ask_user_question"; request: PermissionBrokerRequest }
  | { kind: "plan_approval"; request: PermissionBrokerRequest };

/** wire options 全落 allow_once/deny ⇔ in-process 的 approvalMode:"user-once"。 */
function optionsAreUserOnceOnly(options: ZCodePermissionOption[]): boolean {
  return options.every(
    (option) => option.kind === "allow_once" || option.kind === "deny",
  );
}

/** "Always allow in this project" 项的 response.permissionUpdates 是服务端算好的授权规则，
 *  客户端缺 suggestedPermissionUpdates 时 TUI 只能重新猜一份（rulePolicy 会失真）。 */
function permissionUpdatesFromOptions(
  options: ZCodePermissionOption[],
): PermissionUpdate[] | undefined {
  return options.find((option) => option.kind === "allow_always")?.response
    .permissionUpdates as PermissionUpdate[] | undefined;
}

function brokerRequestBase(
  params: {
    input?: unknown;
    origin?: PermissionBrokerRequest["origin"];
    reason?: string;
    requestId: string;
    sessionId: string;
    toolCallId?: string;
    toolName: string;
    turnId?: string;
  },
  mode: CollaborationMode,
): PermissionBrokerRequest {
  return {
    input: params.input,
    mode,
    ...(params.origin ? { origin: params.origin } : {}),
    reason: params.reason ?? "",
    // traceId/ruleId 不上线；requestId 全局唯一，占位仍可与服务端日志对上号。
    requestedAt: new Date(),
    requestId: params.requestId,
    riskLevel: "low",
    ruleId: params.requestId,
    sessionId: params.sessionId as SessionId,
    toolCallId: (params.toolCallId ?? params.requestId) as ToolCallId,
    toolName: params.toolName,
    traceId: params.requestId as TraceId,
    ...(params.turnId ? { turnId: params.turnId as TurnId } : {}),
  };
}

export function permissionParamsToBrokerRequest(
  params: ZCodePermissionRequestParams,
  mode: CollaborationMode,
): PermissionBrokerRequest {
  return {
    ...brokerRequestBase(params, mode),
    ...(optionsAreUserOnceOnly(params.options)
      ? { approvalMode: "user-once" as const }
      : {}),
    riskLevel: params.riskLevel,
    suggestedPermissionUpdates: permissionUpdatesFromOptions(params.options),
  };
}

/**
 * TUI broker 结果 → 线上 permission 应答。
 * 优先回 option.response 原文（服务端已把 deny reason、project permissionUpdates
 * 算好）；找不到匹配项（escalate/modify、options 缺位）时只保留 schema 字段。
 */
export function brokerResultToPermissionResponse(
  result: PermissionBrokerResult,
  options: ZCodePermissionOption[],
): ZCodePermissionResponse {
  const matched = matchPermissionOption(result, options);
  if (matched) return matched.response;
  return {
    decision: result.decision,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.modifiedInput !== undefined
      ? { modifiedInput: result.modifiedInput }
      : {}),
    ...(result.permissionUpdates !== undefined
      ? {
          permissionUpdates:
            result.permissionUpdates as ZCodePermissionResponse["permissionUpdates"],
        }
      : {}),
  };
}

function matchPermissionOption(
  result: PermissionBrokerResult,
  options: ZCodePermissionOption[],
): ZCodePermissionOption | undefined {
  if (result.decision === "deny") {
    return options.find((option) => option.kind === "deny");
  }
  if (result.decision !== "allow") return undefined;
  // TUI 只有 allow_project 会在结果上带 permissionUpdates（见 createApprovalResult）。
  const kind =
    result.permissionUpdates !== undefined ? "allow_always" : "allow_once";
  return options.find((option) => option.kind === kind);
}

/**
 * requestUserInput params → 可渲染的 broker 请求。
 * 无法渲染的 kind（MCP elicitation、未知 schema）返回 undefined，调用方如实 decline。
 */
export function userInputParamsToBrokerRequest(
  params: ZCodeUserInputRequestParams,
  mode: CollaborationMode,
): TranslatedUserInputRequest | undefined {
  const schema = isRecord(params.schema) ? params.schema : {};
  const toolName =
    params.toolName ??
    (typeof schema.toolName === "string" ? schema.toolName : undefined);
  if (toolName === ASK_USER_QUESTION_TOOL_NAME) {
    return {
      kind: "ask_user_question",
      // input 原样透传——TUI requester 用 AskUserQuestionInputSchema 校验后才建
      // questionState；非法 input 在 requester 侧已是自动 deny（不渲染）。
      request: brokerRequestBase(
        { ...params, reason: params.prompt, toolName: ASK_USER_QUESTION_TOOL_NAME },
        mode,
      ),
    };
  }
  const interaction =
    typeof schema.interaction === "string" ? schema.interaction : undefined;
  if (interaction === PLAN_APPROVAL_INTERACTION || toolName === EXIT_PLAN_MODE_TOOL_NAME) {
    return {
      kind: "plan_approval",
      request: {
        ...brokerRequestBase(
          {
            ...params,
            reason: params.prompt,
            toolName: EXIT_PLAN_MODE_TOOL_NAME,
          },
          mode,
        ),
        // 计划批准只有批准/拒绝两义，不允许沉淀 "always allow" 持久规则。
        approvalMode: "user-once",
      },
    };
  }
  return undefined;
}

/**
 * TUI broker 结果 → 线上 userInput 应答。
 * ask_user_question：question wizard 的 modify 结果把 answers/annotations 原样放进
 * content——服务端 normalizeAskUserQuestionResponseContent 只取这两键并与 input 合并，
 * 其余字段（questions 等）一律丢弃，多带不会泄漏。
 */
export function brokerResultToUserInputResponse(
  result: PermissionBrokerResult,
  translated: TranslatedUserInputRequest,
): ZCodeUserInputResponse {
  if (result.decision === "deny") {
    return {
      action: "decline",
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  }
  if (translated.kind === "plan_approval") {
    // 普通审批面板只产出 allow/deny；allow 即批准计划。
    return {
      action: "accept",
      content: { answer: EXIT_PLAN_APPROVED_ANSWER },
    };
  }
  if (result.decision !== "modify") {
    return { action: "accept" };
  }
  const modified = isRecord(result.modifiedInput) ? result.modifiedInput : {};
  const content: Record<string, unknown> = {};
  if (isRecord(modified.answers)) content.answers = modified.answers;
  if (isRecord(modified.annotations)) content.annotations = modified.annotations;
  return { action: "accept", content };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 首个应答送达后短暂保留结果：服务端恢复链路会按同 requestId 周期 reannounce，
 *  迟到的重发拿到同一份应答，而不是重开面板。 */
const INTERACTION_RESULT_GRACE_MS = 2_000;

type PendingInteraction = {
  controller: AbortController;
  promise: Promise<unknown>;
};

/**
 * interaction/* 反向请求的执行口：同一业务 requestId 的重发只驱动一次 invoke、
 * 共享同一个应答（首个响应到达后服务端忽略其余同 requestId 响应）。
 * signal 挂到当前回合 abortSignal 上：本地 Ctrl-C/abort 一并撤下面板；
 * permission_resolved / turn end 由调用方（AttachSessionHandle.routeTurnEvent）
 * 触发 drop() → controller.abort()。
 *
 * abort 必须独立 settle 外层 promise：请求方若在 signal 已 aborted 后才注册
 * 监听（事件与请求同帧到达、invoke 尚未执行）会永远等不到回调，race 保证
 * 服务端总能拿到应答，而不是挂到超时。
 */
export class PendingInteractions {
  private readonly entries = new Map<string, PendingInteraction>();

  serve(
    requestId: string,
    invoke: (signal: AbortSignal) => Promise<unknown>,
    turnSignal?: AbortSignal,
  ): Promise<unknown> {
    const existing = this.entries.get(requestId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const onTurnAbort = () => controller.abort();
    if (turnSignal?.aborted) {
      controller.abort();
    } else {
      turnSignal?.addEventListener("abort", onTurnAbort, { once: true });
    }
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () =>
        reject(new Error("Interaction aborted before the client answered"));
      if (controller.signal.aborted) {
        onAbort();
      } else {
        controller.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    const promise = Promise.race([
      Promise.resolve().then(() => invoke(controller.signal)),
      aborted,
    ]).finally(() => {
      turnSignal?.removeEventListener("abort", onTurnAbort);
      const timer = setTimeout(() => {
        if (this.entries.get(requestId)?.promise === promise) {
          this.entries.delete(requestId);
        }
      }, INTERACTION_RESULT_GRACE_MS);
      timer.unref();
    });
    this.entries.set(requestId, { controller, promise });
    return promise;
  }

  drop(requestId?: string): void {
    for (const [id, entry] of this.entries) {
      if (requestId !== undefined && id !== requestId) continue;
      entry.controller.abort();
      // 条目留给 settle 后的 grace 自清；abort 只触发撤下仍在等待的交互。
    }
  }
}
