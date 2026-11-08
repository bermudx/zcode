// /goal 与 /dwf 在 ACP lane 的本地路由回归：解析、action 映射、goal 续跑等待的
// 订阅时序、dwf 分发文案。core 由 fake handle 承担——这里验的是命令层，不是 core。
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@zcode/contracts";
import {
  goalActionFromArgs,
  localSlashCommandsUpdate,
  newGoalInputId,
  parseLocalSlashCommand,
  runDwfCommand,
  runGoalCommand,
  watchTurnSettlement,
} from "../src/acp/acp-commands.js";
import type { AttachSessionHandle } from "../src/attach/attach-session.js";

test("parseLocalSlashCommand: word boundary, /target alias, everything else passes through", () => {
  assert.deepEqual(parseLocalSlashCommand("/goal fix the bug"), {
    args: "fix the bug",
    kind: "goal",
  });
  assert.deepEqual(parseLocalSlashCommand("/GOAL fix"), { args: "fix", kind: "goal" });
  assert.deepEqual(parseLocalSlashCommand("/goal"), { args: "", kind: "goal" });
  assert.deepEqual(parseLocalSlashCommand("/target pause"), {
    args: "pause",
    kind: "goal",
  });
  assert.deepEqual(parseLocalSlashCommand("/dwf list"), { args: "list", kind: "dwf" });
  // 不是本地命令：原文转发给模型（P005），拦截层必须放行。
  assert.equal(parseLocalSlashCommand("/model glm-5"), null);
  assert.equal(parseLocalSlashCommand("/goalsy text"), null);
  assert.equal(parseLocalSlashCommand("please /goal me"), null);
  assert.equal(parseLocalSlashCommand(""), null);
});

test("goalActionFromArgs maps TUI semantics onto session/goal actions", () => {
  assert.deepEqual(goalActionFromArgs(""), { action: "show" });
  assert.deepEqual(goalActionFromArgs("pause"), { action: "pause" });
  assert.deepEqual(goalActionFromArgs("RESUME"), { action: "resume" });
  assert.deepEqual(goalActionFromArgs("clear"), { action: "clear" });
  assert.deepEqual(goalActionFromArgs("replace"), { action: "replace" });
  // replace 裸用（无目标）由 core 回 Usage 文案；objective 缺席不拼空串。
  assert.deepEqual(goalActionFromArgs("replace new objective here"), {
    action: "replace",
    objective: "new objective here",
  });
  // TUI 语义同样把首词当 action（handleTargetCommand 的 splitArgs 分支）：
  // "pause the deployment" 就是 pause，不是以 pause 开头的目标——与 TUI 对齐。
  assert.deepEqual(goalActionFromArgs("pause the deployment"), { action: "pause" });
  // 目标正文不误吞：非 action 首词整段都是 objective。
  assert.deepEqual(goalActionFromArgs("ship the 1.0 release"), {
    action: "set",
    objective: "ship the 1.0 release",
  });
});

test("runGoalCommand passes the caller's inputId through and returns core truth", async () => {
  const calls: unknown[] = [];
  const handle = {
    goalCommand: async (input: unknown) => {
      calls.push(input);
      return {
        response: "Goal active\nObjective: ship it",
        snapshot: { settings: {} },
        startedTurn: true,
      };
    },
  } as unknown as AttachSessionHandle;
  const inputId = newGoalInputId();
  const result = await runGoalCommand(handle, "ship it", inputId);
  assert.equal(result.response, "Goal active\nObjective: ship it");
  assert.equal(result.startedTurn, true);
  assert.deepEqual(calls, [{ action: "set", inputId, objective: "ship it" }]);
});

test("runGoalCommand synthesizes feedback for the silent pause success", async () => {
  // core 对 pause 成功回空串（协议 lane 无气泡）；ACP 客户端没有目标面板，必须补一行。
  const handle = {
    goalCommand: async () => ({
      response: "",
      snapshot: { settings: {} },
      startedTurn: false,
    }),
  } as unknown as AttachSessionHandle;
  const result = await runGoalCommand(handle, "pause", "acp-goal-x");
  assert.equal(result.response, "Goal paused.");
  // 非空 core 回包原样透传，不叠加文案。
  const visible = {
    goalCommand: async () => ({
      response: "Goal paused\nObjective: ship it",
      snapshot: { settings: {} },
      startedTurn: false,
    }),
  } as unknown as AttachSessionHandle;
  assert.equal(
    (await runGoalCommand(visible, "pause", "acp-goal-y")).response,
    "Goal paused\nObjective: ship it",
  );
});

