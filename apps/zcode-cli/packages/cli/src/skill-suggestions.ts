// `/skill <name>` 的可调用名是 qualifiedName（`plugin:skill`）优先于 name——
// 与 command-center `formatCommandCenterSkillName` 同一口径。bundled 技能只
// 通过 /workflow 入口暴露，不出现在用户面引用（referenceCatalog 在协议层同
// 口径过滤）；老服务端缺省 source 字段时不做过滤。同名去重保序。
import type { TuiSkillSuggestion } from "@zcode/tui";

export const toTuiSkillSuggestions = (
  skills: readonly {
    description: string;
    name: string;
    qualifiedName?: string;
    source?: string;
  }[],
): TuiSkillSuggestion[] => {
  const seen = new Set<string>();
  const suggestions: TuiSkillSuggestion[] = [];
  for (const skill of skills) {
    if (skill.source === "bundled") continue;
    const name = skill.qualifiedName ?? skill.name;
    if (seen.has(name)) continue;
    seen.add(name);
    suggestions.push({ description: skill.description, name });
  }
  return suggestions;
};
