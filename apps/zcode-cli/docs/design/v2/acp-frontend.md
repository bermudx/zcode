# ACP 前端（`piz acp` / `zcode-attach acp`）

## 目的

让 Zed、T3 Code 这类 ACP（Agent Client Protocol）客户端直接驱动 **共享 core**，
而不必经过 pi-tui，也不必为每个编辑器会话再起一份重型 runtime。

```text
editor / T3 Code                      每 workspace 一个
┌──────────────────┐   stdio        ┌──────────────────────────────┐
│ ACP client       │  JSON-RPC 2.0  │ zcode-attach acp             │
│ (T3 / Zed)       │ ◀────────────▶ │ (ACP 前端：协议映射，无 runtime)│
└──────────────────┘                └──────────────┬───────────────┘
                                                   │ unix socket
                                                   │ ZCode Protocol
                                    ┌──────────────▼───────────────┐
                                    │ zcode app-server --socket    │
                                    │ (core+runtime+store，无插件)   │
                                    └──────────────────────────────┘
```

非目标：T3 侧改动；core 协议改动；ACP v2（preview）；`fs/*`、`terminal/*`
（core 自己跑工具，前端不代理文件与终端）；ACP 侧登录（沿用 `piz login`）。

## 目标面（稳定 ACP v1）

| 区域 | v1 行为 |
|---|---|
| 会话 | `session/new`、`session/resume`、`session/close`（真停止）；**不**声明 `session/load`，不重放历史 |
| 回合 | `session/prompt`、`session/cancel`（notification）、`session/update` |
| workspace | 每个 `cwd` 一个惰性 core 客户端；`cwd` 是 per-session 事实 |
| 权限 | `session/request_permission`，应答回 core 的 `option.response` 原文 |
| `AskUserQuestion` | `elicitation/create` form + string `enum`；多选退化为自由文本 |
| `ExitPlanMode` | approve/reject elicitation，Auto/Full access 不能静默批准计划 |
| 模式与模型 | `plan`/`build` 模式、模型 `configOptions`、GLM 压缩上限 |
| 断线 | 与 attach 相同：只 detach，core session 照常存活 |
| T3 的 MCP | 接收但忽略并记日志（不声明 `mcpCapabilities`） |
| 鉴权 | ACP 之外处理（`piz login`），不声明 `authMethods` |

## 归属（ownership）

- **stdio 归 ACP 进程**：stdout 只写 JSON-RPC 帧，任何诊断走 stderr。这与
  `zcode app-server` 的 stdout 独占约束同源。
- **会话事实归 core**：ACP `sessionId` **就是** core session id。resume 因此
  天然可重连：编辑器重启后拿同一个 id 调 `session/resume`，core 侧仍是同一
  会话（含消息、模型、模式）。
- **前端只做协议映射**：不复制 transcript 投影、权限状态机、模型目录。
  复用 `AttachSessionHandle`（`attach-session.ts`）这一层，它与 pi-tui 前端
  共用同一套 attach 映射；ACP 前端只把 `SessionEvent` 投影成 ACP
  `session/update`。
- **per-workspace 惰性客户端**：`ensureServer()` + `connectAttachClient()`
  按 `cwd` 复用；同进程多会话共享一个 socket 连接（core 协议本身支持多
  会话、多连接）。这不是"全局单一 core"：不同 `cwd` 仍是不同 socket。

## 事件顺序

```text
client                          acp 前端                       core
  │ session/prompt {sessionId,prompt[]}                        │
  ├──────────────────────────────▶│                            │
  │                               │ handle.submitPrompt()      │
  │                               ├───────────────────────────▶│ sendText(v4)
  │                               │                            │ turn.started
  │                               │◀───────────────────────────┤
  │  session/update agent_thought_chunk ◀─ model_streaming(reasoning_delta)
  │  session/update tool_call     ◀─ tool_call_scheduled
  │  session/request_permission   ◀─ interaction/requestPermission  (反向请求)
  │──────────────────────────────▶│                            │
  │    {outcome:"selected",optionId} → core option.response 原文 │
  │  session/update tool_call_update(status=completed) ◀─ tool_call_result
  │  session/update agent_message_chunk ◀─ model_streaming(text_delta)
  │                               │                            │ turn.complete
  │◀──────────────────────────────┤                            │
  │  {stopReason:"end_turn",usage?}                             │
  │                               │                            │
  │ session/cancel                │                            │
  ├──────────────────────────────▶│ turnAbort.abort()          │
  │                               ├───────────────────────────▶│ v4 stop
  │◀── {stopReason:"cancelled"} ──┤                            │
```

