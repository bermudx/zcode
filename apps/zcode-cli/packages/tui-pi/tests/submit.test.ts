// Submit branch semantics: idle → options.submitPrompt with optimistic user
// row; busy → options.sendInput with steer results projected into the queue
// area or restored back into the draft on rejection.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiPromptInput, TuiSendInputResult } from "@zcode/tui/internals";
import { createHarness } from "./harness.js";

test("idle submit calls submitPrompt and appends a local user row", async () => {
  const prompts: TuiPromptInput[] = [];
  const h = createHarness({
    submitPrompt: async (input) => {
      prompts.push(input);
      return { response: "agent reply", traceId: "t1", turnId: "turn-9" };
    },
  });
  h.store.set("messages", []);
  const result = await h.app.submitValue("hello agent");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.text, "hello agent");
  const roles = h.store.state.messages.map((message) => `${message.role}:${message.content}`);
  assert.deepEqual(roles, ["user:hello agent", "agent:agent reply"]);
  assert.equal(result?.turnId, "turn-9");
  assert.equal(h.store.state.busy, false);
  await h.stop();
});

test("submit clears the draft and toggles busy through the turn", async () => {
  const h = createHarness({
    submitPrompt: async () => {
      assert.equal(h.store.state.busy, true);
      return { response: "ok" };
    },
  });
  h.feed("hello");
  await h.app.submitValue(h.draftText());
  assert.equal(h.draftText(), "");
  assert.equal(h.store.state.busy, false);
  await h.stop();
});

test("/login api-key text is redacted in the transcript row", async () => {
  const h = createHarness({ submitPrompt: async () => ({ response: "ok" }) });
  await h.app.submitValue("/login zai-coding-plan-api-key sk-secret-123");
  const userRow = h.store.state.messages.find((message) => message.role === "user");
  assert.ok(userRow);
  assert.ok(!userRow.content.includes("sk-secret-123"));
  await h.stop();
});

test("/compact renders a timeline row instead of echoing the response", async () => {
  const h = createHarness({
    submitPrompt: async () => ({ response: "compacted summary" }),
  });
  await h.app.submitValue("/compact");
  const roles = h.store.state.messages.map((message) => message.role);
  assert.ok(roles.includes("timeline"));
  assert.ok(!roles.includes("agent"));
  await h.stop();
});

test("busy submit steers through sendInput and shows the queue row", async () => {
  const steered: TuiPromptInput[] = [];
  const sendResult: TuiSendInputResult = {
    kind: "queued",
    pendingInputId: "p1",
    queueLength: 1,
    turnId: "turn-1" as never,
  };
  const h = createHarness({
    sendInput: async (input) => {
      steered.push(input);
      return sendResult;
    },
    submitPrompt: async () => ({ response: "unused" }),
  });
  h.store.set("busy", true);
  h.store.set("activeTurnId", "turn-1" as never);
  const result = await h.app.submitValue("queued question");
  assert.equal(result, undefined);
  assert.equal(steered.length, 1);
  assert.equal(steered[0]!.text, "queued question");
  assert.equal(h.store.state.queuedInputs.length, 1);
  assert.equal(h.store.state.queuedInputs[0]!.text, "queued question");
  assert.equal(h.store.state.status, "Steering active turn.");
  await h.stop();
});

test("steered input becomes a transcript user row when drained", async () => {
  // 2026-10-25 live 复现：steer 注入成功后 UI 整场不显示该输入。pending 只进
  // 队列区；turn_steer_drained 的 drainedInputs 必须把它补成 transcript user 行。
  const h = createHarness({
    sendInput: async () =>
      ({ kind: "queued", pendingInputId: "p1", queueLength: 1, turnId: "turn-1" as never }) as TuiSendInputResult,
    submitPrompt: async () => ({ response: "unused" }),
  });
  h.store.set("busy", true);
  h.store.set("activeTurnId", "turn-1" as never);
  await h.app.submitValue("now to my actual point");
  assert.deepEqual(h.store.state.messages, []);
  assert.equal(h.store.state.queuedInputs.length, 1);

  h.app.applyEvent({
    id: "drain-1",
    payload: {
      drainedInputs: [
        { messageId: "m1", pendingInputId: "p1", text: "now to my actual point" },
      ],
      injectedMessageIds: ["m1"],
      pendingInputIds: ["p1"],
      targetTurnId: "turn-1",
    },
    sequenceNumber: 2,
    sessionId: "session-1",
    timestamp: new Date(0),
    traceId: "trace-1",
    type: "turn_steer_drained",
  } as Parameters<typeof h.app.applyEvent>[0]);

  assert.deepEqual(h.store.state.messages, [
    { content: "now to my actual point", id: "m1", role: "user" },
  ]);
  assert.deepEqual(h.store.state.queuedInputs, []);
  await h.stop();
});

