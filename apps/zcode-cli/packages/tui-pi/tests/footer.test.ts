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
import { createHarness } from "./harness.js";

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

/** formatter 输出内嵌着色段：内容断言前剥掉 SGR。 */
const strip = (text: string): string => text.replace(/\x1b\[[0-9;:]*m/g, "");

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
    // meta 行：cwd 标签常驻（无 branch 时无括号段），行尾是身份簇
    // （pi 语法：model • mode；单 provider 无前缀）。
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

test("workspaceGitBranch lands in the meta row only", async () => {
  const h = createHarness({ workspaceDirectory: "/home/u/proj" });
  try {
    h.store.set("workspaceGitBranch", "main");
    const rows = footerRows(h.app);
    assert.match(strip(rows[1] ?? ""), /\(main\)/);
    assert.doesNotMatch(rows[0] ?? "", /\(main\)/);
  } finally {
    await h.stop();
  }
});

test("startup options deliver the branch to the meta row", async () => {
  const h = createHarness({ workspaceDirectory: "/home/u/proj" });
  try {
    await h.app.applyStartupOptions({ workspaceGitBranch: "feature/x" });
    const rows = footerRows(h.app);
    assert.match(strip(rows[1] ?? ""), /\(feature\/x\)/);
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
