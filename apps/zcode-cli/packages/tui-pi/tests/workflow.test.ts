import assert from "node:assert/strict";
import { test } from "node:test";
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