function dwfHandle(options: {
  runs?: { runId: string; status: string; resumable?: boolean }[];
  cancelResult?: unknown;
  resumeResult?: unknown;
}): { handle: AttachSessionHandle; resumeCalls: string[] } {
  const resumeCalls: string[] = [];
  const handle = {
    cancelBackgroundTask: async (taskId: string) =>
      options.cancelResult ?? { cancelled: true, status: "cancelled", taskId },
    listDynamicWorkflowRuns: async (input?: { limit?: number }) => {
      assert.equal(input?.limit, 20);
      return (options.runs ?? []).map((run) => ({
        resumable: run.resumable ?? false,
        runId: run.runId,
        status: run.status,
      }));
    },
    resumeWorkflowRun: async (input: { workId: string }) => {
      resumeCalls.push(input.workId);
      return options.resumeResult ?? { ok: true, runId: input.workId };
    },
  } as unknown as AttachSessionHandle;
  return { handle, resumeCalls };
}

test("runDwfCommand list formats runs via the shared TUI formatter", async () => {
  const { handle } = dwfHandle({
    runs: [{ runId: "dwfrun_1", status: "running", resumable: false }],
  });
  const response = await runDwfCommand(handle, "list");
  assert.match(response, /Dynamic workflow runs \(1\):/);
  assert.match(response, /- dwfrun_1 · running/);
});

test("runDwfCommand without runs reports the empty journal", async () => {
  const { handle } = dwfHandle({});
  assert.equal(
    await runDwfCommand(handle, ""),
    "No dynamic workflow runs in this session.",
  );
});

test("runDwfCommand cancel without runId picks the single in-flight run", async () => {
  const { handle } = dwfHandle({
    runs: [
      { runId: "dwfrun_done", status: "completed" },
      { runId: "dwfrun_live", status: "running" },
    ],
  });
  assert.equal(
    await runDwfCommand(handle, "cancel"),
    "Cancelled dynamic workflow run dwfrun_live.",
  );
});

test("runDwfCommand cancel with multiple in-flight runs demands a runId", async () => {
  const { handle } = dwfHandle({
    runs: [
      { runId: "dwfrun_a", status: "running" },
      { runId: "dwfrun_b", status: "pending" },
    ],
  });
  const response = await runDwfCommand(handle, "cancel");
  assert.match(response, /Multiple in-flight dynamic workflow runs/);
  assert.match(response, /- dwfrun_a · running/);
  assert.match(response, /- dwfrun_b · pending/);
});

test("runDwfCommand resume success and structured rejection wording", async () => {
  const ok = dwfHandle({});
  assert.equal(
    await runDwfCommand(ok.handle, "resume dwfrun_9"),
    "Resumed dynamic workflow run dwfrun_9.",
  );
  assert.deepEqual(ok.resumeCalls, ["dwfrun_9"]);

  const rejected = dwfHandle({
    resumeResult: { ok: false, reason: "not_resumable" },
  });
  assert.equal(
    await runDwfCommand(rejected.handle, "resume dwfrun_9"),
    "Cannot resume dwfrun_9: only a stopped run can be resumed (an errored run needs a corrected script via AmendWorkflow) (not_resumable)",
  );

  const missingId = dwfHandle({});
  assert.match(await runDwfCommand(missingId.handle, "resume"), /^Usage: \/dwf/);
});

test("localSlashCommandsUpdate advertises exactly the two routed commands", () => {
  const update = localSlashCommandsUpdate();
  assert.equal(update.sessionUpdate, "available_commands_update");
  const names = update.availableCommands.map((command) => command.name).sort();
  assert.deepEqual(names, ["dwf", "goal"]);
  for (const command of update.availableCommands) {
    assert.ok(command.description.length > 0);
  }
});

