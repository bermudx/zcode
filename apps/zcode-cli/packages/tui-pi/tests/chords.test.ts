// Chord guards driven through the real input channel: VirtualTerminal →
// TuiMainScreen listeners → dispatchChord / focused component. Asserts on the
// shared status constants so wording stays pinned to internals.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUSY_QUIT_CHOICE_CANCELLED_STATUS,
  BUSY_QUIT_CHOICE_PROMPT,
} from "../src/quit-choice.js";
import {
  CTRL_C_EXIT_PROMPT,
  ESCAPE_PAUSE_PROMPT,
  NO_ACTIVE_OUTPUT_STATUS,
  NO_SELECTABLE_MODEL_STATUS,
  PROMPT_DRAFT_CLEARED_STATUS,
  SIDEBAR_HIDDEN_STATUS,
  SIDEBAR_SHOWN_STATUS,
} from "@zcode/tui/internals";
import type { TuiSubmitPromptResult } from "@zcode/tui/internals";
import {
  LAST_REPLY_COPIED_STATUS,
  NEW_SESSION_BUSY_STATUS,
  NO_QUEUED_TO_RESTORE_STATUS,
  NO_REPLY_TO_COPY_STATUS,
  THINKING_COLLAPSED_STATUS,
  THINKING_EXPANDED_STATUS,
  restoredQueuedStatus,
} from "../src/chords.js";
import {
  CTRL_C,
  CTRL_D,
  CTRL_L,
  CTRL_N,
  CTRL_O,
  CTRL_P,
  CTRL_Q,
  ALT_UP,
  CTRL_T,
  CTRL_X,
  ESC,
  SHIFT_TAB,
  createHarness,
} from "./harness.js";

const modelOption = (providerId: string, modelId: string) =>
  ({ label: `${providerId}/${modelId}`, ref: { providerId, modelId } }) as never;

test("Ctrl+C clears a non-empty draft before arming exit", async () => {
  const h = createHarness();
  h.feed("draft");
  assert.equal(h.draftText(), "draft");
  h.feed(CTRL_C);
  assert.equal(h.draftText(), "");
  assert.equal(h.store.state.status, PROMPT_DRAFT_CLEARED_STATUS);
  assert.equal(h.exitCode(), undefined);
  await h.stop();
});

test("Ctrl+C on empty draft prompts, second press exits", async () => {
  const h = createHarness();
  h.feed(CTRL_C);
  assert.equal(h.store.state.status, CTRL_C_EXIT_PROMPT);
  assert.equal(h.exitCode(), undefined);
  h.feed(CTRL_C);
  assert.equal(h.exitCode(), 0);
  await h.stop();
});

test("SIGINT shares the Ctrl+C guard: first signal prompts, second exits", async () => {
  // 信号路径（多路复用器把 Ctrl-C 递送为 SIGINT）必须与字节路径同语义：
  // 首按只提示，不退出；二次才退出。缺这条时 Node 默认行为是直接终止。
  const h = createHarness();
  h.app.handleCtrlCIntent();
  assert.equal(h.store.state.status, CTRL_C_EXIT_PROMPT);
  assert.equal(h.exitCode(), undefined);
  h.app.handleCtrlCIntent();
  assert.equal(h.exitCode(), 0);
  await h.stop();
});

test("SIGINT with a non-empty draft clears the draft instead of exiting", async () => {
  const h = createHarness();
  h.feed("draft");
  h.app.handleCtrlCIntent();
  assert.equal(h.draftText(), "");
  assert.equal(h.store.state.status, PROMPT_DRAFT_CLEARED_STATUS);
  assert.equal(h.exitCode(), undefined);
  await h.stop();
});

test("Ctrl+D exits only on an empty draft", async () => {
  const h = createHarness();
  h.feed(CTRL_D);
  assert.equal(h.exitCode(), 0);
  await h.stop();
});

