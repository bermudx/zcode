// Status-line usage cluster: pi-mono footer parity for ↑/↓/R/CH/ctx%/win
// segments, plus agents:N when running subagents exist. Covers the pure
// formatter and the end-to-end event → UsageTotalsAccumulator → status line
// path through applyEvent.

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTokens, formatUsageCluster } from "../src/status-line.js";
import { createHarness, sessionEvent } from "./harness.js";

const totals = (inputTokens: number, outputTokens: number, cacheReadTokens: number) => ({
  cacheReadTokens,
  inputTokens,
  outputTokens,
});

test("formatTokens matches pi-mono boundaries", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_500), "1.5k");
  assert.equal(formatTokens(103_000), "103k");
  assert.equal(formatTokens(255_000), "255k");
  assert.equal(formatTokens(1_800_000), "1.8M");
  assert.equal(formatTokens(12_300_000), "12M");
});

test("usage cluster mirrors pi footer segments", () => {
  const line = formatUsageCluster({
    usageTotals: totals(1_900_000, 43_000, 1_800_000),
    contextUsage: { contextUsed: 103_000, contextWindow: 255_000 },
    cacheHitRate: 0.995,
  });
  assert.equal(line, "↑1.9M ↓43k R1.8M CH99.5% 40.4%/255k");
});

test("cache hit falls back to the session aggregate formula", () => {
  const line = formatUsageCluster({
    usageTotals: totals(1_000, 10, 995),
    contextUsage: {},
  });
  assert.equal(line, "↑1.0k ↓10 R995 CH99.5%");
});

test("ctx degrades without a window; cluster hides until data exists", () => {
  assert.equal(formatUsageCluster({ contextUsage: {} }), undefined);
  assert.equal(
    formatUsageCluster({ contextUsage: { contextUsed: 5_000 } }),
    "ctx 5.0k",
  );
});

test("agents segment appears only while running", () => {
  assert.equal(
    formatUsageCluster({ contextUsage: {}, runningSubagents: 0 }),
    undefined,
  );
  assert.equal(
    formatUsageCluster({ contextUsage: {}, runningSubagents: 2 }),
    "agents:2",
  );
});

test("model_complete accumulates per-request usage + latestHitRate", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    h.resetOutput();
    h.app.applyEvent(sessionEvent("session_created", { contextWindow: 255_000 }));
    // contextUsed 是最后一个请求的 input（context meter 口径）；累计 ↑↓R
    // 必须跨两请求求和——1.8M+103k → ↑1.9M，103k/255k → 40.4%。
    for (const usage of [
      { inputTokens: 1_800_000, outputTokens: 20_000, cacheReadTokens: 900_000 },
      { inputTokens: 103_000, outputTokens: 23_000, cacheReadTokens: 900_000 },
    ]) {
      h.app.applyEvent(
        sessionEvent("model_complete", {
          cacheHit: { latestHitRate: 0.995 },
          content: "chunk",
          stopReason: "stop",
          usage,
        }),
      );
    }
    await h.flush();
    assert.equal(h.store.state.cacheHitRate, 0.995);
    // Cumulative across both requests — not the second request's numbers alone.
    assert.match(h.output(), /↑1\.9M ↓43k R1\.8M CH99\.5% 40\.4%\/255k/);
  } finally {
    await h.stop();
  }
});

test("usage accumulates across turns; per-turn summary is not adopted", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    h.app.applyEvent(
      sessionEvent("model_complete", {
        content: "turn 1",
        stopReason: "stop",
        usage: { inputTokens: 1_000, outputTokens: 10 },
      }),
    );
    // turn_complete 的 usage 是回合口径（createModelUsageSummaryFromEvents
    // 只汇总本回合）——累计器不得采纳，否则 footer 打回本回合数字。
    h.app.applyEvent(
      sessionEvent("turn_complete", {
        usage: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inputTokens: 1_000,
          modelRequestCount: 1,
          outputTokens: 10,
          reasoningTokens: 0,
          source: "provider",
          totalTokens: 1_010,
          webFetchRequests: 0,
          webSearchRequests: 0,
        },
      }),
    );
    h.app.applyEvent(
      sessionEvent("model_complete", {
        content: "turn 2",
        stopReason: "stop",
        usage: { inputTokens: 500, outputTokens: 5 },
      }),
    );
    await h.flush();
    assert.deepEqual(h.store.state.usageTotals, {
      cacheReadTokens: 0,
      inputTokens: 1_500,
      outputTokens: 15,
    });
    h.resetOutput();
    h.app.applyEvent(sessionEvent("session_created", { contextWindow: 255_000 }));
    h.app.applyEvent(
      sessionEvent("model_complete", {
        content: "turn 3",
        stopReason: "stop",
        usage: { inputTokens: 500, outputTokens: 5 },
      }),
    );
    await h.flush();
    assert.match(h.output(), /↑2\.0k ↓20 R0/);
  } finally {
    await h.stop();
  }
});

