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
  启动；等待 socket 就绪超时 60s。停止：`kill $(cat <path>.pid)`，
  写入文档；不做 idle 自动退出。锁等待与就绪等待各占独立预算：
  就绪窗口从新 spawn 完成起算，等锁耗掉的预算不压缩 core 启动
  （2026-10-25 实测：herdr 开机恢复并发拉起十余个 agent 时 core 的
  spawn→listen 超过旧 10s 上限，客户端超时误杀正常启动中的 core，
  piz --resume 全灭；上限提至 60s 并把锁/就绪预算拆开）。

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
  - `removeQueuedInputs` → `session/discardPendingInputs` 请求 topic
    （本地队列项客户端摘除，core pendingInputs 项走协议，2026-10-25）
  - `subscribeSessionEvents` → 通知 topic（沿用 desktop-continuous 语义）。
    订阅对象是「当前会话」而非某个句柄：`createAttachPromptHandler` 以
    `durableSinks` + `runtime.onSessionBound` 迁移常驻 sink——/new /resume
    /fork 换 `current` 后 sink 挂到新句柄，否则旧句柄永久失聪新会话的
    出回合事件（per-turn onEvent 掩盖故障，表现静默；monolith 侧同一语义
    由 `sessionEventRelay` 承担）。事件按 `sessionId` 经
    `runtime.sessions` 注册表路由到句柄 `ingestRawEvent` → sinks。
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
- 断线 UX：socket 断开 → pi-tui 状态行显示断线提示；重连并按 `sequenceNumber`
  续订成功 → 重连成功提示；core 重启后会话不可冷恢复时显示"会话暂不可用、
  继续重试"提示（先 `session/resume` 兜底，失败则如实提示并保持退避重试）。
  三条状态文案经 `@zcode/i18n` 目录（`tui.connection.lost/reconnected/
  reconnectedSessionUnavailable`）按 `--locale` 解析（2026-10-26 前曾硬编码
  法语，无视 locale——P004-F3）。

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

## 交互语义收口（busy 队列 / 断线重连 / 会话选择）

### busy 输入：steer 与 follow-up 队列（pi-mono 对齐，2026-10-25）

以下旧 `session/send` 行为已被本文「输入提交迁移到 v4」覆盖；v4 guide 的
idle 竞态会原子接纳为新回合，客户端必须按 ACK 的实际 delivery 跟踪并展示。
旧 core 的 `session/send` 同一时间只接纳一个 prompt（并发时拒绝
"A prompt is already running"）。busy 输入分两条 lane，语义对齐
pi-mono（Enter=steer，Ctrl+Q=queue follow-up）：

- **steer（`sendInput` options `delivery:"steer"`）**：经
  `session/send` 新增的可选 `delivery:"steer"` 参数直驱 core 的
  `app.steerTurn`（`inputPresentation:"user_steer"`、
  `delivery:"guide"`）——输入注入 active turn 的 pendingInputs，
  在下一个 tool/text 边界被消费。core 发真实
  `turn_steer_queued`/`turn_steer_drained` 事件，客户端不合成。
  拒绝（`no_active_turn` settle 竞态、`turn_not_steerable`、附件 steer）
  服务端回 `guard.steerRejected.{reason}`，客户端回退**本地 follow-up
  队列**并提示，用户输入永不丢失；服务端不擅自开新回合（客户端没有
  等待它的 pendingTurns）。
- **follow-up 队列（`delivery:"queue"`，与缺省行为一致）**：
  排队放在 **attach 客户端**（`AttachSessionHandle.sendInput`），
  settle 后作为新回合重放：

  - `pendingTurns` 非空（有回合在跑）时，`sendInput` 把输入停进
    本地 FIFO 队列，返回 `{kind:"queued", pendingInputId, queueLength,
    turnId}`，并同步向 sinks 发本地合成 `turn_steer_queued` 事件
    （`delivery:"queue"`），让 TUI 队列区立即可见。
  - `expectedTurnId` 与当前活跃回合不一致时返回
    `{kind:"rejected", reason:"expected_turn_mismatch"}`。
  - 回合 settle（`turn_complete`/`turn_error`）后 microtask 触发
    `flushQueuedInputs`：先合成 `turn_steer_drained`（UI 摘除队列行），
    再把该输入作为新回合 `session/send`；user 行由 core 正常的
    `user_message`/`turn_started` 下发，不伪造 transcript。
    一次只放一条——新回合重新占住 `pendingTurns`，余下条目等
    下一轮 settle 接力；flush 失败合成 `session_notice` 错误行并
    继续后续条目。

两 lane 的 pending 输入在 TUI 端只有**一个事实来源**：事件投影出的
`queuedInputs`（core 真实事件 + 本地合成事件同形，按 `pendingInputId`
幂等 upsert/remove）。Alt+Up 撤回（见 tui-pi-frontend.md）经
`TuiOptions.removeQueuedInputs` 端口：本地队列项客户端摘除（合成
`turn_steer_discarded`），core pendingInputs 项经新增
`session/discardPendingInputs` 方法（params `{sessionId,
pendingInputIds}`，result `{removed: string[]}`，逐项桥
`app.removeQueueItem`，core 发真实 `turn_steer_discarded`）。

### slash 命令路由

`sendInput` 与 `submitPrompt` 一样先经 `commandCenter` 的 slash 路由。
`/model`、`/effort`（Ctrl+P 轮换、Ctrl+L 选择器、忙时输入）在
`sendInput` 内特判，走 `commandCenter` → `sessionSetModel` /
`sessionSetThoughtLevel`，返回 `{kind:"command_result"}`；
不会作为普通 prompt 发给模型。

