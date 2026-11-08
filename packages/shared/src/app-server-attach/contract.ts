import { z } from "zod";
import { nonEmptyStringSchema } from "../validation.js";

/** 校验去空白后非空但不改写原值：路径前导/尾随空格是真实拼写的一部分。 */
const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must not be blank" });

/**
 * `zcode app-server --socket` 启动元数据的文件契约（`<path>.info`，JSON 单行）。
 * 由 bind 成功的 server 进程在 listen 后自写、操作者读取；属于跨进程边界
 * 数据，必须有运行时校验。`scope` 恒为 "user"，只记录这份登记的数据/共享
 * 范围（单一 core 服务整个用户的全部 workspace，身份不进入元数据）——
 * 它不是监督关系证明：手动 `zcode app-server --socket` 启动的进程同样写
 * "user"。进程真实归谁管（user 服务管理器/客户端 scope/前台终端）只能由
 * cgroup/service manager 事实证明，不能由进程自报的元数据字段断言。
 */
export const appServerInfoSchema = z.object({
  version: nonEmptyStringSchema,
  /** 本登记的数据/共享范围；当前唯一取值 "user"。非监督/归属证明。 */
  scope: z.literal("user"),
  /** server 实际监听的 socket 路径。 */
  socketPath: nonBlankStringSchema,
  /** ISO-8601 启动时间。 */
  startedAt: z.iso.datetime(),
});
export type AppServerInfo = z.infer<typeof appServerInfoSchema>;
