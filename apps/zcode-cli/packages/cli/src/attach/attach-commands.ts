// 瘦客户端的自定义命令目录：composer `/` 面板 suggestions 与 commandCenter
// `/help` 列表都从 `commands/referenceCatalog` 取数（core 现扫，单一事实源）。
// 命令展开不走这里：瘦客户端把 `/name args` 原文经 session/send 转发，由
// core 的 input facade 展开 custom-command-prompt.ts（含 !`cmd` 动态语法，
// 客户端侧展开器反而砍能力）。见 docs/fork/attach-custom-commands-design.md。
import {
  zcodeProtocolMethods,
  zcodeCommandsReferenceCatalogResultSchema,
  type ZCodeCommandsReferenceCatalogResult,
} from "@zcode/shared";
import type {
  CommandCenterCustomCommand,
  CommandCenterCustomCommandListOutcome,
} from "../command-center-custom.js";

export type AttachCommandCatalogRequest = <T = unknown>(
  method: string,
  params?: unknown,
) => Promise<T>;

/**
 * workspace 权威目录：每次调用请求 core 现扫（自定义命令没有会话冻结状态）。
 * 回包 strict 校验 fail closed —— 形状不对宁可丢面板条目，不渲染猜测数据。
 */
export const listAttachCommandCatalog = async (input: {
  request: AttachCommandCatalogRequest;
  workspace: { workspacePath: string; workspaceKey: string; workspaceIdentity?: string };
}): Promise<ZCodeCommandsReferenceCatalogResult> => {
  const result = await input.request(zcodeProtocolMethods.commandsReferenceCatalog, {
    workspace: input.workspace,
  });
  return zcodeCommandsReferenceCatalogResultSchema.parse(result);
};

/** catalog entry → command-center `/help` 行与 suggestions 元数据。 */
export const toCommandCenterCustomCommand = (
  entry: ZCodeCommandsReferenceCatalogResult["commands"][number],
): CommandCenterCustomCommand => ({
  description: entry.description,
  name: entry.name,
  path: entry.path,
  scope: entry.scope,
  source: entry.source,
  ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
  ...(entry.allowedTools ? { allowedTools: entry.allowedTools } : {}),
  ...(entry.disableNonInteractive ? { disableNonInteractive: true } : {}),
  ...(entry.frontmatterKeys ? { frontmatterKeys: entry.frontmatterKeys } : {}),
  ...(entry.model ? { model: entry.model } : {}),
  ...(entry.rootPath ? { rootPath: entry.rootPath } : {}),
  ...(entry.skills ? { skills: entry.skills } : {}),
});

/** catalog → commandCenter `/help` 的列表形状；协议目录不载诊断，置空。 */
export const toCommandCenterCustomCommandList = (
  result: ZCodeCommandsReferenceCatalogResult,
): CommandCenterCustomCommandListOutcome => ({
  commands: result.commands.map(toCommandCenterCustomCommand),
  diagnostics: [],
  totalDiscovered: result.totalDiscovered ?? result.commands.length,
});