test("Ctrl+D keeps a non-empty draft alive", async () => {
  const h = createHarness();
  h.feed("x");
  h.feed(CTRL_D);
  assert.equal(h.exitCode(), undefined);
  await h.stop();
});

test("single Esc while idle reports no active output", async () => {
  const h = createHarness();
  h.feed(ESC);
  assert.equal(h.store.state.status, NO_ACTIVE_OUTPUT_STATUS);
  await h.stop();
});

test("double Esc while busy aborts the active turn", async () => {
  const h = createHarness();
  const controller = new AbortController();
  h.store.turnAbort.current = controller;
  h.store.set("busy", true);
  h.feed(ESC);
  assert.equal(h.store.state.status, ESCAPE_PAUSE_PROMPT);
  assert.equal(controller.signal.aborted, false);
  h.feed(ESC);
  assert.equal(controller.signal.aborted, true);
  await h.stop();
});

test("busy Ctrl+C arms the quit choice; Ctrl+D detaches without aborting", async () => {
  // attach 语义：客户端退出只断开连接，detached 的 turn 必须保持存活。
  const h = createHarness();
  const controller = new AbortController();
  h.store.turnAbort.current = controller;
  h.store.set("busy", true);
  h.feed(CTRL_C);
  assert.equal(h.store.state.status, BUSY_QUIT_CHOICE_PROMPT);
  assert.equal(h.exitCode(), undefined);
  assert.equal(controller.signal.aborted, false);
  h.feed(CTRL_D);
  assert.equal(h.exitCode(), 0);
  assert.equal(controller.signal.aborted, false);
  await h.stop();
});

