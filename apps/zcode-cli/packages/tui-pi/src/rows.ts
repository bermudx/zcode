// Transcript row components: Message[] (shared projection model) → pi-tui
// Components. One component per message; composite rows render each part.

import {
  Markdown,
  Text,
  TruncatedText,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type {
  Message,
  ThoughtTranscriptPart,
  ToolTranscriptPart,
  TranscriptPart,
} from "@zcode/tui/internals";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PiTheme, Style } from "./theme.js";

const USER_PREFIX = "> ";
const TOOL_STATUS_GLYPHS = {
  completed: "✓",
  failed: "✗",
  pending: "◌",
  running: "⠋",
} as const;
const MAX_TOOL_OUTPUT_LINES = 6;
const MAX_TOOL_DETAIL_LINES = 8;

export const piMarkdownTheme = (theme: PiTheme): MarkdownTheme => ({
  bold: theme.bold,
  code: theme.warning,
  codeBlock: theme.text,
  codeBlockBorder: theme.muted,
  heading: theme.accent,
  hr: theme.muted,
  italic: theme.dim,
  link: theme.accent,
  linkUrl: theme.muted,
  listBullet: theme.accent,
  quote: theme.muted,
  quoteBorder: theme.muted,
  strikethrough: theme.dim,
  underline: theme.accent,
});

const truncateLines = (lines: string[], max: number, style: Style): string[] => {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), style(`… ${lines.length - max} more lines`)];
};

class ToolPartRow implements Component {
  private part: ToolTranscriptPart;

  constructor(
    part: ToolTranscriptPart,
    private readonly theme: PiTheme,
  ) {
    this.part = part;
  }

  setPart(part: ToolTranscriptPart): void {
    this.part = part;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const theme = this.theme;
    const part = this.part;
    const glyph = TOOL_STATUS_GLYPHS[part.status] ?? "?";
    const glyphStyle = part.status === "failed" ? theme.danger : theme.success;
    const title = part.title?.trim() ? ` ${part.title}` : "";
    const header = `  ${glyphStyle(glyph)} ${theme.text(part.toolName)}${theme.muted(title)}`;
    const lines = [header];

    for (const detail of truncateLines(part.detailLines, MAX_TOOL_DETAIL_LINES, theme.muted)) {
      lines.push(`    ${theme.muted(detail)}`);
    }
    if (part.output) {
      const outputLines = truncateLines(
        part.output.split("\n").slice(0, MAX_TOOL_OUTPUT_LINES + 1),
        MAX_TOOL_OUTPUT_LINES,
        theme.muted,
      );
      for (const line of outputLines) lines.push(`    ${theme.dim(line)}`);
    }
    if (part.error) {
      for (const line of part.error.split("\n").slice(0, 4)) {
        lines.push(`    ${theme.danger(line)}`);
      }
    }
    if (part.resultDisplay) {
      for (const line of part.resultDisplay.lines.slice(0, 24)) {
        const style =
          line.tone === "addition"
            ? theme.success
            : line.tone === "deletion"
              ? theme.danger
              : line.tone === "meta"
                ? theme.muted
                : theme.text;
        lines.push(`    ${style(line.text)}`);
      }
      if (part.resultDisplay.truncated) {
        lines.push(`    ${theme.muted("… diff truncated")}`);
      }
    }
    return lines;
  }
}

class ThoughtPartRow implements Component {
  constructor(
    private part: ThoughtTranscriptPart,
    private readonly theme: PiTheme,
  ) {}

  setPart(part: ThoughtTranscriptPart): void {
    this.part = part;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const label =
      this.part.status === "thinking"
        ? this.theme.muted("⠋ thinking…")
        : this.theme.muted(`✻ thought (${this.part.contentCharCount} chars)`);
    const body = this.part.text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(0, 2)
      .map((line) => `  ${this.theme.dim(line.trim())}`);
    return [label, ...body];
  }
}

class PartRow implements Component {
  private child: ToolPartRow | ThoughtPartRow | Markdown | Text;

  constructor(
    part: TranscriptPart,
    private readonly theme: PiTheme,
    markdownTheme: MarkdownTheme,
  ) {
    this.child =
      part.type === "tool"
        ? new ToolPartRow(part, theme)
        : part.type === "thought"
          ? new ThoughtPartRow(part, theme)
          : part.format === "plain"
            ? new Text(part.text, 2, 0)
            : new Markdown(part.text, 0, 0, markdownTheme);
  }

