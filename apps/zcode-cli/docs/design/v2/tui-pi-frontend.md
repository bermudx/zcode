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
  文件路径补全；`/model`、`/effort`、`/mode`、`/skill` 经 `getArgumentCompletions`
  给参数补全（等价于现有的草稿建议面板）；编辑器自带 bracketed paste、历史导航、
  kill-ring、撤销。`/skill` 的候选来自 startup 快照的 `skillSuggestions`
  （`TuiSkillSuggestion[]`，attach 走 `skills/referenceCatalog` session 权威、
  内嵌走 `listZCodeSkills` 现扫，命名均为 `qualifiedName ?? name` 同名去重）。
- 全局键经 `tui.addInputListener` 拦截（先于焦点组件）：`Ctrl+C`（有草稿→清空；
  否则 2s 双击退出）、`Ctrl+D`（空草稿退出）、双 `Esc`（2s 内中断当前 turn）、
  `Ctrl+P`（轮换可用模型，silent 提交 `/model`）、`Ctrl+L`（直接弹出可过滤模型
  选择面板，回车提交 `/model <ref>`）、`Ctrl+Y`（复制最后一条 agent 回复）、
  `Ctrl+V`/`Alt+V`（剪贴板图片粘贴，见下节）、`Shift+Tab`（mode 轮换
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
- 状态行：mode | model | thoughtLevel | busy? | status，随后一段空格分隔的
  用量簇（pi-mono 页脚形态）：`↑{input} ↓{output} R{cacheRead} CH{hit}%
  {ctxPct}%/{ctxWindow} agents:{n}`。
  - `↑`/`↓`/`R` 读 `UsageTotalsAccumulator`（`tui-pi/src/usage-totals.ts`）
    维护的 session 累计。契约没有 session 级权威用量源——`turn_complete`
    / `submitPrompt` 结果的 `usage` 都是 `createModelUsageSummaryFromEvents`
    (本回合事件) 的回合口径，采纳会把累计显示打回本回合数字——故只做
    纯折叠：已 dedup 的主会话 `model_complete` 与 `model_request_failed`
    单请求 `ModelUsage` 逐次累加（与权威口径同一事件集合）。只在
    `applyMainSessionEvent` 采纳后折叠：同一事件经 session sink 与
    per-turn onEvent 双投递，dedup 保证恰好一次。attach 中途接入只计
    接入后流量；`resetSessionProjection` 清零。`state.usage` 在 turn 内
    是单请求口径，不能直接显示为累计。
  - `R` 为累计 `cacheReadTokens`（与 pi-mono footer 同字段语义）。
  - `CH` 取 `ModelComplete.payload.cacheHit.latestHitRate`（最近一次请求的
    命中口径，即 pi 的 `latestCacheHitRate`；0–1 小数，渲染成一位小数百分比）。
    事件缺 `cacheHit` 时回退 session 累计口径 `cacheRead/input`（与 React
    sidebar `cacheHitLabel` 同一公式），两者皆缺则不显示该段。
  - `ctx` 段为 `contextUsage.contextUsed / contextWindow`：窗口在时渲染
    `{pct}%/{compact(window)}`，仅有 contextUsed 时降级为 `ctx {compact}`。
  - `agents:{n}` 在 running 子代理数 > 0 时追加（见下方目录段）。
  - 不显示 `$`：契约不含模型定价来源，虚拟成本数字宁可缺省；plan 额度
    读数属独立的 provider-balance 方向，不在本段伪造。
  - 紧凑计数与 pi-mono `formatTokens` 等值：<1k 原值、<10k 一位小数 `k`、
    <1M 整数 `k`、<10M 一位小数 `M`、否则整数 `M`。
  `busy` 时 Composer 旁挂 `Loader`，busy 不锁输入（steer 语义经 `sendInput`
  `delivery:"auto"`）。mode 显示协作模式（来自快照 `settings.mode.current`，
  plan 覆盖期间为 `plan`，见 tui-mode-switching.md 与 tui-attach-shared-core.md）。
- 子代理目录：`SubagentDirectory`（`tui-pi/src/subagents.ts`）把
  `options.readSubagents` 的快照收敛进 `store.state.subagents`，是目录的唯一
  owner——组件只读 store，不各自拉取副本。刷新触发与 React 端
  `useSubagents` 同规约：`changesSubagentDirectory`（已剥离 subagent tool
  mirror）+ `ToolCallResult` 仅主会话；并发去重用 dirty + in-flight 循环；
  结果落地前用 epoch（reset/dispose 递增）与 `getMainSessionId` 父会话比对
  双重守卫丢弃过期快照。会话投影重置（`resetSessionProjection`）时清空目录。
  `readSubagents` 端口缺失（非 attach / 未接线）时整体静默缺省。
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
  servers、最近网络请求；Esc 关闭。subagents 段渲染 `store.state.subagents`
  （`SubagentDirectory` 为唯一 owner），面板打开时主动触发 refresh 并经 store
  变更通知获得活体更新；MCP servers 无事件源，仍为打开时一次性拉取。