test("the same event id folds exactly once across both delivery paths", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    const event = sessionEvent("model_complete", {
      content: "chunk",
      stopReason: "stop",
      usage: { inputTokens: 1_000, outputTokens: 10 },
    });
    // 真实路径里同一事件由 session sink 与 per-turn onEvent 各投递一次。
    h.app.applyEvent(event);
    h.app.applyEvent({ ...event });
    await h.flush();
    assert.deepEqual(h.store.state.usageTotals, {
      cacheReadTokens: 0,
      inputTokens: 1_000,
      outputTokens: 10,
    });
  } finally {
    await h.stop();
  }
});

test("failed model requests fold usage the same as completions", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    h.app.applyEvent(
      sessionEvent("model_complete", {
        content: "chunk",
        stopReason: "stop",
        usage: { inputTokens: 1_000, outputTokens: 10 },
      }),
    );
    h.app.applyEvent(
      sessionEvent("model_network_status", {
        type: "model_request_failed",
        usage: { inputTokens: 200, outputTokens: 0 },
      }),
    );
    // 其他 network status 类型不计。
    h.app.applyEvent(
      sessionEvent("model_network_status", {
        type: "model_request_started",
      }),
    );
    await h.flush();
    assert.deepEqual(h.store.state.usageTotals, {
      cacheReadTokens: 0,
      inputTokens: 1_200,
      outputTokens: 10,
    });
  } finally {
    await h.stop();
  }
});

test("latestHitRate null leaves cacheHitRate untouched", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    h.app.applyEvent(
      sessionEvent("model_complete", {
        cacheHit: { latestHitRate: 0.5 },
        content: "a",
        stopReason: "stop",
        usage: { inputTokens: 100, outputTokens: 1 },
      }),
    );
    h.app.applyEvent(
      sessionEvent("model_complete", {
        cacheHit: { latestHitRate: null },
        content: "b",
        stopReason: "stop",
        usage: { inputTokens: 50, outputTokens: 1 },
      }),
    );
    await h.flush();
    assert.equal(h.store.state.cacheHitRate, 0.5);
  } finally {
    await h.stop();
  }
});

test("child-session usage events never reach the main footer", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    h.resetOutput();
    h.app.applyEvent(
      sessionEvent("model_complete", {
        content: "main turn",
        stopReason: "stop",
        usage: { inputTokens: 500, outputTokens: 5 },
      }),
    );
    // 子会话自己的 model_complete / turn_complete：footer 只显示主会话累计。
    h.app.applyEvent(
      sessionEvent(
        "model_complete",
        {
          content: "subagent turn",
          stopReason: "stop",
          usage: { inputTokens: 9_000_000, outputTokens: 900_000 },
        },
        { sessionId: "child-session-9" },
      ),
    );
    h.app.applyEvent(
      sessionEvent(
        "turn_complete",
        {
          usage: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTokens: 9_000_000,
            modelRequestCount: 9,
            outputTokens: 900_000,
            reasoningTokens: 0,
            source: "provider",
            totalTokens: 9_900_000,
            webFetchRequests: 0,
            webSearchRequests: 0,
          },
        },
        { sessionId: "child-session-9" },
      ),
    );
    await h.flush();
    // Store 级断言：子会话事件根本不进入累计（渲染帧是累积 buffer，
    // 字符串断言分不清「未渲染」与「渲染后又消失」）。
    assert.deepEqual(h.store.state.usageTotals, {
      cacheReadTokens: 0,
      inputTokens: 500,
      outputTokens: 5,
    });
    h.resetOutput();
    h.app.applyEvent(sessionEvent("session_created", { contextWindow: 255_000 }));
    await h.flush();
    assert.match(h.output(), /↑500 ↓5 R0/);
    assert.doesNotMatch(h.output(), /↑9\.0M|9\.9M/);
  } finally {
    await h.stop();
  }
});
