// `piz acp` 入口：在 stdin/stdout 上跑 ACP v1 stdio agent。
// 瘦客户端二进制（zcode-attach.cjs）内只有 attach/ 协议客户端 + 本适配器，
// 不带 bootstrap/core/adapters，运行时全部经共享 core 的 socket 走。
// stdout 是严格的 NDJSON 协议通道，诊断一律走 stderr。
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import { AcpCoreBridge } from "./acp-core-bridge.js";
import { createAcpAgent } from "./acp-agent.js";

export const ACP_COMMAND = "acp";

export const isAcpInvocation = (argv: readonly string[]): boolean => argv[0] === ACP_COMMAND;

export interface AcpRunDeps {
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
}

export const runAcpCommand = async (
  ctx: RunContext,
  deps: AcpRunDeps,
  version: string,
  options: GlobalOptions = { force: false, json: false, noColor: false, verbose: false },
): Promise<number> => {
  const env = deps.env ?? process.env;
  const stderr = ctx.stderr;
  const logger = {
    info: (message: string, context?: Record<string, unknown>) => {
      if (options.verbose) {
        stderr.write(`acp: ${message}${context ? ` ${JSON.stringify(context)}` : ""}\n`);
      }
    },
    warn: (message: string, context?: Record<string, unknown>) => {
      stderr.write(`acp: ${message}${context ? ` ${JSON.stringify(context)}` : ""}\n`);
    },
  };
  const bridge = new AcpCoreBridge({ env, logger, version });
  const stream = ndJsonStream(
    Writable.toWeb(ctx.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(ctx.stdin) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = new AgentSideConnection(
    (conn) => createAcpAgent({ bridge, connection: conn, env, logger, version }),
    stream,
  );
  void connection;
  // stdin EOF（客户端断开）即退出：detach，不断 core。
  await new Promise<void>((resolve) => {
    ctx.stdin.on("end", resolve);
    ctx.stdin.on("close", resolve);
    ctx.stdin.on("error", resolve);
  });
  await bridge.close();
  return 0;
};
