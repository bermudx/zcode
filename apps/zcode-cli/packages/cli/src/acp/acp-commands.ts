// ACP 的本地 slash 命令层：/goal 与 /dwf 不进模型——ACP 客户端没有 command-center，
// 不拦截就会按 P005 把原文喂给模型，goal 状态机与 workflow journal 永远不参与。
// 这里按 TUI command-center 同一套 core 语义做解析与分发，dwf 文案/裁定直接复用
// handlers/dwf.ts，不在第二处再写一份。不持有连接：core 事实全部经 AttachSessionHandle。
import { randomUUID } from "node:crypto";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ZCodeSessionGoalAction } from "@zcode/shared";
import type { AttachSessionHandle } from "../attach/attach-session.js";
import { splitArgs } from "../command-center/utils.js";
import {
  DWF_LIST_LIMIT,
  DWF_USAGE,
  describeResumeRejection,
  formatRunLine,
  formatRunList,
  resolveDwfCancelTarget,
} from "../command-center/handlers/dwf.js";

export type AcpLocalCommand =
  | { args: string; kind: "dwf" }
  | { args: string; kind: "goal" };

/** TUI parseSlashCommand 同款词边界：命令词（含 /target 别名）+ 空格 + args；只认本地路由的名字。 */
export function parseLocalSlashCommand(text: string): AcpLocalCommand | null {
  if (!text.startsWith("/")) return null;
  const trimmed = text.trim();
  const commandEnd = trimmed.search(/\s/);
  const name = (
    commandEnd === -1 ? trimmed.slice(1) : trimmed.slice(1, commandEnd)
  ).toLowerCase();
  if (name !== "goal" && name !== "target" && name !== "dwf") return null;
  const args = commandEnd === -1 ? "" : trimmed.slice(commandEnd + 1).trim();
  return { args, kind: name === "dwf" ? "dwf" : "goal" };
}

/** /goal 文本 → `session/goal` action 面；set-over-existing 的 replace 收敛由 core 裁定。 */
export function goalActionFromArgs(args: string): {
  action: ZCodeSessionGoalAction;
  objective?: string;
} {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { action: "show" };
  const [first] = splitArgs(trimmed);
  const commandEnd = trimmed.search(/\s/);
  const rest = commandEnd === -1 ? "" : trimmed.slice(commandEnd + 1).trim();
  if (first === "pause" || first === "resume" || first === "clear") {
    return { action: first };
  }
  if (first === "replace") {
    return rest.length === 0
      ? { action: "replace" }
      : { action: "replace", objective: rest };
  }
  return { action: "set", objective: trimmed };
}

export interface AcpGoalCommandResult {
  response: string;
  startedTurn: boolean;
}

/** inputId 由调用方先生成：settlement 订阅必须先于 session/goal 发出（见下）。 */
export function newGoalInputId(): string {
  return `acp-goal-${randomUUID()}`;
}

export async function runGoalCommand(
  handle: AttachSessionHandle,
  args: string,
  inputId: string,
): Promise<AcpGoalCommandResult> {
  const { action, objective } = goalActionFromArgs(args);
  const result = await handle.goalCommand({
    action,
    ...(objective === undefined ? {} : { objective }),
    inputId,
  });
  return {
    response: goalResponseText(action, result.response),
    startedTurn: result.startedTurn === true,
  };
}

/**
 * core 对 pause 的成功刻意回空串（协议 lane 不想要无意义气泡），但 ACP 客户端没有
 * 目标面板——不补一行，用户会看到命令被吞。与 TUI lane 的本地 handler 文案同款。
 */
function goalResponseText(action: ZCodeSessionGoalAction, response: string): string {
  return action === "pause" && response.length === 0 ? "Goal paused." : response;
}

export async function runDwfCommand(
  handle: AttachSessionHandle,
  args: string,
): Promise<string> {
  const [action = "list", runId] = splitArgs(args);
  if (action === "list") {
    const runs = await handle.listDynamicWorkflowRuns({ limit: DWF_LIST_LIMIT });
    return formatRunList(runs);
  }
  if (action === "cancel") {
    return await runDwfCancel(handle, runId);
  }
  if (action === "resume") {
    // 与 TUI lane 不同，这里不做客户端 workflow-mode 门：engine 开关是 core 的事实
    // （fail-closed），v4 命令的拒绝就是给用户的真话。
    if (!runId) return DWF_USAGE;
    const result = await handle.resumeWorkflowRun({ workId: runId });
    return result.ok
      ? `Resumed dynamic workflow run ${result.runId}.`
      : `Cannot resume ${runId}: ${describeResumeRejection(result.reason)} (${result.reason})${result.message === undefined ? "" : `\n${result.message}`}`;
  }
  return DWF_USAGE;
}