### Coding Plan 额度读数（usage/codingPlanQuota，2026-10-27）

pi 侧 provider-balance 额度簇的 piz 对应物。数据面走协议而非客户端直连：

- **新协议方法** `usage/codingPlanQuota`（params `{sessionId}`，账号级读数
  经 session 载体访问 live app 的 Registry）：bootstrap session facade 新增
  `readCodingPlanQuota` —— Registry 里第一个可用凭据的「zai-family /
  bigmodel-family」provider 按 family 分流打监控端点（api.z.ai /
  open.bigmodel.cn 同一路径），Bearer 凭据只进请求头；envelope
  `success===true && code===200` 门后透传 `UsageQuotaSnapshot`（共享
  `usage-quota.ts` 纯类型 + zod schema 双向漂移门）。凭据两路
  （2026-10-28 扩展账号通道）：provider config 内 API key 访问
  （api-key / zhipu-coding-plan-api-key）直读；zhipu-account（entitled +
  individual-coding-plan）经 session facade 注入的账号解析器现取——
  复用 `providerRuntimeHeadersPort.refreshBeforeModelRequest`（与模型请求
  同一凭据所有者：standalone core 的 manual 计划 Key 或 OAuth 派生 project
  token），解析失败/返回空跳过该 provider 继续候选；team/start/off-peak
  等其它套餐形态维持不覆盖（desktop 各自额度服务负责）。无可用 provider
  抛显式错误。
- **消费面**：tui-pi 额度簇（`TuiOptions.readUsageQuota`，quota-cluster）
  在主会话绑定后接线（attach 经 attach-tui-options，进程内经
  tui-prompt-handler-queries），刷新策略与展示格式见 tui-pi-frontend.md
  footer 节；`readUsageQuota` 缺席（旧 core）时簇静默。

### 自定义命令（/commands，2026-10-24）

用户级（`~/.zcode/commands`）与 workspace 级（`<cwd>/.zcode/commands`）
markdown 命令在 attach 模式分两段：**目录走协议，展开留 core**。

- **目录**：新协议方法 `commands/referenceCatalog`（workspace 权威、
  每次调用现扫，照 `skills/referenceCatalog` 的 draft 先例；无 session
  权威 —— 自定义命令没有会话冻结状态，core 的 input facade 每次 send
  现扫展开）。瘦客户端 `/` 面板 suggestions（`loadStartupOptions`）与
  commandCenter `/help` 列表都从它取数，不本地重扫（瘦客户端 bundle 无
  bootstrap；`listAttachCustomCommands` 本地扫描注入点已删除）。保留名
  剔除（facade 拒绝保留名，列出即谎话），`disableNonInteractive` 透传。
- **展开**：未知 `/name args` 照 P005 原文经 `session/send` 转发，由 core
  的 input facade（`customCommandPromptResolver` →
  `resolveZCodeCustomCommandPrompt`，create-app.ts 传 `workingDirectory`）
  展开并把原文记为 `displayInput`。这是 monolith headless 的同款路径，
  且能力更强：facade 经 `executionPort` 支持 `!\`cmd\`` 动态 shell 展开，
  客户端侧展开器（`expandCliCustomCommandPrompt`）对同语法直接拒绝 ——
  刻意不接 `loadCustomCommand`。决策记录：
  [docs/fork/attach-custom-commands-design.md](../../../../../docs/fork/attach-custom-commands-design.md)。

### core 死亡与重连恢复

socket close → 状态行 "reconnecting" + transcript 内 `session_notice`
横幅 → 指数退避重连（1s 起，封顶 30s）。每轮重连先重跑
`ensureServer`：stale pid/socket 由原子 reclaim 清理并 detached
respawn 新 core（同一确定性 socketPath）。连接恢复后逐会话
`session/subscribe(afterSeq)` 补放缺口；core 重启丢 registry 时先经
`session/resume` 冷物化再重试。composer 草稿本地保留，恢复后可继续
输入。

### 会话选择（-c / --resume，默认新会话）

attach 入口的会话选择与主 CLI 同语义，不再默认 resume：

| 意图               | 行为                                                |
| ------------------ | --------------------------------------------------- |
| 默认（无旗标）     | `session/create` —— 开新会话                        |
| `-c` / `--continue` | `session/list` 取本 workspace 最近会话 → `resume`  |
| `--resume <id>`     | 完整 id，或本 workspace 内唯一匹配的 id 前缀 → `session/resume` |

之前无条件 resume 最近会话，piz 永远进旧对话、无法开新会话——
与主 CLI（默认新会话、`-c` 才继续）相反。

resume 成功时 `restoredMessages` 作为 `initialResult` 交给
`runTui` 首帧渲染历史 transcript。同时 `sessionSnapshotSeed()` 把快照
投影成一次性的页脚种子并入 `initialResult`（/new /resume /fork 的
swap 结果同样携带）：`runtime.contextUsage`（`{used,size}`）→
`projection.contextUsed/contextWindow`，`runtime.usageTotals` →
`usageTotals`。`runtime.usageTotals` 是 additive 协议字段（
`packages/shared/src/zcode-protocol-legacy-types.ts`），core 在
`snapshotWithDiagnostics` 时对本 session eventStore 用
`summarizeSessionUsageTotals`（contracts）折叠——与 TUI 累计器同一
事件集合（`model_complete` + 带 usage 的 `model_request_failed`）与
字段语义，`seed` 与 live 折叠同源同径、读数不跳变。eventStore 是运行
期内存账本：core 重启冷恢复的 session 只含物化后事件，种子口径与
`contextUsage` 一致，不承诺跨重启的历史完整度。`applyResult` 必须先
执行 `resetSessionProjection` 再合并种子，否则种子被清零（曾先 merge
projection 再 reset，种子整体被抹掉）。

