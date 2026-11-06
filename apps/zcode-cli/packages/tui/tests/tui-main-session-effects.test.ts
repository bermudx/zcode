// WP-F 效果级回归：actor/子会话的原始事件绝不进主转写（user directive 2026-08-23）。
//
// 与 tui-main-session-filter.test.ts 的分工：那个文件钉谓词，这个文件钉**流水线的效果**
// （闸门 → 去重 → applySessionEventToState）。有些回归只在效果层面看得见——尤其是
// actor 的 turn_complete 会不会经 applyTurnCompleteFallbackResponse 把 actor 的答案
// 追加成主转写里的一条 agent 消息。
import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  createSessionEvent,
  type ModelUsageSummary,
  type SessionEvent,
} from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import { applyMainSessionEvent } from "../src/app-session-event-handler.js";
import type { ContextUsage, Message } from "../src/app-model.js";
import { EMPTY_TUI_WORKFLOW_MIRROR, type TuiWorkflowMirror } from "../src/app-workflow-mirror.js";

const COPY = getZCodeCopy("en-US").tui;
const MAIN = "session-main";
const ACTOR = "session-actor-1";

/**
 * 收集所有可观察副作用，用来断言「什么都没发生」。
 *
 * 接的是 **getter** 而不是 id：显式传 `undefined` 会重新触发默认参数替换，
 * 于是「主会话 id 未知」这个用例其实还在按 MAIN 过滤——踩过一次，这里钉住。
 */
function harness(getMainSessionId: () => string | undefined = () => MAIN) {
  const state = {
    messages: [] as Message[],
    statuses: [] as string[],
    lastEvents: [] as string[],
    mirror: EMPTY_TUI_WORKFLOW_MIRROR as TuiWorkflowMirror,
    contextUsage: {} as ContextUsage,
    usage: undefined as ModelUsageSummary | undefined,
  };
  const applied = new Set<string>();
  const input = {
    copy: COPY,
    getMainSessionId,
    setActiveTurnId: () => {},
    setCacheStats: () => {},
    setContextUsage: (update: unknown) => {
      state.contextUsage =
        typeof update === "function"
          ? (update as (current: ContextUsage) => ContextUsage)(state.contextUsage)
          : (update as ContextUsage);
    },
    setLastError: () => {},
    setLastEvent: (value: string) => state.lastEvents.push(value),
    setLiveModelText: () => {},
    setMessages: (update: unknown) => {
      state.messages =
        typeof update === "function"
          ? (update as (current: Message[]) => Message[])(state.messages)
          : (update as Message[]);
    },
    setModel: () => {},
    setNetworkRequests: () => {},
    setStatus: (value: string) => state.statuses.push(value),
    setTodos: () => {},
    setUsage: (update: unknown) => {
      state.usage =
        typeof update === "function"
          ? (update as (current: ModelUsageSummary | undefined) => ModelUsageSummary | undefined)(
              state.usage,
            )
          : (update as ModelUsageSummary | undefined);
    },
    setWorkflowMirror: (update: unknown) => {
      state.mirror =
        typeof update === "function"
          ? (update as (current: TuiWorkflowMirror) => TuiWorkflowMirror)(state.mirror)
          : (update as TuiWorkflowMirror);
    },
    assistantMessageIdsByToolCallId: new Map<string, string>(),
    toolNamesById: new Map<string, string>(),
  } as unknown as Parameters<typeof applyMainSessionEvent>[2];

  return {
    state,
    apply: (event: SessionEvent) => applyMainSessionEvent(event, applied, input),
  };
}

function event(sessionId: string, type: SessionEventType, payload: unknown = {}): SessionEvent {
  return { ...createSessionEvent(type, sessionId as never, payload), sessionId } as SessionEvent;
}

// ── 载荷最重的一条：actor 的 turn_complete 绝不经兜底写进主转写 ──

test("an actor turn_complete never appends its answer through the fallback", () => {
  const h = harness();
  const applied = h.apply(
    event(ACTOR, SessionEventType.TurnComplete, { response: "actor internal answer" }),
  );
  assert.equal(applied, false);
  // 这条是整个 WP-F 里最要命的：兜底会把任意 turn_complete.response 追加成 agent 消息，
  // 所以没有闸门的话 actor 的中间答案会原文出现在主转写里。
  assert.deepEqual(h.state.messages, []);
  assert.deepEqual(h.state.statuses, []);
});

