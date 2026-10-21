// Workflow run cards, rendered inline between transcript and composer.
// Compact: one line per run. Expanded (empty-draft "+"/"-"): actors, node
// usage, reports preview, log tail. State comes from the shared
// TuiWorkflowMirror reducer fed by replay + live progress envelopes.

import type { Component } from "@earendil-works/pi-tui";
import type {
  TuiWorkflowMirror,
  TuiWorkflowRunSeed,
} from "@zcode/tui/internals";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { PiTheme, Style } from "./theme.js";

const RUN_STATUS: Record<WorkflowRunState["status"], { glyph: string; pick: (t: PiTheme) => Style }> = {
  completed: { glyph: "✓", pick: (t) => t.success },
  errored: { glyph: "✗", pick: (t) => t.danger },
  pending: { glyph: "◌", pick: (t) => t.muted },
  running: { glyph: "⟳", pick: (t) => t.accent },
  stopped: { glyph: "■", pick: (t) => t.muted },
};

const ACTOR_GLYPHS: Record<string, string> = {
  completed: "✓",
  running: "●",
  waiting: "○",
};

const MAX_EXPANDED_ACTORS = 8;
const MAX_LOG_LINES = 6;
const MAX_REPORT_PREVIEW_LINES = 4;

const truncate = (text: string, width: number): string =>
  text.length > width && width > 1 ? `${text.slice(0, width - 1)}…` : text;

export class WorkflowCard implements Component {
  private mirror: TuiWorkflowMirror;
  private expanded = false;

  constructor(
    mirror: TuiWorkflowMirror,
    private readonly theme: PiTheme,
  ) {
    this.mirror = mirror;
  }

  setMirror(mirror: TuiWorkflowMirror): void {
    this.mirror = mirror;
  }

  toggleExpanded(): boolean {
    this.expanded = !this.expanded;
    return this.expanded;
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  get runCount(): number {
    return this.mirror.state.runs.length;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const runs = this.mirror.state.runs;
    if (runs.length === 0) return [];
    const lines: string[] = [];
    for (const run of runs) {
      const seed = this.mirror.seedByRunId[run.runId];
      lines.push(`  ${this.runLine(run, seed, width)}`);
      if (!this.expanded) continue;
      lines.push(...this.expandedLines(run, width));
    }
    return lines;
  }

  private runLine(
    run: WorkflowRunState,
    seed: TuiWorkflowRunSeed | undefined,
    width: number,
  ): string {
    const theme = this.theme;
    const status = RUN_STATUS[run.status] ?? RUN_STATUS.pending;
    const label = seed?.label ?? run.runId;
    const used = run.usage.nodesUsed;
    const settled =
      run.nodes.filter((node) => node.phase === "settled").length +
      (run.usage.nodesUnlistedSettled ?? 0);
    const actors = run.actors.length;
    const parts = [
      `${status.pick(theme)(status.glyph)} ${theme.text(truncate(label, 40))}`,
      theme.muted(run.status),
      theme.muted(`${settled}/${used} nodes`),
    ];
    if (actors > 0) parts.push(theme.muted(`${actors} actors`));
    if (run.error) parts.push(theme.danger(truncate(run.error, 40)));
    if (!this.expanded) parts.push(theme.muted("(+ to expand)"));
    return parts.join(theme.muted("  ·  ")).slice(0, Math.max(width, 40));
  }

  private expandedLines(run: WorkflowRunState, width: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    for (const actor of run.actors.slice(0, MAX_EXPANDED_ACTORS)) {
      const glyph = ACTOR_GLYPHS[actor.status] ?? "○";
      const name = actor.name ?? actor.siteId;
      const nodes = run.nodes.filter(
        (n) => n.actorSiteId === actor.siteId && n.actorOrdinal === actor.ordinal,
      );
      const active = nodes.find((n) => n.phase === "executing" || n.phase === "repairing");
      const lastTool = active?.lastTool;
      const toolText = lastTool
        ? `  ${theme.dim(lastTool.name)}${lastTool.target ? theme.muted(` ${truncate(lastTool.target, 30)}`) : ""}`
        : "";
      lines.push(
        `    ${theme.muted(glyph)} ${theme.text(truncate(name, 24))} ${theme.muted(actor.status)}${toolText}`,
      );
    }
    if (run.actors.length > MAX_EXPANDED_ACTORS) {
      lines.push(`    ${theme.muted(`… ${run.actors.length - MAX_EXPANDED_ACTORS} more actors`)}`);
    }
    for (const report of (run.reports ?? []).slice(0, 2)) {
      for (const line of report.preview.split("\n").slice(0, MAX_REPORT_PREVIEW_LINES)) {
        if (line.trim()) lines.push(`    ${theme.dim(truncate(line, width - 8))}`);
      }
    }
    const tail = this.mirror.logTailByRunId[run.runId] ?? [];
    for (const line of tail.slice(-MAX_LOG_LINES)) {
      lines.push(`    ${theme.muted("│")} ${theme.dim(truncate(line, width - 8))}`);
    }
    if (run.resultPreview) {
      lines.push(`    ${theme.muted("→")} ${theme.text(truncate(run.resultPreview, width - 8))}`);
    }
    return lines;
  }
}
