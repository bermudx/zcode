// Transcript markdown: pi-tui `Markdown` for prose plus fork-local rendering
// for two transcript eyesores the stock component leaves as-is:
//
// 1. Pipe tables. pi-tui's renderer draws full box borders (`┌─┬─┐`, `│` walls,
//    a `├─┼─┤` seam between *every* row) and sizes columns from source line
//    widths, so a three-column table turns into a wall of rules with nearly
//    equal, badly wrapped columns. Here tables are borderless: bold header,
//    per-column rule under the header, two-space gutters, and column widths
//    balanced by cell text volume with a longest-word floor — same data, a
//    fraction of the ink.
// 2. `json` fenced code blocks. Provider-side narration (Z.ai built-in tools)
//    streams single-line JSON with `\/`-escaped slashes; unescaped and
//    pretty-printed it reads like the object it is.
//
// Everything else is delegated unchanged to `Markdown`; a message without a
// table row takes a zero-overhead fast path. Tables nested in blockquotes or
// list items are not re-handled here (indented lines don't start a table
// segment) and keep the stock renderer.

import {
  Markdown,
  visibleWidth,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

const COLUMN_GUTTER = 2;
/** Longest-word floor cap: a column never stretches past this for one token. */
const MAX_WORD_FLOOR = 24;
/** Cells are measured unwrapped at this width; terminals never approach it. */
const MEASURE_WIDTH = 4096;
const JSON_FENCE_MAX_CHARS = 32_768;

type CellAlign = "left" | "center" | "right";

type MarkdownTable = {
  align: CellAlign[];
  header: string[];
  rows: string[][];
};

type Segment = { kind: "markdown"; text: string } | { kind: "table"; table: MarkdownTable };

/** Split a GFM table row on unescaped pipes, dropping the outer pipe cells. */
const splitTableRow = (line: string): string[] => {
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && line[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  if (line.trimStart().startsWith("|")) cells.shift();
  if (line.trimEnd().endsWith("|") && !line.trimEnd().endsWith("\\|")) cells.pop();
  return cells;
};

const alignFromDelimiter = (cell: string): CellAlign => {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
};

const delimiterRow = (line: string): CellAlign[] | undefined => {
  if (!line.includes("|") || /^\s/u.test(line)) return undefined;
  const cells = splitTableRow(line);
  if (cells.length === 0 || cells.some((cell) => cell === "" || !/^:{0,1}-{1,}:{0,1}$/u.test(cell)))
    return undefined;
  return cells.map(alignFromDelimiter);
};

const parseTable = (lines: string[], start: number): { table: MarkdownTable; next: number } | undefined => {
  const headerLine = lines[start];
  if (!headerLine || !headerLine.includes("|") || /^\s/u.test(headerLine)) return undefined;
  const delimiterLine = lines[start + 1];
  if (!delimiterLine) return undefined;
  const align = delimiterRow(delimiterLine);
  if (!align) return undefined;
  const header = splitTableRow(headerLine);
  if (header.length === 0 || header.length !== align.length) return undefined;

  const rows: string[][] = [];
  let next = start + 2;
  while (next < lines.length) {
    const line = lines[next];
    if (!line || !line.includes("|") || /^\s/u.test(line)) break;
    const cells = splitTableRow(line);
    rows.push(cells.slice(0, header.length));
    next += 1;
  }
  return { next, table: { align, header, rows } };
};

/**
 * Split markdown source into top-level prose/table segments. Only column-0
 * tables start a segment; anything indented stays prose for the stock
 * renderer, so a failed match can never drop content — the lines just remain
 * part of the surrounding markdown segment.
 */
export const splitMarkdownSegments = (text: string): Segment[] => {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let prose: string[] = [];
  let index = 0;
  const flushProse = (): void => {
    if (prose.length > 0) {
      segments.push({ kind: "markdown", text: prose.join("\n") });
      prose = [];
    }
  };
  while (index < lines.length) {
    const parsed = parseTable(lines, index);
    if (parsed) {
      flushProse();
      segments.push({ kind: "table", table: parsed.table });
      index = parsed.next;
      continue;
    }
    prose.push(lines[index] ?? "");
    index += 1;
  }
  flushProse();
  return segments;
};

/** Strip trailing plain spaces (Markdown pads its lines to the given width). */
const rtrimSpaces = (line: string): string => line.replace(/ +$/u, "");

const padCell = (text: string, width: number, align: CellAlign): string => {
  const space = Math.max(0, width - visibleWidth(text));
  if (align === "right") return " ".repeat(space) + text;
  if (align === "center")
    return " ".repeat(Math.floor(space / 2)) + text + " ".repeat(Math.ceil(space / 2));
  return text + " ".repeat(space);
};

const longestWordWidth = (text: string): number => {
  let longest = 1;
  for (const word of text.split(/\s+/u)) longest = Math.max(longest, visibleWidth(word));
  return longest;
};

/**
 * Column widths for a table whose columns must fit `available` cells: each
 * column keeps at least its longest word (capped) when everything fits, and
 * the remaining space is split by total cell text volume, so a column of two
 * short words stops stealing width from the paragraph beside it. Falls back
 * to volume shares alone when even the word floors cannot fit.
 */
export const balanceColumnWidths = (input: {
  available: number;
  columns: ReadonlyArray<{ cells: readonly string[] }>;
}): number[] => {
  const count = input.columns.length;
  if (count === 0) return [];
  const naturals: number[] = [];
  const floors: number[] = [];
  const volumes: number[] = [];
  for (const column of input.columns) {
    let natural = 1;
    let floor = 1;
    let volume = 0;
    for (const cell of column.cells) {
      natural = Math.max(natural, visibleWidth(cell));
      floor = Math.max(floor, Math.min(longestWordWidth(cell), MAX_WORD_FLOOR));
      volume += visibleWidth(cell);
    }
    naturals.push(natural);
    floors.push(Math.min(floor, natural));
    volumes.push(volume);
  }

  const totalNatural = naturals.reduce((sum, width) => sum + width, 0);
  if (totalNatural <= input.available) return naturals;

  let widths = floors.slice();
  let used = widths.reduce((sum, width) => sum + width, 0);
  if (used > input.available) {
    // Degenerate narrow terminal: shrink the word floors by volume share.
    const totalVolume = volumes.reduce((sum, volume) => sum + Math.max(1, volume), 0);
    widths = widths.map((_, index) => {
      const share =
        totalVolume > 0
          ? Math.floor((Math.max(1, volumes[index]) / totalVolume) * input.available)
          : Math.floor(input.available / count);
      return Math.max(1, Math.min(naturals[index], share));
    });
    used = widths.reduce((sum, width) => sum + width, 0);
  }

  let remaining = Math.max(0, input.available - used);
  const totalVolume = volumes.reduce((sum, volume) => sum + volume, 0);
  for (let index = 0; index < count && remaining > 0; index += 1) {
    const headroom = naturals[index] - widths[index];
    if (headroom <= 0) continue;
    const share =
      totalVolume > 0
        ? Math.floor((volumes[index] / totalVolume) * remaining)
        : Math.floor(remaining / count);
    const grow = Math.min(headroom, share);
    widths[index] += grow;
    remaining -= grow;
  }
  // Spend what proportional rounding left over, first column with headroom.
  while (remaining > 0) {
    let grew = false;
    for (let index = 0; index < count && remaining > 0; index += 1) {
      if (widths[index] < naturals[index]) {
        widths[index] += 1;
        remaining -= 1;
        grew = true;
      }
    }
    if (!grew) break;
  }
  return widths;
};

/** Unescape `\/` and pretty-print `json` fenced blocks (streaming-safe). */
export const prettifyJsonFences = (text: string): string => {
  const lines = text.split("\n");
  const output: string[] = [];
  let fence: { marker: string; body: string[] } | undefined;
  const flushFence = (): void => {
    if (!fence) return;
    const body = fence.body.join("\n");
    let rendered = body.replace(/\\\//gu, "/");
    if (body.length <= JSON_FENCE_MAX_CHARS) {
      try {
        rendered = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // Partial JSON mid-stream (or non-JSON mislabeled json): keep the
        // unescaped body verbatim; the next render retries.
      }
    }
    output.push(rendered);
    fence = undefined;
  };
  for (const line of lines) {
    if (!fence) {
      const opening = /^\s*(```|~~~)[ \t]*(\S*)/u.exec(line);
      if (opening) {
        output.push(line);
        if (/^json/iu.test(opening[2] ?? "")) fence = { marker: opening[1] ?? "```", body: [] };
      } else {
        output.push(line);
      }
      continue;
    }
    if (line.trim() === fence.marker) {
      flushFence();
      output.push(line);
      continue;
    }
    fence.body.push(line);
  }
  flushFence();
  return output.join("\n");
};

const renderTableSegment = (input: {
  table: MarkdownTable;
  theme: MarkdownTheme;
  width: number;
}): string[] => {
  const { table, theme } = input;
  const count = table.header.length;
  if (count === 0) return [];
  const available = Math.max(count, input.width - COLUMN_GUTTER * (count - 1));

  // One child Markdown per cell (bold default style for header cells) so
  // inline emphasis, code spans and links inside cells render exactly like
  // prose. Measured cells are rendered unwrapped; the visible width of that
  // single line is the column's natural content width.
  const cellBlock = (text: string, bold: boolean): Markdown =>
    new Markdown(text, 0, 0, theme, bold ? { bold: true } : undefined);
  const naturalOf = (text: string): number =>
    visibleWidth(rtrimSpaces(cellBlock(text, false).render(MEASURE_WIDTH)[0] ?? ""));

  const columns = Array.from({ length: count }, (_, index) => ({
    cells: [table.header[index] ?? "", ...table.rows.map((row) => row[index] ?? "")],
  }));
  const widths = balanceColumnWidths({
    available,
    columns: columns.map((column) => ({
      cells: column.cells.map((cell) => "x".repeat(naturalOf(cell))),
    })),
  });

  // Pre-render every cell block at its final column width, then assemble with
  // full knowledge of which rows wrapped.
  const headerBlocks = table.header.map((cell, index) =>
    cellBlock(cell, true).render(Math.max(1, widths[index] ?? 1)).map(rtrimSpaces),
  );
  const rowBlocks = table.rows.map((row) =>
    row.map((cell, index) =>
      cellBlock(cell ?? "", false).render(Math.max(1, widths[index] ?? 1)).map(rtrimSpaces),
    ),
  );
  const pushRow = (blocks: string[][], lines: string[]): void => {
    const height = blocks.reduce((max, block) => Math.max(max, block.length), 1);
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      const parts = blocks.map((block, index) =>
        padCell(block[lineIndex] ?? "", Math.max(1, widths[index] ?? 1), table.align[index] ?? "left"),
      );
      lines.push(rtrimSpaces(parts.join(" ".repeat(COLUMN_GUTTER))));
    }
  };

  const lines: string[] = [];
  pushRow(headerBlocks, lines);
  lines.push(
    rtrimSpaces(
      widths
        .map((width) => theme.hr("─".repeat(Math.max(1, width))))
        .join(" ".repeat(COLUMN_GUTTER)),
    ),
  );
  const anyRowWraps = rowBlocks.some((blocks) => blocks.some((block) => block.length > 1));
  rowBlocks.forEach((blocks, index) => {
    pushRow(blocks, lines);
    // Wrapped rows blur together without separation; single-line rows stay
    // tight. One rule for the whole table keeps the rhythm uniform.
    if (anyRowWraps && index < rowBlocks.length - 1) lines.push("");
  });
  return lines;
};

/**
 * Markdown replacement for transcript prose: table segments render
 * borderless, everything else is stock `Markdown` over the same source.
 */
export class TranscriptMarkdown implements Component {
  private text: string;
  private readonly paddingX: number;
  private readonly theme: MarkdownTheme;
  private cachedText: string | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(text: string, paddingX: number, theme: MarkdownTheme) {
    this.text = text;
    this.paddingX = paddingX;
    this.theme = theme;
  }

  setText(text: string): void {
    this.text = text;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedText = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width)
      return this.cachedLines;
    const source = prettifyJsonFences(this.text);
    const segments = splitMarkdownSegments(source);
    let lines: string[];
    if (segments.length === 1 && segments[0].kind === "markdown") {
      lines = new Markdown(segments[0].text, this.paddingX, 0, this.theme).render(width);
    } else {
      lines = [];
      const indent = " ".repeat(this.paddingX);
      segments.forEach((segment, index) => {
        if (index > 0 && lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
        if (segment.kind === "markdown") {
          if (segment.text.trim().length === 0) return;
          lines.push(...new Markdown(segment.text, this.paddingX, 0, this.theme).render(width));
          return;
        }
        const tableWidth = Math.max(1, width - this.paddingX);
        const tableLines = renderTableSegment({
          table: segment.table,
          theme: this.theme,
          width: tableWidth,
        });
        // prose 段的 paddingX 由 Markdown 自己缩进；表格行在此补齐同一缩进。
        lines.push(...tableLines.map((line) => (line === "" ? line : indent + line)));
      });
    }
    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}