## `!` 本地 shell 逃逸

- composer 内 `!cmd`（trim 后以 `!` 开头且长度 > 1）不进入模型回合：在客户端
  workspace（`workspaceDirectory ?? cwd`）本地执行；`!cmd` 头行 + 退出状态 +
  输出（stdout/stderr 合并、120s 超时、64k 字符 / 2000 行截断）作为 system
  消息行写入 transcript；捕获输出以 `<shell-output …>` 块前置到下一条真实
  prompt（slash 命令不消费缓冲，缓冲只交付一次）。core 没有「追加本地消息」的
  协议面，上下文交接只能在提交时发生；transcript 展示端把该块折叠为
  `⤷ shell output:` 一行，未闭合的手写标记原样保留。
- 执行 shell：POSIX 下取 `env.SHELL` 且 basename 为 bash/zsh 的可执行文件，
  否则回退 `/bin/sh`；Windows 保持 `ComSpec ?? cmd.exe`（`/d /s /c`）。
- bash/zsh 以 `-ic` 执行：交互模式加载真实 rc 路径，使 `!` 与用户交互 shell
  里的 alias、函数、初始化一致（`!gd` == `git diff`）。不能用非交互 `-c` +
  前缀注入替代：zsh 对 `-c` 串整体先解析再执行，同一串内定义的 alias 对串内
  命令不生效（bash 按完整命令逐段解析才可行，且依赖 expand_aliases）。
- `-i` 在无控制 tty 时产生启动期 stderr 诊断（bash 的
  `cannot set terminal process group` / `no job control in this shell`，
  zsh 同类 tty/job-control 警告）：属 shell 启动噪声而非命令输出，从捕获
  输出中剔除；其余 stderr 原样保留进输出。
- rc 的副作用（噪声输出、慢初始化、阻塞读）与用户在自己终端里执行同一命令
  的暴露面一致；stdin 置 ignore，120s 超时兜底。
- 非 bash/zsh 的 SHELL 走原 `/bin/sh -c` 语义：不读 rc、无 alias。

## 图片粘贴与草稿附件

- `Ctrl+V`（macOS/Linux，与 React 前端一致）与 `Alt+V`（Windows 终端常把
  `Ctrl+V` 留给文本粘贴的兜底）触发 `PiImagePaste`（`tui-pi/src/image-paste.ts`）：
  走 `TuiOptions.readClipboardImage` 端口读系统剪贴板，busy/无端口/无图/
  非支持 MIME 各自给出状态行，同一时刻串行化一次剪贴板读取。
- 粘贴成功登记 `DraftAttachment` 并在光标处插入 `[image #N]` 占位符（词中
  位置自动补前导空格）；占位符即唯一绑定——`onChange` reconcile 把已被编辑
  删掉的占位符对应附件摘除，`toPromptInput` 只提交仍被文本引用的附件。
  reconcile 延迟到 microtask：pi `Editor.submitValue()` 先清空文本再回调
  `onSubmit`，同步 reconcile 会在提交捕获前误删草稿附件。
- 附件 id 即占位符数字命名空间，由 `PiDraftAttachments`（`tui-pi/src/attachments.ts`）
  统一分配并跳过当前草稿已占用的 id——history 恢复会把 `[image #N]` 还原成
  同号附件，独立计数器会产生同名占位符让两张图被同一处文本引用。
- `@path` 提及与图片附件共用 `DraftAttachment` 域，提交时 `appendFileMentions`
  在工作区内把 `@path` 追加为 file 附件；slash 命令按控制消息处理，不占位
  符引用的附件不会随 `/...` 下发。
- 线上形状与 React 前端相同：`{text:"…[image #1]", attachments:[{type:"image",
  path:"[image #1]", content:"data:…"}]}`；attach 端 `toProtocolAttachments`
  转 `{kind,mimeType,dataBase64}`。history 条目恢复时占位符数字回填附件 id。

## 验收

- `zcode tui --tui-frontend=pi` 启动 composer；提交 prompt 流式渲染 markdown +
  工具行；权限/选择/问题面板可交互；`Ctrl+P/L/Y`、`Shift+Tab`、双 Esc、Ctrl+C
  语义与 opentui 前端一致。
- `--tui-frontend` 非法值报错；缺省走 opentui 行为不变（回归）。
- `node:test` 用例：投影（事件→Message[]）、提交分支、审批结果合成、
  选择/问题状态机、草稿命令解析、键位守卫；`VirtualTerminal` 冒烟渲染。
- 已知裁剪（后续按需）：子代理转写下钻浏览、workflow 卡与工具卡详情页联动、
  i18n copy 全量接线；先以英文 status 文案起步，结构预留。