test("a main-session turn_complete still appends through the fallback", () => {
  const h = harness();
  assert.equal(
    h.apply(event(MAIN, SessionEventType.TurnComplete, { response: "the real answer" })),
    true,
  );
  assert.equal(h.state.messages.length, 1);
  assert.equal(h.state.messages[0]?.content, "the real answer");
});

// ── actor 的其余噪音：不产生任何转写 part、不改状态行 ──

test("actor submit_result / tool_call_* create no transcript parts and no status changes", () => {
  const h = harness();
  const toolEvents: readonly [SessionEventType, unknown][] = [
    [
      SessionEventType.ToolCallScheduled,
      { toolCallId: "tc-a", toolName: "submit_result", input: {} },
    ],
    [SessionEventType.ToolCallStarted, { toolCallId: "tc-a", toolName: "submit_result" }],
    [
      SessionEventType.ToolCallResult,
      { toolCallId: "tc-a", toolName: "submit_result", result: { content: "ok" } },
    ],
    [SessionEventType.ToolCallError, { toolCallId: "tc-a", toolName: "submit_result" }],
  ];
  for (const [type, payload] of toolEvents) {
    assert.equal(h.apply(event(ACTOR, type, payload)), false, `${type} passed the gate`);
  }
  assert.deepEqual(h.state.messages, []);
  assert.deepEqual(h.state.statuses, []);
  assert.deepEqual(h.state.lastEvents, []);
});

test("actor turn lifecycle events do not touch the main status line", () => {
  const h = harness();
  h.apply(event(ACTOR, SessionEventType.TurnStarted, {}));
  h.apply(event(ACTOR, SessionEventType.ModelRequest, {}));
  assert.deepEqual(h.state.statuses, []);
});

// ── 没有过滤过头：三个必须活着的表面 ──

test("dwf progress on the parent session still reduces into the mirror", () => {
  const h = harness();
  const applied = h.apply(
    event(MAIN, SessionEventType.DynamicWorkflowRunProgress, {
      runId: "dwfrun-1",
      toolCallId: "tc-1",
      sequence: 0,
      eventType: "run-started",
      payload: { caps: { maxConcurrency: 4 } },
    }),
  );
  assert.equal(applied, true);
  // 卡片的生命线：闸门收得太紧就会把工具卡打回死的文本投影。
  assert.equal(h.state.mirror.state.runs[0]?.runId, "dwfrun-1");
  assert.equal(h.state.mirror.state.runs[0]?.status, "running");
});

test("a mirrored subagent tool event still renders (it carries the parent sessionId)", () => {
  // mirrorSubagentToolEvent 用 createSessionEvent(type, parentSessionId, ...) 铸造，
  // 所以 Agent 工具的渲染不受 WP-F 影响。
  const h = harness();
  const applied = h.apply(
    event(MAIN, SessionEventType.ToolCallScheduled, {
      toolCallId: "tc-agent",
      toolName: "Agent",
      input: { description: "explore" },
    }),
  );
  assert.equal(applied, true);
  assert.equal(h.state.messages.length, 1);
});

test("the actor gate does not depend on event kind — only on session", () => {
  // 同一种事件，父会话过、子会话不过。闸门是会话级的，不是按类型拉黑名单。
  const h = harness();
  assert.equal(h.apply(event(MAIN, SessionEventType.AssistantMessage, { content: "main" })), true);
  assert.equal(
    h.apply(event(ACTOR, SessionEventType.AssistantMessage, { content: "actor" })),
    false,
  );
  assert.deepEqual(
    h.state.messages.map((message) => message.content),
    ["main"],
  );
});

// ── 闸门与去重的组合 ──

test("drops actor events and deduplicates repeated main events", () => {
  const h = harness();
  const actorEvent = event(ACTOR, SessionEventType.AssistantMessage, { content: "noise" });
  h.apply(actorEvent);
  h.apply(actorEvent);
  // 同一主会话事件重复投递时只应用一次。
  const mainEvent = event(MAIN, SessionEventType.AssistantMessage, { content: "signal" });
  assert.equal(h.apply(mainEvent), true);
  assert.equal(h.apply(mainEvent), false);
  assert.deepEqual(
    h.state.messages.map((message) => message.content),
    ["signal"],
  );
});

test("an unknown main session id fails open so the transcript is never blank", () => {
  const h = harness(() => undefined);
  assert.equal(h.apply(event(ACTOR, SessionEventType.AssistantMessage, { content: "x" })), true);
});

