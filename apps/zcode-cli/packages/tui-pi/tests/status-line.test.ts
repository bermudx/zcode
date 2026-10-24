// Footer meta 行：左区 cwd + 用量簇（↑in ↓out R… CH%），右区 ctx +
// `(provider) model · thought · mode · agents:N`。覆盖纯 formatter 与
// 事件 → UsageTotalsAccumulator → meta 行的端到端路径。

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  formatContextSegment,
  formatCwdLabel,
  formatIdentityCluster,
  formatMetaLine,
  formatModelLabel,
  formatTokens,
  formatUsageCluster,
} from "../src/status-line.js";
import type { AppStore } from "../src/store.js";
import { createHarness, sessionEvent } from "./harness.js";

const totals = (inputTokens: number, outputTokens: number, cacheReadTokens: number) => ({
  cacheReadTokens,
  inputTokens,
  outputTokens,
});

const state = (over: Partial<AppStore["state"]>): AppStore["state"] =>
  ({ contextUsage: {}, ...over }) as AppStore["state"];

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
    cacheHitRate: 0.995,
  });
  assert.equal(line, "↑1.9M ↓43k R1.8M CH99.5%");
});

test("cache hit falls back to the session aggregate formula", () => {
  assert.equal(formatUsageCluster({ usageTotals: totals(1_000, 10, 995) }), "↑1.0k ↓10 R995 CH99.5%");
  assert.equal(formatUsageCluster({}), undefined);
});

test("ctx segment degrades without a window and hides without data", () => {
  assert.equal(formatContextSegment({}), undefined);
  assert.equal(formatContextSegment({ contextUsed: 5_000 }), "ctx 5.0k");
  assert.equal(
    formatContextSegment({ contextUsed: 103_000, contextWindow: 255_000 }),
    "40.4%/255k",
  );
});

test("model label splits provider/ into the pi form", () => {
  assert.equal(formatModelLabel("prov/model"), "(prov) model");
  assert.equal(formatModelLabel("a/b/c"), "(a/b) c");
  assert.equal(formatModelLabel("GLM-5.3-Flash"), "GLM-5.3-Flash");
  assert.equal(formatModelLabel(""), undefined);
});

test("identity cluster joins ctx + model · thought · mode", () => {
  const line = formatIdentityCluster(
    state({
      contextUsage: { contextUsed: 103_000, contextWindow: 255_000 },
      mode: "yolo",
      model: "prov/model",
      thoughtLevel: "max",
    }),
  );
  assert.equal(line, "40.4%/255k  (prov) model · max · yolo");
});

test("agents segment appears only while running", () => {
  const base = { contextUsage: {}, mode: "yolo", model: "m" };
  assert.equal(formatIdentityCluster(state(base)), "m · yolo");
  assert.match(
    formatIdentityCluster(
      state({
        ...base,
        subagents: { ended: { total: 0 }, running: [{}, {}] },
      } as unknown as AppStore["state"]),
    ) ?? "",
    /agents:2/,
  );
});

test("cwd label folds the home prefix to ~", () => {
  assert.equal(
    formatCwdLabel({ cwd: "/home/daniel/build/piz", home: "/home/daniel" }),
    "~/build/piz",
  );
  assert.equal(formatCwdLabel({ cwd: "/home/daniel", home: "/home/daniel" }), "~");
  assert.equal(formatCwdLabel({ cwd: "C:\\work\\piz", home: "C:\\work" }), "~/piz");
  assert.equal(formatCwdLabel({ cwd: "/opt/piz", home: "/home/daniel" }), "/opt/piz");
});

test("meta line lays out left cwd + cluster and right identity", () => {
  const s = state({
    cacheHitRate: 0.995,
    contextUsage: { contextUsed: 103_000, contextWindow: 255_000 },
    mode: "yolo",
    model: "prov/model",
    thoughtLevel: "max",
    usageTotals: totals(1_900_000, 43_000, 1_800_000),
  });
  const left = "~/piz  ↑1.9M ↓43k R1.8M CH99.5%";
  const right = "40.4%/255k  (prov) model · max · yolo";
  assert.equal(
    formatMetaLine({ cwdLabel: "~/piz", state: s, width: 100 }),
    `${left}${" ".repeat(100 - left.length - right.length)}${right}`,
  );
});

test("meta line sheds cluster, then cwd, as the width shrinks", () => {
  const s = state({
    contextUsage: { contextWindow: 255_000, contextUsed: 103_000 },
    mode: "yolo",
    model: "prov/model",
    usageTotals: totals(1_900_000, 43_000, 1_800_000),
  });
  const right = "40.4%/255k  (prov) model · yolo";
  // 60 列放不下 cluster + right：cluster 先退场。
  assert.equal(
    formatMetaLine({ cwdLabel: "~/piz", state: s, width: 60 }),
    `~/piz${" ".repeat(60 - 5 - right.length)}${right}`,
  );
  // 再窄：cwd 左省略但尾部保留（budget = 40-31-2 = 7 → "…" + 6 格尾段）。
  const shrunk = formatMetaLine({ cwdLabel: "~/build/piz", state: s, width: 40 });
  assert.equal(shrunk, `…ld/piz${" ".repeat(40 - 7 - right.length)}${right}`);
  // 极窄：只剩右区且硬截断（truncateToWidth 的 "..." 标记带 ANSI，按可见宽度断言）。
  const tiny = formatMetaLine({ cwdLabel: "~/build/piz", state: s, width: 20 });
  assert.equal(visibleWidth(tiny), 20);
  assert.match(tiny, /^40\.4%/);
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
    // 用量簇在左区、ctx 仪表在右区，中间隔着对齐空白。
    assert.match(h.output(), /↑1\.9M ↓43k R1\.8M CH99\.5% +40\.4%\/255k/);
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
