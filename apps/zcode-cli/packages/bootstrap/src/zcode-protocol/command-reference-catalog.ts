// Composer 自定义命令只读目录（瘦客户端 `/` 面板与 /help 的数据源）。
// 与 skills/referenceCatalog 的差异：无 session 权威 —— 自定义命令没有会话
// 冻结状态，core 的 input facade（custom-command-prompt.ts）每次 send 现扫
// 展开；这里同样每次调用现扫 workspace。命令的执行/展开不经过该目录。
import {
  zcodeCommandsReferenceCatalogParamsSchema,
  type ZCodeCommandReferenceCatalogEntry,
  type ZCodeCommandsReferenceCatalogResult,
} from "@zcode/shared";
import type { CustomCommandMetadata, CustomCommandLoadOutcome } from "@zcode/contracts";
import { listZCodeCustomCommands } from "../custom-commands.js";
import { isReservedZCodeSlashCommandName } from "../slash-command-surface.js";
import {
  parseParams,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

export async function getCommandReferenceCatalog(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeCommandsReferenceCatalogResult> {
  const params = parseParams(zcodeCommandsReferenceCatalogParamsSchema, rawParams);
  // 照 skills workspace 权威先例：复用 CLI 正式发现配置现扫，用户从文件系统
  // 手动增删命令后无需重启即可在下次目录请求中看到。
  const outcome = await listZCodeCustomCommands({
    env: context.deps.env,
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return toResult(outcome);
}

function toResult(outcome: CustomCommandLoadOutcome): ZCodeCommandsReferenceCatalogResult {
  return {
    // 保留名（含内置 workflow）在任何客户端都不可经 facade 调用，目录列出即是
    // 谎话 —— 照 listProtocolSlashCommands 的保留名过滤先例剔除。
    // disableNonInteractive 不过滤：那是「仅交互式」标记，由消费方按自身形态取舍。
    commands: outcome.commands
      .filter((command) => !isReservedZCodeSlashCommandName(command.name))
      .map(toReferenceCatalogEntry),
    totalDiscovered: outcome.totalDiscovered,
  };
}

function toReferenceCatalogEntry(command: CustomCommandMetadata): ZCodeCommandReferenceCatalogEntry {
  return {
    name: command.name,
    description: command.description,
    scope: command.scope,
    source: command.source,
    path: command.path,
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    ...(command.model ? { model: command.model } : {}),
    ...(command.allowedTools.length > 0 ? { allowedTools: [...command.allowedTools] } : {}),
    ...(command.skills.length > 0 ? { skills: [...command.skills] } : {}),
    ...(command.rootPath ? { rootPath: command.rootPath } : {}),
    ...(command.frontmatterKeys.length > 0
      ? { frontmatterKeys: [...command.frontmatterKeys] }
      : {}),
    ...(command.disableNonInteractive ? { disableNonInteractive: true } : {}),
  };
}