  setPart(part: TranscriptPart): void {
    if (this.child instanceof Markdown && part.type === "text") this.child.setText(part.text);
    else if (this.child instanceof Text && part.type === "text") this.child.setText(part.text);
    else if (this.child instanceof ToolPartRow && part.type === "tool") this.child.setPart(part);
    else if (this.child instanceof ThoughtPartRow && part.type === "thought")
      this.child.setPart(part);
  }

  invalidate(): void {
    this.child.invalidate();
  }

  render(width: number): string[] {
    return this.child.render(width);
  }
}

/** One transcript message → one component with lazily rebuilt part rows. */
export class MessageRow implements Component {
  private message: Message;
  private partRows: PartRow[] = [];
  private cached: string[] | undefined;
  private renderedWidth = 0;

  constructor(
    message: Message,
    private readonly theme: PiTheme,
    private readonly markdownTheme: MarkdownTheme,
  ) {
    this.message = message;
  }

  setMessage(message: Message): void {
    this.message = message;
    this.cached = undefined;
  }

  invalidate(): void {
    this.cached = undefined;
    for (const row of this.partRows) row.invalidate();
  }

  render(width: number): string[] {
    if (this.cached && this.renderedWidth === width) return this.cached;
    this.renderedWidth = width;
    this.cached = this.renderMessage(width);
    return this.cached;
  }

  private renderMessage(width: number): string[] {
    const message = this.message;
    const theme = this.theme;

    if (message.role === "user") {
      const text = message.content || transcriptPartText(message);
      const lines = text.split("\n").map((line, index) =>
        index === 0
          ? `${theme.accent(USER_PREFIX)}${theme.text(line)}`
          : `  ${theme.text(line)}`,
      );
      return lines.length > 0 ? lines : [theme.accent(USER_PREFIX)];
    }

    if (message.role === "system") {
      return message.content
        .split("\n")
        .map((line) => `${theme.warning("!")} ${theme.warning(line)}`);
    }

    if (message.role === "timeline" && message.timeline) {
      const tl = message.timeline;
      const status =
        tl.status === "failed" || tl.status === "interrupted"
          ? theme.danger(tl.status)
          : theme.muted(tl.status);
      const attempt =
        tl.attempt && tl.maxAttempts ? theme.muted(` (${tl.attempt}/${tl.maxAttempts})`) : "";
      const command = tl.command ? ` ${theme.text(tl.command)}` : "";
      const reason = tl.reason ? ` ${theme.muted(`— ${tl.reason}`)}` : "";
      return [`${theme.accent("∴")}${command} ${status}${attempt}${reason}`];
    }

    const lines: string[] = [];
    if (message.parts && message.parts.length > 0) {
      while (this.partRows.length < message.parts.length) {
        const part = message.parts[this.partRows.length];
        if (part) this.partRows.push(new PartRow(part, theme, this.markdownTheme));
      }
      for (let index = 0; index < message.parts.length; index += 1) {
        const part = message.parts[index];
        const row = this.partRows[index];
        if (!part || !row) continue;
        row.setPart(part);
        lines.push(...row.render(width));
      }
    }
    if (!message.parts || message.parts.length === 0) {
      if (message.content.trim().length > 0) {
        const markdown = new Markdown(message.content, 0, 0, this.markdownTheme);
        lines.push(...markdown.render(width));
      }
    }
    if (message.streaming) lines.push(theme.muted("▌"));
    if (lines.length > 0) lines.push("");
    return lines;
  }
}

const transcriptPartText = (message: Message): string =>
  (message.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");

/** Reconcile the rendered component list against the message list. */
export const reconcileTranscript = (input: {
  container: { children: Component[]; invalidate(): void };
  messages: readonly Message[];
  theme: PiTheme;
  markdownTheme: MarkdownTheme;
  rows: MessageRow[];
}): void => {
  const { container, messages, rows } = input;
  const targetCount = messages.length;

  while (rows.length < targetCount) {
    const message = messages[rows.length];
    if (!message) break;
    const row = new MessageRow(message, input.theme, input.markdownTheme);
    rows.push(row);
    container.children.push(row);
  }

  for (let index = 0; index < targetCount; index += 1) {
    const message = messages[index];
    const row = rows[index];
    if (message && row) row.setMessage(message);
  }

  while (rows.length > targetCount) {
    rows.pop();
    container.children.pop();
  }
  container.invalidate();
};

export { TruncatedText, visibleWidth };