顺序不变量：

1. `session/prompt` 的 response **只在** core 回合 settle（`turn.complete` /
   `turn_error` / abort）之后返回；期间的 `session/update` 全部先于 response。
2. 同一 `toolCallId` 的 `tool_call` 先于任何 `tool_call_update`。
3. `session/request_permission` 与 `session/cancel` 并发：cancel 后必须回
   `{outcome:"cancelled"}`，不能让 core 等一个不会来的应答。
4. `session/close` 到达时若回合仍在跑：先按 cancel 语义收口（stopReason
   `cancelled`），再释放会话。

## 与 attach / pi-tui 的差异

| 关注点 | pi-tui attach | ACP |
|---|---|---|
| 事件消费 | 复用 `@zcode/tui` reducer，渲染 transcript | 只投影成 `session/update` |
| 输入 | composer、本地队列、steer | 无队列：一次一个 prompt；v1 无 steer |
| 权限 UI | 审批面板 / question wizard | `session/request_permission` / `elicitation/create` |
| 断线 | 指数退避重连 + 横幅 | 无重连：socket 断即让 in-flight 请求失败（客户端的会话事实在 core，重连靠 `session/resume`） |
| 生命周期 | TUI 退出即 detach | stdin EOF 即 detach；不 `session/close` |

## 权限映射

core 的 `interaction/requestPermission` 已把每个选项的权威应答
（`option.response`，含 deny reason 与 project `permissionUpdates`）算好。
ACP 侧只做 id 映射，**不重新组装**应答：

| core option.kind | ACP `PermissionOption.kind` |
|---|---|
| `allow_once` | `allow_once` |
| `allow_always` | `allow_always` |
| `deny` | `reject_once` |

`optionId` 由 core 选项下标生成（`opt-0`…），ACP `outcome.optionId` 再映射回
同一项，直接回 `option.response`。client 回 `cancelled` → 回 core 的 `deny`
选项原文（如实拒绝，不伪造用户批准）。

## 问题与计划（elicitation）

`interaction/requestUserInput` 分两类，都不走 `requestPermission`：

- **`AskUserQuestion`**：每题一个 form property。
  - `title` = question.header（T3 把它当 header 渲染）
  - `description` = question.question（T3 把它当问题正文）
  - 单 selected：`type:"string"` + `enum` = 选项 label（T3 把 enum 渲染成选项列表）
  - `multiSelect:true`：**不给 enum**，只给 `type:"string"`，正文追加"多选，
    用逗号分隔"。v1 的 form schema 只允许扁平原始类型与 enum，没有数组；
    硬套 enum 会让多选变成一个只能单选的问题，那是丢信息，不是降级。
  - 应答：`content[<属性名>]` 按题目顺序映射回 core 的
    `answers[<question 原文>]`（core 以问题原文为 key）；多选按 TUI 同款
    `", "` 拼接。
- **`ExitPlanMode`**：一个 `decision` 属性，`enum: ["approve","reject"]`。
  只有 `approve` 才回 core 的 `{action:"accept", content:{answer:"approve"}}`；
  `reject`/`cancel` 一律 decline。计划批准不能因为编辑器处于 Auto/Full access
  就被静默接受——把批准做成显式 elicitation 才能保住这条边界。

无法渲染的 kind（MCP elicitation、未知 schema）→ 如实 `decline`，不冒充用户输入。

## 模式、模型与压缩上限

- 模式：`session/new`、`session/resume` 回 `modes`，`availableModes` 至少
  `plan` + `build`（core 侧另有 edit/yolo/guarded/auto，不暴露给编辑器：
  这些是 core 的权限档，不是编辑器能安全表达的交互模式）。T3 用
  `id === "plan"` 识别计划模式。
- 模型：回 `configOptions`（`type:"select"`、`id:"model"`、`category:"model"`），
  选项来自 core 的 `settings.model.available`。同时支持
  `session/set_model`（老客户端）与 `session/set_config_option`（v1 现行）。
