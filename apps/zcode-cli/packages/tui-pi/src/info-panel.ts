// Session info overlay (Ctrl+O): mode/model/thought, context usage, todos,
// modified files, subagents, MCP servers, network requests. Mirrors the
// React frontend's sidebar content; state comes from the shared event
// projection, the store's SubagentDirectory snapshot (single owner — the
// panel renders store.state.subagents and only triggers a refresh), and a
// one-shot listMcpServers port read (MCP has no event source).

import { truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { TuiOptions } from "@zcode/tui/internals";
import type { McpServerStatus } from "@zcode/contracts";
import type { AppStore } from "./store.js";
import { effectiveContextUsage } from "./status-line.js";
import type { PiTheme } from "./theme.js";

const MAX_SECTION_ITEMS = 8;
const MAX_STATUS_DETAILS = 2;

// 旧的 `truncate` 按 UTF-16 length 切：CJK 标题/路径会超预算两倍宽度、预算
// ≤1 时干脆不截；overlay 行同样受 doRender 超宽即抛错的约束。改用 pi-tui
// 的宽度感知截断（grapheme + ANSI 安全）。
const truncate = (text: string, width: number): string =>
  truncateToWidth(text, Math.max(0, width), "…");

const sectionHeader = (theme: PiTheme, title: string): string =>
  `  ${theme.accent("─")} ${theme.accent(title)}`;

export class SessionInfoPanel implements Component, Focusable {
  focused = false;
  private mcpServers: Record<string, McpServerStatus> | undefined;
  private loadFailed = false;

  constructor(
    private readonly tui: TUI,
    private readonly store: AppStore,
    private readonly theme: PiTheme,
    private readonly options: TuiOptions,
    private readonly onClose: () => void,
    private readonly refreshSubagents?: () => void,
  ) {
    void this.load();
  }

  handleInput(data: string): void {
    // Esc and Ctrl+O are handled by the app's chord dispatch (dismiss/toggle).
    void data;
  }

  invalidate(): void {}

  close(): void {
    this.onClose();
  }

  private async load(): Promise<void> {
    const { listMcpServers } = this.options;
    try {
      if (listMcpServers) this.mcpServers = await listMcpServers();
    } catch {
      this.loadFailed = true;
    }
    this.refreshSubagents?.();
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
    // ctx 行与页脚仪表同一终态（GLM cap 收紧分母），两处读数不漂移；
    // used 未知渲染 `?`（与页脚 `?/{win}` 同口径），不伪造 0。
    const ctx = effectiveContextUsage(s).usage;
    if ((ctx.contextWindow ?? 0) > 0) {
      lines.push(
        `    ${theme.muted("ctx")} ${theme.text(`${ctx.contextUsed ?? "?"}/${ctx.contextWindow}`)}`,
      );
    }
    if (s.usage && s.usage.totalTokens > 0) {
      lines.push(`    ${theme.muted("tokens")} ${theme.text(String(s.usage.totalTokens))}`);
    }
    if (s.lastEvent) lines.push(`    ${theme.muted("last")} ${theme.dim(truncate(s.lastEvent, inner - 6))}`);
    for (const detail of s.statusDetails.slice(0, MAX_STATUS_DETAILS)) {
      lines.push(`    ${theme.dim(truncate(detail, inner))}`);
    }

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

    const subagents = s.subagents;
    const running = subagents?.running ?? [];
    const endedTotal = subagents?.ended.total ?? 0;
    if (running.length > 0 || endedTotal > 0) {
      lines.push(
        sectionHeader(theme, `Subagents (${running.length} running, ${endedTotal} ended)`),
      );
      for (const agent of running.slice(0, MAX_SECTION_ITEMS)) {
        lines.push(
          `    ${theme.accent("●")} ${theme.text(truncate(agent.title, inner - 24))} ${theme.muted(agent.subagentType)}`,
        );
      }
      for (const agent of (subagents?.ended.items ?? []).slice(0, 3)) {
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

    if (this.loadFailed || s.subagentsError) {
      lines.push(`  ${theme.muted("(subagent / MCP data unavailable)")}`);
    }
    lines.push(`  ${theme.muted("Ctrl+O or Esc to close")}`);
    // 兜底（同 rows.ts clampLines）：overlay 行不受 MessageRow 的截断保护，
    // 任何一行超过面板宽度都会让 doRender 抛错崩掉客户端。
    const lineWidth = Math.max(1, width);
    return lines.map((line) =>
      visibleWidth(line) <= lineWidth ? line : truncateToWidth(line, lineWidth, "…"),
    );
  }
}
