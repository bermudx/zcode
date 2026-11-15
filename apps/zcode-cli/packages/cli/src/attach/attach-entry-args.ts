// zcode-attach（piz）瘦客户端入口的 argv 解析：纯函数，供 attach-main
// 与单测共用（attach-main 顶层即执行 main()，测试不能直接 import）。
// TUI 入口只收 attach 语义子集；未知旗标沿用既有宽容行为（忽略），新增
// 旗标必须显式登记并接入 runAttachCommand。`acp` 子命令的旗标解析在
// 文件末尾（acpWorkflowModeOption），语义对齐 run.ts 的 parseArgs。
import type { GlobalOptions } from "@zcode/shared-types";
import type { CliResumeRequest } from "../cli-types.js";

export interface AttachEntryArgs {
  action?: "help" | "version";
  /** `--model <ref>`：启动模型选择，交给 runAttachCommand 应用。 */
  initialModel?: string;
  options: GlobalOptions;
  resume: CliResumeRequest;
}

export function parseAttachEntryArgs(argv: readonly string[]): AttachEntryArgs {
  const options: GlobalOptions = { force: false, json: false, noColor: false, verbose: false };
  const resume: CliResumeRequest = { continueSession: false };
  let action: "help" | "version" | undefined;
  let initialModel: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--locale") {
      options.locale = argv[++i] as GlobalOptions["locale"];
    } else if (arg === "--no-color") {
      options.noColor = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "-c" || arg === "--continue") {
      resume.continueSession = true;
    } else if (arg === "--resume") {
      const value = argv[++i];
      // 缺值若静默置 undefined 会降级成开新会话——显式意图必须显式失败（同 --model）。
      if (value === undefined || value === "") {
        throw new Error("--resume requires a value: --resume <sessionId>");
      }
      resume.resumeSessionId = value;
    } else if (arg === "--model") {
      const value = argv[++i];
      if (value === undefined || value === "") {
        throw new Error("--model requires a value: --model <model|provider/model>");
      }
      initialModel = value;
    } else if (arg === "--version" || arg === "-v") {
      action = "version";
    } else if (arg === "--help" || arg === "-h") {
      action = "help";
    }
  }
  return { action, initialModel, options, resume };
}

/** `zcode-attach acp` 后的旗标只认 --workflow-mode；其余沿用入口惯例忽略。
 *  重复出现须与 run.ts 的 parseArgs 同规则：最后一次生效（last wins），
 *  值 token 被消费、不再当旗标扫描；只有生效值交给 normalize 校验，
 *  被覆盖的非法值不单独报错。 */
export function acpWorkflowModeOption(argv: readonly string[]): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workflow-mode") {
      const next = argv[++i];
      if (next === undefined || next === "") {
        throw new Error(
          "--workflow-mode requires a value: --workflow-mode <disabled|onDemand|alwaysOn>",
        );
      }
      value = next;
      continue;
    }
    if (arg?.startsWith("--workflow-mode=")) {
      value = arg.slice("--workflow-mode=".length);
    }
  }
  return value;
}