**显式 resume 意图不静默降级**
（2026-10-24 修复：截断 id `--resume sess_99f180d5` 曾被
`.catch(() => undefined)` 吞掉 not-found，无声开出空新会话）：

- `--resume` 先对本 workspace `session/list` 做前缀解析：完整 id
  原样通过；唯一前缀展开成完整 id；多候选报错并列出候选；无本地
  匹配时原样透传（跨 workspace 完整 id 交给 `session/resume` 裁决）。
  列表失败不阻断透传。
- `session/resume` 失败（任何原因）直接抛错：stderr + exit 1，
  不再回退 `session/create`。
- `-c` 列表为空报 `No resumable session found for <path>`（与主
  CLI 同语义）；`session/list` 本身失败也报错，不静默开新会话。
- 无旗标默认路径不变：直接 `session/create`。

同一 workspace 多个 pane 在 `-c` 下 attach 到
同一会话，事件经 core fan-out 同步。

### 启动模型选择（--model）

`--model <ref>` 让会话在启动时即落在指定模型上，而不是进入 TUI 后
再 Ctrl+P 轮换或 `/model` 挑选。作用域：仅 `tui --shared-core`（含
`zcode attach` 别名）与瘦客户端 `zcode-attach`（piz）；monolith tui
与 headless prompt 不接受该旗标（run.ts 作用域报错，同
`--shared-core` 惯例）。

- **应用点**：attach 客户端在 `session/create`/`session/resume` 返回
  快照、`subscribe` 完成后、`runTui` 之前，调用既有
  `AttachSessionHandle.setModel`（`session/setModel` mutation）。不新造
  协议路径：`session/create` 虽有 `model` 参数，但 resume 无对应参数、
  且客户端目录校验（未知模型报错并列出可用项）只能在拿到快照目录后
  做——统一走 setModel 一条链路，Ctrl+P/`/model`/`--model` 共享校验
  与状态合并语义。
- **取值**：`provider/model` 完整 ref（支持 `$effort` 档位后缀，同
  `/model` 参数）；bare modelId 在目录中唯一命中时自动补全 provider，
  多命中或零命中时报错并列出可用完整 ref。模型校验复用
  `resolveTuiModelSelection`（目录精确匹配 + 默认档位）。
- **resume 语义**：`-c`/`--resume` 携带 `--model` 时对恢复的会话执行
  同一 setModel——启动覆盖是每次调用一次性事实。
- **失败**：校验失败在 TUI 接管屏幕前以 stderr 报错、退出码 1。
- **不做**：不写客户端默认模型偏好（交互 `/model` 会记忆默认选型；
  一次性旗标不改变持久偏好），不改协议 schema、不改服务端。

### GLM 压缩窗口上限（262K）

piz 对 GLM 系列模型（`modelId` 匹配 `/^glm-/i`）把 core 的 auto-compact 窗口压到
262,000（≈228K 触发），其他模型不设。常量与谓词的唯一来源是
`@zcode/shared` `compact-context-window.ts`（`attach/attach-compact-cap.ts`
re-export 兼容旧导入路径）——wire 下发与 tui-pi 页脚分母收紧同源，不会漂移。
`AttachSessionHandle.syncCompactContextWindow()` 在
会话绑定（启动 create/resume、`/new` `/resume` `/fork`）、`setModel` 成功后、以及
`recoverSession` 的 resume 里下发——cap 跟随**当前**模型，切到非 GLM 会以 `null` 清除。
core 侧契约与理由见 [compact/plan.md M2.1](./compact/plan.md)。2026-11-02 修订：
原「此上限不改页脚 ctx 分母」不再成立——页脚/信息面板的 ctx 分母现在按同一
谓词客户端侧收紧（见 [tui-pi-frontend.md](./tui-pi-frontend.md) 的 ctx 仪表条目）；
协议与 core 侧窗口语义仍不动。

### 模型状态同步（mutation 快照 / state.updated）

legacy `session/setModel`/`setThoughtLevel`/`setMode` 与订阅事件不同源：

- mutation 回包是 `afterStateMutation` 返回的**快照本体**（无
  `{snapshot}` 包装），且其 `available` 列表按 `modelAvailability:
  "current"` 过滤成仅当前模型——它是回显投影，不是 provider
  catalog 事实。客户端合并时（`mergeSettings`）：直返形状要认，
  过滤形状（available 长度 1 且旧 catalog >1）保留旧 catalog，
  只取 current；否则 Ctrl+P 依次退化为 "Model is not available" →
  "Only one model available"。
- mutation 后 core 只发 `state.updated` settings patch 通知、不发
  raw `ModelSelected` 事件；attach 客户端合并 patch 后向 sinks 补发
  合成 `model_selected`（current 变化时），其他 pane 的状态行才能
  跟上远端切模。

### 模式投影（settings.mode.current）

