// Local shell escape for the composer (`!command`).
//
// Semantics mirror the other coding harnesses: the command runs in the client's
// workspace, its output lands in the transcript immediately, and the captured
// output rides along with the *next* prompt so the model actually sees it.
// The shared core owns session history and exposes no "append a local message"
// topic, so the context hand-off happens at submit time (see app.ts).

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { basename } from "node:path";

export const SHELL_ROW_PREFIX = "!";
const MAX_OUTPUT_CHARS = 64_000;
const MAX_OUTPUT_LINES = 2_000;
export const SHELL_TIMEOUT_MS = 120_000;

/**
 * `-i` 无控制 tty 时 bash/zsh 的启动期 stderr 诊断（job control / tty pgrp），
 * 属 shell 启动噪声而非命令输出，从捕获输出中剔除。
 */
const INTERACTIVE_STARTUP_NOISE =
  /cannot set terminal process group|no job control in this shell|can't set tty pgrp|can't have job control/u;

export type ShellRunResult = {
  command: string;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
};

/** `!` alone is not a command; `!cmd …` is. */
export const isShellCommand = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.startsWith(SHELL_ROW_PREFIX) && trimmed.length > 1;
};

/** Transcript content for a finished run: `!cmd` line, blank line, output. */
export const formatShellTranscriptRow = (run: ShellRunResult): string => {
  const header = `${SHELL_ROW_PREFIX}${run.command}`;
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

type EscapeShell = {
  args: string[];
  file: string;
  interactive: boolean;
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
 * `!` 的执行 shell：bash/zsh 用 `-ic` 让真实 rc（alias、函数）生效——不能用
 * 非交互 `-c` + 前缀注入替代，zsh 对 `-c` 串整体先解析，串内定义的 alias 对
 * 串内命令不生效。非 bash/zsh 的 SHELL 回退 `/bin/sh -c`（不读 rc）。
 * `+m` 关闭 monitor/job control：交互 shell 的 job control 会对 /dev/tty
 * tcsetpgrp 抢占前台进程组，退出恢复不可靠（exec/信号杀死/超时 kill 都留死
 * pgrp 占着前台），客户端下一次 stdin read 即 SIGTTIN 挂起
 * （"suspended (tty input)"）。捕获式 `!` 用不到 job control。zsh 用 `+m`
 * 可完全免除启动期抢占；bash 启动期先抢再读选项，`+m` 只管住会话内 monitor，
 * 所以还要靠 spawn detached 兜底（见 runShellCommand）。
 */
export const resolveEscapeShell = (
  command: string,
  options: {
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
  } = {},
): EscapeShell => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    return {
      args: ["/d", "/s", "/c", command],
      file: env.ComSpec ?? "cmd.exe",
      interactive: false,
    };
  }

  const shell = env.SHELL ?? "";
  const name = basename(shell);
  const interactive =
    (name.includes("bash") || name.includes("zsh")) &&
    (options.exists ?? isExecutableFile)(shell);
  return interactive
    ? { args: ["+m", "-ic", command], file: shell, interactive: true }
    : { args: ["-c", command], file: "/bin/sh", interactive: false };
};

const stripInteractiveStartupNoise = (output: string): string =>
  output
    .split("\n")
    .filter((line) => !INTERACTIVE_STARTUP_NOISE.test(line))
    .join("\n");

export const runShellCommand = async (input: {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shellExists?: (path: string) => boolean;
  signal?: AbortSignal;
}): Promise<ShellRunResult> => {
  const env = input.env ?? process.env;
  const spec = resolveEscapeShell(input.command, {
    env,
    exists: input.shellExists,
  });

  return await new Promise<ShellRunResult>((resolve) => {
    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    // detached（POSIX setsid）：子进程拿到新 session、没有控制终端，open
    // /dev/tty 必失败——bash 启动期无条件 tcsetpgrp 的抢占也被根除，rc 里
    // `set -m`、嵌套 `!zsh` 之类的交互 shell 同样够不到本终端。win32 无此语义。
    const detached = process.platform !== "win32";
    const child = spawn(spec.file, spec.args, {
      cwd: input.cwd,
      detached,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

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
      const body = spec.interactive ? stripInteractiveStartupNoise(output) : output;
      const lines = body.trimEnd().split("\n");
      const cappedOutput =
        lines.length > MAX_OUTPUT_LINES
          ? `${lines.slice(0, MAX_OUTPUT_LINES).join("\n")}\n[output truncated at ${MAX_OUTPUT_LINES} lines]`
          : body;
      resolve({
        command: input.command,
        exitCode,
        output: cappedOutput,
        timedOut,
        truncated: truncated || lines.length > MAX_OUTPUT_LINES,
      });
    };

    const killChild = (): void => {
      // detached 后 child.pid 就是新进程组 pgid：组 kill 才能带上仍在跑的
      // 命令；只杀 shell 会把活命令遗留在同组里继续跑。
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          /* 进程组已退出，退回单 pid */
        }
      }
      child.kill("SIGTERM");
    };

    const onAbort = (): void => {
      killChild();
      finish(null);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, SHELL_TIMEOUT_MS);
    // The timer must not keep the client alive once the TUI exits.
    timer.unref?.();

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error: Error) => {
      append(`${error.message}\n`);
      finish(null);
    });
    child.once("close", (code) => finish(code));
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
  });
};
