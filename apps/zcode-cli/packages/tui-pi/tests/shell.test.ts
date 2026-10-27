// `!command`/`!!command` escape: runs in the client workspace, prints into the
// transcript, and `!` output rides along with the next prompt (the core owns
// history, so there is no protocol verb to append a local message). Execution
// semantics mirror pi-mono: deterministic `bash -c` (never $SHELL, no rc),
// detached spawn, process-tree kill, idle-pipe-grace wait.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("only `!cmd`/`!!cmd` are shell escapes, bare prefixes are text", () => {
  assert.equal(isShellCommand("!ls"), true);
  assert.equal(isShellCommand("!!ls"), true);
  assert.equal(isShellCommand("  ! git status"), true);
  assert.equal(isShellCommand("!"), false);
  assert.equal(isShellCommand("!!"), false);
  assert.equal(isShellCommand("!  "), false);
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

test("resolveEscapeShell follows the pi-mono bash chain, never $SHELL", () => {
  // Unix: /bin/bash wins even when $SHELL points elsewhere.
  assert.deepEqual(
    resolveEscapeShell({ env: { SHELL: "/usr/bin/zsh" }, exists: () => true }),
    { args: ["-c"], commandTransport: "argv", file: "/bin/bash" },
  );
  // /bin/bash missing → `which bash` hit; $SHELL still ignored.
  assert.deepEqual(
    resolveEscapeShell({
      env: { SHELL: "/usr/bin/zsh" },
      exists: (path) => path !== "/bin/bash",
      which: () => "/usr/local/bin/bash",
    }),
    { args: ["-c"], commandTransport: "argv", file: "/usr/local/bin/bash" },
  );
  // No bash anywhere → bare `sh` (PATH-resolved, like pi-mono).
  assert.deepEqual(
    resolveEscapeShell({ exists: () => false, which: () => null }),
    { args: ["-c"], commandTransport: "argv", file: "sh" },
  );
});

test("resolveEscapeShell on Windows prefers Git Bash, then `where bash.exe`", () => {
  const env = { ProgramFiles: "C:\\Program Files" };
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  assert.deepEqual(
    resolveEscapeShell({ env, exists: () => true, platform: "win32" }),
    { args: ["-c"], commandTransport: "argv", file: gitBash },
  );
  // Git Bash absent → bash.exe on PATH. A legacy WSL path gets `-s` + stdin
  // transport (argv -c quoting is broken there).
  const wsl = "C:\\Windows\\System32\\bash.exe";
  assert.deepEqual(
    resolveEscapeShell({
      env,
      exists: () => false,
      platform: "win32",
      which: () => wsl,
    }),
    { args: ["-s"], commandTransport: "stdin", file: wsl },
  );
  // No bash at all → pi-mono throws with install instructions.
  assert.throws(
    () =>
      resolveEscapeShell({ env, exists: () => false, platform: "win32", which: () => null }),
    /No bash shell found/,
  );
});

