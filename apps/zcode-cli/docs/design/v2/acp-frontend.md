# `piz acp`：ACP v1 stdio 适配器（thin client + shared core）

## 背景与目标

T3 Code 这类 ACP 客户端通过 `Local ACP` 以 stdio 拉起 agent 子进程，按 ACP v1
（`PROTOCOL_VERSION = 1`，SDK `@agentclientprotocol/sdk@0.21.1` 固定版本）通信。
目标：**`piz acp`（即 `zcode-attach.cjs acp`）作为该 stdio agent 运行，所有业务
事实仍在共享 core，薄客户端只做 ACP↔ZCode Protocol 的映射**——不引入第二份
runtime，不启动插件/MCP 子进程，RSS 与 `piz` TUI 同量级。

非目标：T3 改动、core 协议改动、ACP 之外的认证（沿用既有 `piz login`）。

## Spike 结论（对照真实客户端/规格的核对项）

| 问题 | 结论 |
|---|---|
| cancel 时序 | `session/cancel` 是通知：agent 应尽快停、补发剩余 `session/update`，并以 `stopReason: "cancelled"` 应答原 `session/prompt`。实现：v4 `stop` 命令 + 本地 turnAbort，`turn_complete/turn_error` 到达即以 cancelled 收口 |
| resume during live turn | 允许：`session/resume` 只重绑 core session 与订阅，不打断在途回合；新 prompt 正常排队/admission |
| question 表单渲染 | `AskUserQuestion` 走 `elicitation/create` form：每个问题一个 string 属性，选项落 `enum`；`multiSelect` 在 ACP form 无数组枚举形态，降级为键入文本 |
| 忽略客户端 MCP servers | 允许且必须：MCP 由共享 core 承载。规格要求 agent 连接 `mcpServers`，但 core 已持有 workspace 的 MCP 配置；适配器对收到的 server 只记日志忽略（`acp: ignoring client-provided MCP servers`），不伪造连接 |

## 所有权与事件秩序

```
T3 (ACP client)                     piz acp (thin)                 shared core
      │  initialize ──────────────▶ │                                │
      │ ◀── protocolVersion 1 ───── │                                │
      │  session/new {cwd,mcp[]} ─▶│─ session/create (per cwd ws) ─▶│
      │ ◀── sessionId/modes/models │◀─ subscribe(raw events) ──────│
      │  session/prompt ─────────▶ │─ v4/command sendText ────────▶│
      │ ◀── session/update ◀────── │◀─ session/rawEvent 流 ────────│
      │  session/cancel ─────────▶ │─ v4/command stop ────────────▶│
      │ ◀── prompt: cancelled ─────│◀─ turn_complete ──────────────│
      │  session/close ──────────▶ │─ stop + session/close ───────▶│
      │                            │◀─ interaction/requestPermission │
      │ ◀── session/request_permission (optionId) ─┐                │
      │ ── core option.response 原文 ──────────────┘                │
      │                            │◀─ interaction/requestUserInput  │
      │ ◀── elicitation/create (AskUserQuestion / ExitPlanMode) ─┐ │
      │ ── accept/decline ────────────────────────────────────────┘ │
```

所有权：会话/回合/存储/权限事实全部在 core；薄客户端只持有 ACP↔wire 映射态
（per-workspace 一条惰性 socket，cwd 是 per-session 的，不能进程级单例）。
断开 = detach，与 attach 同义：客户端退出不断 core session。

## v1 行为映射

| 面 | 行为 |
|---|---|
| Sessions | `session/new`、`session/resume`、`session/close`（真实 stop）；不实现 `session/load`（`loadSession: false`） |
| Turns | `session/prompt`、`session/cancel`、`session/update`（raw 事件投影为 chunk/tool_call/mode 更新） |
| Workspaces | 每 workspace 一条惰性 core client（`AcpCoreBridge`） |
| Permissions | `session/request_permission`，core 的 `option.response` 原文回传 |
| AskUserQuestion | form elicitation，string `enum`；multi-select 键入文本 |
| ExitPlanMode | approve/reject elicitation；Auto/Full 不能静默批准计划 |
| Modes/models | 暴露 `plan` 模式、模型选项、GLM 压缩上限（262K 随模型下发） |
| MCP from T3 | 忽略并记日志（core 承载） |
| Files/terminals | core 运行；不用 `fs/*`、`terminal/*` |
| Auth | ACP 外完成（既有 piz login），`authenticate` 直接放行 |

## 实现

- `packages/cli/src/attach/acp/acp-main.ts`：`acp` 入口，stdin/stdout 跑
  `AgentSideConnection` + `ndJsonStream`；stdout 为严格协议通道，诊断走 stderr。
- `acp-core-bridge.ts`：per-workspace 惰性 `AttachClient`，路由反向请求与 raw 事件。
- `acp-agent.ts`：`Agent` 实现（上述映射）。
- 入口接缝：`attach-main.ts`（`piz acp`）与 monolith `run.ts`（`zcode acp`）共用同一实现。
- 依赖：`@agentclientprotocol/sdk` 固定 `0.21.1`（与 `packages/services` 同版本，
  Apache-2.0，已在 THIRD-PARTY-NOTICES 登记）。

## Bundle 成本

实测 `pnpm --filter @zcode/cli build:attach`：引入 SDK + 适配器前 `zcode-attach.cjs`
= 2,150,797 B，引入后 = 2,259,900 B，**增量 +109,103 B（约 +105 KB，薄客户端整体
+5%）**——SDK 为纯 TS ESM，全部内联进瘦客户端，运行时仍为零，core 不进二进制。

## 验收（T3 侧）

完整 GLM 回合、per-client RSS、确认无插件子进程、attach 链路签名追踪。
额外用量资格除非账户计量可见，否则不作宣称。
