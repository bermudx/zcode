// `zcode-attach` 瘦客户端入口：只做 shared-core attach（pi-tui 薄客户端）。
// 与 zcode.cjs 同入口分离的原因：attach pane 不需要 bootstrap/core/adapters/
// 插件机制，单独 bundle 把每客户端 RSS 压到探针目标内。
// core 缺失时仍由 attach-command 经 PATH `zcode`（或 ZCODE_SERVER_BIN）拉起。
import type { DynamicWorkflowMode } from "@zcode/shared";
import { runAttachCommand } from "./attach-command.js";
import { parseAttachEntryArgs } from "./attach-entry-args.js";
import { runAcpCommand } from "../acp/acp-command.js";
import {
  DEFAULT_ACP_WORKFLOW_MODE,
  normalizeWorkflowModeOption,
} from "../workflow-mode.js";

declare const __CLI_VERSION__: string;

const ATTACH_PROCESS_NAME = "zcode-attach";

const usage = `zcode-attach — pi-tui thin client for a shared ZCode core

Usage:
  zcode-attach [--locale <en-US|zh-CN|auto>] [--no-color] [--verbose]
               [-c|--continue] [--resume <sessionId>] [--model <model|provider/model>]
               [--version] [-h|--help]
  zcode-attach acp [--workflow-mode <disabled|onDemand|alwaysOn>]
                  stdio Agent Client Protocol (ACP v1) adapter

Session selection (same semantics as the main CLI):
  (default)        start a NEW session
  -c/--continue   resume the most recent session of this workspace
  --resume <id>   resume a specific session

Model selection:
  --model <model|provider/model>
                  start on this model (e.g. --model glm-5.3); bare names
                  ignore case and prefer the session's current provider
                  when ambiguous. Other ambiguity requires provider/model.
                  Quote a $effort suffix, e.g. --model 'glm-5.3$high'.

Environment:
  ZCODE_SERVER_BIN   core 二进制（缺省 PATH 里的 zcode），core 不存在时
                     由 ensureServer 经 user 服务管理器拉起（--socket --no-plugins）。
`;

/** `zcode-attach acp` 后的旗标只认 --workflow-mode；其余沿用入口惯例忽略。 */
const acpWorkflowModeOption = (argv: readonly string[]): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workflow-mode") {
      const value = argv[i + 1];
      if (value === undefined || value === "") {
        throw new Error(
          "--workflow-mode requires a value: --workflow-mode <disabled|onDemand|alwaysOn>",
        );
      }
      return value;
    }
    if (arg?.startsWith("--workflow-mode=")) {
      return arg.slice("--workflow-mode=".length);
    }
  }
  return undefined;
};

const main = async (): Promise<number> => {
  process.title = ATTACH_PROCESS_NAME;
  // `piz acp`：同一份瘦客户端二进制里的 ACP stdio 入口。必须在 TUI argv
  // 解析之前分流——ACL 的 cwd/会话由 ACP 客户端逐会话给出，不读 attach 旗标。
  if (process.argv[2] === "acp") {
    let workflowMode: DynamicWorkflowMode;
    try {
      // 与 run.ts 同一个 normalizeWorkflowModeOption：非法值报三值清单 + exit 1。
      workflowMode =
        normalizeWorkflowModeOption(acpWorkflowModeOption(process.argv.slice(3))) ??
        DEFAULT_ACP_WORKFLOW_MODE;
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    return await runAcpCommand(
      {
        argv: process.argv,
        stderr: process.stderr,
        stdin: process.stdin,
        stdout: process.stdout,
      },
      { force: false, json: false, noColor: false, verbose: false },
      { cwd: () => process.cwd(), env: process.env },
      __CLI_VERSION__,
      workflowMode,
    );
  }
  const { action, initialModel, options, resume } = parseAttachEntryArgs(
    process.argv.slice(2),
  );
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
    resume,
    initialModel,
    "piz",
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
