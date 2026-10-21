/**
 * app-server-attach 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import { appServerInfoSchema } from "./contract.js";

export const exampleAppServerInfo = appServerInfoSchema.parse({
  version: "test",
  workspaceIdentity: "/workspace",
  startedAt: "2026-10-21T00:00:00.000Z",
});