- 思考档位：`configOptions` 里的 `thoughtLevel` select（core 有档位时才出现）。
- GLM 压缩上限：模型项的 `_meta.piz.compactContextWindow` 带上
  `handle.getCompactContextWindow()`，并在 `session/set_config_option(model)`
  之后重新下发（core 的 `syncCompactContextWindow` 随模型变化）。v1 没有
  独立的"压缩上限"概念，塞进 `_meta` 是可逆的扩展，不发明新方法。

## SDK 评估（测量于 2026-11-04）

- `@zed-industries/agent-client-protocol@0.4.5`（npm latest，`PROTOCOL_VERSION=1`）。
- bundle 成本（esbuild `--bundle --minify --platform=node`，只引入
  initialize/session-new/prompt/permission/update 等 schema）：**71.7 kB
  minified / 16.3 kB gzip**，基线空 bundle 489 B。成本可接受。
- **覆盖缺口**：0.4.5 早于现行 v1 的 `session/resume`、`session/close`、
  `elicitation/create`、`session/set_config_option`、`configOptions`，
  且 `AgentSideConnection` 只把 `_` 前缀方法路由给扩展 handler，无法在同一
  条流上接管这些方法（两套 dispatcher 拼接会破坏 id 关联与错误语义）。
- 结论：**手写 wire + zod schema**（`packages/cli/src/acp/acp-protocol.ts`），
  SDK 只作 **devDependency**，用它的 zod schema 做 conformance 回归
  （`tests/acp-conformance.test.ts`）：我们发出的 initialize/session-new/
  prompt/permission/update 载荷必须仍能被官方 schema 校验。等 SDK 覆盖上述
  方法，`acp-protocol.ts` 整体替换为 SDK 类型即可，前端其它文件不用动。

## bundle 成本（实测，2026-11-04）

同一份 `scripts/build.mjs --client-only` 产物，只差 `attach-main.ts` 的 `acp`
分支（临时移除该分支得到基线）：

| 产物 | minified | gzip |
|---|---|---|
| `zcode-attach.cjs`（无 ACP） | 2 150 848 B | 419 637 B |
| `zcode-attach.cjs`（含 ACP） | 2 515 245 B | 466 198 B |
| 增量 | **+364 397 B（+16.9%）** | **+46 561 B（+11.1%）** |

增量几乎全部来自 `@zcode/contracts` 的工具 schema 图：ACP 侧只 import 了
`ASK_USER_QUESTION_TOOL_NAME` / `EXIT_PLAN_MODE_TOOL_NAME` / 两个 input
schema，但 contracts 的根入口 `export * from "./tools/index.js"` 会把整套工具
schema 一起带进来（`packages/contracts` 没有 `sideEffects: false`，re-export
无法被 tree-shake）。单独测量：`zod` 基线 453 kB，`@zcode/contracts` 根入口
1 048 kB，`@zcode/contracts/tools` 964 kB——深路径子入口也只省 8%，不值得。

结论：**接受**。理由与取舍写在这里而不是留白：

- 相对 monolith（`zcode.cjs` 29.3 MB）仍是两个数量级以下；gzip 增量 46 kB
  与 SDK 路线（16 kB）同一量级，而 SDK 无法实现 resume/close/elicitation。
- 用"手写窄 schema 代替 contracts"能省掉这 364 kB，但等于把
  AskUserQuestion / ExitPlanMode 的形状复制一份；core 侧契约一改，ACP 就会
  静默渲染错表单。宁可多带 364 kB，也不要第二份真相。
- 真正该省的地方在 contracts 侧（`sideEffects: false` 或工具子入口细分），
  那是仓库范围的改动，不在本前端范围内；记在这里作为后续可选优化。

## 落地位置

```text
packages/cli/src/acp/
  acp-protocol.ts     v1 方法名、zod schema、停止原因
  acp-wire.ts         stdio NDJSON JSON-RPC 传输（id 关联、错误、行上限）
  acp-updates.ts      SessionEvent → session/update 投影
  acp-interactions.ts permission / userInput → ACP 请求与应答
  acp-session.ts      单会话：AttachSessionHandle + 回合/cancel/close
  acp-core.ts         per-cwd 惰性 core 客户端与会话工厂
  acp-agent.ts        ACP 方法分发与能力声明
  acp-command.ts      入口（attach-main 的 `acp` 分支懒加载）
```