`settings.mode.current` 是协作模式投影：runtime 的 plan 是叠加在
permission mode 上的独立开关（`planEnabled`），不是 mode 枚举值，core 按
`planEnabled ? "plan" : mode` 下发；`settings.permission.mode` 保留真实
permission mode，二者在 plan 会话中刻意不同。attach 的 `initialMode`、
`loadStartupOptions`、`getMode()`、回合 `result.mode` 与 `setMode` 回显
都读 `settings.mode.current`——状态行因此在 plan 会话显示 `mode:plan`
而不是底层 permission mode（如 yolo）。

### core 自登记（.pid/.info 所有权）

`.pid/.info` 由 **bind 成功的 server 进程**在 listen 后自写
（`zcode-protocol-entrypoint`）。客户端侧 `ensureServer` 只负责
锁/spawn/等就绪，不写登记：双 spawn 竞争下客户端写入会把先退出的
进程登记成 owner（实测 `.pid` 指向死进程、真 listener 无登记），
`probeSocket` 只能证明"有人在听"，证明不了"我的 child 在听"。
失败路径同样不清理登记文件——所有权在 server，客户端删别人的
登记才是破坏。

### resume 目标的"最近"定义

`-c` 选"最近会话"时，`session/list` 返回顺序不保证（实测含任意序/创建序混排），
"最近会话"必须按 `updatedAt`（退化 `createdAt`）显式取最大，
`sessions.at(-1)` 会恢复到陈旧会话。

### Ctrl-C：字节路径与信号路径同义

Ctrl-C 有两条投递路径，二者必须共享同一条 guard（`PiTuiApp.handleCtrlCIntent`）：

- **字节路径**：raw 模式下的 `0x03` 字节（普通终端）。
- **信号路径**：SIGINT（多路复用器如 herdr pane 把 Ctrl-C 递送为信号）。

缺 SIGINT handler 时 Node 的默认行为是直接终止进程（exit 130），
多路复用器环境下就会"首按即死"，与字节路径的"再按一次退出"不一致。
因此 `run-tui` 装 SIGINT handler 转发到同一 intent；退出时摘掉 handler
（signal handler 是 ref 句柄，不摘会让进程在 TUI 退出后挂着不退）。

### 客户端退出：detach / adopt / 回收

协议 server 是**按连接**建的（每条 socket 一个 `ZCodeProtocolAgentServer`
与一份 `sessions` 表），所以"客户端退出"拆成两档语义：

- **传输断开 = detach**（`markClientDetached`）：连接移出 attached、进入
  `detachedConnections` 池；server、sessions、在跑 turn、pending 反向
  请求全部保留，只取消只回本连接的请求级工作（generateText/plugin op）。
- **进程终止 = shutdown**（`disconnectClient` + `runtimeResources.close`）：
  拒绝全部反向请求、取消前台执行。SIGTERM/进程退出仍走这条，语义不变。

**收养（adopt）**：新连接的 server 没有旧 session 时，`session/resume`
与 `requireSession` 先经 `locateSessionOwner` 找持有该 record 的 detached
owner，命中则原子转出（`claimSessionRecord`：摘出 sessions 表 → 登记
`sessionOwnerRedirects` → 迁移该 session 的 pending 反向请求 → app 资源
登记过户）而非冷物化第二个 runtime。事件扇出走 `record.ownerContext`
间接层，收养后改挂新 context；旧 owner 上迟到的反向请求沿 redirect 落到
新 sink。旧 owner resident pool 有 in-flight 去激活时，异步路径先
`awaitSessionDeactivation`，同步路径直接放弃收养走冷恢复。

**孤儿交互的有界等待**：pending 反向请求在 owner detached 后按
`detachedTimeoutMs`（默认 `DETACHED_CLIENT_REQUEST_TIMEOUT_MS` = 10min）
兜底，超时按 `timedOut`（-32022）拒绝——孤儿会话上的审批/提问最终如实
失败，不会永久挂住一个 turn。sink 恢复（`setNotificationSink`）时 park 的
请求自动续投并撤除计时器。

**收养窗口与回收**：detached session 的收养窗口是
`detachedAdoptWindowMs`（默认 `DETACHED_SESSION_ADOPT_WINDOW_MS` = 10min，
与孤儿请求同一本账期）——窗口内常驻 idle session 不可回收
（`isReapable` 还要求：detached、无 pending/parked 反向请求、无 session
busy 事实——前台执行 / background task / finalization / model-only turn，
与 resident pool 同一判据）；窗口外 idle session 才可随 owner shutdown。
空壳（从未建 session 或 sessions 已被收养迁空）不受窗口保护，下一趟
30s sweep 即落地。busy session 永远不可 reap，turn 跑完前 owner 存活。

**core 排空退出**：同一趟 30s sweep 在回收后检查 `attachedConnections`
与 `detachedConnections` 全空（且没有 accepted-未登记的建链在途）→
`lifecycle.requestShutdown()` 走正常关闭路径，core 进程退出——否则
socket core 只剩空壳监听却常驻成僵尸（每 workspace 一个）。下一个
attach 客户端 `ensureServer` 探测到死 socket 后走原子 reclaim 重拉新
core，用户无感。detached session 仍在收养窗口内时池非空，core 照常活。

**退出 UX（busy 三选一）**：turn 在跑（含等交互）时，退出必须显式选边——

| 按键（busy、草稿为空时第一下） | 行为 |
| ------------------------------ | ---- |
| Ctrl-D | detach & quit：只关客户端，agent 在 core 继续跑 |
| Ctrl-C | stop & quit：`requestStopActiveTurn` → `session/stop` 有界回执（1.5s）后退出 |
| Esc / 其他键 | 取消，回到 turn |

