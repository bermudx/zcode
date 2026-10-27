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
//
// Fenced code blocks count as prose: the segment scanner tracks fence state
// (same state machine the json pretty-printer uses), so a table written
// *inside* a fence — someone documenting markdown syntax, a TSV snippet —
// stays one intact code block instead of being torn into a rendered table
// with dangling fence markers around it.

import {
  Markdown,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

const COLUMN_GUTTER = 2;
/** Longest-word floor cap: a column never stretches past this for one token. */
const MAX_WORD_FLOOR = 24;
/** Cells are measured unwrapped at this width; terminals never approach it. */
const MEASURE_WIDTH = 4096;
const JSON_FENCE_MAX_CHARS = 32_768;
/** Pretty-printed json is indented two spaces, like `JSON.stringify(_, null, 2)`. */
const JSON_INDENT = "  ";
/** Bounded cell-measurement cache; cleared wholesale when full (no LRU). */
const MEASURE_CACHE_LIMIT = 4096;

type CellAlign = "left" | "center" | "right";

type MarkdownTable = {
  align: CellAlign[];
  header: string[];
  rows: string[][];
};

type Segment = { kind: "markdown"; text: string } | { kind: "table"; table: MarkdownTable };

/** Opening fence line: 3+ backticks or tildes, an optional info string. */
type Fence = { char: string; info: string; length: number };

/** `open` captures marker + info string; `close` captures the marker only. */
type FencePatterns = { open: RegExp; close: RegExp };

/**
 * 顶层 fence 的最多 3 格缩进是 GFM 规则。表格切分只在列 0 生效，所以判断
 * 「这行是不是 fence」必须用同一套顶层规则：4 格缩进的行按 GFM 属于缩进代码块，
 * 本来就进不了 `parseTable`，也就不需要 fence 保护。
 */
const TOP_LEVEL_FENCE: FencePatterns = {
  close: /^ {0,3}(`{3,}|~{3,})[ \t]*$/u,
  open: /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/u,
};

/** 任意缩进 fence：列表项/引用里的 json 块历史上就按缩进 fence 美化。 */
const INDENTED_FENCE: FencePatterns = {
  close: /^[ \t]*(`{3,}|~{3,})[ \t]*$/u,
  open: /^[ \t]*(`{3,}|~{3,})[ \t]*(\S*)/u,
};

const openFence = (line: string, patterns: FencePatterns): Fence | undefined => {
  const match = patterns.open.exec(line);
  if (!match) return undefined;
  const marker = match[1] ?? "";
  const info = match[2] ?? "";
  // GFM：反引号 fence 的 info string 不能再含反引号，含反引号的行不是 fence 起点。
  if (marker.startsWith("`") && info.includes("`")) return undefined;
  return { char: marker.charAt(0), info, length: marker.length };
};

/** 闭合 fence 必须是同类字符且不短于开启行（GFM），否则 fence 还没结束。 */
const closesFence = (fence: Fence, line: string, patterns: FencePatterns): boolean => {
  const match = patterns.close.exec(line);
  if (!match) return false;
  const marker = match[1] ?? "";
  return marker.charAt(0) === fence.char && marker.length >= fence.length;
};

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
 * tables outside fenced code blocks start a segment; anything indented or
 * inside a fence stays prose for the stock renderer, so a failed match can
 * never drop content — the lines just remain part of the surrounding markdown
 * segment.
 */
export const splitMarkdownSegments = (text: string): Segment[] => {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let prose: string[] = [];
  let fence: Fence | undefined;
  let index = 0;
  const flushProse = (): void => {
    if (prose.length > 0) {
      segments.push({ kind: "markdown", text: prose.join("\n") });
      prose = [];
    }
  };
  while (index < lines.length) {
    const line = lines[index] ?? "";
    // fence 内的行一律留在 prose 段：代码块里的 `|---|---|` 是内容，不是表格。
    // 逐行找表格而不看 fence，会把 fence 体撕成渲染表格，并留下悬空的 ```。
    if (fence) {
      prose.push(line);
      if (closesFence(fence, line, TOP_LEVEL_FENCE)) fence = undefined;
      index += 1;
      continue;
    }
    fence = openFence(line, TOP_LEVEL_FENCE);
    if (fence) {
      prose.push(line);
      index += 1;
      continue;
    }
    const parsed = parseTable(lines, index);
    if (parsed) {
      flushProse();
      segments.push({ kind: "table", table: parsed.table });
      index = parsed.next;
      continue;
    }
    prose.push(line);
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

/**
 * 只把字符串里的 `\/` 还原成 `/`。`\\` 是转义后的反斜杠，它后面的 `/` 不是
 * 转义序列，必须原样保留——正则全局替换会把 `\\/` 的首个反斜杠吃掉。
 */
const unescapeJsonSlashes = (text: string): string => {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\\" && next === "\\") {
      output += "\\\\";
      index += 1;
      continue;
    }
    if (char === "\\" && next === "/") {
      output += "/";
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
};

const isJsonWhitespace = (char: string | undefined): boolean =>
  char === " " || char === "\t" || char === "\n" || char === "\r";

/**
 * 只重排缩进，不重新序列化：字符串与数字保留源文本。
 * `JSON.stringify(JSON.parse(x), null, 2)` 会把 9007199254740993 打印成 …992、
 * 把 1.10 打印成 1.1、把 1e400 打印成 null（double 溢出），转写就显示了模型
 * 没发过的值。合法性由调用方的 `JSON.parse` 把关，这里只需按 token 扫一遍。
 */
const indentJsonText = (source: string): string => {
  const lines: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;
  const flush = (): void => {
    if (current.length > 0) lines.push(JSON_INDENT.repeat(depth) + current);
    current = "";
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (inString) {
      current += char;
      if (char === "\\") {
        const escaped = source[index + 1];
        if (escaped !== undefined) {
          current += escaped;
          index += 1;
        }
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      current += char;
      continue;
    }
    if (isJsonWhitespace(char)) continue;
    if (char === "{" || char === "[") {
      const closer = char === "{" ? "}" : "]";
      let lookahead = index + 1;
      while (lookahead < source.length && isJsonWhitespace(source[lookahead])) lookahead += 1;
      // 空容器写成 `{}` / `[]`，跟 JSON.stringify 一致。
      if (source[lookahead] === closer) {
        current += char + closer;
        index = lookahead;
        continue;
      }
      current += char;
      flush();
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      flush();
      depth = Math.max(0, depth - 1);
      // 收尾括号后的逗号要粘在同一行，否则会单独占一行（`}\n,`）。
      let closer = char;
      let lookahead = index + 1;
      while (lookahead < source.length && isJsonWhitespace(source[lookahead])) lookahead += 1;
      if (source[lookahead] === ",") {
        closer += ",";
        index = lookahead;
      }
      current = closer;
      flush();
      continue;
    }
    if (char === ",") {
      current += char;
      flush();
      continue;
    }
    if (char === ":") {
      current += ": ";
      continue;
    }
    current += char;
  }
  flush();
  return lines.join("\n");
};

/** Unescape `\/` and pretty-print `json` fenced blocks (streaming-safe). */
export const prettifyJsonFences = (text: string): string => {
  const lines = text.split("\n");
  const output: string[] = [];
  let fence: { body: string[]; json: boolean; markers: Fence } | undefined;
  const flushFence = (): void => {
    if (!fence) return;
    const { body: bodyLines, json } = fence;
    fence = undefined;
    // 流式刚看到开 fence 行、体还没流入：不补空行（否则每段 fence 末尾多一空行）。
    if (bodyLines.length === 0) return;
    const body = bodyLines.join("\n");
    if (!json) {
      output.push(body);
      return;
    }
    let rendered = unescapeJsonSlashes(body);
    if (body.length <= JSON_FENCE_MAX_CHARS) {
      try {
        // parse 只作合法性闸门：流式中的半截 JSON 不美化，原文照旧。
        JSON.parse(rendered);
        rendered = indentJsonText(rendered);
      } catch {
        // Partial JSON mid-stream (or non-JSON mislabeled json): keep the
        // unescaped body verbatim; the next render retries.
      }
    }
    output.push(rendered);
  };
  for (const line of lines) {
    if (!fence) {
      output.push(line);
      const opened = openFence(line, INDENTED_FENCE);
      // 非 json fence 也要跟踪：否则 fence 体里一行 ```json 会被当成真的 json 块。
      if (opened) {
        fence = { body: [], json: /^json/iu.test(opened.info), markers: opened };
      }
      continue;
    }
    if (closesFence(fence.markers, line, INDENTED_FENCE)) {
      flushFence();
      output.push(line);
      continue;
    }
    fence.body.push(line);
  }
  flushFence();
  return output.join("\n");
};

/**
 * 单元格自然宽度缓存（按主题分桶，每桶有界）。流式消息每个 delta 都整表重排，
 * 而测量是「把 cell 当 markdown 按 MEASURE_WIDTH 渲染一次」——同一个 cell 的
 * 可见宽度不随帧变化，跨帧复用即可省掉一半渲染成本。主题只加零宽 ANSI 序列，
 * 但宽度仍按主题分桶：将来若有主题加可见前缀，不会污染其他主题的测量结果。
 */
const measureCaches = new WeakMap<MarkdownTheme, Map<string, number>>();

const measureCellWidth = (text: string, theme: MarkdownTheme): number => {
  let cache = measureCaches.get(theme);
  if (!cache) {
    cache = new Map();
    measureCaches.set(theme, cache);
  }
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const rendered = new Markdown(text, 0, 0, theme).render(MEASURE_WIDTH)[0] ?? "";
  const width = visibleWidth(rtrimSpaces(rendered));
  // 有界：满了整桶清空重算，不做 LRU（清空一次比每帧算 LRU 便宜）。
  if (cache.size >= MEASURE_CACHE_LIMIT) cache.clear();
  cache.set(text, width);
  return width;
};

const renderTableSegment = (input: {
  table: MarkdownTable;
  theme: MarkdownTheme;
  width: number;
}): string[] => {
  const { table, theme } = input;
  const count = table.header.length;
  if (count === 0) return [];
  // Too narrow for count columns plus gutters: a rendered row measures
  // count + GUTTER·(count-1) cells at best, so no column balancing can keep
  // it inside input.width — and pi-tui's screen throws on any over-wide
  // line, killing the client. Degrade to wrapped raw text (same fallback
  // posture as the stock renderer's availableForCells < numCols guard).
  if (input.width < count + COLUMN_GUTTER * (count - 1)) {
    const raw = [table.header, ...table.rows].map((cells) => cells.join(" | "));
    return raw.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, input.width)));
  }
  const available = input.width - COLUMN_GUTTER * (count - 1);

  // One child Markdown per cell (bold default style for header cells) so
  // inline emphasis, code spans and links inside cells render exactly like
  // prose. Measured cells are rendered unwrapped; the visible width of that
  // single line is the column's natural content width (cached across frames).
  const cellBlock = (text: string, bold: boolean): Markdown =>
    new Markdown(text, 0, 0, theme, bold ? { bold: true } : undefined);
  const naturalOf = (text: string): number => measureCellWidth(text, theme);

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
