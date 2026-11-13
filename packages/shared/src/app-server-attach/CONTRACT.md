# app-server-attach

`tui attach` / `piz acp` 共享 core 的边界模块：客户端按数据根派生单一
`app-server --socket` 端点、缺失时经 user 服务管理器拉起，server 侧
Unix socket 传输监听。

ACP stdio 入口 `apps/zcode-cli/packages/cli/src/acp/acp-command.ts` 同属此
adapter 模块；它复用 AttachRuntime/AttachSessionHandle，不引入第二套 core
会话状态。ACP wire 与投影约束见 `docs/design/v2/acp-frontend.md`。

## 不变量

- **单一 core**：socket 路径只由数据根派生
  `<dataBaseDir>/.zcode/v2/sockets/core.sock`（数据根 =
  `options.dataBaseDir ?? ZCODE_DATA_BASE_DIR ?? homedir()`，去空白后非空
  且在 Unix 上必须是绝对路径）；不含 workspace/frontend/provider 标识。
  workspace 身份只存在于会话级请求参数（session/create|resume|list），
  不参与传输选择；`session` 侧 `workspaceKey = workspaceIdentity?.trim() ||
  workspacePath` 的隔离语义不变（定义在 task-realtime-core，不属本模块）。
- 生命周期归 user 服务管理器，不归任何客户端 scope：Linux 经
  `systemd-run --user --service-type=exec` 瞬时 service
  （`piz-core-<sha256(absolute socketPath)[:16]>`）拉起，服务活在拉起它的
  客户端 cgroup 之外，客户端 scope 退役不能带走它。要求 systemd ≥ 254
  （`--expand-environment=no` 自 v254 起；本地 man systemd-run(1)）。systemd-run exit 0
  只代表服务被受理、不代表 core 就绪——客户端继续探测 socket 到上限；
  非零退出按 manager/启动失败显式报错（stderr 有界收集），报错前可重探
  一次 socket 容忍竞态。无 service manager 的平台（非 Linux Unix，含
  darwin）：已监听 socket 仍可复用，缺席时显式报「需要独立 supervisor」
  错误，不回落 detached/double-fork spawn；win32 不支持 spawn。
- service env = 客户端 env 过滤后转发：`--setenv=NAME` 只传变量名（值由
  systemd-run 从自己 env 解析，绝不进 argv/日志）；`ZCODE_WORKSPACE_IDENTITY`、
  `HERDR_*`、`T3CODE_*`、service-instance 变量（`INVOCATION_ID`、
  `JOURNAL_STREAM`、`NOTIFY_SOCKET`、`LISTEN_*`、`WATCHDOG_*`）一律不透传，
  并经 `--property=UnsetEnvironment=` 防 manager 侧 env 泄漏进服务；
  `ZCODE_ATTACH_CORE=1` 恒写入，`ZCODE_DATA_BASE_DIR`/`PWD` 固定为数据根。
- `<socket>.info` 元数据是跨进程边界数据：`{version, scope, socketPath,
  startedAt}`——`scope` 恒为字面量 `"user"`，只记录登记的数据/共享范围
  （单一 core 服务整个用户的全部 workspace）；它**不**断言监督关系——
  手动 `zcode app-server --socket` 启动的进程写同样的值，真实生命周期
  归属只能由 cgroup/service manager 事实证明（如 `systemctl --user
  status piz-core-<hash>`），`.pid`/`.info` 是操作者元数据，可能滞后或
  陈旧，永不作拉起器的归属/清理依据。`socketPath` 非空白，`startedAt`
  必须能通过严格 ISO-8601 校验。
- 启动锁只表示「本调用正在 spawn」：stale 锁（死 pid / 过期无效锁）经原子
  rename 回收——移出的 inode 必须确为先前读到的那份死锁才删除，锁位被
  替换过的 inode 一律 link 放回不覆盖；socket 路径上的非 socket 文件永不
  删除。失败路径只释放本调用的锁、最多回收仍在运行的启动器进程，绝不
  按 unit 停共享服务。
- socket 监听模式按 spec 恒为零插件 core：共享 MCP pool 与 broker 不装配；
  singleton 不扩展到 plugin-enabled 形态。
- 只有真正 bind 成功的 listener 才拥有 socket 文件的删除权。
- AttachRuntime 独占 client 安装/重连/关闭；每次连接必须创建新 transport。
  成功 session/close 后注销 recovery 句柄，失败保留原绑定并向协议边界抛错。
