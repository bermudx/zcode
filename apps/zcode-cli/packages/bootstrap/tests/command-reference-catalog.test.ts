// commands/referenceCatalog 的 workspace 现扫契约：瘦客户端 `/` 面板与 /help 的
// 数据源。每次调用现扫（自定义命令无会话冻结状态）；保留名剔除（列出即谎话，
// facade 拒绝保留名）；disableNonInteractive 透传不过滤（attach TUI 是交互式）。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zcodeCommandsReferenceCatalogResultSchema } from "@zcode/shared";
import { getCommandReferenceCatalog } from "../src/zcode-protocol/command-reference-catalog.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

function contextWithEnv(env: NodeJS.ProcessEnv): ZCodeProtocolAgentServerContext {
  return {
    deps: { env },
  } as unknown as ZCodeProtocolAgentServerContext;
}

async function writeCommand(
  root: string,
  name: string,
  frontmatter: string[] = ["description: Demo command"],
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, `${name}.md`),
    ["---", ...frontmatter, "---", "", "Command body."].join("\n"),
  );
}

/** 用户档根目录由 adapters 的 os.homedir() 解析（POSIX 读 $HOME）：临时改写
 *  process.env.HOME 做无泄漏测试，结束即还原。 */
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "zcode-command-catalog-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = originalHome;
    await rm(home, { force: true, recursive: true });
  }
}

describe("commands/referenceCatalog protocol", () => {
  it("rescans workspace and user command roots per call", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "zcode-command-catalog-ws-"));
    try {
      await withFakeHome(async (home) => {
        await writeCommand(join(workspace, ".zcode", "commands"), "ws-review", [
          "description: Workspace review",
          "argument-hint: <diff>",
        ]);
        await writeCommand(join(home, ".zcode", "commands"), "user-good-prompt", [
          "description: User prompt",
        ]);

        const result = await getCommandReferenceCatalog(
          contextWithEnv({ ...process.env }),
          { workspace: { workspacePath: workspace, workspaceKey: workspace } },
        );

        expect(result.totalDiscovered).toBe(2);
        const byName = new Map(result.commands.map((command) => [command.name, command]));
        const ws = byName.get("ws-review");
        expect(ws).toMatchObject({
          argumentHint: "<diff>",
          description: "Workspace review",
          scope: "project",
          source: "zcode",
        });
        expect(ws?.path).toContain("ws-review.md");
        const user = byName.get("user-good-prompt");
        expect(user).toMatchObject({ description: "User prompt", scope: "user" });
        // strict schema：真实回包形状必须可解析（客户端 × 服务端同版本口径）。
        expect(() => zcodeCommandsReferenceCatalogResultSchema.parse(result)).not.toThrow();
        return undefined;
      });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("drops reserved names (facade can never invoke them) but keeps interactive-only commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "zcode-command-catalog-ws-"));
    try {
      await withFakeHome(async (home) => {
        expect(home).toBeTruthy();
        await writeCommand(join(workspace, ".zcode", "commands"), "compact", [
          "description: Shadowing builtin",
        ]);
        await writeCommand(join(workspace, ".zcode", "commands"), "interactive-only", [
          "description: TUI only",
          "disable-noninteractive: true",
        ]);

        const result = await getCommandReferenceCatalog(
          contextWithEnv({ ...process.env }),
          { workspace: { workspacePath: workspace, workspaceKey: workspace } },
        );

        expect(result.commands.map((command) => command.name)).toEqual(["interactive-only"]);
        expect(result.commands[0]?.disableNonInteractive).toBe(true);
        expect(result.totalDiscovered).toBe(2);
        return undefined;
      });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("rejects malformed params as protocol invalid-params", async () => {
    await expect(
      getCommandReferenceCatalog(contextWithEnv({ ...process.env }), {
        workspace: { workspacePath: "/ws" },
        sessionId: "unexpected",
      }),
    ).rejects.toThrow(/Invalid params/u);
  });
});

// 防呆：方法名拼进 zcodeProtocolMethods 后与 server dispatch 保持同一字符串。
describe("commands/referenceCatalog method registration", () => {
  it("is declared in the shared protocol methods table", async () => {
    const { zcodeProtocolMethods } = await import("@zcode/shared");
    expect(zcodeProtocolMethods.commandsReferenceCatalog).toBe("commands/referenceCatalog");
  });
});