// ── ctx 仪表只认主会话往返 ──
// sidecar（session_title/compact/目标校验/tool_internal 嵌套用量）在主
// sessionId 上发 model_complete，session 闸门拦不住；采纳其 usage 会把
// ctx 读数打成 sidecar 小请求（实测 GLM 会话被标题请求打成 0.1%/262k），
// 且 idle 期间没有 main_turn 覆盖会一直挂着。裁决与 event-reducer 共用。

function modelComplete(payload: {
  querySource?: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
  contextWindow?: number;
}): SessionEvent {
  return event(MAIN, SessionEventType.ModelComplete, { content: "x", ...payload });
}

test("sidecar model_complete on the main session never moves the ctx meter or usage", () => {
  const h = harness();
  // 先落一条主会话读数，断言 sidecar 不覆盖它。
  h.apply(
    modelComplete({
      querySource: "main_turn",
      stopReason: "tool-calls",
      usage: { inputTokens: 216_330, outputTokens: 449 },
      contextWindow: 262_144,
    }),
  );
  const settled = { ...h.state.contextUsage };

  for (const sidecar of [
    { querySource: "session_title", stopReason: "stop" },
    { querySource: "compact", stopReason: "stop" },
    { querySource: "goal_completion_verification", stopReason: "stop" },
    { querySource: "subagent", stopReason: "stop" },
    // 无 querySource 的嵌套用量（工具/子任务内部模型调用）靠 stopReason 识别。
    { stopReason: "tool_internal" },
  ]) {
    h.apply(
      modelComplete({
        ...sidecar,
        usage: { inputTokens: 244, outputTokens: 12 },
        contextWindow: 999,
      }),
    );
  }

  assert.deepEqual(h.state.contextUsage, settled);
  assert.equal(h.state.usage?.inputTokens, 216_330);
  // sidecar 完结也不能盖状态行——idle 里闪一条 sidecar 的 token 读数是同款假水位。
  assert.equal(h.state.statuses.length, 1);
});

test("main_turn model_complete updates ctx used with input+output and refreshes the window", () => {
  const h = harness();
  h.apply(
    modelComplete({
      querySource: "main_turn",
      stopReason: "stop",
      usage: { inputTokens: 216_330, outputTokens: 449 },
      contextWindow: 262_144,
    }),
  );
  assert.equal(h.state.contextUsage.contextUsed, 216_779);
  assert.equal(h.state.contextUsage.contextWindow, 262_144);
});

test("an output-only main_turn usage keeps the previous reading (input 缺报不可作水位)", () => {
  const h = harness();
  h.apply(
    modelComplete({
      querySource: "main_turn",
      stopReason: "tool-calls",
      usage: { inputTokens: 216_330, outputTokens: 449 },
      contextWindow: 262_144,
    }),
  );
  // provider 缺报 input 时 output 只是上下文里的一小段，不能把仪表打回 ~0%。
  h.apply(
    modelComplete({
      querySource: "main_turn",
      stopReason: "stop",
      usage: { inputTokens: 0, outputTokens: 449 },
      contextWindow: 262_144,
    }),
  );
  assert.equal(h.state.contextUsage.contextUsed, 216_779);
});

test("a legacy main-session model_complete without querySource still updates the meter", () => {
  const h = harness();
  h.apply(
    modelComplete({
      stopReason: "stop",
      usage: { inputTokens: 5_000, outputTokens: 100 },
      contextWindow: 200_000,
    }),
  );
  assert.equal(h.state.contextUsage.contextUsed, 5_100);
  assert.equal(h.state.contextUsage.contextWindow, 200_000);
});

test("compact boundary events drop the meter to the post-compact level immediately", () => {
  const h = harness();
  h.apply(
    modelComplete({
      querySource: "main_turn",
      stopReason: "tool-calls",
      usage: { inputTokens: 216_330, outputTokens: 449 },
      contextWindow: 262_144,
    }),
  );
  // session_compacted 嵌 compactBoundary 字段；truePost 优先于 post。
  h.apply(
    event(MAIN, SessionEventType.SessionCompacted, {
      compactBoundary: {
        boundaryId: "b1",
        postCompactTokenCount: 40_000,
        truePostCompactTokenCount: 42_500,
      },
    }),
  );
  assert.equal(h.state.contextUsage.contextUsed, 42_500);
  // compact_boundary 事件 payload 本体即 boundary。
  h.apply(
    event(MAIN, SessionEventType.CompactBoundary, {
      boundaryId: "b2",
      postCompactTokenCount: 12_000,
    }),
  );
  assert.equal(h.state.contextUsage.contextUsed, 12_000);
});
