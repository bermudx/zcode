import { describe, expect, it } from "vitest";

import { resolveWorkspaceKey } from "../task-realtime-core.js";
import {
  appServerAttachWorkspaceSchema,
  appServerInfoSchema,
} from "./contract.js";
import { appServerAttachModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("app-server-attach contract", () => {
  it("declares its module manifest", () => {
    expect(appServerAttachModule.id).toBe("app-server-attach");
    expect(appServerAttachModule.requires).toEqual(["shared", "zcode-cli"]);
  });

  it("validates startedAt as strict ISO-8601 metadata", () => {
    const info = appServerInfoSchema.parse({
      version: "test",
      workspaceIdentity: "/workspace",
      startedAt: "2026-10-21T00:00:00.000Z",
    });
    expect(Number.isNaN(Date.parse(info.startedAt))).toBe(false);
    expect(() =>
      appServerInfoSchema.parse({
        version: "test",
        workspaceIdentity: "/workspace",
        startedAt: "not-a-date",
      }),
    ).toThrow();
  });

  it("accepts whitespace-only workspaceIdentity and falls back via resolveWorkspaceKey", () => {
    const parsed = appServerAttachWorkspaceSchema.parse({
      workspacePath: "/workspace/demo",
      workspaceIdentity: "   ",
    });
    expect(resolveWorkspaceKey(parsed)).toBe("/workspace/demo");
  });

  it("preserves workspacePath spelling while rejecting blank paths", () => {
    expect(
      appServerAttachWorkspaceSchema.parse({ workspacePath: " /workspace/demo " })
        .workspacePath,
    ).toBe(" /workspace/demo ");
    expect(() =>
      appServerAttachWorkspaceSchema.parse({ workspacePath: "   " }),
    ).toThrow();
  });
});
