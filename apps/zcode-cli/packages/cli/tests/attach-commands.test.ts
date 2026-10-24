// attach-commands 纯映射：commands/referenceCatalog 回包 → commandCenter `/help`
// 列表形状（diagnostics 置空、totalDiscovered 回退）、`/` 面板 suggestions 经
// listSlashCommandSuggestions 的合成，以及协议请求形状与 strict schema 边界。

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZCodeCommandsReferenceCatalogResult } from "@zcode/shared";
import {
  listAttachCommandCatalog,
  toCommandCenterCustomCommand,
  toCommandCenterCustomCommandList,
} from "../src/attach/attach-commands.js";
import { listSlashCommandSuggestions } from "../src/command-center.js";

const entry = (
  overrides: Partial<ZCodeCommandsReferenceCatalogResult["commands"][number]> = {},
): ZCodeCommandsReferenceCatalogResult["commands"][number] => ({
  description: "Review Guidelines",
  name: "review",
  path: "/home/user/.zcode/commands/review.md",
  scope: "user",
  source: "zcode",
  ...overrides,
});

test("toCommandCenterCustomCommand 全字段时还原 /help 显示面", () => {
  const command = toCommandCenterCustomCommand(
    entry({
      allowedTools: ["Read"],
      argumentHint: "<diff>",
      disableNonInteractive: true,
      frontmatterKeys: ["description", "argument-hint"],
      model: "glm-4.6",
      rootPath: "/home/user/.zcode/commands",
      skills: ["code-review"],
    }),
  );
  assert.deepEqual(command, {
    allowedTools: ["Read"],
    argumentHint: "<diff>",
    description: "Review Guidelines",
    disableNonInteractive: true,
    frontmatterKeys: ["description", "argument-hint"],
    model: "glm-4.6",
    name: "review",
    path: "/home/user/.zcode/commands/review.md",
    rootPath: "/home/user/.zcode/commands",
    scope: "user",
    skills: ["code-review"],
    source: "zcode",
  });
});

test("toCommandCenterCustomCommandList 补空诊断并回退 totalDiscovered", () => {
  const outcome = toCommandCenterCustomCommandList({
    commands: [entry()],
  });
  assert.deepEqual(outcome, {
    commands: [
      {
        description: "Review Guidelines",
        name: "review",
        path: "/home/user/.zcode/commands/review.md",
        scope: "user",
        source: "zcode",
      },
    ],
    diagnostics: [],
    totalDiscovered: 1,
  });
  assert.equal(
    toCommandCenterCustomCommandList({
      commands: [],
      totalDiscovered: 3,
    }).totalDiscovered,
    3,
  );
});

test("listAttachCommandCatalog 发 commands/referenceCatalog 并校验回包形状", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = async <T = unknown,>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    return { commands: [entry({ argumentHint: "<prompt>" })], totalDiscovered: 1 } as T;
  };
  const result = await listAttachCommandCatalog({
    request,
    workspace: { workspaceKey: "/ws", workspacePath: "/ws" },
  });
  assert.equal(result.commands.length, 1);
  assert.deepEqual(calls, [
    {
      method: "commands/referenceCatalog",
      params: { workspace: { workspaceKey: "/ws", workspacePath: "/ws" } },
    },
  ]);
});

test("listAttachCommandCatalog 对不合协议回包 fail closed", async () => {
  const request = async <T = unknown,>(): Promise<T> =>
    ({ commands: [{ bogus: true }] }) as T;
  await assert.rejects(
    listAttachCommandCatalog({
      request,
      workspace: { workspaceKey: "/ws", workspacePath: "/ws" },
    }),
  );
});

test("目录经 listSlashCommandSuggestions 合成 `/` 面板条目（含 usage 提示）", () => {
  const suggestions = listSlashCommandSuggestions(
    toCommandCenterCustomCommandList({
      commands: [
        entry({ argumentHint: "<prompt>" }),
        entry({ description: "Workspace cmd", name: "ws-cmd", scope: "project" }),
      ],
    }),
    {},
  );
  const custom = suggestions.filter((suggestion) => suggestion.name === "review");
  assert.equal(custom.length, 1);
  assert.equal(custom[0]?.usage, "/review <prompt>");
  assert.match(custom[0]?.summary ?? "", /Review Guidelines \(user\/zcode\)/);
  const wsCmd = suggestions.find((suggestion) => suggestion.name === "ws-cmd");
  assert.equal(wsCmd?.usage, "/ws-cmd");
});
