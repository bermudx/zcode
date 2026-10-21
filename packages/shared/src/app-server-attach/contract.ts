import { z } from "zod";
import { nonEmptyStringSchema } from "../validation.js";

/** 校验去空白后非空但不改写原值：路径前导/尾随空格是真实拼写的一部分。 */
const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must not be blank" });

/**
 * `zcode app-server --socket` 启动元数据的文件契约（`<path>.info`，JSON 单行）。
 * 由 attach spawn 端写入、客户端读取；属于跨进程边界数据，必须有运行时校验。
 */
export const appServerInfoSchema = z.object({
  version: nonEmptyStringSchema,
  /** 服务端 workspace 身份 key：`workspaceIdentity?.trim() || workspacePath`。 */
  workspaceIdentity: nonEmptyStringSchema,
  /** ISO-8601 启动时间。 */
  startedAt: z.iso.datetime(),
});
export type AppServerInfo = z.infer<typeof appServerInfoSchema>;

/** attach 输入：server 的 cwd/身份来源，与 `resolveWorkspaceKey` 的入参一致。 */
export const appServerAttachWorkspaceSchema = z.object({
  workspacePath: nonBlankStringSchema,
  workspaceIdentity: z.string().max(4096).optional(),
});
export type AppServerAttachWorkspace = z.infer<typeof appServerAttachWorkspaceSchema>;
