// Transcript row components: Message[] (shared projection model) → pi-tui
// Components. One component per message; composite rows render each part.

import {
  Markdown,
  Text,
  TruncatedText,
  truncateToWidth,
  wrapTextWithAnsi,
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
// Shell transcript rows are local-only system messages produced by shell.ts;
// the sigil that marks them belongs to the producer.
import { SHELL_ROW_PREFIX, collapseShellContextBlocks } from "./shell.js";

const USER_PREFIX = "> ";
const TOOL_STATUS_GLYPHS = {
  completed: "✓",
  failed: "✗",
  pending: "◌",
  running: "⠋",
} as const;
const MAX_TOOL_OUTPUT_LINES = 6;
const MAX_TOOL_DETAIL_LINES = 8;

/**
 * Wrap `text` into rows that never exceed `width` cells, prefixing the first
 * line with `prefix` and later lines with `continuation`.
 *
 * Why: pi-tui's TuiMainScreen.doRender() throws as soon as one rendered line is
 * wider than the terminal, which kills the whole client. Any transcript row fed
 * by user input (paste, model output, shell output) must therefore be measured
 * against the real width *before* styling — visibleWidth() ignores ANSI, so the
 * prefix width has to be subtracted from the raw strings, not the styled ones.
 */
const wrapPrefixed = (input: {
  continuation: string;
  prefix: string;
  style: (text: string) => string;
  text: string;
  width: number;
}): string[] => {
  const prefixWidth = visibleWidth(input.prefix);
  const continuationWidth = visibleWidth(input.continuation);
  const contentWidth = Math.max(1, input.width - Math.max(prefixWidth, continuationWidth));
  const lines: string[] = [];
  for (const raw of input.text.split(/\r\n|\r|\n/u)) {
    for (const wrapped of wrapTextWithAnsi(raw, contentWidth)) lines.push(wrapped);
  }
  return lines.map(
    (line, index) =>
      `${index === 0 ? input.prefix : input.continuation}${input.style(line)}`,
  );
};

/** Hard guarantee for the whole transcript: no row wider than `width`. */
const clampLines = (lines: string[], width: number): string[] =>
  lines.map((line) => (visibleWidth(line) <= width ? line : truncateToWidth(line, width)));

/** Local shell transcript row: `!command` line + captured output below it. */
const renderShellRow = (content: string, theme: PiTheme, width: number): string[] => {
  const newlineIndex = content.indexOf("\n");
  const command = newlineIndex < 0 ? content.slice(1) : content.slice(1, newlineIndex);
  const output = newlineIndex < 0 ? "" : content.slice(newlineIndex + 1);
  const commandLines = wrapPrefixed({
    continuation: "  ",
    prefix: `${theme.accent("!")} `,
    style: theme.text,
    text: command,
    width,
  });
  if (output.trim().length === 0) return [...commandLines, theme.muted("  (no output)")];
  return [
    ...commandLines,
    ...wrapPrefixed({
      continuation: "  ",
      prefix: "  ",
      style: theme.dim,
      text: output,
      width,
    }),
  ];
};

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

  render(width: number): string[] {
    const theme = this.theme;
    const part = this.part;
    const glyph = TOOL_STATUS_GLYPHS[part.status] ?? "?";
    const glyphStyle = part.status === "failed" ? theme.danger : theme.success;
    const title = part.title?.trim() ? ` ${part.title}` : "";
    // 工具标题/detail/output/error/diff 行都可能超终端宽度；doRender 对超宽行
    // 抛错崩 TUI，所有行先截到可见宽度再加样式。
    const bodyWidth = Math.max(1, width - 4);
    const header = `  ${glyphStyle(glyph)} ${theme.text(part.toolName)}${theme.muted(title)}`;
    const lines = [truncateToWidth(header, width)];

    for (const detail of truncateLines(part.detailLines, MAX_TOOL_DETAIL_LINES, theme.muted)) {
      lines.push(`    ${theme.muted(truncateToWidth(detail, bodyWidth))}`);
    }
    if (part.output) {
      const outputLines = truncateLines(
        part.output.split("\n").slice(0, MAX_TOOL_OUTPUT_LINES + 1),
        MAX_TOOL_OUTPUT_LINES,
        theme.muted,
      );
      for (const line of outputLines)
        lines.push(`    ${theme.dim(truncateToWidth(line, bodyWidth))}`);
    }
    if (part.error) {
      for (const line of part.error.split("\n").slice(0, 4)) {
        lines.push(`    ${theme.danger(truncateToWidth(line, bodyWidth))}`);
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
        lines.push(`    ${style(truncateToWidth(line.text, bodyWidth))}`);
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

  render(width: number): string[] {
    const label =
      this.part.status === "thinking"
        ? this.theme.muted("⠋ thinking…")
        : this.theme.muted(`✻ thought (${this.part.contentCharCount} chars)`);
    // 流式 reasoning 单行可能远超终端宽度；doRender 对超宽行直接抛错崩 TUI，
    // 必须先把纯文本截到可见宽度再加样式。
    const bodyWidth = Math.max(1, width - 2);
    const body = this.part.text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(0, 2)
      .map((line) => `  ${this.theme.dim(truncateToWidth(line.trim(), bodyWidth))}`);
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
    // 兜底：任何一行超过终端宽度，pi-tui doRender 都会抛错终止整个进程；
    // 分派层（user/system/shell/timeline/markdown）各自按宽度折行后，这里
    // 再对最终行做一次硬截断，防止第三方 Markdown 渲染器的超宽边界。
    this.cached = clampLines(this.renderMessage(Math.max(1, width)), Math.max(1, width));
    return this.cached;
  }

  private renderMessage(width: number): string[] {
    const message = this.message;
    const theme = this.theme;

    if (message.role === "user") {
      const text = message.content || transcriptPartText(message);
      // 用户输入（粘贴的剪贴板、长单行）以前不换行，直接按原始行渲染；
      // 一旦某行超过终端宽度，doRender 抛错崩掉整个客户端（实测 211 列终端
      // 粘贴 212 列的行即崩溃）。这里按终端宽度折行后再上色。
      // `!cmd` 的输出块已在上面单独成行展示，这里只留一行提示，正文不重复堆叠。
      const collapsed = collapseShellContextBlocks(text);
      const lines = wrapPrefixed({
        continuation: "  ",
        prefix: USER_PREFIX,
        style: theme.text,
        text: collapsed.text,
        width,
      });
      for (const notice of collapsed.notices) {
        lines.push(...wrapPrefixed({
          continuation: "    ",
          prefix: "  ",
          style: theme.muted,
          text: notice,
          width,
        }));
      }
      return lines.length > 0 ? lines : [theme.accent(USER_PREFIX)];
    }

    if (message.role === "system" && message.content.startsWith(SHELL_ROW_PREFIX)) {
      return renderShellRow(message.content, theme, width);
    }

    if (message.role === "system") {
      return wrapPrefixed({
        continuation: "  ",
        prefix: `${theme.warning("!")} `,
        style: theme.warning,
        text: message.content,
        width,
      });
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
