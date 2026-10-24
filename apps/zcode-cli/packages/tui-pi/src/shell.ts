// Local shell escape for the composer (`!command`, `!!command`).
//
// Execution semantics are ported from pi-mono
// (packages/coding-agent/src/utils/shell.ts + core/tools/bash.ts):
// - bash is resolved deterministically (/bin/bash → `bash` on PATH → sh; Git
//   Bash → `where bash.exe` on Windows), never the user's $SHELL, and always
//   non-interactive `-c`. Same shell the model's bash tool uses; no rc, so
//   aliases/functions do not apply, but exported env (PATH etc.) does.
// - POSIX children spawn detached (new session, no controlling tty), so no
//   interactive job-control tcsetpgrp can ever steal the client terminal.
// - Timeout/abort kills the whole process tree (SIGKILL to -pgid, or
//   taskkill /F /T on Windows); detached children are tracked so shutdown
//   can reap them (see killTrackedShellChildren, wired in run-tui.ts).
// - Completion waits on `exit` + idle-pipe grace, not `close`: a detached
//   grandchild holding the stdout pipe can't hang the run or truncate the
//   tail (pi#5303).
//
// Divergences kept for this thin client: no settings.shellPath override, no
// pi bin-dir PATH prepend, no extension hooks/Esc-cancel, and output keeps
// head-truncation into <shell-output> blocks on the next prompt instead of
// pi's tail-truncation + temp file (the core owns history and has no
// "append local message" verb). `!` buffers output into the next prompt;
// `!!` runs locally and is excluded from context — pi's own semantics.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join } from "node:path";

export const SHELL_ROW_PREFIX = "!";
export const SHELL_EXCLUDED_PREFIX = "!!";
const MAX_OUTPUT_CHARS = 64_000;
const MAX_OUTPUT_LINES = 2_000;
export const SHELL_TIMEOUT_MS = 120_000;
const EXIT_STDIO_GRACE_MS = 100;
const WHICH_TIMEOUT_MS = 5_000;

export type ShellRunResult = {
  command: string;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
  /** `!!cmd` ran locally but its output never enters model context. */
  excludeFromContext?: boolean;
};

/**
 * `!`/`!!` alone are text, not commands; `!cmd` buffers output into the next
 * prompt, `!!cmd` runs locally without touching context (pi-mono semantics).
 */
export const isShellCommand = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SHELL_ROW_PREFIX)) return false;
  const body = trimmed.startsWith(SHELL_EXCLUDED_PREFIX)
    ? trimmed.slice(SHELL_EXCLUDED_PREFIX.length)
    : trimmed.slice(SHELL_ROW_PREFIX.length);
  return body.trim().length > 0;
};

/** Transcript content for a finished run: `!cmd` line, blank line, output. */
export const formatShellTranscriptRow = (run: ShellRunResult): string => {
  const header = `${run.excludeFromContext ? SHELL_EXCLUDED_PREFIX : SHELL_ROW_PREFIX}${run.command}`;
  const status = run.timedOut
    ? `(timed out after ${Math.round(SHELL_TIMEOUT_MS / 1000)}s)`
    : run.exitCode !== null && run.exitCode !== 0
      ? `(exit ${run.exitCode})`
      : "";
  const lines = [header];
  if (status) lines.push(status);
  if (run.output.trim().length > 0) lines.push(run.output.trimEnd());
  return lines.join("\n");
};

/** Context block prepended to the next prompt so the model sees the output. */
export const formatShellContextBlock = (run: ShellRunResult): string => {
  const attributes = [
    `command=${JSON.stringify(run.command)}`,
    run.exitCode === null ? "" : `exit=${run.exitCode}`,
    run.timedOut ? "timed_out=true" : "",
    run.truncated ? "truncated=true" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [`<shell-output ${attributes}>`, run.output.trimEnd(), "</shell-output>"].join(
    "\n",
  );
};

const SHELL_CONTEXT_OPEN = "<shell-output ";
const SHELL_CONTEXT_CLOSE = "</shell-output>";
/** `key="value"` 或 `key=value`；quoted 分支避开命令里的 `>`（如 `2>&1`）。 */
const SHELL_CONTEXT_ATTRIBUTE = /([a-zA-Z_][\w-]*)=(?:"((?:[^"\\]|\\.)*)"|([^\s>]+))/gu;

const shellContextNotices = (header: string): string[] => {
  const attributes = new Map<string, string>();
  for (const match of header.matchAll(SHELL_CONTEXT_ATTRIBUTE)) {
    const raw = match[2];
    if (raw === undefined) {
      attributes.set(match[1] as string, match[3] as string);
      continue;
    }
    try {
      attributes.set(match[1] as string, JSON.parse(`"${raw}"`) as string);
    } catch {
      attributes.set(match[1] as string, raw);
    }
  }
  const command = attributes.get("command");
  const exitCode = attributes.get("exit");
  const suffix = exitCode === undefined ? "" : ` (exit ${exitCode})`;
  return [`⤷ shell output: ${command ?? ""}${suffix}`];
};

