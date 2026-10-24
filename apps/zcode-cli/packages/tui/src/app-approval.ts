import type { PermissionBrokerRequest, PermissionBrokerResult } from "@zcode/contracts";
import { EXIT_PLAN_MODE_TOOL_NAME } from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import type { KeyEvent } from "@mbears/opentui-core";
import type React from "react";
import type { ApprovalDecision, ApprovalPrompt } from "./app-model.js";
import { approvalDecisions } from "./app-model.js";
import { clampIndex } from "./app-input.js";
import { handleQuestionKey } from "./app-question-state.js";
import { asRecord, stringField } from "./state.js";

const COMMAND_INPUT_FIELD = "command";
const DESCRIPTION_INPUT_FIELD = "description";

export function decisionsForApproval(request: PermissionBrokerRequest): ApprovalDecision[] {
  // ExitPlanMode 的"批准"只能作用于本次方案；persist 成项目规则会让后续
  // 每次 plan 审批都被自动放行，语义上是危险的，所以永远单选。
  if (request.toolName === EXIT_PLAN_MODE_TOOL_NAME) return ["allow_once", "deny"];
  return request.approvalMode === "user-once" ? ["allow_once", "deny"] : approvalDecisions;
}

export function handleApprovalKey(
  key: KeyEvent,
  approval: ApprovalPrompt,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  if (approval.questionState) {
    handleQuestionKey(key, approval, setApprovalQueue, setStatus);
    return;
  }

  if (key.name === "up" || key.name === "down") {
    const decisions = decisionsForApproval(approval.request);
    const delta = key.name === "up" ? -1 : 1;
    setApprovalQueue((current) => {
      const [first, ...rest] = current;
      if (!first) return current;
      const selectedIndex = decisions.indexOf(first.selectedDecision);
      return [
        {
          ...first,
          selectedDecision:
            decisions[clampIndex(selectedIndex + delta, decisions.length)] ?? "deny",
        },
        ...rest,
      ];
    });
    return;
  }

  if (key.name === "return") {
    resolveApproval(approval, approval.selectedDecision, setApprovalQueue, setStatus);
    return;
  }

  if (key.name === "escape") {
    resolveApproval(approval, "deny", setApprovalQueue, setStatus);
  }
}

export function approvalDecisionLabel(
  decision: ApprovalDecision,
  request?: PermissionBrokerRequest,
): string {
  const isExitPlanMode = request?.toolName === EXIT_PLAN_MODE_TOOL_NAME;
  // plan 审批与普通权限语义不同：allow_once 即批准方案并退出 plan mode。
  if (decision === "allow_once") return isExitPlanMode ? "Approve plan" : "Allow once";
  if (decision === "allow_project") {
    return request && isOfficialCuaProjectApproval(request)
      ? "Always allow Computer Use in this project"
      : "Always allow in this project";
  }
  return isExitPlanMode ? "Reject" : "Deny";
}

export function isOfficialCuaProjectApproval(request: PermissionBrokerRequest): boolean {
  return permissionUpdatesForApproval(request).some(
    (update) =>
      update.type === "addRules" &&
      update.behavior === "allow" &&
      update.rules.some((rule) => rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME),
  );
}

export function approvalRequestDescription(request: PermissionBrokerRequest): string {
  return stringField(asRecord(request.input), DESCRIPTION_INPUT_FIELD) ?? request.reason;
}

export function previewPermissionInput(input: unknown): string {
  const command = stringField(asRecord(input), COMMAND_INPUT_FIELD);
  if (command) return command;
  // plan 正文已经在 transcript 的 ExitPlanMode 行内渲染，这里只回显开头作为上下文，
  // 避免 JSON.stringify 出的 {"plan": ...} 噪声。
  const plan = stringField(asRecord(input), "plan");
  if (plan) return plan;
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

export function approvalPermissionScopes(
  request: PermissionBrokerRequest,
): Array<{ kind: "exact" | "prefix"; text: string }> {
  const scopes: Array<{ kind: "exact" | "prefix"; text: string }> = [];
  for (const update of permissionUpdatesForApproval(request)) {
    if (update.type !== "addRules" || update.behavior !== "allow") continue;
    for (const rule of update.rules) {
      if (rule.toolName.toLowerCase() !== "bash") continue;
      const content = rule.ruleContent?.trim();
      if (!content) continue;
      scopes.push(
        content.endsWith(":*")
          ? { kind: "prefix", text: `${content.slice(0, -2)} …` }
          : { kind: "exact", text: content },
      );
    }
  }
  return scopes.slice(0, 5);
}

function resolveApproval(
  approval: ApprovalPrompt,
  decision: ApprovalDecision,
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>,
  setStatus: (status: string) => void,
): void {
  approval.cleanup();
  approval.resolve(createApprovalResult(approval.request, decision));
  setApprovalQueue((current) => current.filter((item) => item !== approval));
  setStatus(`Permission ${approvalStatusLabel(decision)} for ${approval.request.toolName}.`);
}

export function createApprovalResult(
  request: PermissionBrokerRequest,
  decision: ApprovalDecision,
): PermissionBrokerResult {
  if (
    decision === "deny" ||
    (decision === "allow_project" && request.approvalMode === "user-once")
  ) {
    return {
      decision: "deny",
      reason: "Denied in TUI",
      resolvedAt: new Date(),
    };
  }

  return {
    decision: "allow",
    permissionUpdates:
      decision === "allow_project" ? permissionUpdatesForApproval(request) : undefined,
    reason: decision === "allow_project" ? "Approved for this project in TUI" : "Approved in TUI",
    resolvedAt: new Date(),
  };
}

function permissionUpdatesForApproval(request: PermissionBrokerRequest) {
  if (request.suggestedPermissionUpdates?.length) return request.suggestedPermissionUpdates;
  const permissionRuleContent = ruleContentFromApprovalInput(request.input);
  return [
    {
      behavior: "allow" as const,
      rules: [
        {
          toolName: request.toolName,
          ...(permissionRuleContent ? { ruleContent: permissionRuleContent } : {}),
        },
      ],
      type: "addRules" as const,
    },
  ];
}

function approvalStatusLabel(decision: ApprovalDecision): string {
  if (decision === "deny") return "denied";
  return decision === "allow_project" ? "approved for this project" : "approved";
}

function ruleContentFromApprovalInput(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  const record = asRecord(input);
  for (const key of [COMMAND_INPUT_FIELD, "url", "file_path", "path", "pattern"]) {
    const value = stringField(record, key);
    if (value) return value;
  }
  return undefined;
}
