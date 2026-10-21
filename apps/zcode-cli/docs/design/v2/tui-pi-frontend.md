# pi-tui 前端（`--tui-frontend pi`）

## 目的

ZCode CLI 的交互前端是可替换的：`run(ctx, deps)` 通过 `deps.runTui` 注入
`(options: TuiOptions) => Promise<number>`（`cli-types.ts`、`tui-command.ts`）。
本 spec 定义第二个实现：基于 `@earendil-works/pi-tui`（pi-mono 的命令式
differential-rendering TUI 库）的前端 `@zcode/tui-pi`，与现有 OpenTUI/React 实现
（`@zcode/tui`）并存，由 `--tui-frontend` 旗标选择。默认仍为 `opentui`。

请求签名、coding-plan、session/runtime、权限 broker、CommandInbox 等业务层全部在
契约之下，pi 前端不触碰也不复制。

## 接口与旗标

- `zcode tui --tui-frontend=pi|opentui`（无参默认命令同样适用）。
- 仅 `tui` 命令作用域内合法；其他命令携带时报错（与 `--toolsearch-mode` 同规约）。
- 未知值报错并列出合法值。
- `runTuiCommand` 按旗标 `await import("@zcode/tui-pi")` 或回退 `loadTuiRuntime()`；
  `deps.runTui` 注入继续优先于两者（测试与嵌入方不变）。

## 共享层：`@zcode/tui` `./internals` 子路径导出

`@zcode/tui` 的投影层（事件归约、流式累积、工具行投影、提交流水线、审批/选择/问题
状态机、面板字段助手）是与框架无关的纯函数，仅 `import type` 依赖 React/opentui。
新增 `src/internals.ts` 与 `exports["./internals"]` 子路径，向 `@zcode/tui-pi`
再导出这些纯模块，避免两份漂移的投影实现：

- `state.ts`、`app-model.ts`（类型 + `approvalDecisions`）、`app-locale.ts`
- `app-events.ts`（`applySessionEventToState`）、`app-session-event-handler.ts`
  （`isMainSessionEvent`、`applyMainSessionEvent`、`rememberSessionEvent`）
- `app-transcript-stream.ts`、`app-transcript-errors.ts`、`app-event-data.ts`
- `app-tool-transcript.ts`、`app-tool-diff-display.ts`、`app-tool-path-display.ts`
- `app-terminal-width.ts`、`app-modified-files.ts`、`app-network-events.ts`
- `app-compact-timeline.ts`、`app-queued-inputs.ts`、`app-turn-complete.ts`
- `app-submit.ts`（`appendAgentResult`、`redactSensitivePromptForTranscript`）
- `app-approval.ts`（纯助手；`handleApprovalKey` 属 opentui KeyEvent，不导出也无妨）
- `app-question-state.ts`（状态机纯函数）、`app-selection-keyboard.ts`
  （`filterSelectionItems`、`clampIndex`、窗口计算、item 提交语义）
- `app-input.ts`（`toPromptInput`、`toDraftAttachments`、命令草稿查询/过滤）
- `app-model-ref.ts`、`app-subagent-events.ts`、workflow 镜像 reducer
  （`app-workflow-mirror.ts` / `app-workflow-events.ts` / `app-workflow-seed.ts`）
- `types.ts`（`Tui*` 类型已由 `.` 导出；internals 面向实现代码）
- `theme/`（palette、主题解析）

约束：internals 的 React/opentui 依赖以 `import type` 为主，但闭包内存在少量
运行时导入（`app-submit.ts` 的 `useCallback`、`app-keyboard-helpers.ts` 的
`@mbears/opentui-core` `KeyEvent` 类型使用）。pi 前端 esbuild 打包时把这类第
三方导入 external 化、经 node_modules 解析，因此对调用方仍表现为自包含。
带 *.tsx 渲染组件或 hook 入口的模块（`app-subagents.ts` hook、`app.tsx`、
`app-view.tsx`、opentui 主题 `app-markdown-theme.ts`）不导出；
pi 前端自行实现对应渲染与 hook 逻辑。

## `@zcode/tui-pi` 结构

`apps/zcode-cli/packages/tui-pi`，`runTui(options)` 签名与 `@zcode/tui` 一致。
构建方式与 `@zcode/tui` 相同：`tsc` 产出类型，esbuild 把 `src/index.ts` 打包
成自包含 `dist/index.js`——所有 `@zcode/*` 工作区依赖（含 `@zcode/tui` 的
internals 闭包、`@zcode/shared` 的 TS 源码）内联，第三方依赖运行时经
node_modules 解析。`@zcode/cli` bundle 把 `@zcode/tui-pi` 列为 external，
运行时 `import("@zcode/tui-pi")` 直接加载该 dist。
渲染器选 `TuiMainScreen`（主屏内联转写 + 终端 scrollback，与现行 UX 同形；
pi 的 `TuiAltScreen` 全屏视口语义不同，不选）。

- `ProcessTerminal` + `TuiMainScreen`；stdin/stdout 非 TTY 时与现有前端同判退出 1。
- 根 `Container` 纵向堆叠：transcript 容器 → 交互面板（审批 / AskUserQuestion /
  TuiSelection，与 React 前端同形内联呈现）→ queued-inputs → composer(Editor) →
  statusline。Esc 经全局输入监听关闭当前面板或触发双按中断。