/**
 * Display-only: the prompt row would otherwise repeat the whole block we just
 * printed as its own `!cmd` row. The wire text keeps the block verbatim; the
 * transcript replaces it with a one-line notice appended after the user text.
 * A block without a closing tag (someone typing the marker by hand) is kept
 * as-is — we only hide blocks this client produced.
 */
export const collapseShellContextBlocks = (
  text: string,
): { notices: string[]; text: string } => {
  const notices: string[] = [];
  const kept: string[] = [];
  let block: string[] | undefined;
  for (const line of text.split("\n")) {
    if (!block) {
      if (line.startsWith(SHELL_CONTEXT_OPEN)) {
        block = [line];
        continue;
      }
      kept.push(line);
      continue;
    }
    block.push(line);
    if (line.trim() === SHELL_CONTEXT_CLOSE) {
      const header = block[0]!.slice(SHELL_CONTEXT_OPEN.length).trimEnd();
      notices.push(...shellContextNotices(header));
      block = undefined;
    }
  }
  if (block) kept.push(...block);
  return {
    notices,
    text: kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim(),
  };
};

// ---------------------------------------------------------------------------
// Shell resolution — ported from pi-mono utils/shell.ts:getShellConfig.
// ---------------------------------------------------------------------------

export type EscapeShell = {
  /** Shell executable path (or bare name resolved via PATH at spawn). */
  file: string;
  /** Flag args only — the command is appended for argv transport, or written
   *  to stdin when commandTransport === "stdin". */
  args: string[];
  commandTransport: "argv" | "stdin";
};

const WINDOWS_SYSTEM32_BASH =
  /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/iu;

/**
 * Legacy WSL bash.exe misreads `-c` argv quoting; pi feeds the command through
 * stdin with `-s` instead.
 */
const isLegacyWslBashPath = (path: string): boolean =>
  WINDOWS_SYSTEM32_BASH.test(path.replaceAll("/", "\\").toLowerCase());

const bashShellSpec = (file: string): EscapeShell =>
  isLegacyWslBashPath(file)
    ? { args: ["-s"], commandTransport: "stdin", file }
    : { args: ["-c"], commandTransport: "argv", file };

const windowsGitBashCandidates = (env: NodeJS.ProcessEnv): string[] => {
  const paths: string[] = [];
  // Literal `\\` like pi-mono: these paths only ever resolve on Windows,
  // where the platform separator is a backslash regardless of host.
  for (const key of ["ProgramFiles", "ProgramFiles(x86)"] as const) {
    const root = env[key];
    if (root) paths.push(`${root}\\Git\\bin\\bash.exe`);
  }
  return paths;
};

/**
 * `where` on Windows / `which` on Unix. `where` can return non-existent paths,
 * so Windows results are re-checked with exists; Unix `which` output is
 * trusted (handles Termux and special filesystems).
 */
const findExecutableOnPath = (
  executable: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | null => {
  const isWindows = process.platform === "win32";
  try {
    const result = spawnSync(isWindows ? "where" : "which", [executable], {
      encoding: "utf-8",
      env,
      timeout: WHICH_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/u)[0];
      if (firstMatch && (!isWindows || exists(firstMatch))) {
        return firstMatch;
      }
    }
  } catch {
    /* lookup tool missing — fall through */
  }
  return null;
};

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolve the `!` escape shell. Deterministic bash, same chain as pi-mono:
 * Windows — Git Bash in ProgramFiles → `where bash.exe` → throw with install
 * instructions. Unix — /bin/bash → `which bash` → `sh`. The user's $SHELL is
 * deliberately not consulted: `!` uses non-interactive `-c`, so a zsh/fish
 * login shell would only add divergence, not rc/aliases.
 */
export const resolveEscapeShell = (
  options: {
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
    which?: (executable: string, env: NodeJS.ProcessEnv) => string | null;
  } = {},
): EscapeShell => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? isExecutableFile;
  const which = options.which ?? ((name: string) => findExecutableOnPath(name, env, existsSync));

  if (platform === "win32") {
    const candidates = windowsGitBashCandidates(env);
    for (const candidate of candidates) {
      if (exists(candidate)) return bashShellSpec(candidate);
    }
    const bashOnPath = which("bash.exe", env);
    if (bashOnPath) return bashShellSpec(bashOnPath);
    throw new Error(
      `No bash shell found. Options:\n` +
        `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
        `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n\n` +
        `Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
    );
  }

  if (exists("/bin/bash")) return bashShellSpec("/bin/bash");
  const bashOnPath = which("bash", env);
  if (bashOnPath) return bashShellSpec(bashOnPath);
  return { args: ["-c"], commandTransport: "argv", file: "sh" };
};

// ---------------------------------------------------------------------------
// Process management — ported from pi-mono utils/shell.ts + child-process.ts.
// ---------------------------------------------------------------------------

/**
 * 输出去掉控制字符（含 ESC，防 `!cat` 二进制/转义序列污染 TUI 渲染与模型
 * 上下文）。剔除区间与 pi-mono sanitizeBinaryOutput 一致：C0 控制符保留
 * \t/\n/\r，外加会崩 string-width 的 U+FFF9..U+FFFB。
 */
const SANITIZE_CODEPOINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0xfff9, 0xfffb],
];

