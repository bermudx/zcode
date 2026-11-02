// `!command`/`!!command` escape: runs in the client workspace, prints into the
// transcript, and `!` output rides along with the next prompt (the core owns
// history, so there is no protocol verb to append a local message). Execution
// semantics mirror pi-mono: deterministic `bash -c` (never $SHELL, no rc),
// detached spawn, process-tree kill, idle-pipe-grace wait, and pi
// bash-execator output policy — tail truncation at 64k chars / 2000 lines
// with the full output spilled to <tmpdir>/piz-shell-<hex>.log.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("oversized `!cmd` keeps the tail and spills the full output", async (t) => {
  if (!existsSync("/bin/bash")) {
    t.skip("bash not installed");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-spill-"));
  try {
    // 20000 lines ≈ 109k chars：行数与字符双超限，spill 在流式阶段开启。
    const run = await runShellCommand({ command: "seq 1 20000", cwd });
    assert.equal(run.exitCode, 0);
    assert.equal(run.truncated, true);
    assert.ok(run.fullOutputPath, "truncated run must expose the spill path");
    assert.ok(
      run.fullOutputPath!.startsWith(join(tmpdir(), "piz-shell-")),
      run.fullOutputPath,
    );
    assert.ok(run.fullOutputPath!.endsWith(".log"), run.fullOutputPath);
    // 保尾：上下文只留最后 2000 行完整行。
    assert.ok(run.output.startsWith("18001\n18002"), run.output.slice(0, 40));
    assert.ok(run.output.trimEnd().endsWith("20000"));
    assert.ok(run.output.length <= 64_000);
    // spill 文件保有完整输出（懒开启早于滚动淘汰，头部不丢）。
    const spilled = readFileSync(run.fullOutputPath!, "utf8");
    assert.ok(spilled.startsWith("1\n2\n3\n"), "spill must keep the head");
    assert.ok(spilled.endsWith("20000\n"));
    assert.equal(statSync(run.fullOutputPath!).mode & 0o777, 0o600);
    rmSync(run.fullOutputPath!, { force: true });
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("line-count-only truncation opens the spill at finish", async (t) => {
  if (!existsSync("/bin/bash")) {
    t.skip("bash not installed");
    return;
  }
  // 3000 行 ≈ 14k 字符：字符未越界，流式阶段不触发，finish 兜底开启。
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-lines-"));
  try {
    const run = await runShellCommand({ command: "seq 1 3000", cwd });
    assert.equal(run.truncated, true);
    assert.ok(run.output.startsWith("1001\n1002"), run.output.slice(0, 40));
    assert.ok(run.fullOutputPath);
    const spilled = readFileSync(run.fullOutputPath!, "utf8");
    assert.ok(spilled.startsWith("1\n2\n3\n"));
    assert.ok(spilled.endsWith("3000\n"));
    rmSync(run.fullOutputPath!, { force: true });
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("untruncated runs never create a spill file", async (t) => {
  if (!existsSync("/bin/bash")) {
    t.skip("bash not installed");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-nospill-"));
  try {
    const run = await runShellCommand({ command: "seq 1 100", cwd });
    assert.equal(run.truncated, false);
    assert.equal(run.fullOutputPath, undefined);
    // 未截断输出保留尾随换行（pi truncateTail 惯例）。
    assert.equal(run.output, `${Array.from({ length: 100 }, (_, i) => i + 1).join("\n")}\n`);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("an oversize line is dropped unless it is the only kept content", async (t) => {
  if (!existsSync("/bin/bash")) {
    t.skip("bash not installed");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-bigline-"));
  try {
    // 超限单行 + 末行：从尾往前保行，超限行整体让位（pi 语义，仅“一行都
    // 没保住”时才切该行末尾）。
    const two = await runShellCommand({
      command: `awk 'BEGIN { for (i = 0; i < 70000; i++) printf "x" } END { printf "\\nEND-MARKER" }'`,
      cwd,
    });
    assert.equal(two.truncated, true);
    assert.equal(two.output, "END-MARKER");
    assert.ok(two.fullOutputPath);
    assert.equal(readFileSync(two.fullOutputPath!, "utf8").length, 70000 + "\nEND-MARKER".length);
    rmSync(two.fullOutputPath!, { force: true });

    // 仅一行且超限：保留该行末尾 64k 字符（pi lastLinePartial）。
    const one = await runShellCommand({
      command: `awk 'BEGIN { for (i = 0; i < 70000; i++) printf "x" }'`,
      cwd,
    });
    assert.equal(one.truncated, true);
    assert.equal(one.output.length, 64_000);
    assert.ok(one.fullOutputPath);
    rmSync(one.fullOutputPath!, { force: true });
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("spill failure degrades to a pathless truncation notice", async (t) => {
  if (!existsSync("/bin/bash")) {
    t.skip("bash not installed");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-spillfail-"));
  const errors: unknown[] = [];
  try {
    const run = await runShellCommand({
      command: "seq 1 3000",
      cwd,
      createSpillStream: () => {
        throw new Error("disk full");
      },
      onSpillError: (error) => errors.push(error),
    });
    assert.equal(run.truncated, true);
    assert.equal(run.fullOutputPath, undefined);
    assert.equal(errors.length, 1);
    const block = formatShellContextBlock(run);
    assert.ok(block.includes("truncated=true"));
    assert.ok(!block.includes("full_output="));
    assert.ok(block.includes("[Output truncated. Full output: unavailable]"));
    const collapsed = collapseShellContextBlocks(`${block}\n\nsummarize`);
    assert.deepEqual(collapsed.notices, ["⤷ shell output: seq 1 3000 (exit 0) — truncated"]);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("truncation notice travels in the block, transcript row and collapsed display", () => {
  const run = {
    command: "cat big.log",
    exitCode: 0,
    output: "tail-end\n",
    timedOut: false,
    truncated: true,
    fullOutputPath: "/tmp/piz-shell-deadbeef.log",
  };
  const block = formatShellContextBlock(run);
  assert.ok(
    block.startsWith(
      '<shell-output command="cat big.log" exit=0 truncated=true full_output="/tmp/piz-shell-deadbeef.log">',
    ),
  );
  assert.ok(block.includes("[Output truncated. Full output: /tmp/piz-shell-deadbeef.log]"));
  assert.ok(block.indexOf("tail-end") < block.indexOf("[Output truncated"));

  const row = formatShellTranscriptRow(run);
  assert.ok(row.includes("[Output truncated. Full output: /tmp/piz-shell-deadbeef.log]"));

  const collapsed = collapseShellContextBlocks(`${block}\n\nsummarize`);
  assert.equal(collapsed.text, "summarize");
  assert.deepEqual(collapsed.notices, [
    "⤷ shell output: cat big.log (exit 0) — truncated, full output: /tmp/piz-shell-deadbeef.log",
  ]);
});

test("`!cmd` truncation reaches the next prompt block end to end", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "zcode-shell-app-spill-"));
  const prompts: TuiPromptInput[] = [];
  const h = createHarness({
    submitPrompt: async (input) => {
      prompts.push(input);
      return { response: "ok" };
    },
    workspaceDirectory: workspace,
  });
  try {
    h.feed("!seq 1 3000");
    h.feed(ENTER);
    await h.flush(() =>
      h.store.state.messages.some(
        (message) => message.role === "system" && message.content.startsWith("!seq"),
      ),
    );
    const shellRow = h.store.state.messages.find(
      (message) => message.role === "system" && message.content.startsWith("!seq"),
    );
    assert.ok(shellRow!.content.includes("[Output truncated. Full output: "));

    await h.app.submitValue("summarize it");
    const sent = promptText(prompts[0]!);
    assert.ok(sent.startsWith('<shell-output command="seq 1 3000" exit=0 truncated=true'), sent.slice(0, 80));
    assert.ok(sent.includes('full_output="'), sent.slice(0, 200));
    assert.ok(sent.includes("[Output truncated. Full output: "));
    assert.ok(sent.endsWith("summarize it"));
    const spilled = /full_output="([^"]+)"/u.exec(sent);
    assert.ok(spilled, "block must carry the spill path");
    assert.ok(readFileSync(spilled[1]!, "utf8").startsWith("1\n2\n3\n"));
    rmSync(spilled[1]!, { force: true });
  } finally {
    await h.stop();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("boundary: exactly at cap does not truncate, one over does", async (t) => {
  if (!existsSync("/bin/bash")) {
    t.skip("bash not installed");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-boundary-"));
  try {
    // 字符边界：64000 恰好不截断（保留尾随换行惯例不适用于无换行单行）。
    const chars = await runShellCommand({
      command: `awk 'BEGIN { for (i = 0; i < 64000; i++) printf "x" }'`,
      cwd,
    });
    assert.equal(chars.truncated, false);
    assert.equal(chars.output.length, 64_000);
    const charsOver = await runShellCommand({
      command: `awk 'BEGIN { for (i = 0; i < 64001; i++) printf "x" }'`,
      cwd,
    });
    assert.equal(charsOver.truncated, true);
    assert.equal(charsOver.output.length, 64_000);
    rmSync(charsOver.fullOutputPath!, { force: true });

    // 行边界：2000 行恰好不截断，2001 行保尾。
    const lines = await runShellCommand({ command: "seq 1 2000", cwd });
    assert.equal(lines.truncated, false);
    assert.ok(lines.output.startsWith("1\n2\n"));
    assert.ok(lines.output.trimEnd().endsWith("2000"));
    const linesOver = await runShellCommand({ command: "seq 1 2001", cwd });
    assert.equal(linesOver.truncated, true);
    assert.ok(linesOver.output.startsWith("2\n3\n"), linesOver.output.slice(0, 20));
    rmSync(linesOver.fullOutputPath!, { force: true });
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("control-char-heavy output cannot silently beat the cap", async (t) => {
  if (!existsSync("/bin/bash")) {
    t.skip("bash not installed");
    return;
  }
  // 审查回归：清理必须先于计数/缓冲——否则控制字符把原始长度顶过滚动
  // 淘汰线、清理后却低于截断阈值，真实内容被无声丢掉且不报告截断。
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-control-"));
  try {
    // 清理后 70k 可见字符 > 64k：必须按截断处理，spill 保有清理后全文。
    const over = await runShellCommand({
      command: `awk 'BEGIN { for (i = 0; i < 70000; i++) printf "y"; for (i = 0; i < 150000; i++) printf "%c", 7 }'`,
      cwd,
    });
    assert.equal(over.truncated, true);
    assert.equal(over.output.length, 64_000);
    assert.ok(over.fullOutputPath);
    const spilledOver = readFileSync(over.fullOutputPath!, "utf8");
    assert.equal(spilledOver.length, 70_000);
    assert.ok(/^y+$/u.test(spilledOver));
    rmSync(over.fullOutputPath!, { force: true });

    // 清理后 60k 可见字符 < 64k：不截断、无 spill、内容零丢失。
    const under = await runShellCommand({
      command: `awk 'BEGIN { for (i = 0; i < 30000; i++) printf "z"; for (i = 0; i < 50000; i++) printf "%c", 7; for (i = 0; i < 30000; i++) printf "z"; for (i = 0; i < 50000; i++) printf "%c", 7 }'`,
      cwd,
    });
    assert.equal(under.truncated, false);
    assert.equal(under.fullOutputPath, undefined);
    assert.equal(under.output.length, 60_000);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
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