- composer 用内置 `Editor`：`CombinedAutocompleteProvider` 提供 `/` 命令与 `@`
  文件路径补全；`/model`、`/effort`、`/mode` 经 `getArgumentCompletions` 给参数
  补全（等价于现有的草稿建议面板）；编辑器自带 bracketed paste、历史导航、
  kill-ring、撤销。
- 全局键经 `tui.addInputListener` 拦截（先于焦点组件）：`Ctrl+C`（有草稿→清空；
  否则 2s 双击退出）、`Ctrl+D`（空草稿退出）、双 `Esc`（2s 内中断当前 turn）、
  `Ctrl+P`（轮换可用模型，silent 提交 `/model`）、`Ctrl+L`（直接弹出可过滤模型
  选择面板，回车提交 `/model <ref>`）、`Ctrl+Y`（复制最后一条 agent 回复）、`Shift+Tab`（mode 轮换
  `plan→build→guarded→yolo`）、空草稿 `+`/`-`（展开/收起 workflow 卡）。
- Editor 自带 history 导航与 `recallPreviousInput` 远端历史并存：草稿为空时
  Up/Down 先走 CLI 侧 `recallPreviousInput`（跨会话持久历史），与现有前端一致。

## 事件投影

复用 `./internals`：`rememberSessionEvent`（2048 去重窗）+
`isMainSessionEvent`（主会话门 + subagent tool mirror 剥离）+
`applySessionEventToState`（同一 reducer），setter 注入到本前端的状态存贮：

- transcript：`Message[]`/`TranscriptPart` 同一模型；流式 `text_delta` /
  `reasoning_delta` 按 `assistantMessageId` 累积，`finish`/`reasoning_end` 收口；
  `tool_call_*` 生命周期 upsert tool part（`buildToolTranscriptProjection` 生成
  标题与详情行，`file_diff` display 渲染彩色 diff）。
- 每条 Message/Part 映射一个 `Component`：`Markdown`（agent 文本）、`Text`
  （user/system/timeline/thought）、自定义 `ToolRowComponent`（状态图标 + 名称 +
  详情 + 错误 + diff，`invalidate` + `requestRender` 驱动流式更新）。
- 状态行：mode | model | thoughtLevel | status | ctx；`busy` 时 Composer 旁挂
  `Loader`，busy 不锁输入（steer 语义经 `sendInput` `delivery:"auto"`）。
- `submitPrompt` / `sendInput` 分支语义与 `app-submit.ts` 相同：空闲→
  `submitPrompt`；`busy`→`sendInput`，queued → 队列区（`TurnSteerQueued`/
  `Drained`/`Discarded` 同步），rejected → status 提示。本地 user row 乐观追加，
  `/login *-api-key` 文本在 transcript 中脱敏；`/compact` 渲染为
  compact-timeline row 且不回显 response。
- `requestPermission`：CreateWorkflow/AmendWorkflow 沿用 CLI 自动放行例外；
  AskUserQuestion 经 `AskUserQuestionInputSchema` 校验 → 问题向导内联面板
  （选项、Other 输入、multiSelect、review 页，`decision:"modify"` 回传
  answers/annotations）；其余 → 审批内联面板（Allow once / Always allow in
  this project / Deny；`optionsPolicy`、`suggestedPermissionUpdates`、
  `approvalPermissionScopes` 全量遵守，Esc=Deny）。
- `TuiSelection`：内联面板，`filterSelectionItems` 过滤，`input` 子状态
  （masked、bracketed paste 路由进输入）、`pending` 子状态，item →
  `submitValue(item.command)`。
- `applyResult` 同 `app-result.ts`：mode/model/locale/thoughtLevel/
  modelOptions/effortOptions/loginRequired、`restoredMessages` 回放、
  `resetSessionProjection`、`result.selection` → 面板、usage/projection/traceId。
- workflow：镜像 setter 走共享 `applyWorkflowProgressToMirror`；挂载后先
  `replayWorkflowRuns` 冷回放再 `listWorkflowRuns` 补 label 与 interrupted
  notice（`workflowRunSeedFromSummary` / `interruptedWorkflowNotices` /
  `appendWorkflowInterruptedNotices`）。`WorkflowCard` 内联渲染在转写与交互区
  之间：每 run 一行（状态 | label | settled/used | actors），空草稿 `+`/`-`
  切换展开 actors、reports 预览与 log tail。
- 信息面板：Ctrl+X leader 复用 `resolveSidebarShortcut`（Ctrl+X → B 开/关），
  `SessionInfoPanel` 经 `tui.showOverlay` 右栏呈现：mode/model/thought、ctx、
  token 用量、最近事件、todos、修改文件、subagents（running/ended）、MCP
  servers、最近网络请求；Esc 关闭。

## 验收

- `zcode tui --tui-frontend=pi` 启动 composer；提交 prompt 流式渲染 markdown +
  工具行；权限/选择/问题面板可交互；`Ctrl+P/L/Y`、`Shift+Tab`、双 Esc、Ctrl+C
  语义与 opentui 前端一致。
- `--tui-frontend` 非法值报错；缺省走 opentui 行为不变（回归）。
- `node:test` 用例：投影（事件→Message[]）、提交分支、审批结果合成、
  选择/问题状态机、草稿命令解析、键位守卫；`VirtualTerminal` 冒烟渲染。
- 已知裁剪（后续按需）：子代理转写下钻浏览、workflow 卡与工具卡详情页联动、
  图片附件、i18n copy 全量接线；先以英文 status 文案起步，结构预留。
