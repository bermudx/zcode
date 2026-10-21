// Session info overlay (Ctrl+X B): mode/model/thought, context usage, todos,
// modified files, subagents, MCP servers, network requests. Mirrors the
// React frontend's sidebar content; state comes from the shared event
// projection and the readSubagents/listMcpServers option ports.

import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type { TuiOptions } from "@zcode/tui/internals";
import type { McpServerStatus } from "@zcode/contracts";
import type { ZCodeSessionSubagentsResult } from "@zcode/shared";
import type { AppStore } from "./store.js";
import type { PiTheme } from "./theme.js";

const MAX_SECTION_ITEMS = 8;

const truncate = (text: string, width: number): string =>
  text.length > width && width > 1 ? `${text.slice(0, width - 1)}…` : text;

const sectionHeader = (theme: PiTheme, title: string): string =>
  `  ${theme.accent("─")} ${theme.accent(title)}`;

export class SessionInfoPanel implements Component, Focusable {
  focused = false;
  private subagents: ZCodeSessionSubagentsResult | undefined;
  private mcpServers: Record<string, McpServerStatus> | undefined;
  private loadFailed = false;

  constructor(
    private readonly tui: TUI,
    private readonly store: AppStore,
    private readonly theme: PiTheme,
    private readonly options: TuiOptions,
    private readonly onClose: () => void,
  ) {
    void this.load();
  }

  handleInput(data: string): void {
    // Esc and Ctrl+X are handled by the app's chord dispatch (dismiss/leader).
    void data;
  }

  invalidate(): void {}

  close(): void {
    this.onClose();
  }

  private async load(): Promise<void> {
    const { listMcpServers, readSubagents } = this.options;
    try {
      if (readSubagents) this.subagents = await readSubagents();
      if (listMcpServers) this.mcpServers = await listMcpServers();
    } catch {
      this.loadFailed = true;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const s = this.store.state;
    const lines: string[] = [""];
    const inner = width - 6;

    lines.push(sectionHeader(theme, "Session"));
    const meta = [`mode:${s.mode}`, s.model, s.thoughtLevel && `thought:${s.thoughtLevel}`]
      .filter(Boolean)
      .join("  ·  ");
    lines.push(`    ${theme.text(truncate(meta, inner))}`);
    const ctx = s.contextUsage;
    if ((ctx.contextWindow ?? 0) > 0) {
      lines.push(
        `    ${theme.muted("ctx")} ${theme.text(`${ctx.contextUsed ?? 0}/${ctx.contextWindow}`)}`,
      );
    }
    if (s.usage && s.usage.totalTokens > 0) {
      lines.push(`    ${theme.muted("tokens")} ${theme.text(String(s.usage.totalTokens))}`);
    }
    if (s.lastEvent) lines.push(`    ${theme.muted("last")} ${theme.dim(truncate(s.lastEvent, inner - 6))}`);

    if (s.todos.length > 0) {
      lines.push(sectionHeader(theme, `Todos (${s.todos.length})`));
      for (const todo of s.todos.slice(0, MAX_SECTION_ITEMS)) {
        const glyph = todo.status === "completed" ? theme.success("✓") : theme.muted("○");
        lines.push(`    ${glyph} ${theme.text(truncate(todo.content, inner - 3))}`);
      }
    }

    if (s.modifiedFiles.length > 0) {
      lines.push(sectionHeader(theme, `Modified files (${s.modifiedFiles.length})`));
      for (const file of s.modifiedFiles.slice(0, MAX_SECTION_ITEMS)) {
        const stats = theme.muted(` +${file.additions} -${file.deletions}`);
        lines.push(`    ${theme.text(truncate(file.filePath, inner - 12))}${stats}`);
      }
    }

    const running = this.subagents?.running ?? [];
    const endedTotal = this.subagents?.ended.total ?? 0;
    if (running.length > 0 || endedTotal > 0) {
      lines.push(
        sectionHeader(theme, `Subagents (${running.length} running, ${endedTotal} ended)`),
      );
      for (const agent of running.slice(0, MAX_SECTION_ITEMS)) {
        lines.push(
          `    ${theme.accent("●")} ${theme.text(truncate(agent.title, inner - 24))} ${theme.muted(agent.subagentType)}`,
        );
      }
      for (const agent of (this.subagents?.ended.items ?? []).slice(0, 3)) {
        const glyph = agent.status === "success" ? theme.success("✓") : theme.danger("✗");
        lines.push(`    ${glyph} ${theme.dim(truncate(agent.title, inner - 3))}`);
      }
    }

    const servers = Object.entries(this.mcpServers ?? {});
    if (servers.length > 0) {
      lines.push(sectionHeader(theme, `MCP servers (${servers.length})`));
      for (const [name, server] of servers.slice(0, MAX_SECTION_ITEMS)) {
        const glyph = server.status === "connected" ? theme.success("●") : theme.danger("●");
        const tools = server.toolCount > 0 ? theme.muted(` ${server.toolCount} tools`) : "";
        const state = server.error ?? server.status;
        lines.push(
          `    ${glyph} ${theme.text(truncate(name, inner - 30))} ${theme.muted(truncate(state, 20))}${tools}`,
        );
      }
    }

    if (s.networkRequests.length > 0) {
      lines.push(sectionHeader(theme, `Network (${s.networkRequests.length})`));
      for (const request of s.networkRequests.slice(-4)) {
        lines.push(`    ${theme.dim(truncate(`${request.method} ${request.url}`, inner))}`);
      }
    }

    if (this.loadFailed) {
      lines.push(`  ${theme.muted("(subagent / MCP data unavailable)")}`);
    }
    lines.push(`  ${theme.muted("Ctrl+X B or Esc to close")}`);
    return lines;
  }
}
