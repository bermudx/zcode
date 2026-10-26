// Transcript markdown rendering: borderless tables, json fence pretty-
// printing, and the polished thought/tool part rows. Render contract from
// rows-wrap.test.ts applies here too: no line may exceed the given width
// (pi-tui's doRender throws and kills the client on an over-wide line).

import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Message } from "@zcode/tui/internals";
import { MessageRow, piMarkdownTheme } from "../src/rows.js";
import { createPiTheme } from "../src/theme.js";
import {
  TranscriptMarkdown,
  balanceColumnWidths,
  prettifyJsonFences,
  splitMarkdownSegments,
} from "../src/transcript-markdown.js";

const theme = createPiTheme({ noColor: true });
const mdTheme = piMarkdownTheme(theme);
const renderMarkdown = (text: string, width: number): string[] =>
  new TranscriptMarkdown(text, 0, mdTheme).render(width);
const plain = (lines: string[]): string[] => lines.map(stripTerminalSequences);

const assertFits = (lines: string[], width: number): void => {
  for (const [index, line] of lines.entries()) {
    assert.ok(
      visibleWidth(line) <= width,
      `line ${index} is ${visibleWidth(line)} wide, limit ${width}: ${line}`,
    );
  }
};

/* ---------- segment splitting ---------- */

test("tables split from surrounding prose", () => {
  const segments = splitMarkdownSegments(
    "before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nafter",
  );
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["markdown", "table", "markdown"],
  );
  const table = segments[1];
  assert.ok(table.kind === "table");
  assert.deepEqual(table.table.header, ["a", "b"]);
  assert.deepEqual(table.table.rows, [["1", "2"], ["3", "4"]]);
});

test("a paragraph pipe line without a delimiter row stays prose", () => {
  const segments = splitMarkdownSegments("speed | velocity\nand | plus");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "markdown");
});

test("setext-looking lines never become tables", () => {
  const segments = splitMarkdownSegments("Title\n===\nbody");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "markdown");
});

test("indented tables stay with the stock renderer (no segment split)", () => {
  const segments = splitMarkdownSegments("  | a | b |\n  |---|---|\n  | 1 | 2 |");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "markdown");
});

test("escaped pipes stay inside the cell", () => {
  const segments = splitMarkdownSegments("| a \\| b |\n|---|\n| x \\| y |");
  const table = segments[0];
  assert.ok(table.kind === "table");
  assert.deepEqual(table.table.header, ["a | b"]);
  assert.deepEqual(table.table.rows, [["x | y"]]);
});

test("alignment is captured from the delimiter row", () => {
  const segments = splitMarkdownSegments("| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |");
  const table = segments[0];
  assert.ok(table.kind === "table");
  assert.deepEqual(table.table.align, ["left", "center", "right"]);
});

test("streaming partial table: rows so far render, no crash", () => {
  const lines = renderMarkdown("| a | b |\n|---|---|\n| 1 |", 40);
  assertFits(lines, 40);
  assert.ok(lines.some((line) => line.includes("1")));
});

// fence 体里的 `|---|` 是内容不是表格：旧实现逐行找表格，会把代码块撕成
// 「空 fence 记号 + 渲染表格 + 吞掉后文的悬空 ```」，比 stock Markdown 更差。
const fencedTableSource = [
  "Here is the table syntax:",
  "",
  "```markdown",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "```",
  "",
  "That is how you write one.",
].join("\n");

test("fenced code blocks are never scanned for tables", () => {
  assert.deepEqual(
    splitMarkdownSegments(fencedTableSource).map((segment) => segment.kind),
    ["markdown"],
  );
  const tilde = splitMarkdownSegments("~~~\n| a | b |\n|---|---|\n~~~");
  assert.deepEqual(
    tilde.map((segment) => segment.kind),
    ["markdown"],
  );
});

test("a fenced table renders as one intact code block", () => {
  const lines = renderMarkdown(fencedTableSource, 60);
  assertFits(lines, 60);
  const flat = plain(lines);
  assert.ok(
    flat.some((line) => line.includes("```markdown")),
    `opening fence survives:\n${flat.join("\n")}`,
  );
  assert.ok(
    flat.some((line) => line.includes("| a | b |")),
    "table source stays verbatim inside the fence",
  );
  assert.ok(
    !flat.some((line) => line.includes("─")),
    "no rendered table rule (the table is a code block here)",
  );
  const closing = flat.findIndex((line) => line.trim() === "```");
  const sentence = flat.findIndex((line) => line.includes("That is how you write one."));
  assert.ok(closing >= 0, "closing fence survives");
  assert.ok(sentence > closing, "prose after the fence is not swallowed into it");
});

