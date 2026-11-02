// Footer 恒高回归：statusBox 恒为两行（活动行 + meta 行）。旧实现把 pi-tui
// Loader（自带空行 + 内容行）在 busy 时挂进 composerBox、idle 时摘除——
// footer 在行数间跳变，整屏内容随 spinner 顶起/落下。现两个子组件常驻且
// 各自恒为单行：活动行（spinner + status + 行尾额度簇）、meta 行
// （cwd + 用量/ctx | 身份簇）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TurnId } from "@zcode/contracts";
import type { PiTuiApp } from "../src/app.js";
import type { AppStore } from "../src/store.js";
import { effectiveContextUsage, formatStatsLine } from "../src/status-line.js";
import type { PiTheme } from "../src/theme.js";
import { createHarness } from "./harness.js";

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

/** formatter 输出内嵌着色段：内容断言前剥掉 SGR。 */
const strip = (text: string): string => text.replace(/\x1b\[[0-9;:]*m/g, "");

// 真 ANSI 包装：pi-tui visibleWidth/truncateToWidth 按可见宽度计算，零宽。
const testTheme = {
  danger: (text: string) => `\x1b[31m${text}\x1b[0m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
  warning: (text: string) => `\x1b[33m${text}\x1b[0m`,
} as unknown as PiTheme;

const totals = (inputTokens: number, outputTokens: number, cacheReadTokens: number) => ({
  cacheReadTokens,
  cacheWriteTokens: 0,
  costUsd: 0,
  inputTokens,
  outputTokens,
});

const state = (over: Partial<AppStore["state"]>): AppStore["state"] =>
  ({ contextUsage: {}, ...over }) as AppStore["state"];

const footerRows = (app: PiTuiApp, width = 80): string[] =>
  (app as unknown as { statusBox: { render(w: number): string[] } }).statusBox.render(
    width,
  );

test("footer stays two rows across idle → busy → idle", async () => {
  const h = createHarness({ initialMode: "build", initialModel: "prov/model" });
  try {
    h.store.set("status", "Ready.");
    let rows = footerRows(h.app);
    assert.equal(rows.length, 2);
    assert.match(rows[0] ?? "", /Ready\./);
    assert.doesNotMatch(rows[0] ?? "", SPINNER);
    // meta 行：session 统计 + 身份簇（cwd 已上移活动行行首）。
    assert.ok((visibleWidth(rows[1] ?? "") > 0));
    assert.match(strip(rows[1] ?? ""), /model • build/);
    assert.doesNotMatch(strip(rows[1] ?? ""), /\(prov\)/);
    assert.doesNotMatch(rows[1] ?? "", /Ready\./);

    h.store.set("busy", true);
    rows = footerRows(h.app);
    assert.equal(rows.length, 2);
    assert.match(rows[0] ?? "", SPINNER);
    assert.match(rows[0] ?? "", /Ready\./);
    // meta 行不再有 busy 字面量（活动行即 busy 指示）。
    assert.doesNotMatch(rows[1] ?? "", /busy/);

    h.store.set("busy", false);
    rows = footerRows(h.app);
    assert.equal(rows.length, 2);
    assert.doesNotMatch(rows[0] ?? "", SPINNER);
    assert.match(rows[0] ?? "", /Ready\./);
  } finally {
    await h.stop();
  }
});

test("cwd label and workspaceGitBranch anchor the activity row, not the meta row", async () => {
  const h = createHarness({ workspaceDirectory: "/home/u/proj" });
  try {
    h.store.set("workspaceGitBranch", "main");
    const rows = footerRows(h.app);
    const top = strip(rows[0] ?? "");
    assert.ok(top.startsWith("/home/u/proj (main)"), top);
    assert.doesNotMatch(strip(rows[1] ?? ""), /proj|\(main\)/);
  } finally {
    await h.stop();
  }
});

test("startup options deliver the branch to the activity row", async () => {
  const h = createHarness({ workspaceDirectory: "/home/u/proj" });
  try {
    await h.app.applyStartupOptions({ workspaceGitBranch: "feature/x" });
    const rows = footerRows(h.app);
    assert.match(strip(rows[0] ?? ""), /\/home\/u\/proj \(feature\/x\)/);
    assert.doesNotMatch(strip(rows[1] ?? ""), /\(feature\/x\)/);
  } finally {
    await h.stop();
  }
});

test("activeTurnId alone spins the activity row (attach remote turn)", async () => {
  const h = createHarness();
  try {
    h.store.set("activeTurnId", "turn-1" as TurnId);
    assert.match(footerRows(h.app)[0] ?? "", SPINNER);
    h.store.set("activeTurnId", undefined);
    assert.doesNotMatch(footerRows(h.app)[0] ?? "", SPINNER);
  } finally {
    await h.stop();
  }
});

test("busy with empty status shows the interrupt hint; long status never wraps", async () => {
  const h = createHarness();
  try {
    h.store.set("busy", true);
    assert.match(footerRows(h.app)[0] ?? "", /esc to interrupt/);
    h.store.set("status", "x".repeat(200));
    const rows = footerRows(h.app, 40);
    assert.equal(rows.length, 2);
    for (const row of rows) assert.ok(visibleWidth(row) <= 40);
  } finally {
    await h.stop();
  }
});

test("effectiveContextUsage clamps the gauge to the GLM compact cap", () => {
  // GLM + 1M 投影窗口 → min(262k, 1M)；provider 前缀剥掉后按 bare id 匹配。
  const glm = effectiveContextUsage(
    state({
      model: "zai/glm-5.3",
      contextUsage: { contextUsed: 36_000, contextWindow: 1_000_000 },
    }),
  );
  assert.deepEqual(glm, {
    usage: { contextUsed: 36_000, contextWindow: 262_000 },
    compactCapped: true,
  });
  // 目录窗口比 cap 小 → 不放大（min 语义，与 core resolveCompactContextWindow 一致）。
  const smaller = effectiveContextUsage(
    state({ model: "glm-5.3-flash", contextUsage: { contextUsed: 1_000, contextWindow: 200_000 } }),
  );
  assert.equal(smaller.usage.contextWindow, 200_000);
  assert.equal(smaller.compactCapped, true);
  // 投影/目录窗口全缺 → 直接取 cap：`?/262k` 仍比 `?/1.0M` 诚实。
  const noWindow = effectiveContextUsage(state({ model: "glm-5.3", contextUsage: {} }));
  assert.deepEqual(noWindow, { usage: { contextWindow: 262_000 }, compactCapped: true });
  // 目录回退先算再收紧。
  const catalogOnly = effectiveContextUsage(
    state({
      model: "zai/glm-5.3",
      modelOptions: [
        { ref: { providerId: "zai", modelId: "glm-5.3" }, contextWindow: 1_000_000 },
      ],
    }),
  );
  assert.equal(catalogOnly.usage.contextWindow, 262_000);
  // 非 GLM → 原样：不收紧、不标 (auto)。provider 前缀以 glm- 开头也不算——
  // 谓词作用于剥前缀后的 bare modelId（wire 侧同判）；modelId 自身含斜杠
  // （如 provider/x/foo-glm-y 组合出 provider/x/foo/glm-y）时 last-slash 剥离
  // 会与 wire 的整串 modelId 判定分叉，属已知极端边界，catalog 路径不受影响。
  const other = effectiveContextUsage(
    state({
      model: "anthropic/claude-x",
      contextUsage: { contextUsed: 1_000, contextWindow: 255_000 },
    }),
  );
  assert.deepEqual(other, {
    usage: { contextUsed: 1_000, contextWindow: 255_000 },
    compactCapped: false,
  });
  const glmProvider = effectiveContextUsage(
    state({
      model: "glm-labs/claude-x",
      contextUsage: { contextUsed: 1_000, contextWindow: 255_000 },
    }),
  );
  assert.equal(glmProvider.compactCapped, false);
});

test("stats gauge follows the compact cap: GLM 262k (auto), others keep the model window", () => {
  // 未收紧的 1M 分母会把 100% 刻度放到压缩触发线（~228K）的 ~4.4 倍处。
  const glm = strip(
    formatStatsLine({
      state: state({
        contextUsage: { contextUsed: 36_000, contextWindow: 1_000_000 },
        model: "zai/glm-5.3",
        usageTotals: totals(4_000_000, 36_000, 3_900_000),
      }),
      theme: testTheme,
      width: 200,
    }),
  );
  assert.ok(glm.includes("13.7%/262k (auto)"), glm);
  const other = strip(
    formatStatsLine({
      state: state({
        contextUsage: { contextUsed: 36_000, contextWindow: 1_000_000 },
        model: "kimi/k2",
        usageTotals: totals(4_000_000, 36_000, 3_900_000),
      }),
      theme: testTheme,
      width: 200,
    }),
  );
  assert.ok(other.includes("3.6%/1.0M"), other);
  assert.ok(!other.includes("(auto)"), other);
});