空闲时 Ctrl-C 双击 / Ctrl-D 退出语义不变。armed 窗口
`BUSY_QUIT_CHOICE_WINDOW_MS` = 4s；三选一逻辑收敛在 tui-pi 的
`BusyQuitChoice`（`quit-choice.ts`）：armed 键与 busy 退出键在面板/补全
的键盘所有权之前处理（等审批时 Ctrl-C/Ctrl-D 不死键），SIGINT 路径与
字节路径共用同一 armed 状态，双击 Ctrl-C 停 agent 的旧肌肉记忆保留。
客户端侧 `AttachSessionHandle.stopActiveTurn` 把 `sessionStop`
做成有 ack 的有界等待——socket 先关会让 fire-and-forget 的 stop 落不了线。
opentui 前端无三选一 UI：busy 退出统一先 `session/stop` 再退，保持
旧"退出即终止"语义而不是静默 detach。

### 退出续接提示（exit resume hint，2026-11-02）

客户端正常退出（TUI 拆屏、`runTui` 返回 0）后，attach 客户端在 stdout 打
两行恢复指引，让会话 id 不必事后翻 session/list：

```
Resume this session with:
piz --resume sess_…
```

- **命令名跟随入口**：zcode-attach（piz wrapper）入口打
  `piz --resume <id>`（判据：`attachHerdrAgent === "piz"`，与进程/产品名同源）；
  monolith 入口（`zcode attach`，argv 重写透传全局旗标）打
  `zcode attach --resume <id>`。两条命令都真实可解析、可恢复。
- **会话 id 取当前绑定**：`promptHandler.getMainSessionId()` 跟随
  /new /resume /fork 换绑后的当前会话，不用启动 snapshot 的陈旧 id。
- **打印门槛**：`runTui` 返回 0 且存在绑定会话 id。`runTui` 非 0 返回
  （non-TTY 拒绝）与启动期失败（版本不匹配等 throw，exit 2）都没有
  "这个会话"可续接；SIGTERM/SIGHUP 走 reap-then-reraise，进程直接
  终止，到不了打印点。空会话（开了就退）也打印——提示恒定可预测，
  刻意不做"有无输入"的内容判断。
- **时序**：写在 `runAttachCommand` 的 `await runTui` 之后、
  `finally { runtime.close() }` 之前。此时 pi-tui 已 `app.stop()` 恢复
  终端，stdout 回到主屏缓冲，提示不会被备用屏吞掉；协议走 socket，
  与此 stdout 无涉。
- **范围**：仅 attach 通道（runAttachCommand）。monolith 独立
  `zcode tui`（opentui 前端）不在 piz 产品线，不加。opentui 前端经
  `--tui-frontend opentui --shared-core` 走同一通道：终端恢复点在
  `renderer.destroy()`（DESTROY 路径），提示同样打印，但命令名恒为
  `zcode attach`——该命令 argv 重写固定落回 pi 前端（同会话 id、换
  UI）。monolith-only 开发通道，接受此偏差（2026-11-02 评审记录）。
- 回归：`tests/attach-exit-resume-hint.test.ts`（假 core + 假 runTui：
  piz/monolith 命令名、非 0 退出不打提示、/new 换绑后提示跟随新 id）。

### 审批与提问反向请求（interaction/*）

in-process 模式下 core 的 permission broker 直接调用 TUI requester；attach
模式下 broker 在服务端，反向请求经 socket 到达客户端
（`interaction/requestPermission` 与 `interaction/requestUserInput`）。
attach 客户端必须实现这条回路，否则审批/提问工具整体不可用（2026-10-23
实测：AskUserQuestion 在 attach 下报 "Permission request failed"，且
PermissionBrokerResult 原样回传被服务端 strict schema 拒绝）。

分层：`attach-interactions.ts` 是纯翻译层（线上 params ↔
PermissionBrokerRequest/Result），`PendingInteractions` 持有同业务
requestId 的去重与 abort 生命周期，`AttachRuntime.routeReverseRequest`
做 zod 校验与路由，`AttachSessionHandle.serveInteraction` 只把当前回合
abortSignal 传下去。

- **requestPermission → 审批面板**：wire `options[]` 每项自带权威
  `response` 原文；应答回 option.response，不从 broker 结果重新组装
  （allow_project 项内含服务端算好的 permissionUpdates，客户端重猜会
  失真；`resolvedAt` 等内部字段原样回传会被 strict schema 拒掉）。
  options 全落 allow_once/deny 时还原 `approvalMode:"user-once"`。
- **requestUserInput → 两条渲染路径**：`toolName=AskUserQuestion` 走
  question wizard（TUI requester 用 AskUserQuestionInputSchema 校验
  input）；ExitPlanMode/`interaction:"plan_approval"` 只有一个
  "Approve" 选项、不满足 min(2)，走普通审批面板（allow=approve）。
  wizard 的 modify 结果只回 `content.answers/annotations`——服务端
  normalize 只取这两键，多带不会泄漏但也不该带。MCP elicitation 等
  未知 kind 如实 decline，不冒充用户输入。plan 正文不进审批 params，
  走 `ToolCallScheduled` 的 `input.plan` → transcript 行内 markdown
  （`ToolTranscriptPart.markdown`，live 与 resume 回放共用同一投影）；
  审批面板只回显 plan 开头做上下文，决定项为 Approve plan / Reject。

