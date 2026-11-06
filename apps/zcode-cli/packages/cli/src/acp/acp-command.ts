// `piz acp` / `zcode acp` 的命令入口：只做 stdio 边界与退出码，连接与协议
// 在 acp-main。ACP 的 stdout 是严格协议通道，进程级 console 必须在加载
// 任何 SDK 之前引导到 stderr。
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { RunDependencies } from "../cli-types.js";
import { installStderrConsoleBoundary } from "../protocol-console.js";
import { createAcpStderrLogger, runAcpStdio } from "./acp-main.js";

export async function runAcpCommand(
  ctx: RunContext,
  _options: GlobalOptions,
  deps: RunDependencies,
  version: string,
): Promise<number> {
  const restoreConsole = installStderrConsoleBoundary(ctx.stderr);
  try {
    return await runAcpStdio({
      env: deps.env ?? process.env,
      logger: createAcpStderrLogger(ctx.stderr),
      stderr: ctx.stderr,
      stdin: ctx.stdin,
      stdout: ctx.stdout,
      version,
    });
  } catch (error) {
    ctx.stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    restoreConsole();
  }
}