`zcode-attach acp`（= `piz acp`）是唯一入口；`zcode acp` 仍是未知命令：
monolith 入口已经把 runtime 打进 29 MB bundle，让 ACP 也走那里只会把
"薄客户端"这件事重新抹掉。

## 回归覆盖

| 文件 | 覆盖 |
|---|---|
| `tests/acp-adapter.test.ts` | 真实 unix socket + 假 core 的端到端：initialize 能力声明、session/new（`persistence:"deferred"`、快照 seq 起订阅、MCP 忽略日志）、prompt（thought/text 增量、tool_call→tool_call_update 顺序、权限往返拿到 `option.response` 原文、usage）、cancel（core 侧真发 stop）、close（真停止）、resume（同一 sessionId、不重放历史、无 `session/load`）、set_mode/set_config_option 回发 `config_options`、AskUserQuestion 表单、ExitPlanMode 的 reject≠approve |
| `tests/acp-wire.test.ts` | 坏帧不毒化后续帧、`AcpWireError` 原样回码 vs 未分类异常收敛成不透明 `Internal error`（细节走 stderr）、慢请求不阻塞 cancel、出站 id 与 client id 空间分离、通知不回帧、EOF 兑现 `closed` |
| `tests/acp-interactions.test.ts` | 权限选项 → `opt-N` 稳定 id、`option.response` 原文（含 `permissionUpdates`）、cancelled/未知 id → core 的 deny 原文、无 deny 选项时也不放行；单选 enum / 多选自由文本、多选按 `", "` 归一、preview 注解回填、decline/cancel 直通、空应答按 decline、`ExitPlanMode` 只有 `approve` 能进 core |
| `tests/acp-conformance.test.ts` | 用官方 SDK 的 zod schema 校验我们发出/接受的每个形状（initialize/session-new/prompt/permission/update/elicitation），SDK 只做参照实现 |
| `tests/attach-argv.test.ts` | `acp` 判决先于旗标解析、`--model acp` 不被当子命令 |
| `cli.unit.test.ts` | `zcode acp` 仍是 `Unknown command`（monolith 不接管 ACP），stdout 干净 |

三个由测试/实机抓到的真实缺陷（已修）：

1. **权限应答是双层**：ACP v1 的 `RequestPermissionResponse` 是
   `{ outcome: { outcome: "selected", optionId } }`，最初的实现按扁平
   `{ outcome: "selected", optionId }` 解析——T3 点"允许"会被读成 cancelled，
   于是每次都回 core 的 deny。conformance 测试现在把这条钉死。
2. **诊断按消息节流**：入口日志原先按全局 60s 时间戳节流，导致
   initialize 的"客户端未声明 form elicitation"压掉了同一次启动里的
   "忽略 N 个 MCP server"——静默降级。改为按消息文本分别节流。
3. **`session/create` 缺 `workspace.workspaceKey`**：假 core 全盘接受参数，
   于是单元测试全绿；接上真 core 后立刻 `-32602 invalid params`。修法是
   与 `attach-command` 用同一个 `resolveWorkspaceKey`（identity 优先，否则
   path），并且**让假 core 按真 core 的 schema 校验入站参数**
   （`zcodeSessionCreate/Resume/Subscribe/Close/SetMode/SetModel/…`）——
   否则这类"只有真 core 才炸"的形状错误会一直被放过。

### 真 core 冒烟（手工，2026-11-04）

`ZCODE_SERVER_BIN=<wrapper: node dist/zcode.cjs>` + 构建后的
`dist/zcode-attach.cjs acp`（`ensureServer` 自己拉起 `app-server --socket
--no-plugins`）：`initialize` → `session/new`（拿到真 snapshot 的 modes 与
`configOptions`）→ `session/set_mode plan`（收到 `current_mode_update`）→
`session/resume`（同一 `sessionId`，`currentModeId` 仍为 `plan`）→
`session/close`；stdout 全程只有 JSON-RPC，诊断只在 stderr，进程退出码 0。
未做的是真模型回合（沙箱无 provider 凭据），因此 ACP 前端的 token 流只有
假 core 覆盖。