test("`!cmd` inherits exported env but not rc aliases", async (t) => {
  // pi-mono `bash -c` semantics: no rc, so aliases never apply — but exported
  // environment (PATH additions, vars) still does because the child inherits it.
  if (!existsSync("/bin/bash")) {
    t.skip("bash not installed");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-env-"));
  const home = mkdtempSync(join(tmpdir(), "zcode-shell-home-"));
  try {
    writeFileSync(join(home, ".bashrc"), "alias zz_piz_probe='echo rc-alias-ok'\n");
    const env = { ...process.env, HOME: home, ZZ_PIZ_VAR: "env-inherited" };
    const alias = await runShellCommand({ command: "zz_piz_probe", cwd, env });
    assert.notEqual(alias.exitCode, 0, alias.output);
    assert.ok(!alias.output.includes("rc-alias-ok"), alias.output);
    const inherited = await runShellCommand({ command: "echo $ZZ_PIZ_VAR", cwd, env });
    assert.equal(inherited.exitCode, 0);
    assert.equal(inherited.output, "env-inherited\n");
  } finally {
    rmSync(cwd, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test("`!cmd` resolves commands added to PATH by the user's profile", async (t) => {
  if (!existsSync("/bin/bash")) {
    t.skip("bash not installed");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-path-"));
  const bindir = mkdtempSync(join(tmpdir(), "zcode-shell-bin-"));
  try {
    const tool = join(bindir, "zz-piz-tool");
    writeFileSync(tool, "#!/bin/sh\necho path-tool-ok\n");
    chmodSync(tool, 0o755);
    const env = { ...process.env, PATH: `${bindir}:${process.env.PATH}` };
    const run = await runShellCommand({ command: "zz-piz-tool", cwd, env });
    assert.equal(run.exitCode, 0, run.output);
    assert.ok(run.output.includes("path-tool-ok"), run.output);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
    rmSync(bindir, { force: true, recursive: true });
  }
});

test("`!cmd` resolves when a detached grandchild keeps the output pipe open", async (t) => {
  // pi#5303: the child exits while a backgrounded descendant still holds
  // stdout — waiting on `close` hangs; exit + idle-pipe grace must not.
  if (!existsSync("/bin/bash")) {
    t.skip("bash not installed");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-grandchild-"));
  try {
    const startedAt = Date.now();
    const run = await runShellCommand({ command: "sleep 3 & echo done", cwd });
    assert.equal(run.exitCode, 0, run.output);
    assert.ok(run.output.includes("done"), run.output);
    assert.ok(Date.now() - startedAt < 3_000, "must not wait for the grandchild");
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("`!cmd` abort kills the detached process group", async (t) => {
  if (!existsSync("/bin/bash")) {
    t.skip("bash not installed");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-abort-"));
  try {
    const controller = new AbortController();
    const promise = runShellCommand({ command: "sleep 60", cwd, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const startedAt = Date.now();
    const run = await promise;
    // SIGKILL → 128+9 per the shell convention, not a clean exit.
    assert.equal(run.exitCode, 137);
    assert.ok(Date.now() - startedAt < 5_000);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
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
    // `!cmd` 跨进程边界（spawn bash 子进程）：固定预算必然偶发不足，
    // 按「转写行出现」这一终态条件等待（P003-F1）。
    await h.flush(() =>
      h.store.state.messages.some(
        (message) => message.role === "system" && message.content.startsWith("!echo"),
      ),
    );
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

test("`!!cmd` prints a row but keeps output out of the next prompt", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "zcode-shell-excluded-"));
  const prompts: TuiPromptInput[] = [];
  const h = createHarness({
    submitPrompt: async (input) => {
      prompts.push(input);
      return { response: "ok" };
    },
    workspaceDirectory: workspace,
  });
  try {
    h.feed("!!echo local-only");
    h.feed(ENTER);
    await h.flush(() =>
      h.store.state.messages.some(
        (message) => message.role === "system" && message.content.startsWith("!!echo"),
      ),
    );
    const shellRow = h.store.state.messages.find(
      (message) => message.role === "system" && message.content.startsWith("!!echo"),
    );
    assert.ok(shellRow, "excluded run must still print a transcript row");
    assert.ok(shellRow.content.includes("local-only"));

    await h.app.submitValue("prompt after excluded run");
    assert.equal(prompts.length, 1);
    const sent = promptText(prompts[0]!);
    assert.ok(!sent.includes("<shell-output"), sent);
    assert.ok(!sent.includes("local-only"), sent);
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
    await h.flush(() =>
      h.store.state.messages.some(
        (message) => message.role === "system" && message.content.startsWith("!printf"),
      ),
    );
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
    () => false,
  ).render(80);
  // 用户块首行是 bg 填充，内容行从 index 1 起。
  assert.ok(lines[1]!.startsWith("> review this"));
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