test("busy Ctrl+C twice stops the agent via requestStopActiveTurn then exits", async () => {
  // armed 内的 Ctrl-C = stop & quit：先等 server 端 session/stop 有界回执，
  // 再收尾本地 abort 退出——与旧"双击 Ctrl-C 杀掉 agent"的肌肉记忆一致。
  let stopCalls = 0;
  const h = createHarness({
    requestStopActiveTurn: async () => {
      stopCalls += 1;
    },
  });
  const controller = new AbortController();
  h.store.turnAbort.current = controller;
  h.store.set("busy", true);
  h.feed(CTRL_C);
  h.feed(CTRL_C);
  await h.flush();
  assert.equal(stopCalls, 1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(h.exitCode(), 0);
  await h.stop();
});

test("busy quit choice Esc cancels back to the running turn", async () => {
  const h = createHarness();
  const controller = new AbortController();
  h.store.turnAbort.current = controller;
  h.store.set("busy", true);
  h.feed(CTRL_C);
  assert.equal(h.store.state.status, BUSY_QUIT_CHOICE_PROMPT);
  h.feed(ESC);
  assert.equal(h.store.state.status, BUSY_QUIT_CHOICE_CANCELLED_STATUS);
  assert.equal(h.exitCode(), undefined);
  assert.equal(controller.signal.aborted, false);
  // 取消后的 Esc 恢复原有 busy pause 语义。
  h.feed(ESC);
  assert.equal(h.store.state.status, ESCAPE_PAUSE_PROMPT);
  await h.stop();
});

test("busy Ctrl+D arms the quit choice; second Ctrl+D detaches", async () => {
  const h = createHarness();
  h.store.set("busy", true);
  h.feed(CTRL_D);
  assert.equal(h.store.state.status, BUSY_QUIT_CHOICE_PROMPT);
  assert.equal(h.exitCode(), undefined);
  h.feed(CTRL_D);
  assert.equal(h.exitCode(), 0);
  await h.stop();
});

test("busy stop & quit without requestStopActiveTurn falls back to a local abort", async () => {
  const h = createHarness();
  const controller = new AbortController();
  h.store.turnAbort.current = controller;
  h.store.set("busy", true);
  h.feed(CTRL_C);
  h.feed(CTRL_C);
  await h.flush();
  assert.equal(controller.signal.aborted, true);
  assert.equal(h.exitCode(), 0);
  await h.stop();
});

test("busy + approval panel: Ctrl+C still arms the quit choice instead of dying in the panel", async () => {
  // 等交互也算 busy：面板持有键盘时退出键不能死键——Ctrl-C 必须先走退出决策
  // （与 SIGINT 路径一致），而不是被 ApprovalPanel 吞掉。
  const h = createHarness();
  h.store.set("busy", true);
  h.store.set("approvalQueue", [
    {
      cleanup: () => {},
      reject: () => {},
      request: {
        requestId: "req-1",
        sessionId: "sess-1",
        traceId: "trace-1",
        toolCallId: "tc-1",
        toolName: "Bash",
        input: { command: "ls" },
        mode: "build",
        ruleId: "rule-1",
        reason: "test approval",
        riskLevel: "medium",
        requestedAt: new Date(),
      },
      resolve: () => {},
      selectedDecision: "deny",
    } as never,
  ]);
  h.feed(CTRL_C);
  assert.equal(h.store.state.status, BUSY_QUIT_CHOICE_PROMPT);
  // armed 内 Ctrl-D 照常分离退出。
  h.feed(CTRL_D);
  assert.equal(h.exitCode(), 0);
  await h.stop();
});

test("busy + non-empty draft: Ctrl+C clears the draft instead of arming", async () => {
  // 草稿清空语义优先于三选一：非空草稿的第一下 Ctrl-C 只清草稿。
  const h = createHarness();
  h.store.set("busy", true);
  h.feed("draft text");
  h.feed(CTRL_C);
  assert.equal(h.store.state.status, PROMPT_DRAFT_CLEARED_STATUS);
  assert.equal(h.draftText(), "");
  assert.equal(h.exitCode(), undefined);
  await h.stop();
});

test("Shift+Tab cycles collaboration mode through options.setMode", async () => {
  const seen: string[] = [];
  const h = createHarness({
    setMode: async (mode) => {
      seen.push(String(mode));
      return { mode: mode as never, response: `Mode switched to ${mode}.` };
    },
  });
  h.feed(SHIFT_TAB);
  await h.flush();
  assert.equal(seen.length, 1);
  assert.equal(h.store.state.mode, seen[0]);
  await h.stop();
});

test("Ctrl+P reports when no selectable models exist", async () => {
  const h = createHarness({ modelOptions: [] });
  h.feed(CTRL_P);
  assert.equal(h.store.state.status, NO_SELECTABLE_MODEL_STATUS);
  await h.stop();
});

test("Ctrl+P rotates to the next model with a silent /model submit", async () => {
  const submitted: string[] = [];
  const result: TuiSubmitPromptResult = { response: "Model switched." };
  const h = createHarness({
    initialModel: "prov/a",
    modelOptions: [modelOption("prov", "a"), modelOption("prov", "b")],
    submitPrompt: async (input) => {
      submitted.push(input.text);
      return result;
    },
  });
  h.feed(CTRL_P);
  await h.flush();
  assert.deepEqual(submitted, ["/model prov/b"]);
  assert.equal(h.store.state.status, "Model switched.");
  await h.stop();
});

test("Ctrl+L opens a filterable model selection panel", async () => {
  const h = createHarness({
    modelOptions: [modelOption("prov", "a"), modelOption("prov", "b")],
  });
  h.feed(CTRL_L);
  const selection = h.store.state.selection;
  assert.ok(selection);
  assert.equal(selection.title, "Switch model");
  assert.equal(selection.filterable, true);
  assert.equal(selection.items.length, 2);
  await h.stop();
});

test("Ctrl+X copies the last agent reply through writeClipboardText", async () => {
  const copied: string[] = [];
  const h = createHarness({
    writeClipboardText: async (text) => {
      copied.push(text);
    },
  });
  h.store.set("messages", [{ content: "final answer", role: "agent" }]);
  h.feed(CTRL_X);
  await h.flush();
  assert.deepEqual(copied, ["final answer"]);
  assert.equal(h.store.state.status, LAST_REPLY_COPIED_STATUS);
  await h.stop();
});

test("Ctrl+X without a reply reports the failure", async () => {
  const h = createHarness();
  h.feed(CTRL_X);
  assert.equal(h.store.state.status, NO_REPLY_TO_COPY_STATUS);
  await h.stop();
});

test("Ctrl+O toggles the session info overlay", async () => {
  const h = createHarness();
  h.feed(CTRL_O);
  assert.equal(h.store.state.status, SIDEBAR_SHOWN_STATUS);
  h.feed(CTRL_O);
  assert.equal(h.store.state.status, SIDEBAR_HIDDEN_STATUS);
  await h.stop();
});

test("Ctrl+O overlay still closes on Esc", async () => {
  const h = createHarness();
  h.feed(CTRL_O);
  assert.equal(h.store.state.status, SIDEBAR_SHOWN_STATUS);
  h.feed(ESC);
  assert.equal(h.store.state.status, SIDEBAR_HIDDEN_STATUS);
  await h.stop();
});

test("Ctrl+N submits /new through the normal pipeline while idle", async () => {
  const submitted: string[] = [];
  const h = createHarness({
    submitPrompt: async (input) => {
      submitted.push(input.text);
      return { response: "" };
    },
  });
  h.feed(CTRL_N);
  await h.flush();
  assert.deepEqual(submitted, ["/new"]);
  await h.stop();
});

test("Ctrl+N while busy only hints and does not submit", async () => {
  const submitted: string[] = [];
  const h = createHarness({
    submitPrompt: async (input) => {
      submitted.push(input.text);
      return { response: "" };
    },
  });
  h.store.set("busy", true);
  h.feed(CTRL_N);
  await h.flush();
  assert.equal(h.store.state.status, NEW_SESSION_BUSY_STATUS);
  assert.deepEqual(submitted, []);
  await h.stop();
});

test("Ctrl+N while an attach turn is active (activeTurnId) only hints", async () => {
  // attach 侧远端发起的 turn 只有 activeTurnId 没有 busy——两条 busy 判定腿都
  // 要盖住，否则 Ctrl+N 会在 attach 下把 /new 排进 steer 队列。
  const submitted: string[] = [];
  const h = createHarness({
    submitPrompt: async (input) => {
      submitted.push(input.text);
      return { response: "" };
    },
  });
  h.store.set("activeTurnId", "turn-1" as never);
  h.feed(CTRL_N);
  await h.flush();
  assert.equal(h.store.state.status, NEW_SESSION_BUSY_STATUS);
  assert.deepEqual(submitted, []);
  await h.stop();
});

test("Ctrl+T toggles thought expansion globally", async () => {
  const h = createHarness();
  assert.equal(h.store.state.expandThoughts, false);
  h.feed(CTRL_T);
  assert.equal(h.store.state.expandThoughts, true);
  assert.equal(h.store.state.status, THINKING_EXPANDED_STATUS);
  h.feed(CTRL_T);
  assert.equal(h.store.state.expandThoughts, false);
  assert.equal(h.store.state.status, THINKING_COLLAPSED_STATUS);
  await h.stop();
});

test("Ctrl+T re-renders existing rows: expanded body reaches the terminal stream", async () => {
  // flag 翻转只是状态；行缓存不 invalidate 的话终端永远看不到展开后的正文。
  // 这条用例钉住 flag → invalidate → re-render 的完整链路。
  const h = createHarness();
  h.store.set("messages", [
    {
      content: "",
      parts: [
        {
          contentCharCount: 23,
          status: "thought",
          text: "preview line one\npreview line two\nexpand-only tail",
          type: "thought",
        },
      ],
      role: "agent",
    },
  ]);
  await h.flush();
  assert.ok(
    !h.output().includes("expand-only tail"),
    "collapsed preview must not show the third reasoning line",
  );
  h.feed(CTRL_T);
  await h.flush();
  assert.ok(
    h.output().includes("expand-only tail"),
    "expanded thought body must reach the terminal stream",
  );
  await h.stop();
});

test("Ctrl+Q while busy queues the draft as a follow-up (delivery queue)", async () => {
  // pi-mono app.message.followUp 对齐：busy Ctrl+Q 显式走 follow-up 队列
  // （attach 模式本地 FIFO），而不是 Enter 的 steer lane。
  const deliveries: (string | undefined)[] = [];
  const h = createHarness({
    sendInput: async (_input, options) => {
      deliveries.push(options?.delivery);
      return { kind: "queued", pendingInputId: "q1", queueLength: 1, turnId: "turn-1" as never };
    },
    submitPrompt: async () => ({ response: "unused" }),
  });
  h.store.set("busy", true);
  h.feed("queue me");
  h.feed(CTRL_Q);
  await h.flush();
  assert.deepEqual(deliveries, ["queue"]);
  assert.equal(h.draftText(), "");
  assert.equal(h.store.state.queuedInputs.length, 1);
  await h.stop();
});

test("Ctrl+Q while idle submits like Enter", async () => {
  const submitted: string[] = [];
  const h = createHarness({
    submitPrompt: async (input) => {
      submitted.push(input.text);
      return { response: "ok" };
    },
  });
  h.feed("send now");
  h.feed(CTRL_Q);
  await h.flush();
  assert.deepEqual(submitted, ["send now"]);
  await h.stop();
});

test("Ctrl+Q on an empty draft is a no-op", async () => {
  const h = createHarness({
    submitPrompt: async () => {
      throw new Error("must not submit");
    },
  });
  h.feed(CTRL_Q);
  await h.flush();
  assert.equal(h.store.state.queuedInputs.length, 0);
  await h.stop();
});

test("Alt+Up with an empty queue reports nothing to restore", async () => {
  const h = createHarness();
  h.feed(ALT_UP);
  await h.flush();
  assert.equal(h.store.state.status, NO_QUEUED_TO_RESTORE_STATUS);
  await h.stop();
});

test("Alt+Up restores queued inputs to the editor and removes them from owners", async () => {
  // pi-mono app.message.dequeue 对齐：steer pending + follow-up 队列按序拼回
  // 输入框，当前草稿保留在末尾；owner 摘除按 id 全量下发。
  const removals: string[][] = [];
  const h = createHarness({
    removeQueuedInputs: async (ids) => {
      removals.push([...ids]);
      return ids;
    },
  });
  h.store.set("queuedInputs", [
    { id: "p1", text: "first queued" },
    { id: "p2", text: "second queued" },
  ]);
  h.feed("current draft");
  h.feed(ALT_UP);
  await h.flush();
  assert.deepEqual(removals, [["p1", "p2"]]);
  assert.equal(h.draftText(), "first queued\n\nsecond queued\n\ncurrent draft");
  assert.equal(h.store.state.status, restoredQueuedStatus(2));
  await h.stop();
});

test("Alt+Up counts only actually-removed items", async () => {
  // 竞态下部分项已被消费：状态按实际移除数报，文本仍全部恢复（输入不丢）。
  const h = createHarness({
    removeQueuedInputs: async () => ["p1"],
  });
  h.store.set("queuedInputs", [
    { id: "p1", text: "still there" },
    { id: "p2", text: "already consumed" },
  ]);
  h.feed(ALT_UP);
  await h.flush();
  assert.equal(h.draftText(), "still there\n\nalready consumed");
  assert.equal(h.store.state.status, restoredQueuedStatus(1));
  await h.stop();
});

test("Alt+Up without the removeQueuedInputs port still restores the text", async () => {
  // 端口未接线的宿主：文本恢复不缺席，队列行交给事件投影收敛。
  const h = createHarness();
  h.store.set("queuedInputs", [{ id: "p1", text: "orphaned queue item" }]);
  h.feed(ALT_UP);
  await h.flush();
  assert.equal(h.draftText(), "orphaned queue item");
  assert.equal(h.store.state.status, restoredQueuedStatus(1));
  await h.stop();
});
