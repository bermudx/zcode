import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setActiveTuiThemeMode } from "@zcode/tui/internals";
import type { TuiWorkflowMirror } from "@zcode/tui/internals";
import { createPiTheme } from "../src/theme.js";
import { WorkflowCard } from "../src/workflow.js";

const theme = () => {
  setActiveTuiThemeMode("dark");
  return createPiTheme({ noColor: true });
};

const mirrorWithRun = (): TuiWorkflowMirror => ({
  logTailByRunId: { run1: ["log line one", "log line two"] },
  seedByRunId: { run1: { label: "build-and-test", runId: "run1" } },
  state: {
    revision: 1,
    runs: [
      {
        actors: [
          { ordinal: 0, siteId: "a1", status: "running" },
          { name: "reviewer", ordinal: 1, siteId: "a2", status: "completed" },
        ],
        lastEventSequence: 5,
        nodes: [
          { actorOrdinal: 0, actorSiteId: "a1", ordinal: 0, phase: "executing", siteId: "n1" },
          { actorOrdinal: 0, actorSiteId: "a1", ordinal: 1, phase: "settled", siteId: "n2" },
        ],
        runId: "run1",
        status: "running",
        usage: { nodesUsed: 2, spentTokens: 100 },
      },
    ],
  },
});

test("WorkflowCard renders nothing without runs", () => {
  const card = new WorkflowCard(
    { logTailByRunId: {}, seedByRunId: {}, state: { revision: 0, runs: [] } },
    theme(),
  );
  assert.deepEqual(card.render(80), []);
  assert.equal(card.runCount, 0);
});

test("WorkflowCard renders compact run line", () => {
  const card = new WorkflowCard(mirrorWithRun(), theme());
  const lines = card.render(120);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /build-and-test/);
  assert.match(lines[0]!, /running/);
  assert.match(lines[0]!, /1\/2 nodes/);
});

test("WorkflowCard expands on toggle to show actors and log tail", () => {
  const card = new WorkflowCard(mirrorWithRun(), theme());
  assert.equal(card.toggleExpanded(), true);
  const lines = card.render(120);
  assert.ok(lines.length > 3);
  assert.ok(lines.some((line) => line.includes("reviewer")));
  assert.ok(lines.some((line) => line.includes("log line two")));
});

test("run line never exceeds a narrow terminal with a long CJK label (noColor)", () => {
  // P003-F2 回归：旧实现对 label 按 UTF-16 length 截 40、整行 slice 到
  // Math.max(width, 40)——noColor（identity 样式）下 40 个 CJK 字符 = 80 列，
  // 20 列终端上整行 40+ 列，pi-tui doRender 对超宽行抛错崩 TUI。
  const mirror = mirrorWithRun();
  mirror.seedByRunId.run1 = { label: "构建工作流".repeat(8), runId: "run1" };
  const card = new WorkflowCard(mirror, theme());
  for (const width of [20, 12, 8]) {
    const lines = card.render(width);
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= width,
        `width ${width}: visible ${visibleWidth(line)} — over-width lines crash TuiMainScreen`,
      );
    }
  }
});

test("run line with ANSI styles truncates to width without cutting mid-escape", () => {
  // 彩色模式：parts 带 ANSI 样式。旧的 `.slice(0, N)` 按 UTF-16 单位切，可能
  // 切进转义序列中间（悬挂 CSI）。宽度感知截断必须同时保证：可见宽 ≤ width、
  // 行尾没有不完整的 `\x1b[…` 序列。
  setActiveTuiThemeMode("dark");
  const colored = createPiTheme({ colorMode: "256color" });
  const mirror = mirrorWithRun();
  mirror.seedByRunId.run1 = { label: "构建".repeat(30), runId: "run1" };
  const card = new WorkflowCard(mirror, colored);
  for (const width of [20, 16]) {
    for (const line of card.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: visible ${visibleWidth(line)}`);
      assert.doesNotMatch(line, /\x1b\[[0-9;]*$/, `dangling CSI at end of: ${JSON.stringify(line)}`);
    }
  }
});

test("workflow seed failures surface a stderr diagnostic and keep the TUI alive", async () => {
  // P003-F4 回归：replay/list 失败曾被静默吞掉（"回放失败不该让 TUI 起不来"
  // 只保留了前半句）——用户无感丢失 workflow 状态。现在每次失败必须单行
  // stderr 留痕，且启动照常完成。
  const { createHarness } = await import("./harness.js");
  const stderrLines: string[] = [];
  const h = createHarness({
    listWorkflowRuns: () => Promise.reject(new Error("list boom")),
    replayWorkflowRuns: () => Promise.reject(new Error("replay boom")),
    stderr: { write: (line: string) => (stderrLines.push(line), true) } as never,
  });
  try {
    await h.app.applyStartupOptions({});
    // seedWorkflowRuns 是 void 触发的异步链：按「两条诊断都到达」为终态等待。
    await h.flush(() => stderrLines.length >= 2, 2_000);
    assert.ok(
      stderrLines.some((line) => line.includes("replay boom")),
      `replay diagnostic missing: ${JSON.stringify(stderrLines)}`,
    );
    assert.ok(
      stderrLines.some((line) => line.includes("list boom")),
      `list diagnostic missing: ${JSON.stringify(stderrLines)}`,
    );
    // 启动韧性：TUI 仍在跑、未置退出码。
    assert.equal(h.exitCode(), undefined);
    assert.equal(h.terminal.stopped, false);
  } finally {
    await h.stop();
  }
});
