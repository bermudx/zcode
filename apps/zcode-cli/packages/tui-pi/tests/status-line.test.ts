// Footer stats 行：左区用量簇（↑in ↓out R… [W…] [CH%] [$cost]）+ ctx 仪表，
// 右区 `(provider) model • thought • mode • agents:N`；pwd 行 `~/cwd (branch)`
// + 可选右对齐额度簇。覆盖纯 formatter、定价折算与事件 →
// UsageTotalsAccumulator → stats 行的端到端路径（pi footer 同构）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  formatContextSegment, formatCostSegment, formatCwdLabel, formatIdentityCluster, formatModelLabel,
  appendFooterRightZone, formatPwdLine, formatStatsLine, formatTokens, formatUsageCluster,
} from "../src/status-line.js";
import type { PiTheme } from "../src/theme.js";
import { bareModelId, cacheExclusiveInputTokens, lookupModelRates, requestCostUsd } from "../src/pricing.js";
import type { AppStore } from "../src/store.js";
import { createHarness, sessionEvent } from "./harness.js";

const totals = (inputTokens: number, outputTokens: number, cacheReadTokens: number) => ({
  cacheReadTokens,
  cacheWriteTokens: 0,
  costUsd: 0,
  inputTokens,
  outputTokens,
});

const state = (over: Partial<AppStore["state"]>): AppStore["state"] =>
  ({ contextUsage: {}, ...over }) as AppStore["state"];