- **去重**：服务端恢复链路在等待应答期间按同一业务 requestId 周期
  reannounce；`PendingInteractions.serve` 复用首个 promise，重发不
  重开面板。首个应答送达后短留 2s grace，迟到的重发拿同一份应答。
- **撤下**：`permission_resolved`（服务端先 settle：自动应答/另一
  客户端/v4 竞速）、turn end、本地回合 abortSignal 三路都触发
  controller.abort()，TUI requester 据此出队面板。serve 内部把
  invoke 与 abort 做 race——即使请求方注册监听晚于 abort 或根本不
  理会 signal，服务端也总能拿到 error 应答，不会挂到超时。
- **无 handler**：当前无在途回合（无 requester）时回显式
  deny/decline，绝不伪造用户批准。
- 渲染后即可被 herdr 的 piz manifest 识别为 blocked/needs-attention，
  无需 herdr 侧改动。
## Herdr 生命周期上报（客户端侧 reporter + core env 标记）

### 问题

`zcode-attach`（piz 启动器）在 herdr pane 里曾被识别成 `zcode`：
`process.title = "zcode-attach"` 不在 herdr 的进程名表里，唯一的身份来
源是 `~/.zcode/herdr-hook.sh` 钩子（`--agent zcode`）。该钩子在共享
core 进程内触发，env 是 core spawn 时烘焙的——`HERDR_PANE_ID` 永远是
拉起 core 的那个 pane，第二个及以后 attach 的客户端全部错报；core 被
复用时连第一个 pane 都可能 stale。结果：状态错 pane、错 agent、
resume 命令指向 `zcode --resume`。

### 设计

两层防御，互不依赖：

1. **客户端 reporter**（`attach/herdr-reporter.ts`）：状态所有权在
   客户端。仅当三个 env 同时存在才激活：`HERDR_ENV=1`、
   `HERDR_PANE_ID`、herdr CLI 路径 `HERDR_BIN_PATH`。经
   `herdr pane report-agent <pane> --source piz --agent piz …` 上报：

   | 会话事件                | herdr 状态 |
   | ----------------------- | ---------- |
   | 绑定（新/恢复会话句柄） | idle       |
   | `turn_started`          | working    |
   | `permission_requested`  | blocked（`--message "permission: <toolName>"`） |
   | `permission_resolved`/`permission_denied` | 回到该会话绑定态（有未结回合则 working，否则 idle） |
   | `turn_complete`/`turn_error` | idle    |

   每次上报（含绑定后的 idle）都重带 `--agent-session-id <sid>` 与
   resume argv `piz --resume <sid>`：herdr 对不带 session_ref 的 state
   上报会清掉 pane 的会话归属（与官方 pi 集成同约定）。

   绑定经 `AttachRuntime.onSessionBound`（`registerSession` 单点触发，
   覆盖初始 attach、`/new`、`/resume`、`/fork`、断线重连换句柄）；
   事件经 `AttachSessionHandle.addSink` 常驻 sink。reporter 只认当前
   绑定句柄的事件——旧句柄（已 detach 会话）的迟到事件不影响 pane。
   只对 `zcode-attach` 专用入口（attach-main）启用；monolith
   `zcode attach`/`tui --shared-core` 不启用（进程是 `zcode`，
   herdr 侧仍按 ZCode 处理）。

2. **core env 标记**：`ensureServer` spawn core 时写
   `ZCODE_ATTACH_CORE=1`。语义：「这个 core 为 attach 客户端服务，
   env 烘焙的 pane 归属无效」。`~/.zcode/herdr-hook.sh` 见到该标记
   直接 no-op，从根上停掉共享 core 的 zcode 误报。

   - 优先级/生效面：标记由客户端在 spawn 时无条件写入，不是用户配
     置；in-process core（desktop/monolith tui）不经 ensureServer，
     不受影响；zcode attach（monolith）客户端同样受益——共享 core
     的钩子对任何非首个 pane 都是错的。
   - 失败行为：标记缺失（旧 core 仍在跑）时钩子照旧误报，但 herdr
     侧 `zcode-attach`→`piz` 的进程识别会让 `--agent zcode` 的钩子
     上报与该 pane 的检测 agent 冲突被拒；客户端 reporter 的真实
     `--agent piz` 上报仍然生效。
   - 复用 core：已存在的 core 保留 spawn 时的 env（含旧 HERDR_*
     或无标记），客户端不补写；行为由 herdr 侧冲突拒绝兜底。

   上报本身 best-effort，但必须收敛：herdr 把自定义 source（`piz`）
   当永不过期的状态权威，丢一条 `working` 会让整个回合错报
   idle/done（2026-10-24 实测：队列续接回合的 TurnStarted 上报丢失，
   herdr 错报 idle 约 9 分钟直到下一回合边界）。`execFile` 参数数组
   （不经 shell）、2s 超时、stdio 全丢、不污染协议 stdout。可靠性
   三件套：

   - **同步首发 + 有界重试**：每条上报首次尝试同步发出（保持
     bind/事件即发的契约），失败后按 250ms/1500ms 退避最多 3 次尝
     试。重试晚到无碍乱序：`--seq` 在入队时分配（进程内单调递增，
     epoch-ms × 1000 + 计数器，重启/重绑不回退），herdr 对同
     source 非递增 seq 直接丢弃（`hook_report_is_newer`），旧状态
     不会覆盖新状态，无需客户端跨上报排队。
   - **心跳重申**：30s（unref）定时器重发最近一次状态——任意一条
     上报彻底丢失（重试全败/服务端丢弃）后，陈旧状态最多存活到下
     一跳；未绑定会话前不心跳（无 session ref 的上报会清 pane 会话
     归属）。
   - **常开诊断**：重试耗尽才回调 onError（每条失败上报一次，不再
     逐尝试报）；attach 入口无条件接线，stderr 输出按 ≥60s 节流
     （TUI 下偶发一行可接受，不再仅 `--verbose`）。

