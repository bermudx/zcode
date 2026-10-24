// Footer stats 行：左区用量簇（↑in ↓out R… CH%）+ ctx 仪表，右区
// `(provider) model · thought · mode · agents:N`；pwd 行 `~/cwd (branch)`。
// 覆盖纯 formatter 与事件 → UsageTotalsAccumulator → stats 行的端到端路径。

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  formatContextSegment,
  formatCwdLabel,
  formatIdentityCluster,
  formatModelLabel,
  formatPwdLine,
  formatStatsLine,
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

test("identity cluster joins model · thought · mode (ctx gauge lives on the left)", () => {
  const line = formatIdentityCluster(
    state({
      mode: "yolo",
      model: "prov/model",
      thoughtLevel: "max",
    }),
  );
  assert.equal(line, "(prov) model · max · yolo");
});

test("agents segment appears only while running", () => {
  const base = { mode: "yolo", model: "m" };
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

test("pwd line appends the branch and truncates the tail", () => {
  assert.equal(formatPwdLine({ branch: "main", cwdLabel: "~/piz", width: 100 }), "~/piz (main)");
  assert.equal(formatPwdLine({ cwdLabel: "~/piz", width: 100 }), "~/piz");
  assert.equal(formatPwdLine({ branch: "main", cwdLabel: "~/piz", width: 0 }), "");
  const truncated = formatPwdLine({ branch: "main", cwdLabel: "~/build/piz", width: 10 });
  assert.equal(visibleWidth(truncated), 10);
  assert.ok(truncated.startsWith("~/build"), truncated);
});

test("stats line lays out left cluster + ctx gauge and right identity", () => {
  const s = state({
    cacheHitRate: 0.995,
    contextUsage: { contextUsed: 103_000, contextWindow: 255_000 },
    mode: "yolo",
    model: "prov/model",
    thoughtLevel: "max",
    usageTotals: totals(1_900_000, 43_000, 1_800_000),
  });
  const left = "↑1.9M ↓43k R1.8M CH99.5% 40.4%/255k";
  const right = "(prov) model · max · yolo";
  assert.equal(
    formatStatsLine({ state: s, width: 100 }),
    `${left}${" ".repeat(100 - visibleWidth(left) - visibleWidth(right))}${right}`,
  );
});

test("stats line truncates left first, then right, as the width shrinks", () => {
  const s = state({
    cacheHitRate: 0.995,
    contextUsage: { contextWindow: 255_000, contextUsed: 103_000 },
    mode: "yolo",
    model: "prov/model",
    thoughtLevel: "max",
    usageTotals: totals(1_900_000, 43_000, 1_800_000),
  });
  const left = "↑1.9M ↓43k R1.8M CH99.5% 40.4%/255k";
  // 50 列：左区 36 列放得下，右区压到剩余 12 列（≥2 空格间距保住；
  // truncateToWidth 的截断标记带零宽 ANSI，按可见宽度断言）。
  const mid = formatStatsLine({ state: s, width: 50 });
  assert.equal(visibleWidth(mid), 50);
  assert.ok(mid.startsWith(`${left}  (prov) model`), mid);
  assert.doesNotMatch(mid, /max/);
  // 30 列：左区放不下 → 行尾 "…" 截断，右区退场。
  const tiny = formatStatsLine({ state: s, width: 30 });
  assert.equal(visibleWidth(tiny), 30);
  assert.match(tiny, /^↑1\.9M/);
});

test("right zone drops out below a 4-column window instead of leaving a fragment", () => {
  const s = state({
    cacheHitRate: 0.995,
    contextUsage: { contextWindow: 255_000, contextUsed: 103_000 },
    mode: "yolo",
    model: "prov/model",
    thoughtLevel: "max",
    usageTotals: totals(1_900_000, 43_000, 1_800_000),
  });
  const left = "↑1.9M ↓43k R1.8M CH99.5% 40.4%/255k";
  // 左区 35 列：38–40 列时右区余窗仅 1–3 列（`(`/`(p`/`(pr` 碎片带）→
  // 右区整体退场，不留可见毛刺。
  for (const width of [38, 39, 40]) {
    assert.equal(formatStatsLine({ state: s, width }), left, `width=${width}`);
  }
  // 41 列：余窗回到 4 列，右区以 ≥4 列前缀重新进场，≥2 空格间距保持。
  const back = formatStatsLine({ state: s, width: 41 });
  assert.equal(visibleWidth(back), 41);
  assert.ok(back.startsWith(`${left}  (pro`), back);
  // 整段收缩谱不变式（35–100 列）：右区要么退场，要么以 ≥4 列在场。
  for (let width = 35; width <= 100; width++) {
    const line = formatStatsLine({ state: s, width });
    assert.ok(visibleWidth(line) <= width, `width=${width}: ${line}`);
    if (line === left) continue;
    assert.ok(line.startsWith(`${left}  `), `width=${width}: ${line}`);
    const rest = line.slice(left.length + 2);
    assert.ok(visibleWidth(rest) >= 4, `width=${width}: ${JSON.stringify(rest)}`);
  }
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
    // ctx 仪表贴用量簇（同区，pi footer 同构），单空格分隔。
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
