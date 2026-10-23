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

## 交互语义收口（busy 队列 / 断线重连 / 会话选择）

### busy 输入本地队列

core 的 `session/send` 同一时间只接纳一个 prompt（并发时拒绝
"A prompt is already running"）。与本地 CommandInbox 同语义的排队
放在 **attach 客户端**（`AttachSessionHandle.sendInput`）：

- `pendingTurns` 非空（有回合在跑）时，`sendInput` 把输入停进
  本地 FIFO 队列，返回 `{kind:"queued", pendingInputId, queueLength,
  turnId}`，并同步向 sinks 发本地合成 `turn_steer_queued` 事件，
  让 TUI 队列区立即可见。
- `expectedTurnId` 与当前活跃回合不一致时返回
  `{kind:"rejected", reason:"expected_turn_mismatch"}`。
- 回合 settle（`turn_complete`/`turn_error`）后 microtask 触发
  `flushQueuedInputs`：先合成 `turn_steer_drained`（UI 摘除队列行），
  再把该输入作为新回合 `session/send`；user 行由 core 正常的
  `user_message`/`turn_started` 下发，不伪造 transcript。
  一次只放一条——新回合重新占住 `pendingTurns`，余下条目等
  下一轮 settle 接力；flush 失败合成 `session_notice` 错误行并
  继续后续条目。

### slash 命令路由

`sendInput` 与 `submitPrompt` 一样先经 `commandCenter` 的 slash 路由。
`/model`、`/effort`（Ctrl+P 轮换、Ctrl+L 选择器、忙时输入）在
`sendInput` 内特判，走 `commandCenter` → `sessionSetModel` /
`sessionSetThoughtLevel`，返回 `{kind:"command_result"}`；
不会作为普通 prompt 发给模型。

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
| `--resume <id>`     | `session/resume` 指定会话                          |

之前无条件 resume 最近会话，piz 永远进旧对话、无法开新会话——
与主 CLI（默认新会话、`-c` 才继续）相反。

resume 成功时 `restoredMessages` 作为 `initialResult` 交给
`runTui` 首帧渲染历史 transcript；list 为空或 resume 失败时退回
`session/create`。同一 workspace 多个 pane 在 `-c` 下 attach 到
同一会话，事件经 core fan-out 同步。

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
   | 绑定（新/恢复会话句柄） | idle + `--agent-session-id <sid>` + resume argv `piz --resume <sid>` |
   | `turn_started`          | working    |
   | `permission_requested`  | blocked（`--message "permission: <toolName>"`） |
   | `permission_resolved`/`permission_denied` | 回到该会话绑定态（有未结回合则 working，否则 idle） |
   | `turn_complete`/`turn_error` | idle    |

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

   上报本身 best-effort：`execFile` 参数数组（不经 shell）、2s 超
   时、stdio 全丢、失败静默（不污染协议 stdout；`--verbose` 时写
   stderr）。`--seq` 用进程内单调递增（epoch-ms × 1000 + 计数器），
   重启/重绑不会回退。

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
