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

test("turn_complete authoritative summary replaces folded totals", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-test" });
  try {
    h.resetOutput();
    h.app.applyEvent(
      sessionEvent("model_complete", {
        content: "chunk",
        stopReason: "stop",
        usage: { inputTokens: 1_000, outputTokens: 10 },
      }),
    );
    h.app.applyEvent(
      sessionEvent("turn_complete", {
        usage: {
          cacheReadTokens: 1_800_000,
          cacheWriteTokens: 0,
          inputTokens: 1_900_000,
          modelRequestCount: 2,
          outputTokens: 43_000,
          reasoningTokens: 0,
          source: "provider",
          totalTokens: 1_943_000,
          webFetchRequests: 0,
          webSearchRequests: 0,
        },
      }),
    );
    await h.flush();
    // Authoritative summary wins over the in-turn fold (1.0k/10).
    assert.match(h.output(), /↑1\.9M ↓43k R1\.8M/);
  } finally {
    await h.stop();
  }
});
