// `!command` escape: runs in the client workspace, prints into the transcript,
// and rides along with the next prompt (the core owns history, so there is no
// protocol verb to append a local message).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TuiPromptInput } from "@zcode/tui/internals";
import {
  collapseShellContextBlocks,
  formatShellContextBlock,
  formatShellTranscriptRow,
  isShellCommand,
  resolveEscapeShell,
  runShellCommand,
} from "../src/shell.js";
import { MessageRow, piMarkdownTheme } from "../src/rows.js";
import { createPiTheme } from "../src/theme.js";
import { ENTER, createHarness } from "./harness.js";

const promptText = (input: TuiPromptInput): string =>
  typeof input === "string" ? input : input.text;

test("only `!cmd` is a shell escape, `!` alone is text", () => {
  assert.equal(isShellCommand("!ls"), true);
  assert.equal(isShellCommand("  ! git status"), true);
  assert.equal(isShellCommand("!"), false);
  assert.equal(isShellCommand("hello !world"), false);
});

test("runShellCommand captures stdout and the exit code", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-"));
  try {
    const ok = await runShellCommand({ command: "printf 'a\\nb\\n'", cwd });
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.output, "a\nb\n");
    const failed = await runShellCommand({ command: "sh -c 'echo boom >&2; exit 3'", cwd });
    assert.equal(failed.exitCode, 3);
    assert.ok(failed.output.includes("boom"));
    const missing = await runShellCommand({ command: "definitely-not-a-command-xyz", cwd });
    assert.notEqual(missing.exitCode, 0);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("resolveEscapeShell picks the user's bash/zsh with -i, else /bin/sh", () => {
  const exists = () => true;
  assert.deepEqual(
    resolveEscapeShell("ls", { env: { SHELL: "/usr/bin/zsh" }, exists }),
    { args: ["-ic", "ls"], file: "/usr/bin/zsh", interactive: true },
  );
  assert.deepEqual(
    resolveEscapeShell("ls", { env: { SHELL: "/opt/homebrew/bin/bash" }, exists }),
    { args: ["-ic", "ls"], file: "/opt/homebrew/bin/bash", interactive: true },
  );
  // 非 bash/zsh 的 SHELL 与缺失/不可执行一律回退 /bin/sh（不读 rc）。
  for (const shell of ["/usr/bin/fish", "/usr/bin/nu", "/bin/zsh", ""]) {
    const spec = resolveEscapeShell("ls", {
      env: shell ? { SHELL: shell } : {},
      exists: (path) => path !== "/bin/zsh",
    });
    assert.equal(spec.file, "/bin/sh", shell);
    assert.equal(spec.interactive, false);
    assert.deepEqual(spec.args, ["-c", "ls"]);
  }
  const win = resolveEscapeShell("dir", {
    env: { ComSpec: "C:\\Windows\\cmd.exe" },
    platform: "win32",
  });
  assert.deepEqual(win.args, ["/d", "/s", "/c", "dir"]);
  assert.equal(win.interactive, false);
});

// `!` 必须读到用户 rc：alias/函数只在交互 shell 里定义。
// 用临时 HOME + 种子 rc 证明 `-ic` 让 alias 生效，且启动噪声不进输出。
const interactiveShellCases = [
  { rcFile: ".bashrc", shell: "/bin/bash" },
  { rcFile: ".zshrc", shell: "/usr/bin/zsh" },
] as const;

for (const { rcFile, shell } of interactiveShellCases) {
  test(`\`!cmd\` sees ${rcFile} aliases via ${shell} -ic`, async (t) => {
    if (!existsSync(shell)) {
      t.skip(`${shell} not installed`);
      return;
    }
    const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-rc-"));
    const home = mkdtempSync(join(tmpdir(), "zcode-shell-home-"));
    try {
      writeFileSync(join(home, rcFile), "alias zz_piz_probe='echo rc-alias-ok'\n");
      const env = { ...process.env, HOME: home, SHELL: shell };
      const run = await runShellCommand({ command: "zz_piz_probe", cwd, env });
      assert.equal(run.exitCode, 0, run.output);
      assert.ok(run.output.includes("rc-alias-ok"), run.output);
      assert.ok(!run.output.includes("job control"), run.output);
      assert.ok(!run.output.includes("terminal process group"), run.output);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
      rmSync(home, { force: true, recursive: true });
    }
  });
}

test("`!cmd` keeps real stderr while stripping shell startup noise", async (t) => {
  const shell = ["/bin/bash", "/usr/bin/zsh"].find((path) => existsSync(path));
  if (!shell) {
    t.skip("no bash/zsh installed");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-err-"));
  const home = mkdtempSync(join(tmpdir(), "zcode-shell-home-"));
  try {
    const env = { ...process.env, HOME: home, SHELL: shell };
    const run = await runShellCommand({
      command: "echo real-stderr >&2",
      cwd,
      env,
    });
    assert.ok(run.output.includes("real-stderr"), run.output);
    assert.ok(!run.output.includes("job control"), run.output);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("context block is machine-readable and keeps the command", () => {
  const block = formatShellContextBlock({
    command: "git status --short",
    exitCode: 1,
    output: "M a.ts\n",
    timedOut: false,
    truncated: false,
  });
  assert.ok(block.startsWith('<shell-output command="git status --short" exit=1>'));
  assert.ok(block.endsWith("</shell-output>"));
  assert.ok(block.includes("M a.ts"));
});

test("transcript row renders the command and flags a failure", () => {
  const row = formatShellTranscriptRow({
    command: "false",
    exitCode: 1,
    output: "",
    timedOut: false,
    truncated: false,
  });
  assert.ok(row.startsWith("!false"));
  assert.ok(row.includes("(exit 1)"));
});

test("`!cmd` runs locally, prints a row, and feeds the next prompt", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "zcode-shell-app-"));
  const prompts: TuiPromptInput[] = [];
  const h = createHarness({
    submitPrompt: async (input) => {
      prompts.push(input);
      return { response: "ok" };
    },
    workspaceDirectory: workspace,
  });
  try {
    h.feed("!echo hello-from-shell");
    h.feed(ENTER);
    await h.flush();
    // A shell escape is not a model turn.
    assert.equal(prompts.length, 0);
    assert.equal(h.draftText(), "");
    const shellRow = h.store.state.messages.find(
      (message) => message.role === "system" && message.content.startsWith("!echo"),
    );
    assert.ok(shellRow, "shell output must appear in the transcript");
    assert.ok(shellRow.content.includes("hello-from-shell"));

    await h.app.submitValue("what did it print?");
    assert.equal(prompts.length, 1);
    const sent = promptText(prompts[0]!);
    assert.ok(sent.startsWith('<shell-output command="echo hello-from-shell" exit=0>'));
    assert.ok(sent.includes("hello-from-shell"));
    assert.ok(sent.endsWith("what did it print?"));

    // Consumed exactly once.
    await h.app.submitValue("and again?");
    assert.ok(!promptText(prompts[1]!).includes("<shell-output"));
  } finally {
    await h.stop();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("slash commands do not swallow buffered shell output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "zcode-shell-slash-"));
  const prompts: TuiPromptInput[] = [];
  const h = createHarness({
    submitPrompt: async (input) => {
      prompts.push(input);
      return { response: "ok" };
    },
    workspaceDirectory: workspace,
  });
  try {
    h.feed("!printf buffered");
    h.feed(ENTER);
    await h.flush();
    await h.app.submitValue("/model provider/model");
    assert.equal(promptText(prompts[0]!), "/model provider/model");
    await h.app.submitValue("real prompt");
    assert.ok(promptText(prompts[1]!).startsWith("<shell-output"));
  } finally {
    await h.stop();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("display collapses the context block into a one-line notice", () => {
  const block = formatShellContextBlock({
    command: 'echo "hi" && pwd',
    exitCode: 0,
    output: "/tmp/ws\n",
    timedOut: false,
    truncated: false,
  });
  const collapsed = collapseShellContextBlocks(`${block}\n\nwhat did it print?`);
  assert.equal(collapsed.text, "what did it print?");
  assert.deepEqual(collapsed.notices, ['⤷ shell output: echo "hi" && pwd (exit 0)']);
});

test("user rows hide the inline block but keep the notice", () => {
  const theme = createPiTheme({ noColor: true });
  const block = formatShellContextBlock({
    command: "ls",
    exitCode: 2,
    output: "boom\n",
    timedOut: false,
    truncated: false,
  });
  const lines = new MessageRow(
    { content: `${block}\n\nreview this`, role: "user" },
    theme,
    piMarkdownTheme(theme),
  ).render(80);
  assert.ok(lines[0]!.startsWith("> review this"));
  assert.ok(lines.some((line) => line.includes("⤷ shell output: ls (exit 2)")));
  assert.ok(!lines.some((line) => line.includes("<shell-output")));
  assert.ok(!lines.some((line) => line.includes("boom")));
});

test("commands containing `>` (redirects) survive the display collapse", () => {
  const block = formatShellContextBlock({
    command: 'git status --short 2>&1 | head -3; echo "shell-ok"',
    exitCode: 0,
    output: "shell-ok\n",
    timedOut: false,
    truncated: false,
  });
  const collapsed = collapseShellContextBlocks(`${block}\n\nsummarize`);
  assert.deepEqual(collapsed.notices, [
    '⤷ shell output: git status --short 2>&1 | head -3; echo "shell-ok" (exit 0)',
  ]);
  assert.equal(collapsed.text, "summarize");
});

test("a hand-typed unclosed marker is not swallowed", () => {
  const collapsed = collapseShellContextBlocks('<shell-output command="x">\nstill typing');
  assert.equal(collapsed.notices.length, 0);
  assert.ok(collapsed.text.includes("still typing"));
});