### 验收

- herdr pane 中 `zcode-attach` 进程识别为 `piz`（herdr
  `Agent::Piz`，别名 `piz`/`zcode-attach`/`zcode-attach.cjs`）。
- `herdr agent get <pane>`：agent `piz`、状态随
  idle/working/blocked 转换、`--agent-session-id` 为当前会话、
  resume argv 为 `piz --resume <sid>`。
- 共享 core 的 `zcode-hooks` 上报不再认领 piz pane。
- `ZCODE_ATTACH_CORE` 单测：env 注入进入 childEnv；hook 标记抑制
  由脚本侧 `[ -n "${ZCODE_ATTACH_CORE:-}" ] && exit 0` 承担，
  不进仓库代码路径。
- 上报单测：env gate、事件→状态映射、绑定 resume argv、seq 单调、
  进程调用参数数组（含 `--agent-session-id`、尾部 `--` 分隔）。
- 上报可靠性单测：单条失败重试后成功且重试复用同一 argv/seq、重试
  耗尽只回调一次 onError、心跳仅在绑定后重申最近状态。

### 输入提交迁移到 v4 `v4/command`（2026-11-01 实现）

背景：`session/send` 在共享协议里已标 `@deprecated（部分）`，Electron 主路径是
v4 `sendText`。上游若删除 `session/send`，瘦客户端的输入提交会整体失效，故迁移。
实现落点：`attach-v4-command.ts`（信封/ACK）、`attach-v4-attachments.ts`（寄存
事务）、`attach-v4-input.ts`（TUI 附件形状 → AttachmentRef）、`attach-session.ts`
（submitPrompt/abort）、`attach-steer.ts`（steer lane）、`attach-session-stop.ts`
（stop）。旧 `attach-attachments.ts` 内联映射随迁移删除。

**迁移范围（同一单元，必须一起动）**

| 动作 | 旧 | 新 |
|---|---|---|
| 空闲提交 | `session/send` | `v4/command` `sendText`（**不带** `requestedDelivery`） |
| Enter 忙时 steer | `session/send delivery:"steer"` | `sendText requestedDelivery:"guide"` |
| Ctrl-C / 退出 stop | `session/stop` | `v4/command` `stop`（fire-and-forget 与 stop&quit 有界回执同源） |
| 附件 | `attachments[]` 内联 | `v4/attachment/begin→chunk→commit` 得 `AttachmentRef`；磁盘路径文件直接用路径 ref，无需上传 |

**为什么 stop 必须同迁**：v4 起的 turn 不登记旧的 `record.activeAbortController`，
`session/stop` 只 abort 那个 controller，对 v4 起的 turn 是空操作。v4 `stop`
经 runtime 前台执行收口（`stopActiveForegroundExecution`），新旧路径起的 turn
都能停；对 idle 会话是 no-op ACK。

**不变量（实现口径）**

- `commandId` = 客户端生成的 UUID（`attach-cmd-<uuid>`，`newCommandId`）。core 的
  CommandInbox 以 `(sessionId, commandId)` 持久去重，旧的进程内计数器
  `attach-input-N` 跨进程会撞，撞上即 `duplicate` 而不执行。
- 空闲提交不带 `requestedDelivery`。`forceStartNow`（抢占）只由显式
  `requestedDelivery:"startNow"` 触发；缺省值在 core 侧即使忙时竞态也走 admission
  自动排队，不会抢占共享 core 上别的 client 的 turn。
- 一律携带 `heldQueueDisposition:"keepQueueAndSend"`：仅当队列处于 held/choice 时生效
  （例如 stop 后遗留 guide 项），非破坏性，避免 Ctrl-C 后下一条被
  `heldQueueDispositionRequired` 拒绝。
- ACK 只证明 admission，不证明 turn 开始。turn 等待器在发送前登记，按 `inputId`
  （= `commandId`）关联 raw 事件 `turn_started`；admission 转排队（ACK
  `result.delivery:"queue"`）时 turn 稍后由 core 起，等待器不变。
- 所有 turn 等待器创建后立即挂 rejection handler，上传/命令 ACK 尚未完成时的
  abort 或 turn_error 不得触发进程级 unhandledRejection。abort listener 在提交结束
  的 finally 摘除；已取消信号在上传前、逐片/commit 前与 sendText 前检查，未提交
  命令时只清理上传、不向共享 core 发无目标 stop。已发命令则走现有 v4 stop。
- steer 的 `pendingInputId` = `queue_<commandId>`（`queueItemIdForCommand`，core 以
  `intent.queueItemId` 作队列项 id），客户端无需等回执即可确定；TUI 队列行幂等
  upsert 的键与 core 真实 `TurnSteerQueued` 事件对齐。`queueLength` 客户端只能报 1
  （ACK 不带计数），状态行首帧文案由事件投影修正——刻意为之，不伪造 core 计数。
