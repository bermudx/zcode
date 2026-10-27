// Workflow run cards, rendered inline between transcript and composer.
// Compact: one line per run. Expanded (empty-draft "+"/"-"): actors, node
// usage, reports preview, log tail. State comes from the shared
// TuiWorkflowMirror reducer fed by replay + live progress envelopes.

import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
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
const RUN_FIELD_CELLS = 40;
const ACTOR_NAME_CELLS = 24;
const TOOL_TARGET_CELLS = 30;

// 旧的 `truncate` 按 UTF-16 length 切：40 个 CJK 字符 = 80 列，且可能切进
// ANSI 转义序列中间。改用 pi-tui 的宽度感知截断（grapheme + ANSI 安全）。
const truncate = (text: string, width: number): string =>
  truncateToWidth(text, Math.max(0, width), "…");

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
    const lineWidth = Math.max(1, width);
    const lines: string[] = [];
    for (const run of runs) {
      const seed = this.mirror.seedByRunId[run.runId];
      lines.push(`  ${this.runLine(run, seed, Math.max(1, lineWidth - 2))}`);
      if (!this.expanded) continue;
      lines.push(...this.expandedLines(run, width));
    }
    // 兜底（同 rows.ts clampLines）：WorkflowCard 渲染在 MessageRow 的
    // clampLines 之外，任何一行超过终端宽度都会让 doRender 抛错崩掉客户端。
    return lines.map((line) =>
      visibleWidth(line) <= lineWidth ? line : truncateToWidth(line, lineWidth, "…"),
    );
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
      `${status.pick(theme)(status.glyph)} ${theme.text(truncate(label, RUN_FIELD_CELLS))}`,
      theme.muted(run.status),
      theme.muted(`${settled}/${used} nodes`),
    ];
    if (actors > 0) parts.push(theme.muted(`${actors} actors`));
    if (run.error) parts.push(theme.danger(truncate(run.error, RUN_FIELD_CELLS)));
    if (!this.expanded) parts.push(theme.muted("(+ to expand)"));
    // 旧实现 `slice(0, Math.max(width, 40))` 有三个坑：按 UTF-16 单位切、
    // 窄终端保 40 格、可能切进 ANSI 中间（悬挂转义）。改为按可见宽度截到
    // 调用方预算（已扣除行首 2 格缩进），width 来自真实终端宽度。
    return truncateToWidth(parts.join(theme.muted("  ·  ")), Math.max(1, width), "…");
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
        ? `  ${theme.dim(lastTool.name)}${lastTool.target ? theme.muted(` ${truncate(lastTool.target, TOOL_TARGET_CELLS)}`) : ""}`
        : "";
      lines.push(
        `    ${theme.muted(glyph)} ${theme.text(truncate(name, ACTOR_NAME_CELLS))} ${theme.muted(actor.status)}${toolText}`,
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
