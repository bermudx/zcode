// attach-skills 纯映射：catalog entry → CommandCenterSkill（additive 字段缺省
// 回退）、/skill <Tab> suggestions（qualifiedName 优先 + 同名去重）、以及
// listAttachSkillCatalog 的协议请求形状与 strict schema 边界。

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";
import {
  listAttachSkillCatalog,
  toCommandCenterSkill,
  toCommandCenterSkillList,
  toSkillSuggestions,
} from "../src/attach/attach-skills.js";
import {
  toSkillCatalogEntries,
  toTuiSkillSuggestions,
} from "../src/skill-suggestions.js";

const entry = (
  overrides: Partial<ZCodeSkillReferenceCatalogEntry> = {},
): ZCodeSkillReferenceCatalogEntry => ({
  description: "desc",
  enabled: true,
  id: "glm:workspace:/repo/s",
  name: "demo",
  path: "/repo/s",
  scope: "workspace",
  ...overrides,
});

test("toCommandCenterSkill 全字段时还原 contracts 显示面", () => {
  const skill = toCommandCenterSkill(
    entry({
      name: "lint",
      nativeScope: "project",
      pluginName: "fmt",
      qualifiedName: "fmt:lint",
      scope: "plugin",
      source: "plugin",
      whenToUse: "when formatting",
    }),
  );
  assert.deepEqual(skill, {
    description: "desc",
    name: "lint",
    path: "/repo/s",
    pluginName: "fmt",
    qualifiedName: "fmt:lint",
    scope: "project",
    source: "plugin",
    whenToUse: "when formatting",
  });
});

test("toCommandCenterSkill 老服务端无 additive 字段时退化为折叠 scope", () => {
  // workspace scope 在旧协议里已折叠 project/system；无 nativeScope 只能
  // 反折叠 workspace→project、其余原样，source 以 scope 兜底。
  const project = toCommandCenterSkill(entry({ scope: "workspace" }));
  assert.equal(project.scope, "project");
  assert.equal(project.source, "workspace");
  assert.equal(project.qualifiedName, undefined);
  assert.equal(project.whenToUse, undefined);

  const user = toCommandCenterSkill(entry({ scope: "user" }));
  assert.equal(user.scope, "user");
  assert.equal(user.source, "user");

  const plugin = toCommandCenterSkill(entry({ pluginName: "fmt", scope: "plugin" }));
  assert.equal(plugin.scope, "plugin");
  assert.equal(plugin.source, "plugin");
  assert.equal(plugin.pluginName, "fmt");
});

test("toCommandCenterSkillList 用 totalDiscovered，缺省回退 skills.length", () => {
  const withTotal = toCommandCenterSkillList({
    authority: "session",
    skills: [entry()],
    totalDiscovered: 7,
  });
  assert.equal(withTotal.totalDiscovered, 7);

  const legacy = toCommandCenterSkillList({
    authority: "workspace",
    skills: [entry(), entry({ name: "b" })],
  });
  assert.equal(legacy.totalDiscovered, 2);
  assert.equal(legacy.skills.length, 2);
});

test("toSkillSuggestions 用 qualifiedName 优先并按名去重保序", () => {
  const suggestions = toSkillSuggestions({
    authority: "session",
    skills: [
      entry({ name: "code-review" }),
      entry({
        name: "lint",
        qualifiedName: "fmt:lint",
        scope: "plugin",
        pluginName: "fmt",
      }),
      // 同名（含 qualifiedName 命中）不重复出现。
      entry({ name: "lint", qualifiedName: "fmt:lint", scope: "plugin" }),
      entry({ name: "code-review" }),
    ],
  });
  assert.deepEqual(suggestions, [
    { description: "desc", name: "code-review" },
    { description: "desc", name: "fmt:lint" },
  ]);
});

test("toSkillSuggestions 过滤 bundled（同口径防御；协议层已排）", () => {
  const suggestions = toSkillSuggestions({
    authority: "session",
    skills: [
      entry({ name: "code-review", source: "agents" }),
      // bundled 技能走 /workflow，不出现在 /skill 补全。
      entry({ name: "dynamic-workflows", source: "bundled" }),
      entry({ name: "review", source: "zcode" }),
    ],
  });
  assert.deepEqual(
    suggestions.map((s) => s.name),
    ["code-review", "review"],
  );
});

test("toTuiSkillSuggestions：embedded 侧（SkillMetadata 形状）同样过滤 bundled + 去重", () => {
  const suggestions = toTuiSkillSuggestions([
    { description: "d1", name: "lint", qualifiedName: "fmt:lint", source: "plugin" },
    { description: "d2", name: "dynamic-workflows", source: "bundled" },
    { description: "d3", name: "lint", qualifiedName: "fmt:lint", source: "plugin" },
    { description: "d4", name: "agent-notes", source: "agents" },
  ]);
  assert.deepEqual(suggestions, [
    { description: "d1", name: "fmt:lint" },
    { description: "d4", name: "agent-notes" },
  ]);
  // source 缺省（老服务端）不过滤。
  assert.equal(toTuiSkillSuggestions([{ description: "d", name: "x" }]).length, 1);
});

test("toSkillCatalogEntries 与补全同一份 filter+dedup，但保留裸名（issue #24）", () => {
  // ACP 路由侧要按 Skill 工具 resolver 口径命中（name 或 qualifiedName）——
  // 展示投影丢掉的裸名必须在这条目录投影里留住。
  const entries = toSkillCatalogEntries([
    { description: "d1", name: "lint", qualifiedName: "fmt:lint", source: "plugin" },
    { description: "d2", name: "dynamic-workflows", source: "bundled" },
    { description: "d3", name: "lint", qualifiedName: "fmt:lint", source: "plugin" },
    { description: "d4", name: "agent-notes", source: "agents" },
  ]);
  assert.deepEqual(entries, [
    { description: "d1", name: "lint", qualifiedName: "fmt:lint" },
    { description: "d4", name: "agent-notes" },
  ]);
});

test("listAttachSkillCatalog 发 skills/referenceCatalog 并校验回包形状", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = async <T = unknown,>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    return {
      authority: "session",
      skills: [entry()],
      totalDiscovered: 1,
    } as T;
  };
  const result = await listAttachSkillCatalog({
    request,
    sessionId: "sess-1",
    workspace: { workspaceKey: "/ws", workspacePath: "/ws" },
  });
  assert.equal(result.authority, "session");
  assert.deepEqual(calls, [
    {
      method: "skills/referenceCatalog",
      params: {
        sessionId: "sess-1",
        workspace: { workspaceKey: "/ws", workspacePath: "/ws" },
      },
    },
  ]);

  // sessionId 缺省时按 workspace 权威请求（草稿/无会话入口）。
  calls.length = 0;
  await listAttachSkillCatalog({
    request,
    workspace: { workspaceKey: "/ws", workspacePath: "/ws" },
  });
  assert.deepEqual(calls[0]?.params, {
    workspace: { workspaceKey: "/ws", workspacePath: "/ws" },
  });
});

test("listAttachSkillCatalog 对不合协议回包 fail closed", async () => {
  const request = async <T = unknown,>(): Promise<T> =>
    ({ authority: "session", skills: [{ bogus: true }] }) as T;
  await assert.rejects(
    listAttachSkillCatalog({
      request,
      sessionId: "sess-1",
      workspace: { workspaceKey: "/ws", workspacePath: "/ws" },
    }),
  );
});