test("busy Enter passes the steer delivery (pi-mono parity default)", async () => {
  // Enter 的 busy 缺省是 steer：delivery 缺省值改变的是 attach 模式的 lane
  // （旧本地排队 → 协议直驱 core steerTurn）。这条钉住缺省不再回落 "auto"。
  const deliveries: (string | undefined)[] = [];
  const h = createHarness({
    sendInput: async (_input, options) => {
      deliveries.push(options?.delivery);
      return { kind: "queued", pendingInputId: "s1", queueLength: 1, turnId: "turn-1" as never };
    },
    submitPrompt: async () => ({ response: "unused" }),
  });
  h.store.set("busy", true);
  h.store.set("activeTurnId", "turn-1" as never);
  await h.app.submitValue("redirect please");
  assert.deepEqual(deliveries, ["steer"]);
  await h.stop();
});

test("busy submit with delivery queue keeps the follow-up lane", async () => {
  const deliveries: (string | undefined)[] = [];
  const h = createHarness({
    sendInput: async (_input, options) => {
      deliveries.push(options?.delivery);
      return { kind: "queued", pendingInputId: "q1", queueLength: 1, turnId: "turn-1" as never };
    },
    submitPrompt: async () => ({ response: "unused" }),
  });
  h.store.set("busy", true);
  h.store.set("activeTurnId", "turn-1" as never);
  await h.app.submitValue("after you finish", { delivery: "queue" });
  assert.deepEqual(deliveries, ["queue"]);
  await h.stop();
});

test("queue_unavailable surfaces a status and restores the draft, never a queue row", async () => {
  // P003-F3 / A6：进程内宿主（zcode tui）没有 follow-up 队列消费通道，宿主
  // 显式回 queue_unavailable；UI 必须提示不可排队并恢复草稿——不得显示
  // "已排队"后在回合收尾静默丢失输入。try/finally 保证断言失败也停掉 busy
  // spinner 的 interval（否则进程被定时器拖住不退出）。
  const h = createHarness({
    sendInput: async () => ({ kind: "queue_unavailable" }) as TuiSendInputResult,
    submitPrompt: async () => ({ response: "unused" }),
  });
  try {
    h.store.set("busy", true);
    h.store.set("activeTurnId", "turn-1" as never);
    const result = await h.app.submitValue("follow-up please", { delivery: "queue" });
    assert.equal(result, undefined);
    assert.equal(h.store.state.queuedInputs.length, 0);
    assert.equal(h.draftText(), "follow-up please");
    assert.match(h.store.state.status, /Follow-up queuing is unavailable/);
  } finally {
    await h.stop();
  }
});

test("rejected steer restores the draft and reports the reason", async () => {
  const h = createHarness({
    sendInput: async () => ({ kind: "rejected", reason: "turn_finished" }) as TuiSendInputResult,
    submitPrompt: async () => ({ response: "unused" }),
  });
  h.store.set("busy", true);
  h.store.set("activeTurnId", "turn-1" as never);
  const result = await h.app.submitValue("try again");
  assert.equal(result, undefined);
  assert.equal(h.draftText(), "try again");
  assert.match(h.store.state.status, /Input not queued/);
  await h.stop();
});

test("busy without sendInput reports a still-responding status", async () => {
  const h = createHarness({ submitPrompt: async () => ({ response: "unused" }) });
  h.store.set("busy", true);
  const result = await h.app.submitValue("wait");
  assert.equal(result, undefined);
  assert.equal(h.store.state.status, "Agent is still responding.");
  await h.stop();
});

test("started_turn sendInput applies the result and inserts the user row", async () => {
  const h = createHarness({
    sendInput: async () =>
      ({
        kind: "started_turn",
        result: { response: "steered reply", turnId: "turn-2" },
      }) as TuiSendInputResult,
    submitPrompt: async () => ({ response: "unused" }),
  });
  h.store.set("busy", true);
  h.store.set("activeTurnId", "turn-1" as never);
  const result = await h.app.submitValue("steer this");
  assert.equal(result?.response, "steered reply");
  const roles = h.store.state.messages.map((message) => `${message.role}:${message.content}`);
  assert.deepEqual(roles, ["user:steer this", "agent:steered reply"]);
  await h.stop();
});