async function runDwfCancel(
  handle: AttachSessionHandle,
  runId: string | undefined,
): Promise<string> {
  let targetRunId = runId;
  if (!targetRunId) {
    const runs = await handle.listDynamicWorkflowRuns({ limit: DWF_LIST_LIMIT });
    const target = resolveDwfCancelTarget(runs);
    if (target.kind === "none") return "No in-flight dynamic workflow runs to cancel.";
    if (target.kind === "ambiguous") {
      return [
        "Multiple in-flight dynamic workflow runs; pass the run id to cancel one:",
        ...target.inFlight.map((run) => `- ${formatRunLine(run)}`),
        "",
        "Usage: /dwf cancel <runId>",
      ].join("\n");
    }
    targetRunId = target.runId;
  }
  // runId ≡ taskId：与 TUI lane 同一条 session/cancelBackgroundTask 路径。
  const result = (await handle.cancelBackgroundTask(targetRunId)) as {
    cancelled: boolean;
    reason?: string;
    status?: string;
  };
  if (!result?.cancelled) {
    const reason = result?.reason ? `: ${result.reason}` : ".";
    return `Could not cancel ${targetRunId} (${result?.status ?? "unknown"})${reason}`;
  }
  return `Cancelled dynamic workflow run ${targetRunId}.`;
}

/** 广播给客户端的本地命令面：只广告真正在 ACP 侧路由的两条，不路由的不广告。 */
export function localSlashCommandsUpdate(): SessionUpdate {
  return {
    availableCommands: [
      {
        description: "Show, set, replace, pause, resume or clear the session goal",
        name: "goal",
      },
      {
        description: "List, cancel or resume dynamic workflow runs",
        name: "dwf",
      },
    ],
    sessionUpdate: "available_commands_update",
  };
}

export interface TurnSettlementWatch {
  /** "completed" = 第一轮收口（turn_end 或 no-turn 兜底）；"aborted" = signal 触发或 dispose。 */
  promise: Promise<"aborted" | "completed">;
  /** 未 settle 就放弃等待时调用，注销 sink 与计时器防泄漏。 */
  dispose(): void;
}

export interface TurnSettlementOptions {
  /**
   * no-turn 兜底：core 的 `startedTurn` 只是启动前置检查，续跑命令入队后仍可能
   * 直接空手而归（让位 pending 命令、目标已变、prepare boundary 抛错——这些路径
   * 不发任何 turn 事件）。超过此时长仍未见到 turn_started(ours) 就按已完成收口，
   * 不让 ACP prompt 永久挂起；真实 turn 启动只需亚秒到秒级，30s 极少误伤，
   * 误伤后果也只是提前返回 end_turn（该轮照常作为后台更新流给客户端）。
   */
  noTurnStartTimeoutMs?: number;
}

/**
 * 监听 goal 续跑第一轮的收口：turn_complete / turn_error 的 payload 都带 inputId，
 * 同一续跑循环的后续轮同 id（core 约定），但 prompt 请求只等第一轮——TUI 也不阻塞
 * 整个 goal 循环，后续轮作为普通 session/update 继续流给客户端。
 *
 * 必须在 session/goal 发出**之前**订阅：续跑轮可能在 op 回包之前就快速失败收口，
 * 事后订阅会把 ACP prompt 卡成永不返回。一旦见到 turn_started(ours)，其收口必然
 * 有 turn_complete/turn_error（cancelled 也是 complete），此后不再受兜底计时约束。
 */
export function watchTurnSettlement(
  handle: Pick<AttachSessionHandle, "addSink">,
  inputId: string,
  signal?: AbortSignal,
  options?: TurnSettlementOptions,
): TurnSettlementWatch {
  let resolve!: (outcome: "aborted" | "completed") => void;
  const promise = new Promise<"aborted" | "completed">((res) => {
    resolve = res;
  });
  const finish = (outcome: "aborted" | "completed"): void => {
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
    clearTimeout(noTurnTimer);
    resolve(outcome);
  };
  const onAbort = (): void => finish("aborted");
  const unsubscribe = handle.addSink((event) => {
    if (event.type === "turn_started") {
      const payload = event.payload as { inputId?: string } | undefined;
      if (payload?.inputId === inputId) clearTimeout(noTurnTimer);
      return;
    }
    if (event.type !== "turn_complete" && event.type !== "turn_error") return;
    const payload = event.payload as { inputId?: string } | undefined;
    if (payload?.inputId !== inputId) return;
    finish("completed");
  });
  const noTurnTimer = setTimeout(() => finish("completed"), options?.noTurnStartTimeoutMs ?? 30_000);
  // node 计时器不阻塞退出。
  (noTurnTimer as { unref?: () => void }).unref?.();
  if (signal) {
    if (signal.aborted) {
      finish("aborted");
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    promise,
    dispose: () => finish("aborted"),
  };
}
