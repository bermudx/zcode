// SubagentDirectory: store.state.subagents 唯一 owner 的事件驱动目录。
// 覆盖初始/事件刷新、subagent tool mirror 排除、主会话 ToolCallResult
// 门控、并发去重、reset/dispose 的 epoch 守卫与端口缺省静默。

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZCodeSessionSubagentsResult } from "@zcode/shared";
import type { TuiSubmitPromptResult } from "@zcode/tui/internals";
import { createHarness, sessionEvent } from "./harness.js";

const snapshot = (running: number, ended = 0): ZCodeSessionSubagentsResult => ({
  revision: 1,
  childSessionIds: [],
  ended: {
    items: [],
    nextCursor: undefined,
    total: ended,
  },
  running: Array.from({ length: running }, (_, i) => ({
    childSessionId: `child-${i}`,
    status: "running" as const,
    subagentType: "explore",
    title: `agent-${i}`,
  })),
});

test("constructor refresh lands the directory snapshot in store", async () => {
  const h = createHarness({
    getMainSessionId: () => "sess-test",
    readSubagents: async () => snapshot(2),
  });
  try {
    await h.flush();
    assert.equal(h.store.state.subagents?.running.length, 2);
    assert.equal(h.store.state.subagentsError, undefined);
    assert.match(h.output(), /agents:2/);
  } finally {
    await h.stop();
  }
});

test("directory events refresh; subagent tool mirrors do not", async () => {
  let calls = 0;
  const h = createHarness({
    getMainSessionId: () => "sess-test",
    readSubagents: async () => {
      calls += 1;
      return snapshot(0);
    },
  });
  try {
    await h.flush();
    const baseline = calls;
    // subagent 工具镜像被剥离（changesSubagentDirectory 规约）。
    h.app.applyEvent(
      sessionEvent("tool_call_started", {
        callId: "tc-1",
        source: "subagent",
        toolName: "Bash",
      }),
    );
    await h.flush();
    assert.equal(calls, baseline);
    // 主会话 ToolCallResult 触发；兄弟子会话的 ToolCallResult 不触发。
    h.app.applyEvent(
      sessionEvent("tool_call_result", { callId: "tc-2", toolName: "Bash" }),
    );
    await h.flush();
    assert.equal(calls, baseline + 1);
    h.app.applyEvent(
      sessionEvent("tool_call_result", { callId: "tc-3", toolName: "Bash" }, {
        sessionId: "child-session-9",
      }),
    );
    await h.flush();
    assert.equal(calls, baseline + 1);
    h.app.applyEvent(sessionEvent("subagent_spawned", { childSessionId: "c1" }));
    await h.flush();
    assert.equal(calls, baseline + 2);
  } finally {
    await h.stop();
  }
});

test("concurrent refreshes dedupe to one in-flight read", async () => {
  let calls = 0;
  const resolvers: Array<(v: ZCodeSessionSubagentsResult) => void> = [];
  const h = createHarness({
    getMainSessionId: () => "sess-test",
    readSubagents: () =>
      new Promise<ZCodeSessionSubagentsResult>((resolve) => {
        calls += 1;
        resolvers.push(resolve);
      }),
  });
  try {
    // constructor refresh in-flight；额外刷新只置 dirty，由循环串行重拉。
    h.app.applyEvent(sessionEvent("subagent_spawned", { childSessionId: "c1" }));
    h.app.applyEvent(sessionEvent("subagent_spawned", { childSessionId: "c2" }));
    assert.equal(calls, 1);
    resolvers[0]?.(snapshot(1));
    await h.flush();
    assert.equal(calls, 2);
    resolvers[1]?.(snapshot(1));
    await h.flush();
    assert.equal(calls, 2);
    assert.equal(h.store.state.subagents?.running.length, 1);
  } finally {
    await h.stop();
  }
});

test("stale snapshot is dropped when the main session changes", async () => {
  let mainSessionId = "sess-test";
  const resolvers: Array<(v: ZCodeSessionSubagentsResult) => void> = [];
  const h = createHarness({
    getMainSessionId: () => mainSessionId,
    readSubagents: () =>
      new Promise<ZCodeSessionSubagentsResult>((resolve) => {
        resolvers.push(resolve);
      }),
  });
  try {
    await h.flush();
    // 父会话先行切换到新会话，再重置：reset 内 refresh 以新 parentId
    // 派发读（resolver[1]）；旧读（resolver[0]，旧 epoch + 旧 parentId）
    // 落地时必须被双重守卫丢弃。
    mainSessionId = "sess-other";
    h.app.applyResult({
      resetSessionProjection: true,
      response: "",
    } as TuiSubmitPromptResult);
    assert.equal(h.store.state.subagents, undefined);
    resolvers[0]?.(snapshot(5));
    await h.flush();
    assert.notEqual(h.store.state.subagents?.running.length, 5);
    resolvers[1]?.(snapshot(3));
    await h.flush();
    assert.equal(h.store.state.subagents?.running.length, 3);
  } finally {
    await h.stop();
  }
});

test("missing readSubagents port stays silent", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    await h.flush();
    assert.equal(h.store.state.subagents, undefined);
    h.app.applyEvent(sessionEvent("subagent_spawned", { childSessionId: "c1" }));
    await h.flush();
    assert.equal(h.store.state.subagents, undefined);
    assert.equal(h.store.state.subagentsError, undefined);
  } finally {
    await h.stop();
  }
});
