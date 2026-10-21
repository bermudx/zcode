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