test("a fence after a table does not hide the table", () => {
  const segments = splitMarkdownSegments("| a |\n|---|\n| 1 |\n\n```\n| x | y |\n|---|---|\n```");
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["table", "markdown"],
  );
});

test("an unclosed fence (mid-stream) keeps the rest as prose", () => {
  const segments = splitMarkdownSegments("```\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["markdown"],
  );
});

/* ---------- column widths ---------- */

test("compact tables keep natural widths without stretching", () => {
  const widths = balanceColumnWidths({
    available: 80,
    columns: [{ cells: ["a"] }, { cells: ["longer cell"] }],
  });
  assert.deepEqual(widths, [1, 11]);
});

test("wide tables distribute leftover space by text volume", () => {
  const widths = balanceColumnWidths({
    available: 24,
    columns: [
      { cells: ["one two three four five six seven", "more text here"] },
      { cells: ["short", "tiny"] },
    ],
  });
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 24);
  // The wordy column gets the wide share; the terse column stays near its floor.
  assert.ok(widths[0]! > widths[1]! * 2, `expected volume skew, got ${widths.join("/")}`);
});

test("every column keeps at least its longest word when that fits", () => {
  const widths = balanceColumnWidths({
    available: 40,
    columns: [
      { cells: ["posada-real-chiapas-R2 something"] },
      { cells: ["a few words"] },
    ],
  });
  assert.ok(widths[0] >= "posada-real-chiapas-R2".length);
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 40);
});

/* ---------- table rendering ---------- */

