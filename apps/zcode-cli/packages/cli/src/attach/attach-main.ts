// `zcode-attach` 瘦客户端入口：只做 shared-core attach（pi-tui 薄客户端）。
// 与 zcode.cjs 同入口分离的原因：attach pane 不需要 bootstrap/core/adapters/
// 插件机制，单独 bundle 把每客户端 RSS 压到探针目标内。
// core 缺失时仍由 attach-command 经 PATH `zcode`（或 ZCODE_SERVER_BIN）拉起。
import { runAttachCommand } from "./attach-command.js";
import type { GlobalOptions } from "@zcode/shared-types";

declare const __CLI_VERSION__: string;

const ATTACH_PROCESS_NAME = "zcode-attach";

const usage = `zcode-attach — pi-tui thin client for a shared ZCode core

Usage:
  zcode-attach [--locale <en-US|zh-CN|auto>] [--no-color] [--verbose]
               [--version] [-h|--help]

Environment:
  ZCODE_SERVER_BIN   core 二进制（缺省 PATH 里的 zcode），core 不存在时
                     由 ensureServer 用它 spawn --socket --no-plugins。
`;

const parseArgs = (argv: string[]): { options: GlobalOptions; action?: "help" | "version" } => {
  const options: GlobalOptions = { force: false, json: false, noColor: false, verbose: false };
  let action: "help" | "version" | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--locale") {
      options.locale = argv[++i] as GlobalOptions["locale"];
    } else if (arg === "--no-color") {
      options.noColor = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--version" || arg === "-v") {
      action = "version";
    } else if (arg === "--help" || arg === "-h") {
      action = "help";
    }
  }
  return { action, options };
};

const main = async (): Promise<number> => {
  process.title = ATTACH_PROCESS_NAME;
  const { action, options } = parseArgs(process.argv.slice(2));
  if (action === "help") {
    process.stdout.write(usage);
    return 0;
  }
  if (action === "version") {
    process.stdout.write(`${__CLI_VERSION__}\n`);
    return 0;
  }
  return runAttachCommand(
    {
      argv: process.argv,
      stderr: process.stderr,
      stdin: process.stdin,
      stdout: process.stdout,
    },
    options,
    { cwd: () => process.cwd(), env: process.env },
    __CLI_VERSION__,
    "pi",
  );
};

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
