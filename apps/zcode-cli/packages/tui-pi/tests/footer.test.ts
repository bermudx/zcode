// Footer 恒高回归：statusBox 恒为三行（活动行 + pwd 行 + stats 行）。旧实现
// 把 pi-tui Loader（自带空行 + 内容行）在 busy 时挂进 composerBox、idle 时
// 摘除——footer 在行数间跳变，整屏内容随 spinner 顶起/落下。现三个子组件
// 常驻且各自恒为单行。

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TurnId } from "@zcode/contracts";
import type { PiTuiApp } from "../src/app.js";
import { createHarness } from "./harness.js";

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

const footerRows = (app: PiTuiApp, width = 80): string[] =>
  (app as unknown as { statusBox: { render(w: number): string[] } }).statusBox.render(
    width,
  );

test("footer stays three rows across idle → busy → idle", async () => {
  const h = createHarness({ initialMode: "build", initialModel: "prov/model" });
  try {
    h.store.set("status", "Ready.");
    let rows = footerRows(h.app);
    assert.equal(rows.length, 3);
    assert.match(rows[0] ?? "", /Ready\./);
    assert.doesNotMatch(rows[0] ?? "", SPINNER);
    // pwd 行：cwd 标签常驻（无 branch 时无括号段），stats 行是身份簇。
    assert.ok((visibleWidth(rows[1] ?? "") > 0));
    assert.match(rows[2] ?? "", /\(prov\) model · build/);
    assert.doesNotMatch(rows[2] ?? "", /Ready\./);

    h.store.set("busy", true);
    rows = footerRows(h.app);
    assert.equal(rows.length, 3);
    assert.match(rows[0] ?? "", SPINNER);
    assert.match(rows[0] ?? "", /Ready\./);
    // stats 行不再有 busy 字面量（活动行即 busy 指示）。
    assert.doesNotMatch(rows[2] ?? "", /busy/);

    h.store.set("busy", false);
    rows = footerRows(h.app);
    assert.equal(rows.length, 3);
    assert.doesNotMatch(rows[0] ?? "", SPINNER);
    assert.match(rows[0] ?? "", /Ready\./);
  } finally {
    await h.stop();
  }
});

test("workspaceGitBranch lands in the pwd row only", async () => {
  const h = createHarness({ workspaceDirectory: "/home/u/proj" });
  try {
    h.store.set("workspaceGitBranch", "main");
    const rows = footerRows(h.app);
    assert.match(rows[1] ?? "", /\(main\)$/);
    assert.doesNotMatch(rows[2] ?? "", /\(main\)/);
  } finally {
    await h.stop();
  }
});

test("startup options deliver the branch to the pwd row", async () => {
  const h = createHarness({ workspaceDirectory: "/home/u/proj" });
  try {
    await h.app.applyStartupOptions({ workspaceGitBranch: "feature/x" });
    const rows = footerRows(h.app);
    assert.match(rows[1] ?? "", /\(feature\/x\)$/);
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
    assert.equal(rows.length, 3);
    for (const row of rows) assert.ok(visibleWidth(row) <= 40);
  } finally {
    await h.stop();
  }
});
