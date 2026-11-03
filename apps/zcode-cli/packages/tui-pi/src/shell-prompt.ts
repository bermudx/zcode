// `!command`/`!!command` 握手：客户端本地执行 → transcript 行 → 输出缓冲给下一条
// prompt（`!!` 不进上下文，与 pi-mono 的 excludeFromContext 一致）。
//
// core 拥有会话历史且没有“追加本地消息”的协议面，所以上下文交接发生在提交时：
// 缓冲的命令输出被前置进下一条真实 prompt 的正文（slash 命令不消费缓冲）。

import type { Message } from "@zcode/tui/internals";
import {
  formatShellContextBlock,
  formatShellTranscriptRow,
  runShellCommand,
  SHELL_EXCLUDED_PREFIX,
  SHELL_ROW_PREFIX,
  type ShellRunResult,
} from "./shell.js";

export type ShellEscapeRunner = {
  /** 把缓冲的 `!cmd` 输出前置到下一条 prompt；slash 命令原样返回。 */
  consume(text: string): string;
  /** 执行 `!cmd`/`!!cmd`（trimmed 含前导 `!`），打印结果并按前缀缓冲。 */
  run(trimmed: string): Promise<void>;
};

export const createShellEscapeRunner = (deps: {
  appendMessage: (message: Message) => void;
  clearDraft: () => void;
  cwd: () => string;
  /** 测试可注入假 env（如 pin PATH）；缺省用 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** spill 失败单行诊断出口；缺省静默降级（状态行仍提示截断无路径）。 */
  stderr?: Pick<NodeJS.WriteStream, "write">;
  setStatus: (status: string) => void;
}): ShellEscapeRunner => {
  const pending: ShellRunResult[] = [];
  return {
    consume: (text) => {
      if (pending.length === 0 || text.startsWith("/")) return text;
      const runs = pending.splice(0, pending.length);
      return [...runs.map(formatShellContextBlock), text].join("\n\n");
    },
    run: async (trimmed) => {
      const excludeFromContext = trimmed.startsWith(SHELL_EXCLUDED_PREFIX);
      const command = trimmed
        .slice(excludeFromContext ? SHELL_EXCLUDED_PREFIX.length : SHELL_ROW_PREFIX.length)
        .trim();
      deps.clearDraft();
      deps.setStatus(`Running ${command}…`);
      const result = await runShellCommand({
        command,
        cwd: deps.cwd(),
        env: deps.env,
        onSpillError: (error) =>
          deps.stderr?.write(
            `piz: shell output spill failed: ${error instanceof Error ? error.message : String(error)}\n`,
          ),
      });
      if (excludeFromContext) {
        result.excludeFromContext = true;
      } else {
        pending.push(result);
      }
      deps.appendMessage({ content: formatShellTranscriptRow(result), role: "system" });
      const spillNote =
        result.truncated && result.fullOutputPath
          ? ` (truncated — full output: ${result.fullOutputPath})`
          : "";
      deps.setStatus(
        excludeFromContext
          ? `Done — output is not sent to the model.${spillNote}`
          : result.timedOut
            ? `Command timed out — partial output is sent with your next message.${spillNote}`
            : `Output buffered — it is sent with your next message.${spillNote}`,
      );
    },
  };
};
