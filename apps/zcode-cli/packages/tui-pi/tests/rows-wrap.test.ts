// Render contract: pi-tui's TuiMainScreen.doRender() throws (and kills the
// client) as soon as one rendered line is wider than the terminal. Every
// transcript row that embeds external text — user paste, system notice, shell
// output — must therefore fold to the width it is given.

import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Message } from "@zcode/tui/internals";
import { MessageRow, piMarkdownTheme } from "../src/rows.js";
import { formatShellTranscriptRow } from "../src/shell.js";
import { createPiTheme } from "../src/theme.js";

const theme = createPiTheme({ noColor: false });
const render = (message: Message, width: number, expandThoughts = false): string[] =>
  new MessageRow(message, theme, piMarkdownTheme(theme), () => expandThoughts).render(
    width,
  );

const assertFits = (lines: string[], width: number): void => {
  for (const [index, line] of lines.entries()) {
    assert.ok(
      visibleWidth(line) <= width,
      `line ${index} is ${visibleWidth(line)} wide, limit ${width}: ${line}`,
    );
  }
};

// The original crash: a 212-cell pasted line in a 211-column terminal.
const LONG_SENTENCE =
  "- The transform is rules + two explicit judgment tables (per-family thinkingLevelMaps, per-id MODEL_OVERRIDES with stated reasons — e.g. gpt-5.2-chat keeps its verified max_completion_tokens). The headline test asserts the transform reproduces your hand-maintained block exactly from a pinned live-catalog fixture.";

test("long pasted user lines wrap instead of overflowing", () => {
  const lines = render({ content: LONG_SENTENCE, role: "user" }, 211);
  assertFits(lines, 211);
  assert.ok(lines.length > 1, "long user text must wrap onto multiple rows");
  // 用户块上下各一行 bg 填充：内容行从 index 1 起。
  assert.ok(
    stripTerminalSequences(lines[1]!).startsWith("> "),
    "first content row keeps the composer prefix",
  );
  assert.ok(
    stripTerminalSequences(lines[2]!).startsWith("  "),
    "continuation rows keep the hanging indent",
  );
});

test("user rows sit on the user message background", () => {
  const lines = render({ content: "hi", role: "user" }, 20);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /\x1b\[48/, "top padding row carries the bg");
  assert.match(lines[1]!, /\x1b\[48/, "content row is padded onto the bg");
  assert.ok(stripTerminalSequences(lines[1]!).startsWith("> hi"));
});

test("multi-line user paste keeps every line inside the width", () => {
  const pasted = Array.from({ length: 24 }, (_, index) => `${index}: ${LONG_SENTENCE}`).join(
    "\n",
  );
  const lines = render({ content: pasted, role: "user" }, 80);
  assertFits(lines, 80);
});

test("unbreakable tokens are hard-split (long URLs, base64 blobs)", () => {
  const blob = "x".repeat(500);
  const lines = render({ content: `see @${blob}`, role: "user" }, 40);
  assertFits(lines, 40);
});

test("wide characters (CJK/emoji) are measured, not counted as chars", () => {
  const cjk = "漢".repeat(120);
  const lines = render({ content: `${cjk} 🚀 ${cjk}`, role: "user" }, 30);
  assertFits(lines, 30);
});

test("system notices wrap too", () => {
  const lines = render({ content: LONG_SENTENCE, role: "system" }, 60);
  assertFits(lines, 60);
});

test("shell rows render command + output within the width", () => {
  const row = formatShellTranscriptRow({
    command: "git log --oneline --all",
    exitCode: 0,
    output: `${LONG_SENTENCE}\n${LONG_SENTENCE}`,
    timedOut: false,
    truncated: false,
  });
  const lines = render({ content: row, role: "system" }, 70);
  assertFits(lines, 70);
  assert.ok(lines[0]!.includes("git log --oneline --all"));
});

test("markdown agent rows stay inside the width", () => {
  const lines = render(
    { content: `## Heading\n\n${LONG_SENTENCE}\n\n| a | b |\n|---|---|\n| ${LONG_SENTENCE} | x |`, role: "agent" },
    72,
  );
  assertFits(lines, 72);
});

test("a one-cell-wide terminal does not produce negative widths", () => {
  const lines = render({ content: "abc", role: "user" }, 1);
  assertFits(lines, 1);
});

const THOUGHT_TEXT = "first reasoning line\nsecond reasoning line\nthird reasoning line";

const thoughtMessage = (): Message => ({
  content: "",
  parts: [
    {
      contentCharCount: THOUGHT_TEXT.length,
      status: "thought",
      text: THOUGHT_TEXT,
      type: "thought",
    },
  ],
  role: "agent",
});

test("collapsed thought parts keep the two-line preview", () => {
  const lines = render(thoughtMessage(), 60);
  assert.ok(lines[0]!.includes("+ thought"), "collapsed label carries the + marker");
  assert.ok(lines.some((line) => line.includes("first reasoning line")));
  assert.ok(lines.some((line) => line.includes("second reasoning line")));
  assert.ok(
    !lines.some((line) => line.includes("third reasoning line")),
    "collapsed preview caps at two lines",
  );
});

test("expanded thought parts render the full reasoning text", () => {
  const lines = render(thoughtMessage(), 60, true);
  assert.ok(lines[0]!.includes("- thought"), "expanded label carries the - marker");
  assert.ok(lines.some((line) => line.includes("third reasoning line")));
});

test("expanded thought parts wrap long lines within the width", () => {
  const message: Message = {
    content: "",
    parts: [
      {
        contentCharCount: LONG_SENTENCE.length,
        status: "thought",
        text: LONG_SENTENCE,
        type: "thought",
      },
    ],
    role: "agent",
  };
  const lines = render(message, 40, true);
  assertFits(lines, 40);
  assert.ok(lines.length > 2, "long expanded reasoning must wrap");
});

test("tool part markdown bodies (ExitPlanMode plan) render inside the width", () => {
  const plan = `# Ship it\n\n${LONG_SENTENCE}\n\n- step one\n- step two`;
  const lines = render(
    {
      content: "",
      parts: [
        {
          detailLines: ["Bash: run tests"],
          markdown: plan,
          status: "pending",
          title: "Ship it",
          toolCallId: "call-exit",
          toolName: "ExitPlanMode",
          type: "tool",
        },
      ],
      role: "agent",
    },
    60,
  );

  assertFits(lines, 60);
  assert.ok(lines[0]!.includes("ExitPlanMode"), "tool header stays first");
  assert.ok(lines.some((line) => line.includes("Ship it")), "plan heading renders");
  assert.ok(lines.some((line) => line.includes("step one")), "plan list renders");
  assert.ok(lines.some((line) => line.includes("Bash: run tests")), "allowed prompts render");
});