const sanitizeBinaryOutput = (text: string): string => {
  // `for…of` iterates code points, so astral pairs are never split.
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!SANITIZE_CODEPOINT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) {
      out += ch;
    }
  }
  return out;
};

/** detached 子进程登记表：TUI 退出/被杀时由 killTrackedShellChildren 收尸。 */
const trackedShellPids = new Set<number>();

export const killTrackedShellChildren = (): void => {
  for (const pid of trackedShellPids) {
    killProcessTree(pid);
  }
  trackedShellPids.clear();
};

/** Kill a process and all its children (pi-mono killProcessTree). */
const killProcessTree = (pid: number): void => {
  if (process.platform === "win32") {
    // Use the trusted System32 executable so cleanup does not depend on PATH.
    try {
      const child = spawn(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", String(pid)],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      // A failed spawn emits "error" asynchronously; consume it to avoid
      // crashing Node.
      child.once("error", () => {});
    } catch {
      /* taskkill failed to launch */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Fallback to killing just the child if process group kill fails.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* process already dead */
    }
  }
};

/**
 * Wait for a child to terminate without hanging on inherited stdio handles
 * (pi-mono waitForChildProcess, pi#5303): a short-lived child can `exit`
 * while a detached descendant keeps its stdout/stderr pipe open, so `close`
 * may never fire. After `exit` we wait for the pipes to fall idle — the grace
 * timer re-arms on every chunk, so an actively writing descendant keeps us
 * reading while a quiet inherited handle releases us after the grace.
 */
const waitForChildProcess = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = (): void => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = (): void => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const armIdleTimer = (): void => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = (): void => {
      // Output is still arriving after exit; defer finalizing so we don't
      // destroy the stream mid-write and truncate the tail.
      if (exited && !settled) armIdleTimer();
    };

    const onStdoutEnd = (): void => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = (): void => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onExit = (code: number | null): void => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };

    const onClose = (code: number | null): void => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });

export const runShellCommand = async (input: {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shellExists?: (path: string) => boolean;
  signal?: AbortSignal;
}): Promise<ShellRunResult> => {
  const env = input.env ?? process.env;
  const errorResult = (message: string): ShellRunResult => ({
    command: input.command,
    exitCode: null,
    output: `${message}\n`,
    timedOut: false,
    truncated: false,
  });
  let spec: EscapeShell;
  try {
    spec = resolveEscapeShell({ env, exists: input.shellExists });
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
  try {
    await fsAccess(input.cwd, fsConstants.F_OK);
  } catch {
    return errorResult(
      `Working directory does not exist: ${input.cwd}\nCannot execute shell commands.`,
    );
  }

  return await new Promise<ShellRunResult>((resolve) => {
    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const commandViaStdin = spec.commandTransport === "stdin";
    // detached（POSIX setsid）：子进程拿到新 session、没有控制终端——任何
    // shell/rc 都无法对本终端 tcsetpgrp 抢占前台进程组（客户端下一次
    // stdin read 即 SIGTTIN 挂起的根因）。detached 也让 child.pid 成为
    // 新进程组 pgid，killProcessTree 组杀才能带上仍在跑的命令树。
    const detached = process.platform !== "win32";
    const child = spawn(
      spec.file,
      commandViaStdin ? spec.args : [...spec.args, input.command],
      {
        cwd: input.cwd,
        detached,
        env,
        stdio: [commandViaStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    if (commandViaStdin) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input.command);
    }
    if (child.pid !== undefined) trackedShellPids.add(child.pid);

    const append = (chunk: Buffer | string): void => {
      if (truncated) return;
      output += chunk.toString();
      if (output.length > MAX_OUTPUT_CHARS) {
        output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated at ${MAX_OUTPUT_CHARS} chars]`;
        truncated = true;
      }
    };

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (child.pid !== undefined) trackedShellPids.delete(child.pid);
      // A signal-killed shell has no exit code. Use the standard shell
      // convention so callers don't mistake the termination for success.
      const resolvedCode =
        exitCode ??
        (child.signalCode
          ? 128 + (osConstants.signals[child.signalCode] ?? 0)
          : 1);
      const body = sanitizeBinaryOutput(output);
      const lines = body.trimEnd().split("\n");
      const cappedOutput =
        lines.length > MAX_OUTPUT_LINES
          ? `${lines.slice(0, MAX_OUTPUT_LINES).join("\n")}\n[output truncated at ${MAX_OUTPUT_LINES} lines]`
          : body;
      resolve({
        command: input.command,
        exitCode: resolvedCode,
        output: cappedOutput,
        timedOut,
        truncated: truncated || lines.length > MAX_OUTPUT_LINES,
      });
    };

    const killChild = (): void => {
      if (child.pid !== undefined) killProcessTree(child.pid);
    };

    const onAbort = (): void => {
      killChild();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, SHELL_TIMEOUT_MS);
    // The timer must not keep the client alive once the TUI exits.
    timer.unref?.();

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    void waitForChildProcess(child).then(finish, (error: Error) => {
      append(`${error.message}\n`);
      finish(null);
    });
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
  });
};
