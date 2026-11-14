// /goal 与 /dwf 在 ACP lane 的本地路由回归：解析、action 映射、goal 续跑等待的
// 订阅时序、dwf 分发文案。core 由 fake handle 承担——这里验的是命令层，不是 core。
import assert from "node:assert/strict";
import test from "node:test";
import type {
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunSessionSummary,
  SessionEvent,
} from "@zcode/contracts";
import type {
  ZCodeSessionCancelBackgroundTaskResult,
  ZCodeSessionGoalResult,
} from "@zcode/shared";
import {
  goalActionFromArgs,
  newGoalInputId,
  parseLocalSlashCommand,
  resolveSkillInvocation,
  runDwfCommand,
  runGoalCommand,
  runLoginCommand,
  runLogoutCommand,
  slashCommandsUpdate,
  watchTurnSettlement,
  type AcpSkillResolution,
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

// snapshot 全树（protocol/session/runtime/messages…）本套件不消费：路由层只读
// response/startedTurn。铸造收口到这一处，goalCommand 的成员签名仍按真实成员受检。
const stubSnapshot = { settings: {} } as unknown as ZCodeSessionGoalResult["snapshot"];

test("runGoalCommand passes the caller's inputId through and returns core truth", async () => {
  const calls: unknown[] = [];
  const handle: Pick<AttachSessionHandle, "goalCommand"> = {
    goalCommand: async (input) => {
      calls.push(input);
      return {
        response: "Goal active\nObjective: ship it",
        snapshot: stubSnapshot,
        startedTurn: true,
      };
    },
  };
  const inputId = newGoalInputId();
  const result = await runGoalCommand(handle, "ship it", inputId);
  assert.equal(result.response, "Goal active\nObjective: ship it");
  assert.equal(result.startedTurn, true);
  assert.deepEqual(calls, [{ action: "set", inputId, objective: "ship it" }]);
});

test("runGoalCommand synthesizes feedback for the silent pause success", async () => {
  // core 对 pause 成功回空串（协议 lane 无气泡）；ACP 客户端没有目标面板，必须补一行。
  const handle: Pick<AttachSessionHandle, "goalCommand"> = {
    goalCommand: async () => ({
      response: "",
      snapshot: stubSnapshot,
      startedTurn: false,
    }),
  };
  const result = await runGoalCommand(handle, "pause", "acp-goal-x");
  assert.equal(result.response, "Goal paused.");
  // 非空 core 回包原样透传，不叠加文案。
  const visible: Pick<AttachSessionHandle, "goalCommand"> = {
    goalCommand: async () => ({
      response: "Goal paused\nObjective: ship it",
      snapshot: stubSnapshot,
      startedTurn: false,
    }),
  };
  assert.equal(
    (await runGoalCommand(visible, "pause", "acp-goal-y")).response,
    "Goal paused\nObjective: ship it",
  );
});

function dwfHandle(options: {
  runs?: { runId: string; status: DynamicWorkflowRunSessionSummary["status"]; resumable?: boolean }[];
  cancelResult?: ZCodeSessionCancelBackgroundTaskResult;
  resumeResult?: DynamicWorkflowRunResumeResult;
}): {
  handle: Pick<
    AttachSessionHandle,
    "cancelBackgroundTask" | "listDynamicWorkflowRuns" | "resumeWorkflowRun"
  >;
  resumeCalls: string[];
} {
  const resumeCalls: string[] = [];
  const handle: Pick<
    AttachSessionHandle,
    "cancelBackgroundTask" | "listDynamicWorkflowRuns" | "resumeWorkflowRun"
  > = {
    cancelBackgroundTask: async (taskId) =>
      options.cancelResult ?? { cancelled: true, status: "cancelled", taskId },
    listDynamicWorkflowRuns: async (input) => {
      assert.equal(input?.limit, 20);
      // 与真实 core 对齐：摘要里 resumable 由服务端算好，缺省即 false。
      return (options.runs ?? []).map((run) => ({
        resumable: run.resumable ?? false,
        runId: run.runId,
        status: run.status,
      }));
    },
    resumeWorkflowRun: async (input) => {
      resumeCalls.push(input.workId);
      return options.resumeResult ?? { ok: true, runId: input.workId };
    },
  };
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

test("slashCommandsUpdate: local commands only when the core catalog is unavailable", () => {
  const update = slashCommandsUpdate();
  assert.equal(update.sessionUpdate, "available_commands_update");
  const names = update.availableCommands.map((command) => command.name).sort();
  assert.deepEqual(names, ["dwf", "goal", "login", "logout", "skill"]);
  for (const command of update.availableCommands) {
    assert.ok(command.description.length > 0);
  }
});

const catalog = {
  commands: [
    { argumentHint: "[focus]", description: "Review Guidelines", name: "review" },
    { description: "shadowed", name: "goal" },
    { description: "reserved builtin shadow", name: "init" },
  ],
  skills: [
    { description: "Review a diff", name: "diff-review" },
    { description: "same as command", name: "review" },
    { description: "shadows the /init builtin", name: "init" },
    { description: "shadows /model", name: "model" },
  ],
};

test("slashCommandsUpdate: advertises custom commands and skills, first owner wins", () => {
  const update = slashCommandsUpdate(catalog);
  assert.equal(update.sessionUpdate, "available_commands_update");
  const rows = update.availableCommands.map((command) => [command.name, command.description]);
  assert.deepEqual(rows.map(([name]) => name), [
    "goal",
    "dwf",
    "login",
    "logout",
    "skill",
    "review",
    "diff-review",
  ]);
  assert.equal(rows.find(([name]) => name === "review")?.[1], "Review Guidelines");
});

test("slashCommandsUpdate: case-colliding names dedupe to the routing winner", () => {
  // 同名判定按归一化词（issue #19）：路由全程小写，command `Review` 使 /review
  // 的任何写法落到自定义命令——skill `review` 与同词异写的 `REVIEW` 命令行
  // 都指向不可达路径，广告即谎话。
  const update = slashCommandsUpdate({
    commands: [
      { description: "command winner", name: "Review" },
      { description: "duplicate spelling", name: "REVIEW" },
    ],
    skills: [
      { description: "unreachable skill", name: "review" },
      { description: "reachable", name: "diff-review" },
    ],
  });
  assert.equal(update.sessionUpdate, "available_commands_update");
  const rows = update.availableCommands.map((command) => [command.name, command.description]);
  assert.deepEqual(
    rows.map(([name]) => name),
    ["goal", "dwf", "login", "logout", "skill", "Review", "diff-review"],
  );
  assert.equal(rows.find(([name]) => name === "Review")?.[1], "command winner");
});

test("slashCommandsUpdate: core reserved names are never advertised", () => {
  // 技能/命令行接管 /init、/model 等内置语义即是谎话（issue #17）；
  // catalog 刻意带上 init/model 两类影子行，广告面必须全部剔除。
  const update = slashCommandsUpdate(catalog);
  assert.equal(update.sessionUpdate, "available_commands_update");
  const names = update.availableCommands.map((command) => command.name);
  for (const reserved of ["init", "model", "compact", "workflow"]) {
    assert.ok(!names.includes(reserved), `/${reserved} must not be advertised`);
  }
});

const promptText = (resolution: AcpSkillResolution): string | undefined =>
  resolution.kind === "prompt" ? resolution.text : undefined;

test("resolveSkillInvocation: rewrites skill invocations, leaves commands and unknowns raw", () => {
  assert.match(promptText(resolveSkillInvocation("/diff-review check main", catalog)) ?? "", /Skill` tool with name `diff-review`[\s\S]*check main/);
  assert.match(promptText(resolveSkillInvocation("/skill diff-review", catalog)) ?? "", /name `diff-review`/);
  assert.equal(resolveSkillInvocation("/review", catalog).kind, "forward", "custom command wins over skill");
  assert.equal(resolveSkillInvocation("/nope", catalog).kind, "forward");
  assert.equal(resolveSkillInvocation("hello /diff-review", catalog).kind, "forward");
});

test("resolveSkillInvocation: command word and skill name match case-insensitively", () => {
  // /goal、/dwf 路由与 TUI parseSlashCommand 都小写命令词——/skill 同规（issue #18）。
  assert.match(promptText(resolveSkillInvocation("/SKILL diff-review", catalog)) ?? "", /name `diff-review`/);
  // 技能名先精确后小写兜底，改写用目录规范名（Skill 工具按规范名解析）。
  assert.match(promptText(resolveSkillInvocation("/skill DIFF-REVIEW go", catalog)) ?? "", /name `diff-review`[\s\S]*go/);
  assert.match(promptText(resolveSkillInvocation("/Diff-Review", catalog)) ?? "", /name `diff-review`/);
});

test("resolveSkillInvocation: bare /skill answers locally; named /skill always rewrites", () => {
  // 裸 /skill 列技能（TUI 同款），不产生 prompt（issue #15）。
  const list = resolveSkillInvocation("/skill", catalog);
  assert.equal(list.kind, "message");
  if (list.kind === "message") {
    assert.match(list.text, /Available skills \(4\):/);
    assert.match(list.text, /- diff-review: Review a diff/);
    assert.match(list.text, /\/skill <name> \[task\]/);
  }
  const empty = resolveSkillInvocation("/skill", { commands: [], skills: [] });
  assert.deepEqual(empty, { kind: "message", text: "No skills found for this session." });
});

test("resolveSkillInvocation: /skill <name> never gated by the projected catalog", () => {
  // 目录是展示投影（bundled 过滤、会话冻结、展示名去重），不是 resolver 全集：
  // 未命中不本地回执 Unknown——按原词改写，Skill 工具的 Skill not found 才是
  // 缺失的权威报出（issue #27、#28）。原样保大小写：resolver 精确匹配。
  const miss = resolveSkillInvocation("/skill Dynamic-Workflows ship it", catalog);
  assert.equal(miss.kind, "prompt");
  assert.match(
    promptText(miss) ?? "",
    /Skill` tool with name `Dynamic-Workflows`[\s\S]*ship it/,
  );
  // 展示名去重藏掉的裸名同理放行：目录只剩 literal `p:x` 条目，插件技能的
  // 裸名 `x` 仍可被 resolver 按 name 命中。
  const deduped = {
    commands: [],
    skills: [{ description: "literal name", name: "p:x" }],
  };
  assert.match(
    promptText(resolveSkillInvocation("/skill x go", deduped)) ?? "",
    /name `x`[\s\S]*go/,
  );
});

test("resolveSkillInvocation: missing catalog cannot adjudicate but still consumes /skill", () => {
  // 目录拉取失败/在途：/skill 报不可用，/skill <name> 仍改写（Skill 工具按名裁定，
  // 同 TUI 不校验目录）；直达名无目录可判一律 P005 原文转发。
  const bare = resolveSkillInvocation("/skill");
  assert.equal(bare.kind, "message");
  if (bare.kind === "message") assert.match(bare.text, /unavailable/);
  assert.match(promptText(resolveSkillInvocation("/skill diff-review go")) ?? "", /name `diff-review`/);
  assert.equal(resolveSkillInvocation("/diff-review").kind, "forward");
});

test("resolveSkillInvocation: reserved names keep their core meaning", () => {
  // 直达名不接管保留名：/init 原文转发由 facade 展开内置（issue #17）；
  // 显式 /skill init 仍走技能命名空间——命令词已消歧，同 TUI 语义。
  assert.equal(resolveSkillInvocation("/init", catalog).kind, "forward");
  assert.equal(resolveSkillInvocation("/model glm-5", catalog).kind, "forward");
  assert.match(promptText(resolveSkillInvocation("/skill init", catalog)) ?? "", /name `init`/);
});

const qualifiedCatalog = {
  commands: [],
  skills: [
    { description: "First plugin review", name: "review", qualifiedName: "acp-registry:review" },
    { description: "Second plugin review", name: "review", qualifiedName: "other-plugin:review" },
    { description: "Plain skill", name: "lint" },
  ],
};

test("resolveSkillInvocation: a qualified skill's plain name resolves like the Skill tool", () => {
  // Skill 工具 resolver 同口径（issue #24）：name 或 qualifiedName 精确命中、
  // 目录序首个胜出——裸名歧义不另设错误；改写用展示名锁定命中条目。
  assert.match(
    promptText(resolveSkillInvocation("/skill review go", qualifiedCatalog)) ?? "",
    /name `acp-registry:review`[\s\S]*go/,
  );
  assert.match(
    promptText(resolveSkillInvocation("/skill acp-registry:review", qualifiedCatalog)) ?? "",
    /name `acp-registry:review`/,
  );
});

test("resolveSkillInvocation: direct slash hits plain and qualified names identically", () => {
  // /<plain> 与 /<qualified> 都可直达——裸名命中目录序首个（resolver first-match）。
  assert.match(
    promptText(resolveSkillInvocation("/review", qualifiedCatalog)) ?? "",
    /name `acp-registry:review`/,
  );
  assert.match(
    promptText(resolveSkillInvocation("/other-plugin:review task", qualifiedCatalog)) ?? "",
    /name `other-plugin:review`[\s\S]*task/,
  );
});

test("resolveSkillInvocation: lists advertise display names and the plain alias", () => {
  // TUI `; alias` 同款：展示名在前，裸名作为可用 alias 标注（issue #24）。
  const list = resolveSkillInvocation("/skill", qualifiedCatalog);
  assert.equal(list.kind, "message");
  if (list.kind === "message") {
    assert.match(list.text, /- acp-registry:review \(alias review\): First plugin review/);
    assert.match(list.text, /- lint: Plain skill/);
  }
  // 未知名同样按原词改写进轮内裁定，不再本地回执列表。
  assert.match(
    promptText(resolveSkillInvocation("/skill nope", qualifiedCatalog)) ?? "",
    /name `nope`/,
  );
});

function turnEvent(
  type: "turn_started" | "turn_complete" | "turn_error",
  inputId?: string,
): SessionEvent {
  return {
    // branded wire 字段（id/traceId）与断言无关，仅在铸造点收口；type/payload 仍受真实成员约束。
    id: "evt" as SessionEvent["id"],
    payload: { inputId },
    sessionId: "sess_1" as SessionEvent["sessionId"],
    sequenceNumber: 1,
    timestamp: new Date(),
    traceId: "trace" as SessionEvent["traceId"],
    type,
  };
}

test("watchTurnSettlement resolves on the first matching turn end and filters by inputId", async () => {
  const sinks = new Set<(event: SessionEvent) => void>();
  const handle: Pick<AttachSessionHandle, "addSink"> = {
    addSink: (sink) => {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
  };
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
  const handle: Pick<AttachSessionHandle, "addSink"> = {
    addSink: (sink) => {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
  };
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
  const handle: Pick<AttachSessionHandle, "addSink"> = {
    addSink: (sink) => {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
        removed.push(sinks.size);
      };
    },
  };

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

// ── /login /logout（issue #49）─────────────────────────────────────────
// 本地路由：不进模型；URL 与结果走 send()（acp-agent 转 agent_message_chunk）。

test("parseLocalSlashCommand: /login 与 /logout 进本地路由", () => {
  assert.deepEqual(parseLocalSlashCommand("/login zai-coding-plan"), {
    args: "zai-coding-plan",
    kind: "login",
  });
  assert.deepEqual(parseLocalSlashCommand("/LOGIN bigmodel-coding-plan-api-key sk-x"), {
    args: "bigmodel-coding-plan-api-key sk-x",
    kind: "login",
  });
  assert.deepEqual(parseLocalSlashCommand("/logout"), { args: "", kind: "logout" });
  assert.equal(parseLocalSlashCommand("/loginflow x"), null);
});

test("runLoginCommand zai-coding-plan: start → URL chunk → complete → 结果 chunk", async () => {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const sent: string[] = [];
  const urls: string[] = [];
  await runLoginCommand({
    args: "zai-coding-plan",
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "auth/loginStart") {
        return {
          authorizeUrl: "https://login.example.test/auth?state=s",
          expiresAt: 1_800_000_000,
          flowId: "flow-1",
          pollIntervalSec: 1,
        };
      }
      return {
        configPath: "/x/cfg",
        credentialsPath: "/x/creds",
        model: "glm-5",
        ok: true,
        provider: "zai",
        user: { user_id: "u-1", name: "Tester" },
      };
    },
    openBrowser: async (url) => {
      urls.push(url);
      return { command: "xdg-open", opened: true };
    },
    send: (text) => sent.push(text),
  });
  assert.deepEqual(calls[0]?.method, "auth/loginStart");
  assert.deepEqual(calls[1]?.method, "auth/loginComplete");
  assert.equal(sent.length, 2);
  assert.match(sent[0] ?? "", /Open this URL to sign in with Z\.AI/);
  assert.ok(sent[0]?.includes("https://login.example.test/auth?state=s"));
  assert.match(sent[1] ?? "", /Configured Z\.AI Coding Plan as Tester/);
  assert.deepEqual(urls, ["https://login.example.test/auth?state=s"]);
});

test("runLoginCommand api-key 变体：密钥只进协议 params，不进任何可见文案", async () => {
  const sent: string[] = [];
  let captured: unknown;
  await runLoginCommand({
    args: "bigmodel-coding-plan-api-key sk-secret-1234",
    request: async (_method, params) => {
      captured = params;
      return { configPath: "/x/cfg", model: "glm-5", ok: true, provider: "bigmodel" };
    },
    send: (text) => sent.push(text),
  });
  assert.deepEqual(captured, { apiKey: "sk-secret-1234", provider: "bigmodel" });
  assert.match(sent[0] ?? "", /Configured BigModel Coding Plan/);
  assert.ok(!sent.join("\n").includes("sk-secret-1234"), "api key must not be echoed");
});

test("runLoginCommand 失败：结果 chunk 以 zcode login zai 收尾", async () => {
  const sent: string[] = [];
  await runLoginCommand({
    args: "zai-coding-plan",
    request: async (method) =>
      method === "auth/loginStart"
        ? {
            authorizeUrl: "https://x.test/a",
            expiresAt: 1_800_000_000,
            flowId: "f",
            pollIntervalSec: 1,
          }
        : { error: "Authorization timed out.", ok: false },
    openBrowser: async () => ({ command: "xdg-open", opened: true }),
    send: (text) => sent.push(text),
  });
  assert.match(sent.at(-1) ?? "", /Authorization timed out/);
  assert.match(sent.at(-1) ?? "", /zcode login zai$/);
});

test("runLoginCommand 裸命令与未知参数 → usage 文案", async () => {
  const sent: string[] = [];
  const request = async () => {
    throw new Error("must not be called");
  };
  await runLoginCommand({ args: "", request, send: (t) => sent.push(t) });
  await runLoginCommand({ args: "weird", request, send: (t) => sent.push(t) });
  assert.equal(sent.length, 2);
  assert.match(sent[0] ?? "", /^Usage: \/login/);
});

test("runLogoutCommand 走 auth/logout 并回报凭据路径", async () => {
  const sent: string[] = [];
  const methods: string[] = [];
  await runLogoutCommand({
    request: async (method) => {
      methods.push(method);
      return { credentialsPath: "/x/credentials.json", ok: true };
    },
    send: (t) => sent.push(t),
  });
  assert.deepEqual(methods, ["auth/logout"]);
  assert.match(sent[0] ?? "", /Logged out from Coding Plan accounts/);
});