function turnEvent(
  type: "turn_complete" | "turn_error" | "turn_started",
  inputId?: string,
): SessionEvent {
  return {
    id: "evt",
    payload: { inputId },
    sessionId: "sess_1",
    sequenceNumber: 1,
    timestamp: new Date(),
    traceId: "trace",
    type,
  } as unknown as SessionEvent;
}

test("watchTurnSettlement resolves on the first matching turn end and filters by inputId", async () => {
  const sinks = new Set<(event: SessionEvent) => void>();
  const handle = {
    addSink: (sink: (event: SessionEvent) => void) => {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
  } as unknown as Pick<AttachSessionHandle, "addSink">;
  const watch = watchTurnSettlement(handle, "goal-input-1");
  const other = watchTurnSettlement(handle, "goal-input-2");
  for (const sink of sinks) sink(turnEvent("turn_started", "goal-input-1"));
  for (const sink of sinks) sink(turnEvent("turn_complete", "other-input"));
  let settled = false;
  void watch.promise.then(() => {
    settled = true;
  });
  for (const sink of sinks) sink(turnEvent("turn_error", "goal-input-2"));
  assert.equal(settled, false);
  assert.equal(await other.promise, "completed");
  for (const sink of sinks) sink(turnEvent("turn_complete", "goal-input-1"));
  assert.equal(await watch.promise, "completed");
});

function sinkHandle(): {
  handle: Pick<AttachSessionHandle, "addSink">;
  sinks: Set<(event: SessionEvent) => void>;
} {
  const sinks = new Set<(event: SessionEvent) => void>();
  const handle = {
    addSink: (sink: (event: SessionEvent) => void) => {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
  } as unknown as Pick<AttachSessionHandle, "addSink">;
  return { handle, sinks };
}

test("watchTurnSettlement: no-turn-start backstop resolves instead of hanging", async () => {
  // startedTurn 只是 core 的前置检查，续跑可能空手而归且不发任何 turn 事件——
  // 没有兜底，ACP prompt 会永久挂起。
  const { handle, sinks } = sinkHandle();
  const watch = watchTurnSettlement(handle, "goal-input-1", undefined, {
    noTurnStartTimeoutMs: 20,
  });
  assert.equal(await watch.promise, "completed");
  assert.equal(sinks.size, 0, "backstop must release the sink");
});

test("watchTurnSettlement: our turn_started disarms the backstop", async () => {
  const { handle, sinks } = sinkHandle();
  const watch = watchTurnSettlement(handle, "goal-input-1", undefined, {
    noTurnStartTimeoutMs: 20,
  });
  for (const sink of sinks) sink(turnEvent("turn_started", "goal-input-1"));
  // 兜底窗口过后仍未收口：真实 turn 的收口由 turn_end 保证，不受计时器约束。
  await new Promise((resolve) => setTimeout(resolve, 40));
  let settled = false;
  void watch.promise.then(() => {
    settled = true;
  });
  assert.equal(settled, false);
  for (const sink of sinks) sink(turnEvent("turn_error", "goal-input-1"));
  assert.equal(await watch.promise, "completed");
});

test("watchTurnSettlement: abort and dispose release the sink", async () => {
  const removed: number[] = [];
  const sinks = new Set<(event: SessionEvent) => void>();
  const handle = {
    addSink: (sink: (event: SessionEvent) => void) => {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
        removed.push(sinks.size);
      };
    },
  } as unknown as Pick<AttachSessionHandle, "addSink">;

  const controller = new AbortController();
  const aborted = watchTurnSettlement(handle, "goal-input-1", controller.signal);
  controller.abort();
  assert.equal(await aborted.promise, "aborted");
  assert.equal(sinks.size, 0);

  const disposed = watchTurnSettlement(handle, "goal-input-1");
  disposed.dispose();
  assert.equal(await disposed.promise, "aborted");
  assert.equal(sinks.size, 0);

  const alreadyAborted = watchTurnSettlement(
    handle,
    "goal-input-1",
    AbortSignal.abort(),
  );
  assert.equal(await alreadyAborted.promise, "aborted");
});