// 真 ANSI 包装：pi-tui visibleWidth/truncateToWidth 按可见宽度计算，零宽。
const testTheme = {
  danger: (text: string) => `\x1b[31m${text}\x1b[0m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
  warning: (text: string) => `\x1b[33m${text}\x1b[0m`,
} as unknown as PiTheme;

/** formatter 输出内嵌着色段：内容断言前剥掉 SGR。 */
const strip = (text: string): string => text.replace(/\x1b\[[0-9;:]*m/g, "");

test("formatTokens matches pi-mono boundaries", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_500), "1.5k");
  assert.equal(formatTokens(103_000), "103k");
  assert.equal(formatTokens(255_000), "255k");
  assert.equal(formatTokens(1_800_000), "1.8M");
  assert.equal(formatTokens(12_300_000), "12M");
});

test("usage cluster gates every segment on a positive count (pi footer 同门)", () => {
  assert.equal(
    formatUsageCluster({ usageTotals: totals(1_900_000, 43_000, 1_800_000), cacheHitRate: 0.995 }),
    "↑1.9M ↓43k R1.8M CH99.5%",
  );
  // pi: `if (usageTotals.input)` —— 零计数不出段，R0 不再出现。
  assert.equal(formatUsageCluster({ usageTotals: totals(500, 5, 0) }), "↑500 ↓5");
  assert.equal(formatUsageCluster({ usageTotals: totals(0, 0, 0) }), undefined);
  assert.equal(formatUsageCluster({}), undefined);
});

test("W segment appears only with cache-write traffic", () => {
  const withWrite = { ...totals(1_000, 10, 800), cacheWriteTokens: 200 };
  assert.equal(
    formatUsageCluster({ usageTotals: withWrite, cacheHitRate: 0.8 }),
    "↑1.0k ↓10 R800 W200 CH80.0%",
  );
});

test("CH requires the latest request hit rate; the session-aggregate fallback is gone", () => {
  // cache 流量在但最近命中率缺 → 不出段（pi 无累计回退）。
  assert.equal(formatUsageCluster({ usageTotals: totals(1_000, 10, 995) }), "↑1.0k ↓10 R995");
  // 命中率出界属于 provider 数据异常：隐藏，不伪造 100%+。
  assert.equal(
    formatUsageCluster({ usageTotals: totals(1_000, 10, 995), cacheHitRate: 1.5 }),
    "↑1.0k ↓10 R995",
  );
});

test("ctx segment: ? without used, (auto) suffix, degrade and hide", () => {
  assert.equal(formatContextSegment({}), undefined);
  assert.equal(formatContextSegment({ contextUsed: 5_000 }), "ctx 5.0k");
  assert.equal(
    formatContextSegment({ contextUsed: 103_000, contextWindow: 255_000 }),
    "40.4%/255k",
  );
  // pi：percent 缺失为 `?`（非 –）；(auto) 直接拼段尾。
  assert.equal(formatContextSegment({ contextWindow: 255_000 }), "?/255k");
  assert.equal(
    formatContextSegment({ contextUsed: 103_000, contextWindow: 255_000 }, { autoCompact: true }),
    "40.4%/255k (auto)",
  );
  assert.equal(formatContextSegment({ contextUsed: 5_000 }, { autoCompact: true }), "ctx 5.0k (auto)");
});

test("model label splits provider/ into the pi form", () => {
  assert.equal(formatModelLabel("prov/model"), "(prov) model");
  assert.equal(formatModelLabel("a/b/c"), "(a/b) c");
  assert.equal(formatModelLabel("GLM-5.3-Flash"), "GLM-5.3-Flash");
  assert.equal(formatModelLabel(""), undefined);
});

test("identity cluster: provider prefix only with >1 available providers", () => {
  // 单 provider：无前缀（pi getAvailableProviderCount()>1 同规约）。
  assert.equal(
    formatIdentityCluster(state({ mode: "yolo", model: "zai/glm-5.3-flash", thoughtLevel: "max" })),
    "glm-5.3-flash • max • yolo",
  );
  // 两个 provider：前缀进场。
  const multi = state({
    mode: "yolo",
    model: "zai/glm-5.3-flash",
    modelOptions: [
      { ref: { modelId: "glm-5.3-flash", providerId: "zai" } },
      { ref: { modelId: "m", providerId: "other" } },
    ] as unknown as AppStore["state"]["modelOptions"],
    thoughtLevel: "max",
  });
  assert.equal(formatIdentityCluster(multi), "(zai) glm-5.3-flash • max • yolo");
});

test("identity cluster: thinking off, agents segment", () => {
  assert.equal(
    formatIdentityCluster(state({ model: "m", thoughtLevel: "off" })),
    "m • thinking off",
  );
  assert.equal(
    formatIdentityCluster(
      state({
        model: "m",
        subagents: { ended: { total: 0 }, running: [{}, {}] },
      } as unknown as AppStore["state"]),
    ),
    "m • agents:2",
  );
  assert.equal(formatIdentityCluster(state({})), "no-model");
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

test("pwd line appends the branch and truncates the tail with ...", () => {
  assert.equal(formatPwdLine({ branch: "main", cwdLabel: "~/piz", width: 100 }), "~/piz (main)");
  assert.equal(formatPwdLine({ cwdLabel: "~/piz", width: 100 }), "~/piz");
  assert.equal(formatPwdLine({ branch: "main", cwdLabel: "~/piz", width: 0 }), "");
  const truncated = formatPwdLine({ branch: "main", cwdLabel: "~/build/piz", width: 10 });
  assert.equal(visibleWidth(truncated), 10);
  assert.ok(truncated.startsWith("~/build"), truncated);
});

test("activity row right-aligns the quota cluster; drops it when no room", () => {
  const base = { theme: testTheme };
  // pi provider-balance 同款右对齐 + dim，间距 ≥2 列。
  const line = appendFooterRightZone({
    ...base,
    line: "  Ready.",
    right: "5h: 99% ↻4h",
    width: 40,
  });
  assert.ok(strip(line).endsWith("5h: 99% ↻4h"), line);
  assert.ok(strip(line).startsWith("  Ready."), line);
  assert.equal(visibleWidth(line), 40);
  // 回归：运行时 ActivityLine 传入的是 Loader/Text.render 已补到满宽的
  // 行（尾部填充空格非内容）——右区须按内容宽对齐，不能因满宽填充丢读数。
  const padded = appendFooterRightZone({
    ...base,
    line: "  Ready." + " ".repeat(32),
    right: "5h: 99% ↻4h",
    width: 40,
  });
  assert.ok(strip(padded).endsWith("5h: 99% ↻4h"), padded);
  assert.equal(visibleWidth(padded), 40);
  // idle 兜底行（" ".repeat(width)）：同样落右区。
  const idle = appendFooterRightZone({
    ...base,
    line: " ".repeat(40),
    right: "5h: 99% ↻4h",
    width: 40,
  });
  assert.ok(strip(idle).endsWith("5h: 99% ↻4h"), idle);
  // 内容真实占满行宽：仍丢额度读数而不是截断 status/spinner 文本。
  const full = appendFooterRightZone({
    ...base,
    line: "x".repeat(40),
    right: "5h: 99% ↻4h",
    width: 40,
  });
  assert.equal(strip(full), "x".repeat(40));
  // 余量 <2 列：丢额度读数而不是截断 status/spinner 文本。
  const tight = appendFooterRightZone({
    ...base,
    line: "  " + "x".repeat(30),
    right: "5h: 99% ↻4h",
    width: 40,
  });
  assert.equal(strip(tight), "  " + "x".repeat(30));
  // 无额度读数：原样返回行内容。
  assert.equal(
    appendFooterRightZone({ ...base, line: "  Ready.", width: 40 }),
    "  Ready.",
  );
});

test("meta line is stats + ctx | identity only (cwd moved to the activity row)", () => {
  const s = state({
    cacheHitRate: 1,
    contextUsage: { contextUsed: 103_000, contextWindow: 255_000 },
    mode: "yolo",
    model: "zai/glm-5.3",
    thoughtLevel: "max",
    usageTotals: totals(463_000, 118_000, 27_000_000),
    workspaceGitBranch: "dev",
  });
  const line = strip(
    formatStatsLine({
      state: s,
      theme: testTheme,
      width: 200,
    }),
  );
  // cwd/branch 不在 meta 行（已上移到活动行行首）。
  assert.ok(line.startsWith("↑463k"), line);
  assert.doesNotMatch(line, /cwd|build\/piz|\(dev\)/);
  assert.ok(line.includes("↑463k ↓118k R27M CH100.0%"), line);
  assert.ok(line.includes("40.4%/255k"), line);
  assert.ok(line.endsWith("glm-5.3 • max • yolo"), line);
});

test("stats line lays out left cluster + ctx gauge and right identity (pi separators)", () => {
  const s = state({
    cacheHitRate: 0.995,
    contextUsage: { contextUsed: 103_000, contextWindow: 255_000 },
    mode: "yolo",
    model: "zai/glm-5.3-flash",
    thoughtLevel: "max",
    usageTotals: totals(1_900_000, 43_000, 1_800_000),
  });
  const left = "↑1.9M ↓43k R1.8M CH99.5% 40.4%/255k";
  const right = "glm-5.3-flash • max • yolo";
  assert.equal(
    visibleWidth(formatStatsLine({ state: s, theme: testTheme, width: 100 })),
    visibleWidth(left) + visibleWidth(right) + (100 - visibleWidth(left) - visibleWidth(right)),
  );
  const line = formatStatsLine({ state: s, theme: testTheme, width: 100 });
  assert.ok(strip(line).includes(left), line);
  assert.ok(strip(line).trimEnd().endsWith(right), line);
});

test("stats line ctx percent colors by pi thresholds inside the dim line", () => {
  const base = {
    contextUsage: { contextWindow: 1_000 },
    model: "m",
    usageTotals: totals(10, 1, 0),
  };
  const at = (used: number) =>
    formatStatsLine(
      { state: state({ ...base, contextUsage: { contextUsed: used, contextWindow: 1_000 } }), theme: testTheme, width: 200 },
    );
  // >90 danger、>70 warning、其余随行 dim（无独立色）。
  assert.ok(at(950).includes("\x1b[31m95.0%/1.0k\x1b[0m"), at(950));
  assert.ok(at(800).includes("\x1b[33m80.0%/1.0k\x1b[0m"), at(800));
  assert.ok(at(100).includes("\x1b[2m10.0%/1.0k\x1b[0m"), at(100));
  // (auto) 一起着色（pi 拼段后统一上色）。
  const auto = formatStatsLine(
    { state: state({ ...base, autoCompact: true, contextUsage: { contextUsed: 950, contextWindow: 1_000 } }), theme: testTheme, width: 200 },
  );
  assert.ok(strip(auto).includes("95.0%/1.0k (auto)"), auto);
});

test("cost segment renders totals-estimated dollars with a 3-decimal fixed form", () => {
  assert.equal(formatCostSegment(undefined), undefined);
  assert.equal(formatCostSegment(0), undefined);
  assert.equal(formatCostSegment(0.0193), "$0.019");
});

test("stats line shows the $ segment between CH and the ctx gauge", () => {
  const s = state({
    contextUsage: { contextUsed: 103_000, contextWindow: 255_000 },
    model: "zai/glm-5.3-flash",
    usageTotals: { ...totals(34_000, 9_400, 318_000), costUsd: 0.0193 },
  });
  const line = formatStatsLine({ state: s, theme: testTheme, width: 200 });
  assert.ok(strip(line).includes("↑34k ↓9.4k R318k $0.019 40.4%/255k"), line);
});

test("stats line truncates left first, then right, as the width shrinks (pi behavior)", () => {
  const s = state({
    cacheHitRate: 0.995,
    contextUsage: { contextWindow: 255_000, contextUsed: 103_000 },
    mode: "yolo",
    model: "prov/model",
    thoughtLevel: "max",
    usageTotals: totals(1_900_000, 43_000, 1_800_000),
  });
  const left = "↑1.9M ↓43k R1.8M CH99.5% 40.4%/255k";
  // 50 列：左区放得下，右区压到剩余宽度（≥2 空格间距保住；截断无标记）。
  const mid = formatStatsLine({ state: s, theme: testTheme, width: 50 });
  assert.equal(visibleWidth(mid), 50);
  assert.ok(strip(mid).includes(left), mid);
  assert.doesNotMatch(strip(mid), /yolo$/);
  // 30 列：左区放不下 → 行尾 "..." 截断，右区退场。
  const tiny = formatStatsLine({ state: s, theme: testTheme, width: 30 });
  assert.equal(visibleWidth(tiny), 30);
  assert.match(strip(tiny), /^↑1\.9M/);
  // pi 行为：窄窗下右区可以剩 1–3 列碎片（早期 <4 列整体退场守卫已移除）。
  const fragment = formatStatsLine({ state: s, theme: testTheme, width: 39 });
  const stripped = strip(fragment);
  assert.ok(stripped.startsWith(left), stripped);
  assert.ok(visibleWidth(fragment) <= 39, fragment);
});

test("pricing: bare ids, rate lookup, cache-exclusive input basis", () => {
  assert.equal(bareModelId("zai/glm-5.3-flash"), "glm-5.3-flash");
  assert.equal(bareModelId("GLM-5.3-Flash"), "glm-5.3-flash");
  assert.equal(lookupModelRates("zai/glm-5.3-flash")?.input, 0.15);
  assert.equal(lookupModelRates("unknown-model"), undefined);
  // AI SDK v6 inputTokens 已含 cache：成本基座去掉 cache 两项，下限 0。
  assert.equal(
    cacheExclusiveInputTokens({ cacheReadTokens: 318_000, cacheWriteTokens: 0, inputWindowTokens: 352_000 }),
    34_000,
  );
  assert.equal(
    cacheExclusiveInputTokens({ cacheReadTokens: 400_000, cacheWriteTokens: 0, inputWindowTokens: 352_000 }),
    0,
  );
});

test("pricing: glm-5.3-flash session math reproduces the pi footer dollar figure", () => {
  const rates = lookupModelRates("zai/glm-5.3-flash");
  assert.ok(rates);
  const cost = requestCostUsd(rates!, {
    cacheReadTokens: 318_000,
    cacheWriteTokens: 0,
    inputTokens: 34_000,
    outputTokens: 9_400,
  });
  // ↑34k×0.15 + ↓9.4k×0.5 + R318k×0.03 (per 1M) = 0.01934 → `$0.019`。
  assert.equal(cost.toFixed(3), "0.019");
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
      cacheWriteTokens: 0,
      costUsd: 0,
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
    // 零 cache 段不出（pi 门）；R0 不再出现。
    assert.match(h.output(), /↑2\.0k ↓20(?! R)/);
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
      cacheWriteTokens: 0,
      costUsd: 0,
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
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 1_200,
      outputTokens: 10,
    });
  } finally {
    await h.stop();
  }
});

test("cost folds per request with the current model's catalog rates", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    h.app.applyEvent(
      sessionEvent("model_selected", { modelSelection: { modelId: "glm-5.3-flash", providerId: "zai" } }),
    );
    // pi 粘贴样本复算：inputWindow 352k（含 cache 318k）→ 非 cache 34k。
    h.app.applyEvent(
      sessionEvent("model_complete", {
        content: "chunk",
        stopReason: "stop",
        usage: {
          cacheReadTokens: 318_000,
          cacheWriteTokens: 0,
          inputTokens: 352_000,
          outputTokens: 9_400,
        },
      }),
    );
    await h.flush();
    assert.equal(h.store.state.usageTotals?.costUsd.toFixed(3), "0.019");
  } finally {
    await h.stop();
  }
});

test("unknown model keeps cost at zero and hides the segment", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    h.app.applyEvent(
      sessionEvent("model_selected", { modelSelection: { modelId: "mystery", providerId: "acme" } }),
    );
    h.app.applyEvent(
      sessionEvent("model_complete", {
        content: "chunk",
        stopReason: "stop",
        usage: { inputTokens: 1_000, outputTokens: 10 },
      }),
    );
    await h.flush();
    assert.equal(h.store.state.usageTotals?.costUsd, 0);
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
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 500,
      outputTokens: 5,
    });
    h.resetOutput();
    h.app.applyEvent(sessionEvent("session_created", { contextWindow: 255_000 }));
    await h.flush();
    assert.match(h.output(), /↑500 ↓5/);
    assert.doesNotMatch(h.output(), /↑9\.0M|9\.9M|R0/);
  } finally {
    await h.stop();
  }
});

// ---- attach 绑定种子（快照 runtime.usageTotals / contextUsage → 页脚） ----

test("bind seed lands after reset: swap result seeds usage totals, ctx, CH", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    // /resume 结果同包：resetSessionProjection + 快照种子。旧顺序先 merge
    // projection 再 reset 会把种子整体抹掉——断言种子最终可见。
    h.app.applyResult({
      projection: { contextUsed: 103_000, contextWindow: 255_000 },
      resetSessionProjection: true,
      response: "",
      usageTotals: {
        cacheReadTokens: 27_000_000,
        cacheWriteTokens: 0,
        inputTokens: 463_000,
        latestCacheHitRate: 1,
        outputTokens: 118_000,
      },
    });
    await h.flush();
    assert.deepEqual(h.store.state.contextUsage, {
      contextUsed: 103_000,
      contextWindow: 255_000,
    });
    assert.deepEqual(h.store.state.usageTotals, {
      cacheReadTokens: 27_000_000,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 463_000,
      outputTokens: 118_000,
    });
    assert.equal(h.store.state.cacheHitRate, 1);
  } finally {
    await h.stop();
  }
});

test("live folds continue on top of the bind seed", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    h.app.applyResult({
      response: "",
      usageTotals: {
        cacheReadTokens: 1_000,
        cacheWriteTokens: 0,
        inputTokens: 463_000,
        outputTokens: 118_000,
      },
    });
    h.app.applyEvent(
      sessionEvent("model_complete", {
        content: "chunk",
        stopReason: "stop",
        usage: { cacheReadTokens: 100, inputTokens: 1_000, outputTokens: 10 },
      }),
    );
    await h.flush();
    assert.deepEqual(h.store.state.usageTotals, {
      cacheReadTokens: 1_100,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 464_000,
      outputTokens: 118_010,
    });
  } finally {
    await h.stop();
  }
});

test("model_complete payload.contextWindow seeds the ctx gauge (attach 无 session_created)", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    h.app.applyEvent(
      sessionEvent("model_complete", {
        content: "chunk",
        contextWindow: 255_000,
        stopReason: "stop",
        usage: { inputTokens: 267_000, outputTokens: 5 },
      }),
    );
    await h.flush();
    assert.deepEqual(h.store.state.contextUsage, {
      contextUsed: 267_000,
      contextWindow: 255_000,
    });
  } finally {
    await h.stop();
  }
});

test("ctx segment falls back to the current model's catalog contextWindow (pi 同款)", () => {
  const options = [
    {
      contextWindow: 255_000,
      ref: { modelId: "glm-5.3", providerId: "zai" },
    },
  ] as unknown as AppStore["state"]["modelOptions"];
  const withFallback = strip(
    formatStatsLine({
      state: state({ model: "zai/glm-5.3", modelOptions: options }),
      theme: testTheme,
      width: 200,
    }),
  );
  assert.ok(withFallback.includes("?/255k"), `expected ?/255k in: ${withFallback}`);
  // provider 不匹配不取别家窗口；catalog 缺 contextWindow 也不伪造。
  const wrongProvider = strip(
    formatStatsLine({
      state: state({ model: "other/glm-5.3", modelOptions: options }),
      theme: testTheme,
      width: 200,
    }),
  );
  assert.ok(!wrongProvider.includes("?/255k"), `unexpected ?/255k in: ${wrongProvider}`);
  // 会话事件已给出窗口时优先（快照/model_complete 读数赢过目录）。
  const explicit = strip(
    formatStatsLine({
      state: state({
        contextUsage: { contextWindow: 128_000 },
        model: "zai/glm-5.3",
        modelOptions: options,
      }),
      theme: testTheme,
      width: 200,
    }),
  );
  assert.ok(explicit.includes("?/128k"), `expected ?/128k in: ${explicit}`);
});

// 双向漂移门：attach 的 session 种子由 core 经 contracts
// summarizeSessionUsageTotals 折叠——必须与客户端累计器逐事件折叠同结果，
// 否则接入前后的 ↑/↓/R 读数会跳变。
test("accumulator fold matches contracts summarizeSessionUsageTotals on the same events", async () => {
  const { summarizeSessionUsageTotals } = await import("@zcode/contracts");
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    const events = [
      sessionEvent("model_complete", {
        cacheHit: { latestHitRate: 0.9 },
        content: "a",
        stopReason: "stop",
        usage: { cacheReadTokens: 800, cacheWriteTokens: 10, inputTokens: 1_000, outputTokens: 10 },
      }),
      sessionEvent("model_complete", {
        cacheHit: { latestHitRate: null },
        content: "b",
        stopReason: "stop",
        usage: { outputTokens: 5, totalTokens: 600 },
      }),
      sessionEvent("model_network_status", {
        type: "model_request_failed",
        usage: { inputTokens: 50, outputTokens: 0 },
      }),
    ];
    for (const event of events) h.app.applyEvent(event);
    await h.flush();
    const wire = summarizeSessionUsageTotals(events);
    assert.deepEqual(h.store.state.usageTotals, {
      cacheReadTokens: wire?.cacheReadTokens,
      cacheWriteTokens: wire?.cacheWriteTokens,
      costUsd: 0,
      inputTokens: wire?.inputTokens,
      outputTokens: wire?.outputTokens,
    });
    assert.equal(h.store.state.cacheHitRate, wire?.latestCacheHitRate);
  } finally {
    await h.stop();
  }
});
