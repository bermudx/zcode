# app-server-attach

`tui attach` 共享 core 的边界模块：attach 侧按 workspace 身份派生/拉起 `app-server --socket`
的进程契约，server 侧的 Unix socket 传输监听。

ACP stdio 入口 `apps/zcode-cli/packages/cli/src/acp/acp-command.ts` 同属此
adapter 模块；它复用 AttachRuntime/AttachSessionHandle，不引入第二套 core
会话状态。ACP wire 与投影约束见 `docs/design/v2/acp-frontend.md`。

## 不变量

- 身份 key 唯一规则是 `workspaceIdentity?.trim() || workspacePath`（`resolveWorkspaceKey`）：
  schema 只验证去空白后非空，不改写 `workspacePath` 拼写，也不拒绝纯空白 identity——
  空白 identity 必须落到 fallback，而不是在解析边界报错。
- `<socket>.info` 元数据是跨进程边界数据：`startedAt` 必须能通过严格 ISO-8601 校验。
- 启动锁只表示「本调用正在 spawn」：stale 锁（死 pid / 过期无效锁）经原子 rename
  回收——移出的 inode 必须确为先前读到的那份死锁才删除，锁位被替换过的 inode 一律
  link 放回不覆盖；socket 路径上的非 socket 文件永不删除。
- socket 监听模式按 spec 恒为零插件 core：共享 MCP pool 与 broker 不装配。
- 只有真正 bind 成功的 listener 才拥有 socket 文件的删除权。
- AttachRuntime 独占 client 安装/重连/关闭；每次连接必须创建新 transport。
  成功 session/close 后注销 recovery 句柄，失败保留原绑定并向协议边界抛错。
