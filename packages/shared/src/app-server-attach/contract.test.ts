import { describe, expect, it } from "vitest";

import { appServerInfoSchema } from "./contract.js";
import { appServerAttachModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("app-server-attach contract", () => {
  it("declares its module manifest", () => {
    expect(appServerAttachModule.id).toBe("app-server-attach");
    expect(appServerAttachModule.requires).toEqual([
      "shared",
      "zcode-cli",
      "cli-arguments",
    ]);
  });

  it("pins the singleton user-scope info metadata", () => {
    const info = appServerInfoSchema.parse({
      version: "test",
      scope: "user",
      socketPath: "/home/user/.zcode/v2/sockets/core.sock",
      startedAt: "2026-10-21T00:00:00.000Z",
    });
    expect(info.scope).toBe("user");
    expect(info.socketPath).toBe("/home/user/.zcode/v2/sockets/core.sock");
    expect(Number.isNaN(Date.parse(info.startedAt))).toBe(false);
  });

  it("rejects non-user scopes, blank socket paths and non-ISO startedAt", () => {
    const base = {
      version: "test",
      scope: "user",
      socketPath: "/home/user/.zcode/v2/sockets/core.sock",
      startedAt: "2026-10-21T00:00:00.000Z",
    };
    // scope 是字面量断言位：非 "user" 的登记值必须校验失败而非静默吞掉
    //（它记录数据/共享范围，不是监督关系证明——见 contract.ts 注释）。
    expect(() =>
      appServerInfoSchema.parse({ ...base, scope: "workspace" }),
    ).toThrow();
    // 去空白后非空但不改写拼写；纯空白路径必须拒绝。
    expect(
      appServerInfoSchema.parse({ ...base, socketPath: " /x/core.sock " })
        .socketPath,
    ).toBe(" /x/core.sock ");
    expect(() =>
      appServerInfoSchema.parse({ ...base, socketPath: "   " }),
    ).toThrow();
    expect(() =>
      appServerInfoSchema.parse({ ...base, startedAt: "not-a-date" }),
    ).toThrow();
  });
});
