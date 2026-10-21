# tui attach：共享 core + pi-tui 瘦客户端

## 背景与目标

实测（2026-10-21，见根 AGENTS.md「TUI 空闲 CPU」节）：每个 zcode-cli 会话
= 主进程 0.8-1.3GB + ~930MB MCP 子进程（office×4 + node-repl 宿主）≈
1.8-2.2GB。pi-tui 前端已把主进程降到 ~470MB、空闲 CPU 0%，但子进程与
每会话一份 runtime 的结构成本不变。

目标：**一个 workspace 一个共享无头 core（app-server），N 个 pi-tui 瘦客户
端进程 attach；此模式下不启动任何 MCP/office 插件/node-repl 子进程。**

非目标：desktop/web/remote 链路改动；opentui 前端改动；插件系统重构。

## 架构

```
herdr pane 1..N                    每 workspace 一个
┌──────────────┐                  ┌────────────────────────┐
│ zcode attach │  unix socket     │ zcode app-server       │
│ (pi-tui 渲染  │ ───────────────▶ │ --socket <path>        │
│  + 协议客户端)│  ZCode Protocol  │ (core+runtime+store，   │
└──────────────┘                  │  无插件/无 MCP 子进程)   │
                                  └────────────────────────┘
```

### 1. 服务端：socket 模式

- `zcode app-server --socket <path>`：复用 `runZCodeProtocolCommand` 的
  host 构建，传输从 stdio 增加 Unix socket listener，支持多客户端并发
  连接（每连接一个协议会话；session 归属与 owner/lease 语义沿用现有
  Host 实现，不新增状态所有者）。
- socket 路径约定：`~/.zcode/v2/sockets/core-<hash>.sock`，其中
  `<hash> = sha256(workspaceIdentity).slice(0,16)`；workspaceIdentity
  统一用现有构造工具（`workspaceIdentity?.trim() || workspacePath`），
  不手写格式。同目录写 `<path>.pid` 与 `<path>.info`（JSON：版本、
  workspaceIdentity、启动时间）。
- **插件全关**：socket 模式下服务端以「零插件」配置构建 runtime——
  office 插件、node-repl/browser-use 宿主、marketplace MCP 一律不注
  册、不 spawn。入口在 `bootstrap/src/plugins.ts` / adapters config
  （`pluginsEnabled`）增加显式禁用参数；CLI 侧落为
  `zcode app-server --socket <path> --no-plugins`。
- 生命周期 v1：首个客户端发现无 socket 时负责 detached 启动服务端
  （setsid，stdio 全断开），原子锁（`O_CREAT|O_EXCL` lock 文件）防双
  启动；等待 socket 就绪超时 10s。停止：`kill $(cat <path>.pid)`，
  写入文档；不做 idle 自动退出。

### 2. 客户端：`zcode attach`

- 新命令 `zcode attach`（等价 `zcode tui --tui-frontend=pi --attach`，
  取一个即可，实现取后者 flag、前者别名）。行为：
  1. 解析当前 workspace 的 socket 路径；connect 失败 → 按上节规则
     spawn 服务端并等待；
  2. 协议握手校验 `ZCODE_PROTOCOL_VERSION`，不匹配 → 明确报错退出；
  3. 以协议客户端实现 `TuiOptions` 全部端口，动态 import
     `@zcode/tui-pi` 的 `runTui`（沿用 tui-pi-runtime-loader）。
- `TuiOptions` 端口 → 协议映射（有则用，无则在
  `packages/shared/src/zcode-protocol/index.ts` 补 zod schema）：
  - `submitPrompt` / `sendInput`（steer）/ `setMode` → 对应请求 topic
  - `subscribeSessionEvents` → 通知 topic（沿用 desktop-continuous 语义）
  - `recallPreviousInput` / `listModelOptions` / `slashCommands` /
    `listWorkflowRuns` / `readSubagents` / `readSubagentTranscript` /
    `getMainSessionId` / `listWorkspacePathSuggestions` → 请求 topic
  - `listMcpServers` → 常量空列表（无插件模式）
  - 剪贴板/终端本地能力保留在客户端本地实现
- 客户端不持有业务状态：transcript 投影、提交分支、审批状态机全部
  来自 `@zcode/tui/internals` 共享层 + 服务端事件流；客户端只渲染、
  路由焦点、转发输入（与 tui-pi CONTRACT.md 不变量一致）。
- 断线：socket 断开 → TUI 顶部横幅提示 + 自动重连（指数退避，上限
  30s）；重连后按 session id 重新订阅事件流续传。

### 3. 协议扩展规则

新 topic 一律：严格类型 + zod 运行时校验，写
`packages/shared/src/zcode-protocol/index.ts`；请求/通知/响应三类齐
全；不引入双写路径。

## 验收

1. 同一 workspace 两个 `zcode attach` 并发运行：独立会话、各自
   transcript 正确、steer/审批/模型切换可用。
2. 此模式进程树：服务端无任何 zcode-cli/node-repl-mcp 子进程；客户端
   同样零子进程。
3. 资源（探针脚本入库 `apps/zcode-cli/scripts/measure-attach.sh`）：
   客户端 RSS < 200MB；服务端 RSS < 1.2GB；5 客户端 + 1 服务端合计
   < 3GB。
