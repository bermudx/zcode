// AttachSessionHandle 的 goal/dwf wire 面：/goal 与 /dwf（ACP 本地命令路由、attach TUI
// command-center）的下游调用。函数只收 (client, sessionId)，不带句柄状态；goal 回包的
// 快照合并由句柄侧完成（applyMutationSnapshot 是它的私有职责）。
import type {
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunSessionSummary,
} from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeSessionGoalResultSchema,
  type ZCodeSessionGoalAction,
  type ZCodeSessionGoalResult,
} from "@zcode/shared";
import {
  V4_METHODS,
  v4ConversationWorkflowRunsResultSchema,
  WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX,
} from "@zcode/shared/zcode-protocol-v4";
import type { AttachClient } from "./attach-client.js";
import { AttachV4CommandError, newCommandId, sendV4Command } from "./attach-v4-command.js";

/**
 * resume 拒绝词表（core 只发 contracts `DynamicWorkflowRunResumeErrorReason` 里的值，
 * 见 bootstrap V4WorkflowRunResumeRejectedError）：这里做边界校验，未知后缀不伪装成
 * 业务分支，整体抛错。
 */
const RESUME_REJECTION_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "not_resumable",
  "superseded",
  "already_running",
  "script_missing",
  "script_mismatch",
  "compile_failed",
]);

/**
 * 通用 `session/goal` 调用：结构化 action 直传，core 是 goal 状态/文案/replace 收敛/
 * 续跑的唯一权威；回包按共享 schema 校验后原样返回。
 */
export async function requestGoalCommand(
  client: AttachClient,
  sessionId: string,
  input: {
    action: ZCodeSessionGoalAction;
    inputId?: string;
    objective?: string;
  },
): Promise<ZCodeSessionGoalResult> {
  return zcodeSessionGoalResultSchema.parse(
    await client.request(zcodeProtocolMethods.sessionGoal, {
      action: input.action,
      ...(input.inputId === undefined ? {} : { inputId: input.inputId }),
      ...(input.objective === undefined ? {} : { objective: input.objective }),
      sessionId,
    }),
  );
}

/** dwf run 摘要：v4 只读 query（journal 事实源），条目按共享 schema 校验。 */
export async function listWorkflowRuns(
  client: AttachClient,
  sessionId: string,
  input: { limit?: number } = {},
): Promise<DynamicWorkflowRunSessionSummary[]> {
  const result = v4ConversationWorkflowRunsResultSchema.parse(
    await client.request(V4_METHODS.conversationWorkflowRuns, {
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      sessionId,
    }),
  );
  return result.runs;
}

/**
 * resume 一个 dwf run：v4 command（workId ≡ runId）。业务拒绝以
 * `fault.command.workflowRunResumeRejected.<reason>` 回 ACK，这里按共享前缀还原结构化
 * reason；其余 fault（如 capabilityUnsupported）不是业务分支，原样上抛。
 */
export async function resumeWorkflowRunCommand(
  client: AttachClient,
  sessionId: string,
  workId: string,
): Promise<DynamicWorkflowRunResumeResult> {
  try {
    await sendV4Command(client, {
      commandId: newCommandId(),
      payload: { workId },
      sessionId,
      type: "resumeWorkflowRun",
    });
    return { ok: true, runId: workId };
  } catch (error) {
    if (!(error instanceof AttachV4CommandError)) throw error;
    const suffix = error.reasonCode.startsWith(WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX)
      ? error.reasonCode.slice(WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX.length)
      : undefined;
    if (suffix === undefined || !RESUME_REJECTION_REASONS.has(suffix)) {
      throw new Error(
        `resumeWorkflowRun ${error.status}: ${error.reasonCode}${error.message ? ` (${error.message})` : ""}`,
      );
    }
    return {
      ok: false,
      reason: suffix as Extract<DynamicWorkflowRunResumeResult, { ok: false }>["reason"],
      ...(error.message ? { message: error.message } : {}),
    };
  }
}
