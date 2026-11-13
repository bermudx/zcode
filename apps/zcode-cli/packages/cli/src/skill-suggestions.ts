// `/skill <name>` 的可调用名是 qualifiedName（`plugin:skill`）优先于 name——
// 与 command-center `formatCommandCenterSkillName` 同一口径。bundled 技能只
// 通过 /workflow 入口暴露，不出现在用户面引用（referenceCatalog 在协议层同
// 口径过滤）；老服务端缺省 source 字段时不做过滤。同名去重保序。
import type { TuiSkillSuggestion } from "@zcode/tui";

/** 目录条目：展示名取 `qualifiedName ?? name`；裸名保留给匹配侧（Skill 工具按两者命中）。 */
export interface SkillCatalogEntry {
  description: string;
  name: string;
  qualifiedName?: string;
}

type SkillCatalogSource = readonly {
  description: string;
  name: string;
  qualifiedName?: string;
  source?: string;
}[];

/** bundled 过滤 + 展示名去重保序：补全与目录投影共用的一份判定。 */
export const toSkillCatalogEntries = (
  skills: SkillCatalogSource,
): SkillCatalogEntry[] => {
  const seen = new Set<string>();
  const entries: SkillCatalogEntry[] = [];
  for (const skill of skills) {
    if (skill.source === "bundled") continue;
    const displayName = skill.qualifiedName ?? skill.name;
    if (seen.has(displayName)) continue;
    seen.add(displayName);
    entries.push({
      description: skill.description,
      name: skill.name,
      ...(skill.qualifiedName ? { qualifiedName: skill.qualifiedName } : {}),
    });
  }
  return entries;
};

export const toTuiSkillSuggestions = (
  skills: SkillCatalogSource,
): TuiSkillSuggestion[] =>
  toSkillCatalogEntries(skills).map((entry) => ({
    description: entry.description,
    name: entry.qualifiedName ?? entry.name,
  }));