## 验收

1. 假 core（真实 unix socket）跑通：initialize → session/new → prompt（流式
   update + 权限往返）→ cancel → close → resume；`session/resume` 后同一
   `sessionId` 仍是同一 core 会话。
2. `zcode-attach.cjs` 的 bundle 不引入 `@zcode/bootstrap` / core runtime；
   启动后进程树无 MCP/office 子进程。
3. T3 Code（Local ACP command = `piz acp`）完成一次 GLM 回合；RSS 以
   `scripts/measure-attach.sh` 同口径记录。
4. 门禁：`tsc --noEmit`、`oxlint src`、`architecture:check --changed`、
   `packages/cli` 测试全绿。

状态（2026-11-04）：第 1、4 条已通过（见「回归覆盖」）；第 2 条以 bundle
内容检查代替进程树探针——`zcode-attach.cjs` 中不含 `@zcode/bootstrap`、
不含 `@zed-industries/agent-client-protocol`；第 3 条未验证：本沙箱没有
GUI，无法运行 T3 Code 桌面端，需要真实环境按下面「Spike 结果」的未验证项
逐条确认。

## Spike 结果（T3 Code，2026-11-04）

环境限制：本沙箱无 GUI，跑不起 T3 Code 桌面应用。因此 spike 是**读 T3 的
v1 客户端实现 + 按它的行为写本地 harness**，不是端到端 UI 验证。以下结论
来自 `pingdotgg/t3code@2dbc1cd4`（`packages/provider-acp`、`packages/effect-acp`），
标注为"读码结论"的条目**未经真实 T3 会话验证**。

| 问题 | 结论 | 证据 |
|---|---|---|
| T3 在 rollback 前会 cancel 吗？ | **不会**。回合活跃时 `rollbackThread` 直接报 `ProviderAdapterProtocolError`；rollback 的语义是"恢复 T3 checkpoint + 起一个全新 agent 会话"（ACP 没有截断原语）。所以 ACP 前端不需要实现回滚，只需要保证 `session/close` + 新 `session/new` 是干净的 | `adapter.ts` `rollbackThread`、`checkpointing.providerCanRollbackConversation` |
| 停止（Stop）时会怎样？ | 需要重启运行时的 Stop 走 `session/close`（`ACP_STOP_CONFIRM_TIMEOUT_MS` 超时视为中断失败），注释写明"ACP cancel 会留下原生子进程；close 才确认会话级停止"；不声明 `close` 则退化为 `session/cancel` | `adapter.ts` `interruptTurn` |
| 活跃回合中 resume 会怎样？ | `resumeThread` 先 teardown 再 `session/load`（`loadSession` 为 true 时）或 `session/resume`；**没有**"回合活跃"前置校验，agent 得自己决定。本前端的选择：resume 即重新接管 core 会话（core 支持多订阅者），若此刻仍有回合在跑，其事件继续作为 update 流出；前端不伪造"idle" | `AcpSessionRuntime.setupSession`、`resumeThread` |
| 问题表单怎么渲染？ | `elicitation/create` form：每个 `requestedSchema.properties` 项 → 一个 question；`enum` → 选项（label=value），`boolean` → 是/否，否则自由文本；`title` → header，`description` → 题目正文；应答 `content` 按属性名回填；关闭 = `cancel` | `adapter.ts` `handleElicitation` |
| T3 接受忽略 MCP 的 agent 吗？ | 读码结论：接受。`mcpServers` 按 agent 声明的 `mcpCapabilities` 选择（acp/http/stdio），无声明时发配置里那串；T3 不校验 agent 是否真的连上，只是 MCP 工具不会出现。规范（session-setup）要求 agent 连接所给 server，因此本实现**声明 `mcpCapabilities` 为空并记日志丢弃**——如实表达能力，不假装连上 | `AcpSessionRuntime.sessionMcpServers`；ACP v1 session-setup |

未验证（需要真实 T3 环境，见验收第 3 条）：表单在 T3 UI 里的实际观感、
Stop 的实际时序、MCP 被忽略后 UI 是否出现空工具面板、`_meta` 透传是否被保留。