test("tables render borderless: no box glyphs, header rule only", () => {
  const lines = plain(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", 40));
  assertFits(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", 40), 40);
  for (const line of lines) {
    assert.ok(!/[┌┐└┘├┤│]/u.test(line), `box glyph leaked: ${line}`);
  }
  const rule = lines.find((line) => line.includes("─"));
  assert.ok(rule, "header rule renders");
  assert.equal(lines.filter((line) => line.includes("─")).length, 1, "one rule per table");
  assert.ok(lines[0]!.startsWith("a"), "header row is first");
  assert.ok(lines[2]!.startsWith("1"), "data row follows the rule");
});

test("the motivating wide table stays inside width and wraps cells", () => {
  const source = [
    "| What you see after refresh | What it means | Action |",
    "|---|---|---|",
    '| posada-real-chiapas-R2 shows "Last used: just now / a minute ago" | That token is the leaked 5ebb6a09… key (S3 usage does tick Last used) | Roll/delete it — this is the rotation target |',
    "| Both R2 tokens still show — | The live credential is a user token | Check My Profile → API Tokens |",
  ].join("\n");
  const lines = renderMarkdown(source, 120);
  assertFits(lines, 120);
  const plainLines = plain(lines);
  assert.ok(plainLines[0]!.includes("What you see"));
  assert.ok(plainLines.some((line) => line.includes("rotation target")));
  // The short "Action" column must not waste a third of the table.
  const rule = plainLines[1]!;
  const lastColumnWidth = rule.length - rule.lastIndexOf("─") + 0;
  assert.ok(lastColumnWidth < 48, `Action column too wide (${lastColumnWidth})`);
});

test("wrapped rows separate with a blank line; single-line rows stay tight", () => {
  const wrapped = renderMarkdown(
    "| a | b |\n|---|---|\n| one two three four | x |\n| five six seven eight | y |",
    16,
  );
  assert.ok(wrapped.includes(""), "wrapped table gets row separation");
  const tight = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |", 40);
  assert.ok(!tight.includes(""), "single-line table has no blank separators");
});

test("cell inline markdown renders (bold, code) and links stop at width", () => {
  const source =
    "| name | note |\n|---|---|\n| **bold** | `code` |\n| [link](https://example.com/very/long/url) | x |";
  const lines = renderMarkdown(source, 60);
  assertFits(lines, 60);
  const flat = plain(lines);
  // 断言渲染后的文本：原文 `**bold**` / `` `code` `` 也含 bold/code 字样，
  // 只查 includes("bold") 时标记没被消化也能过。
  const styled = flat.find((line) => line.includes("bold"));
  assert.ok(styled, "bold cell renders");
  assert.match(styled.trimEnd(), /^bold +code$/u, `cell markers must be consumed: ${styled}`);
  assert.ok(!flat.join("\n").includes("**"), "no literal emphasis markers");
  assert.ok(!flat.join("\n").includes("`"), "no literal code-span markers");
  assert.ok(!flat.join("\n").includes("]("), "no literal link syntax");
});

test("repeated renders reuse measured cell widths without changing output", () => {
  const source = "| a | b |\n|---|---|\n| one two | x |\n| three | y |";
  const markdown = new TranscriptMarkdown(source, 0, mdTheme);
  const first = markdown.render(24);
  markdown.invalidate();
  assert.deepEqual(markdown.render(24), first);
});

test("prose around a table keeps its spacing", () => {
  const lines = renderMarkdown(
    "intro paragraph\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\noutro paragraph",
    40,
  );
  const flat = plain(lines);
  const tableStart = flat.findIndex((line) => line.startsWith("a "));
  assert.ok(tableStart > 0 && flat[tableStart - 1] === "", "blank before table");
  const tableEnd = flat.findIndex((line) => line.startsWith("1 "));
  assert.ok(flat[tableEnd + 1] === "", "blank after table");
  assert.ok(flat[flat.length - 1]!.startsWith("outro"), "prose after table renders");
});

test("messages without tables hit the stock markdown path unchanged", () => {
  const lines = renderMarkdown("## Heading\n\n- one\n- two\n\nplain **bold**", 40);
  assert.ok(lines.some((line) => stripTerminalSequences(line).includes("Heading")));
  assert.ok(lines.some((line) => stripTerminalSequences(line).includes("two")));
});

/* ---------- json fences ---------- */

test("single-line json fences pretty-print with unescaped slashes", () => {
  const source = '```json\n{"imageSource":"https:\\/\\/example.test\/a?b=c","prompt":"hi"}\n```';
  const out = prettifyJsonFences(source);
  assert.ok(out.includes("\n  \"imageSource\": \"https://example.test/a?b=c\""), out);
});

test("partial json during streaming keeps content with slashes unescaped", () => {
  const source = '```json\n{"url":"https:\\/\\/example.test\/a",\n```';
  const out = prettifyJsonFences(source);
  assert.ok(out.includes("https://example.test/a"), out);
  assert.ok(out.startsWith("```json\n"), "fence markers survive");
});

test("non-json fences are untouched", () => {
  const source = "```ts\nconst a = 1 \\/ 2;\n```";
  assert.equal(prettifyJsonFences(source), source);
});

// JSON.stringify(JSON.parse(x)) 会通过 double 重写数字：9007199254740993 → …992、
// 1.10 → 1.1、1e400（溢出）→ null。转写必须显示模型实际发出的字面值。
test("json pretty-print preserves number literals instead of re-serializing", () => {
  const out = prettifyJsonFences('```json\n{"id":9007199254740993,"amount":1.10,"tiny":1e400}\n```');
  assert.ok(out.includes('"id": 9007199254740993'), out);
  assert.ok(out.includes('"amount": 1.10'), out);
  assert.ok(out.includes('"tiny": 1e400'), out);
});

test("only slash escapes are unescaped; escaped backslashes survive", () => {
  const out = prettifyJsonFences('```json\n{"raw":"a\\\\/b","url":"https:\\/\\/example.test"}\n```');
  assert.ok(out.includes('"raw": "a\\\\/b"'), out);
  assert.ok(out.includes('"url": "https://example.test"'), out);
});

test("a fence nested in a non-json fence is not pretty-printed", () => {
  const source = '```\n```json\n{"a":1}\n```\n```';
  assert.equal(prettifyJsonFences(source), source);
});

test("the provider narration block renders readable", () => {
  const narration = [
    "🌐 Z.ai Built-in Tool: analyze_image",
    "",
    "Input:",
    "",
    '```json',
    '{"imageSource":"https://maas-log-prod.example.test\/x\/y.png?Sig=abc","prompt":"Describe the layout in detail."}',
    "```",
    "",
    "Executing on server...",
  ].join("\n");
  const lines = renderMarkdown(narration, 100);
  assertFits(lines, 100);
  const flat = plain(lines).join("\n");
  assert.ok(flat.includes('"imageSource": "https://maas-log-prod.example.test/x/y.png?Sig=abc"'), flat);
});

/* ---------- thought and tool part rows ---------- */

const render = (message: Message, width: number): string[] =>
  new MessageRow(message, theme, mdTheme, () => false).render(width);

test("thought rows show compact char counts and a rail on previews", () => {
  const lines = render(
    {
      content: "",
      parts: [
        {
          contentCharCount: 10295,
          status: "thought",
          text: "## Plan\nNow the user is showing the **Account API Tokens** list.\nSecond line.",
          type: "thought",
        },
      ],
      role: "agent",
    },
    80,
  );
  const flat = plain(lines);
  assert.ok(flat[0]!.includes("+ thought · 10k chars"), flat[0]);
  assert.ok(flat[1]!.includes("▎"), "preview carries the rail");
  assert.ok(!flat[1]!.includes("**"), "markdown noise stripped from preview");
  assert.ok(!flat[1]!.includes("##"), "heading marker stripped from preview");
  assert.ok(flat[2]!.includes("▎ Now the user"), "second preview line renders");
  assert.ok(
    !flat.some((line) => line.includes("Second line.")),
    "preview stops at two lines",
  );
  assertFits(lines, 80);
});

test("thinking rows collapse to one line", () => {
  const lines = render(
    {
      content: "",
      parts: [{ contentCharCount: 3, status: "thinking", text: "abc", type: "thought" }],
      role: "agent",
    },
    40,
  );
  assert.equal(plain(lines)[0], "⠋ thinking…");
});

test("tool detail lines keep the label dim and the value readable", () => {
  const lines = render(
    {
      content: "",
      parts: [
        {
          detailLines: ["command: /usr/bin/ssh -o BatchMode=yes -p 2222 host 'docker ps'"],
          status: "completed",
          toolCallId: "c1",
          toolName: "Bash",
          type: "tool",
        },
      ],
      role: "agent",
    },
    100,
  );
  assertFits(lines, 100);
  const detail = plain(lines).find((line) => line.includes("command:"));
  assert.ok(detail, "detail line renders");
  assert.ok(detail!.includes("/usr/bin/ssh"), "command value is present");
});

test("parts separate with one blank line inside a message", () => {
  const lines = render(
    {
      content: "",
      parts: [
        { format: "markdown", text: "intro text", type: "text" },
        {
          detailLines: [],
          status: "completed",
          toolCallId: "c1",
          toolName: "Bash",
          type: "tool",
        },
        { format: "markdown", text: "outro text", type: "text" },
      ],
      role: "agent",
    },
    60,
  );
  const flat = plain(lines);
  const intro = flat.findIndex((line) => line.includes("intro text"));
  const tool = flat.findIndex((line) => line.includes("Bash"));
  const outro = flat.findIndex((line) => line.includes("outro text"));
  assert.ok(intro >= 0 && tool > intro && outro > tool);
  assert.equal(flat[tool - 1], "", "blank line before the tool block");
  assert.equal(flat[outro - 1], "", "blank line after the tool block");
  assert.ok(flat.slice(0, tool).filter((line) => line === "").length <= 1, "no blank stacking");
});

test("tool markdown bodies (plan cards) can contain borderless tables", () => {
  const plan = "# Plan\n\n| step | owner |\n|---|---|\n| ship | me |\n\n- done";
  const lines = render(
    {
      content: "",
      parts: [
        {
          detailLines: [],
          markdown: plan,
          status: "pending",
          title: "Plan",
          toolCallId: "c-exit",
          toolName: "ExitPlanMode",
          type: "tool",
        },
      ],
      role: "agent",
    },
    60,
  );
  assertFits(lines, 60);
  const flat = plain(lines);
  assert.ok(flat.join("\n").includes("ship"), "table content renders in tool markdown");
  assert.ok(!/[┌│└]/u.test(flat.join("\n")), "no box borders in tool markdown tables");
  // plan 卡片正文缩进 4 格（与 detail 行对齐），表格行必须跟 prose 同列起点。
  const tableRow = flat.find((line) => line.includes("ship"));
  assert.ok(tableRow?.startsWith("    "), `table rows keep the 4-cell indent: ${tableRow}`);
});