- ACK 状态 `accepted`/`duplicate` 视为成功；`rejected`/`stale`/`failed`/`noop` 抛
  带 `reasonCode` 的 `AttachV4CommandError`，不静默吞掉。信封与回执、上传事务的
  begin/chunk/commit 回执都按 `@zcode/shared/zcode-protocol-v4` 的共享 zod schema
  校验，客户端不私有定义线上形状。
- steer lane 的回退条件从旧 `guard.steerRejected.*` 前缀改为**整个 ACK 失败族**：
  v4 guide 在 admission 被拒（无 active turn 竞态、held 门、payload 门等）都回退
  本地 follow-up 队列，输入永不丢失；传输/schema 错误照旧如实上抛让上层恢复草稿。
  与旧路径的语义差：v4 guide 落在 idle（settle 竞态窗口）时 core 会**立即开新
  回合**（不再等 settle 后客户端重放）。steer 发送前同样登记 turn 等待器：
  ACK `inputAccepted.delivery:"startNow"` 时保留等待器、返回 `started_turn`，
  由 TUI 的 started_turn 正常提交分支补一条 user 行（不先造 queued 行）；queue/guide
  ACK 时撤下本次临时等待器，只由 core 的真实 queued/drained/discarded 事件持有
  队列投影。不能仅凭 accepted 推断 queued，也不能把已启动的输入重放一遍。
- 签名仍在 core 的 provider 请求路径，客户端不参与；本迁移不触碰。
- **旧 `session/create` 会话的首发持久化（core 侧，2026-11-02 live e2e 发现）**：
  attach 仍用旧 `session/create` 建会话，协议 record 缺省 `persistence:"immediate"`，
  但 runtime 要到首条输入才落 `session` 行（旧 `session/send` 经 runtime prompt
  隐式落行，故从未暴露）。v4 输入 admission 原先只在 record 为 `"deferred"` 时
  先走 `ensureSessionPersistedForExternalActivity`，于是对这类会话直接写
  `session_input` ledger，撞 `session(id)` 外键，**每一次**提交都以
  `FOREIGN KEY constraint failed` 失败（fake-core 适配器测试无法发现）。
  裁决：admission 以 runtime 的落行事实为准——record 为 `"deferred"` **或**
  `runtime.isSessionPersisted()` 明确为 `false` 时，先经 runtime 统一首发持久化边界
  落行再写 ledger，并把 record 镜像推进为 `"immediate"`。唯一写者仍是 runtime；
  不改旧 `session/create` 的缺省值（会改变旧 TUI/headless 的 draft 可见性与
  关闭语义）。`isSessionPersisted` 缺席（测试桩）不触发，与
  `reconcileRecordPersistence` 同口径。回归：
  `bootstrap/tests/v4-legacy-create-admission.test.ts`（真实 sqlite store）。

**附件映射（`attach-v4-input.ts`）**

- `@file` 提及（`{type:"file", path}`）：磁盘路径直传
  `{ref:<path>, mime:"application/octet-stream"}`——core 按普通 file 路径附件读取，
  与旧 `localPath` 分支同语义，零上传、零拷贝。
- 剪贴板图片 / PDF（data URL）：解码后经 begin/chunk/commit 寄存为 artifact URI
  ref，mime 取 data URL 头；core 在模型请求阶段读回（与 monolith 外置产物同形）。
- 内联文本（`{type:"file", content}`）：寄存为 `text/plain` URI ref；core 侧
  ≤64KiB 保留正文，超限只留展示元信息（v4 命令面语义，旧内联 textContent 无此
  65KiB 截断——pi 前端的 file 附件只产自 `@` 提及，实际不受影响）。
- `url` 形状维持丢弃（与旧协议一致）。单个附件不合法（如图形缺 data URL）丢弃
  该项、其余照发；寄存任一步失败 → abort 暂存并让本次提交如实失败（不出现
  "看似提交成功、模型没收到附件"）。
- 每次上传使用新 uploadId，当前不重试 begin；不能把不可能发生的 committed 回执
  分支当成重试保障。上传失败/取消时尽力 abort 暂存；cleanup 失败走 stderr 诊断，
  不替换最初的上传错误。
- 上限/校验常量取共享 `PROTOCOL_V4_LIMITS`（20MiB / 512KiB·片 / 64 片）。

**客户端队列归属不变**：Ctrl+Q follow-up 仍是客户端本地 FIFO，settle 后逐条以普通
`sendText` 重放；core 只拥有 steer(guide) 的 pendingInputs 与 admission 排队项。
未引入第二个 queue owner。

**兼容边界**：只支持同源码构建、配套安装的 client/core，不为旧 core 回退到
`session/send`。v4 stop 可暂停 core guide 队列；`keepQueueAndSend` 保留它但不会恢复
autoDrain。attach 目前只提供 Alt+Up 撤回这些项，没有恢复暂停 core 队列的 UI；
不得把下一次输入成功解释为队列已恢复，也不得自动开启其他 client 暂停的队列。

**仍留在旧协议（迁移后剩余依赖）**：`session/create|resume|list|subscribe|messages|events`、
`session/setModel|setMode|setThoughtLevel`、`session/goal`、`session/fork`、
`session/cancelBackgroundTask`、`session/discardPendingInputs`（v4 `deleteQueueItem`
需要 `baseRevision`，只有 v4 订阅能提供）、`usage/*`、`skills/*`、`commands/*`、
raw 事件流 `session/rawEvent`。上游删除这些中的任何一个都会再次破坏 piz。
`session/send` 与 `session/stop` 已不在 piz 客户端的调用面里——上游带走的
"adapter 附件回退分支"就是本迁移前的旧代码。
