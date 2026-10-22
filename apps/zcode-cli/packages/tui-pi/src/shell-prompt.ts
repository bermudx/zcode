// `!command` 握手：客户端本地执行 → transcript 行 → 输出缓冲给下一条 prompt。
//
// core 拥有会话历史且没有“追加本地消息”的协议面，所以上下文交接发生在提交时：
// 缓冲的命令输出被前置进下一条真实 prompt 的正文（slash 命令不消费缓冲）。

import type { Message } from "@zcode/tui/internals";
import {
  formatShellContextBlock,
  formatShellTranscriptRow,
  runShellCommand,
  type ShellRunResult,
} from "./shell.js";

export type ShellEscapeRunner = {
  /** 把缓冲的 `!cmd` 输出前置到下一条 prompt；slash 命令原样返回。 */
  consume(text: string): string;
  /** 执行 `!cmd`（trimmed 含前导 `!`），打印结果并缓冲给下一条 prompt。 */
  run(trimmed: string): Promise<void>;
};

export const createShellEscapeRunner = (deps: {
  appendMessage: (message: Message) => void;
  clearDraft: () => void;
  cwd: () => string;
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
      const command = trimmed.slice(1).trim();
      deps.clearDraft();
      deps.setStatus(`Running ${command}…`);
      const result = await runShellCommand({ command, cwd: deps.cwd() });
      pending.push(result);
      deps.appendMessage({ content: formatShellTranscriptRow(result), role: "system" });
      deps.setStatus(
        result.timedOut
          ? "Command timed out — partial output is sent with your next message."
          : "Output buffered — it is sent with your next message.",
      );
    },
  };
};
