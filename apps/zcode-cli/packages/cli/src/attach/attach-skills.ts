// 瘦客户端的 Skill catalog：command-center 的 `/skill` 列表与 composer 的
// `/skill <Tab>` 参数补全都从 `skills/referenceCatalog` 取数（session 权威 =
// 模型实际看到的冻结快照，见 skill-reference-catalog.ts）。瘦客户端不带
// config/skill 适配器，本地再扫一遍目录只会得到与 runtime 不同的第二份事实。
import {
  zcodeProtocolMethods,
  zcodeSkillsReferenceCatalogResultSchema,
  type ZCodeSkillReferenceCatalogEntry,
  type ZCodeSkillsReferenceCatalogResult,
} from "@zcode/shared";
import type { TuiSkillSuggestion } from "@zcode/tui";
import { toTuiSkillSuggestions } from "../skill-suggestions.js";
import type {
  CommandCenterSkill,
  CommandCenterSkillListOutcome,
} from "../command-center/types.js";

export type AttachSkillCatalogRequest = <T = unknown>(
  method: string,
  params?: unknown,
) => Promise<T>;

/**
 * sessionId 在场时走 session 权威（runtime 冻结快照）；缺省落 workspace 权威
 * （当前目录现扫）。server 对未知 sessionId fail closed，不回退 workspace。
 */
export const listAttachSkillCatalog = async (input: {
  request: AttachSkillCatalogRequest;
  sessionId?: string;
  workspace: { workspacePath: string; workspaceKey: string; workspaceIdentity?: string };
}): Promise<ZCodeSkillsReferenceCatalogResult> => {
  const result = await input.request(zcodeProtocolMethods.skillsReferenceCatalog, {
    workspace: input.workspace,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  return zcodeSkillsReferenceCatalogResultSchema.parse(result);
};

/** catalog entry → command-center `/skill` 行；additive 字段缺省时退化为折叠 scope。 */
export const toCommandCenterSkill = (
  entry: ZCodeSkillReferenceCatalogEntry,
): CommandCenterSkill => ({
  description: entry.description,
  name: entry.name,
  path: entry.path,
  scope: entry.nativeScope ?? (entry.scope === "workspace" ? "project" : entry.scope),
  source: entry.source ?? entry.scope,
  ...(entry.pluginName ? { pluginName: entry.pluginName } : {}),
  ...(entry.qualifiedName ? { qualifiedName: entry.qualifiedName } : {}),
  ...(entry.whenToUse ? { whenToUse: entry.whenToUse } : {}),
});

export const toCommandCenterSkillList = (
  result: ZCodeSkillsReferenceCatalogResult,
): CommandCenterSkillListOutcome => ({
  skills: result.skills.map(toCommandCenterSkill),
  totalDiscovered: result.totalDiscovered ?? result.skills.length,
});

/**
 * `/skill` 补全口径与 embedded 路径共用 toTuiSkillSuggestions（bundled 过滤 +
 * qualifiedName 去重）；catalog 在协议层已排 bundled，这里是同语义防御。
 */
export const toSkillSuggestions = (
  result: ZCodeSkillsReferenceCatalogResult,
): TuiSkillSuggestion[] => toTuiSkillSuggestions(result.skills);