4. 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check
   --changed`、受影响单测全绿。

## 测试

- 单测：socket 路径派生、原子锁竞态（并发 spawn 只剩一个服务端）、
  协议版本不匹配报错、TuiOptions 端口映射（fake server）。
- 集成：真 socket 起 server + 两客户端，走一轮 submit → 事件流 →
  steer → 退出。
- 现有 tui-pi 用例不回归。

## 实施状态（2026-10-21 实测）

### 已实现

- `zcode app-server --socket <path> --no-plugins`：Unix socket 监听，
  多客户端并发独立协议会话；`--no-plugins` 关闭全部插件/MCP/
  node-repl/browser-use/marketplace MCP 子进程。
- `zcode tui --tui-frontend=pi --shared-core`：pi-tui 瘦客户端经
  NDJSON socket attach 共享 core；`zcode attach` 为其别名命令。
  原 `--attach <path>` 仍是 prompt 文件附件参数，不复用。
- `zcode-attach`（`dist/zcode-attach.cjs`，esbuild 独立入口
  `src/attach-main.ts`）：仅含 attach 链路 + tui-pi/TuiOptions 适配的
  客户端专用二进制，进程名 `zcode-attach`。不内联 bootstrap/core/
  adapters/plugin 机制——`listWorkspacePathSuggestions` 省略、
  slash 建议退回内置命令、locale 用 `auto`，重量级助手经
  `RunDependencies` 依赖注入由 monolith 提供（`zcode attach` 路径
  不受影响）。构建：`pnpm --filter @zcode/cli build` 同时产出，
  或 `build:attach`（`--client-only`）单独构建。
- `ZCODE_SERVER_BIN`：core spawn 可执行文件覆盖（默认 PATH 里的
  `zcode`；优先级 `spawnSpec` 测试注入 > `ZCODE_SERVER_BIN` > PATH）。
  仅供瘦客户端/探针指定 core 入口；路径不存在或不可执行时
  `ensureServer` 在原 spawn/就绪等待错误中原样抛出。烟测
  `tests/attach-binary.smoke.test.ts` 覆盖。
- `ensureServer`：确定性 socket 路径
  `<dataBaseDir>/.zcode/v2/sockets/core-<sha256(workspace-key).slice(0,16)>.sock`，
  原子锁 + detached spawn + `.pid`/`.info` 元数据 + 就绪等待。
- 协议新增：`session/rawEvent` 通知、`eventFormat: "raw"`（subscribe/
  events）、`session/recallPreviousInput`、`session/recordInputHistory`。
- 断线 UX：socket 断开 → pi-tui 状态行显示
  `Connexion au core perdue — reconnexion…`；重连并按 `sequenceNumber`
  续订成功 → `Reconnecté au core`；core 重启后会话不可冷恢复时显示
  `Reconnecté au core — session indisponible`（先 `session/resume`
  兜底，失败则如实提示并保持退避重试）。

### 服务端生命周期

- 起：首个 attach 客户端 `ensureServer` 自动 spawn（detached、
  `--no-plugins`、`ZCODE_WORKSPACE_IDENTITY` 透传）。
- 停：`kill $(cat <socket>.pid)`；SIGTERM 下 `.sock` 文件随监听关闭
  移除，`.pid`/`.info` 由下一次 `ensureServer` 的死 pid 探测回收。
- 客户端退出只断开本连接：core 与其会话照常存活。

### 实测资源（`measure-attach.sh`，稳态 15s）

客户端为 monolith `zcode attach`（N=2）：

| process  | RSS(MB) | children |
|----------|---------|----------|
| client-1 | 436     | 1*       |
| client-2 | 431     | 0        |
| server   | 416     | 0        |
| 合计     | 1283    |          |

客户端为 `zcode-attach` 专用二进制（`ATTACH_BIN` 指定，N=2）：

| process  | RSS(MB) | children |
|----------|---------|----------|
| client-1 | 160     | 0        |
| client-2 | 161     | 1*       |
| server   | 406     | 0        |
| 合计     | 727     |          |

同配置 N=5：

| process  | RSS(MB) | children |
|----------|---------|----------|
| client-1..5 | 160–166 | 1*    |
| server   | 406     | 0        |
| 合计     | 1219    |          |

\* detached server 在拉起它的客户端退出前仍挂在其进程树下。

对照验收线：`zcode-attach` 客户端 160–166MB < 200MB、server
406MB < 1.2GB、N=5 合计 1219MB < 3GB 全部达标。monolith
`zcode attach` 路径单客户端 ~433MB（仍加载完整 CLI bundle），
需要省内存时用 `zcode-attach`。对比改造前每会话 1.8–2.2GB，
5 客户端 + core ≈ 1.22GB。

### 已知遗留（deferred）

- dwf list/replay/resume、expert workflows、`listPlugins` 在 attach
  模式以 "unavailable" 语义面向上层（可选端口未实现）。
- core 重启后 ephemeral/零回合会话不可 `session/resume`（未落
  store），状态行如实显示 session indisponible。
- Windows 下 socket 走 named pipe 分支已实现但未实测。
- 断线横幅的完整 banner 设计未做（当前为状态行最小版）。
