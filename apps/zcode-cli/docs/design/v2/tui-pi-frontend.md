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
- 根 `Container` 纵向堆叠：启动横幅（`PiBanner`）→ transcript 容器 → 交互面板
  （审批 / AskUserQuestion / TuiSelection，与 React 前端同形内联呈现）→
  queued-inputs → composer(Editor) → statusline。Esc 经全局输入监听关闭当前
  面板或触发双按中断。
- 启动横幅（`tui-pi/src/banner.ts`）：PIZ 方块字 logo（与 React 前端
  ZCODE idle logo 同一字族）+ `piz v{version}` + 两行按键提示 + `models:` 行，
  右栏信息排布在 logo 右侧。`modelOptions` 经 startup 快照异步到达（ctor 注入或
  `applyStartupOptions`），到达前该行留空、横幅高度不变。横幅作为普通子组件
  挂在转写之前，随 scrollback 向上滚走；所有行经 `truncateToWidth` 截断，
  窄终端不折行不抛错。纯展示层：不读会话/模型状态之外的源，无新配置面。
- composer 用内置 `Editor`：`CombinedAutocompleteProvider` 提供 `/` 命令与 `@`
  文件路径补全；`/model`、`/effort`、`/mode`、`/skill` 经 `getArgumentCompletions`
  给参数补全（等价于现有的草稿建议面板）；编辑器自带 bracketed paste、历史导航、
  kill-ring、撤销。`/skill` 的候选来自 startup 快照的 `skillSuggestions`
  （`TuiSkillSuggestion[]`，attach 走 `skills/referenceCatalog` session 权威、
  内嵌走 `listZCodeSkills` 现扫，命名均为 `qualifiedName ?? name` 同名去重）。
- 全局键经 `tui.addInputListener` 拦截（先于焦点组件）：`Ctrl+C`（有草稿→清空；
  否则 2s 双击退出）、`Ctrl+D`（空草稿退出）、双 `Esc`（2s 内中断当前 turn）、
  `Ctrl+P`（轮换可用模型，silent 提交 `/model`）、`Ctrl+L`（直接弹出可过滤模型
  选择面板，回车提交 `/model <ref>`）、`Ctrl+X`（复制最后一条 agent 回复）、
  `Ctrl+Q`（busy 时把草稿排进 follow-up 队列——`submitValue(text,
  {delivery:"queue"})`；空闲时与 Enter 等价，pi-mono 对齐）、
  `Ctrl+N`（新 session：空闲时提交 `/new`，turn 进行中只提示不触发）、
  `Ctrl+T`（展开/收起全部 thought part 正文，默认收起到两行预览）、
  `Ctrl+O`（开/关 session 信息面板，见末节）、
  `Ctrl+V`/`Alt+V`（剪贴板图片粘贴，见下节）、`Shift+Tab`（mode 轮换
  `plan→build→guarded→yolo`）、空草稿 `+`/`-`（展开/收起 workflow 卡）、
  `Alt+Up`（把排队输入（steer pending + follow-up 队列）按序拼回输入框
  （`\n\n` 连接、保留当前草稿在末尾），并经 `TuiOptions.removeQueuedInputs`
  端口从其 owner（attach：core pendingInputs / 客户端本地队列）摘除；
  队列为空时提示"没有可恢复的排队输入"。pi-mono 对齐）。
- 所有 chord 只走 `matchesKey` 判定（识别 kitty CSI-u 键码）。不做
  `keyEventFromInput` 驱动的两键 leader：旧 `Ctrl+X`→B sidebar leader 在
  kitty 协议下收不到 CSI-u 形式的 ctrl+x，leader 永不 arm、后续普通键落进
  编辑器，实测失效后随本次键位调整退役（`resolveSidebarShortcut` 仍归
  opentui 前端使用）。`Ctrl+Y` 不再被 app 拦截，回落到 Editor 自带的
  kill-ring yank（此前一直被 copy chord 遮蔽）。
  chord 匹配前先经 `isKeyRelease` 丢弃 kitty release 事件且不消费（交还焦点
  组件，由 `wantsKeyRelease` 过滤）：pi-tui 推 `\x1b[>7u`（flag 2 = 上报
  press/repeat/release），release 与 press 键码相同而 `matchesKey` 不区分
  事件类型，不过滤会让每个物理按键在 chord 层触发两次（↑/↓ 一跳两条历史、
  Esc 单击即暂停、Shift+Tab 跨两档）。repeat 事件与 press 同路径，照常被处理。
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
- user 行按 `tui-transcript-message-rows.md` 同一契约在 pi 前端的实现：
  accent 色 `> ` 前缀 + `userBg`（`backgroundMessageUser` 记号）整行垫底 +
  上下各一行背景填充，用户回合在转写里立块可辨；agent 行保持普通背景。
- 终端 markdown 主题（`piMarkdownTheme` → `theme.markdown`）按 `markdown*`
  记号组装，与 React 前端 `app-markdown-theme.ts` 映射一致：终端没有字号，
  heading/strong 用 bold 属性表达层级，inline code 叠 `backgroundPanel` 底色；
  `underline`/`strikethrough` 只叠加属性不带色——pi-tui 在 h1 和 link 内
  嵌套调用 `underline()`，带 fg 会顶掉 heading/link 颜色。
- 转写正文经 `TranscriptMarkdown`（`tui-pi/src/transcript-markdown.ts`）：
  无表格消息走 pi-tui `Markdown` 原路径（快路径，仅多一次行扫描）；顶层
  pipe 表格改无边框渲染——粗体表头 + 表头下每列 `─` 规线 + 列间 2 空格
  gutter，无竖线无行间框线；列宽按列内单元格文本总量配比（每列保底最长
  词、封顶 24 格，整体装得下用自然宽度不拉伸），出现换行单元格时行间补
  空行、单行表格保持紧凑；对齐标记（`:-:`/`--:`）生效。表格只在列 0 起
  始识别，缩进表格（blockquote/列表内）沿用 pi-tui 原渲染；扫描器同时跟踪
  fence 状态（与 json 美化同一套开/闭判定），围栏代码块内的 `|---|` 属于
  代码内容、整块交给 pi-tui 渲染，扫描失败永远退化为 prose 段，不丢内容。
  `json` 围栏代码块渲染前做 `\/` 反转义 + ≤32KB 时 2 空格重新缩进（只重排
  空白、字符串与数字保留源文本，`JSON.stringify(JSON.parse(x))` 会把
  9007199254740993 打印成 …992、把 1.10 打印成 1.1、把 1e400 打印成 null），
  流式半截 JSON 解析失败则只反转义原样保留——修复 provider 侧 Z.ai
  built-in tool 叙事块单行转义 JSON 的可读性。
- thought 行：`{+|-} thought · {formatTokens(n)} chars` 标签（`+`/`-` 即
  Ctrl+T 折叠/展开状态）；收起时至多两行预览带 `▎` 引导列并剥离
  `**`/`` ` ``/标题记号，展开时按原始行折行保全文（不剥记号）；thinking
  期间单行 `⠋ thinking…`。tool 行：toolName 粗体，详情行 dim 字段名 +
  正文色值（`label: value` 分层，整行不再全灰）；同一消息内
  thought/tool/text part 之间保证恰一行呼吸位（不与 markdown 自带的段尾
  空行叠加）。
- Footer 恒定两行由 `StatusFooter`（`tui-pi/src/footer.ts`，extends
  `Container`）唯一 own：高度不随 busy 变化，挂载/卸载 spinner 不再把整屏
  内容顶起/落下；`update({state, status, cwdLabel, quotaText})` 一行委托
  两行。操作者口径为两行（2026-10-29 起恢复 3324315f 前的双行布局；
  2026-11-01 起 cwd 上移到活动行行首，meta 行只剩 stats 左区）：
  活动行 + meta 行。
  - 活动行（`ActivityLine`，Loader 单行形态）：行首 `~/cwd (branch)`
    （`formatPwdLine`，`$HOME` 折叠为 `~`，branch 取
    `TuiStartupOptions.workspaceGitBranch`——CLI 组合层启动快照，与
    React sidebar 同一来源；无 live watcher，会话内切分支不刷新；非
    git 目录只显 cwd），其后 `spinner + status`：busy 或 `activeTurnId`
    在场时动画 spinner + `status`（status 为空回退
    `input.activeStatusHint`，"esc to interrupt"，与 React 前端同文案）；
    空闲时 spinner 位留空格对齐、显示 `status` 或留白。`activeTurnId`
    并入活动判定与 `quitChoice.turnBusy` 同口径——attach 会话远端发起
    的 turn 也可见 spinner；指示切换只在 busy 沿变化时发生。行尾右对齐
    额度簇（pi provider-balance 同式，`appendFooterRightZone`）：账号级
    读数不占 meta 行的 session 左区；`theme.dim`，间距 ≥2 列，余量不足
    丢额度读数不截 status/spinner。pwd 与 status 两空格分隔；pwd 超宽
    行尾 "..." 截断（cwd 存活最久，status/额度先行收缩——与原 meta 行
    「cwd 在左区最前、最后丢」同优先级）。
  - meta 行（`MetaLine` + `status-line.ts` 纯格式化 `formatStatsLine`）：
    左区 `↑{in} ↓{out} R{cacheRead} [W{cacheWrite}]
    [CH{hit}%] [$cost] {ctxPct}%/{ctxWindow}(auto)`（pi footer 同构同序；
    窗口缺失降级 `ctx {compact(used)}`；`W` 仅 cacheWrite>0 时显示），
    右区 `(provider) model • thought • mode • agents:N`（pi 用 `•`
    分隔；provider 前缀仅当可用 provider 数 >1 时显示，与 pi
    `getAvailableProviderCount()>1` 同规约；mode/agents 为 piz 扩展段，
    附着在 pi 段之后），两区间距 ≥2 空格。宽度收缩顺序：左区行尾 "..."
    截断 → 右区按剩余宽度截断（pi footer 同序，右区截断无标记）。
    早期「右区余窗 <4 列整体退场」的防碎片守卫已移除，以 pi 行为为准。
  - ctx 百分比按 pi 阈值着色：>90% `theme.danger`、>70% `theme.warning`、
    其余随行 `theme.muted`；`(auto)` 直接拼在窗口紧凑计数之后
    （`{pct}%/{win} (auto)`）。
  - ctx 仪表分母按每会话压缩上限收紧（fork 偏离 pi；
    `patch/footer-compact-gauge`，2026-11-02）：当前模型命中 piz 的 GLM
    压缩上限（`@zcode/shared` `resolveCompactContextWindowForModel`——与
    attach 下发 `compactContextWindow` 的谓词同一来源，发送与展示不可能
    漂移）时，分母 = `min(cap, 窗口)`（262_000 → `262k`），投影/目录窗口
    均缺失时直接取 cap。动机：auto-compact 在有效窗口 − 21K − 13K ≈ 228K
    触发，未收紧的 1M 分母把仪表 100% 刻度放到触发线的 ~4.4 倍处——读数
    误导而非保守。`?`/降级分支与 pi 阈值着色不变（按收紧后的百分比计算；已知窗口
    ≥ cap 时触发线落在 ~87% warning 区——窗口未知的 cap-only 分支里 core
    对缺失窗口回退 200K 默认，触发线比例更低，且只存在于首个
    model_complete 之前）。非 GLM/无 cap 会话保持模型窗口分母。
    边界：收紧是纯客户端展示，core/协议侧窗口语义不变；老 core（对
    `session/setCompactContextWindow` 答 -32601、静默跳过）不会应用 cap 而
    仪表仍按 cap 显示——matched-pair 部署下仅 promotion 过渡期存在。
  - 两行均单行截断（取 Text 渲染首行，已按宽补齐），不折行：窄终端或长
    status 也不会把 footer 撑过两行。
  - `(auto)`：core `AutoCompactPolicyConfig.enabled` 目前不在客户端事件面
    暴露（compact 事件只带 `autoCompactThreshold` 结果值）。计划经 additive
    契约字段把设置态带到 `ContextUsage`；字段落地前 footer 不显示 `(auto)`，
    不按默认值伪造。例外（`patch/footer-compact-gauge`）：每会话压缩上限
    激活（GLM cap 收紧了分母）时，分母本身就是压缩预算，直接渲染
    `(auto)`；非 cap 会话仍按上段规则不显示。
  - `↑`/`↓`/`R` 读 `UsageTotalsAccumulator`（`tui-pi/src/usage-totals.ts`）
    维护的 session 累计。折叠口径与 contracts `summarizeSessionUsageTotals`
    同源：已 dedup 的主会话 `model_complete` 与 `model_request_failed`
    单请求 `ModelUsage` 逐次累加（`turn_complete` / `submitPrompt` 结果的
    `usage` 是 `createModelUsageSummaryFromEvents` 回合口径，采纳会把累计
    显示打回本回合数字，故不取）。只在 `applyMainSessionEvent` 采纳后
    折叠：同一事件经 session sink 与 per-turn onEvent 双投递，dedup 保证
    恰好一次。attach 接入前的部分由快照 `runtime.usageTotals` 种子补齐
    （core 对 eventStore 同口径折叠；eventStore 是运行期内存账本，core
    重启冷恢复的 session 只含物化后事件，与 `runtime.contextUsage` 同
    窗口）。种子经 `applyResult`/`seed` 在 `resetSessionProjection` 清零
    之后落地，live 增量在其上继续累加。`state.usage` 在 turn 内是单请求
    口径，不能直接显示为累计。
  - `R` 为累计 `cacheReadTokens`（与 pi-mono footer 同字段语义）。
  - `CH` 取 `ModelComplete.payload.cacheHit.latestHitRate`（最近一次请求的
    命中口径，即 pi 的 `latestCacheHitRate`；0–1 小数，渲染成一位小数百分比）。
    pi footer 同款门：`cacheRead>0 || cacheWrite>0` 且最近命中率在时才显示；
    早期的 session 累计回退公式已删除（pi 无此回退，累计口径会把历史命中率
    伪装成当前命中率）。
  - `ctx` 段为 `contextUsage.contextUsed / contextWindow`：窗口在时渲染
    `{pct}%/{compact(window)}`，仅有 contextUsed 时降级为 `ctx {compact}`。
    `contextWindow` 取值链：`session_created` / `model_complete` payload 的
    `contextWindow`、快照 `runtime.contextUsage.size` 种子；三者都缺时回退
    当前模型的 catalog `contextWindow`（provider 匹配的 `modelOptions` 条目，
    pi `contextWindow ?? model.contextWindow` 同款——同名模型跨 provider 不
    互借窗口）。
  - `agents:{n}` 在 running 子代理数 > 0 时追加到右区身份簇（见下方目录段）。
  - `$cost`：契约无成本字段（core step-finish 落 `cost: 0` 占位），成本在
    客户端按模型单价计算（pi `calculateCost` 同公式：
    `(input·r_in + output·r_out + cacheRead·r_read + cacheWrite·r_write)/1e6`，
    单价取 pi models-store 公开目录的 zai GLM 表，`tui-pi/src/pricing.ts`；
    用量逐请求折叠时按折叠时刻的当前模型计价——会话中途换模型有一次请求的
    归界误差，pi 按条目模型计价无此误差，契约带模型 id 后可消除）。单价
    未知的模型不显示该段；累计为 $0（如 plan 内置 highspeed 档）也不显示，
    与 pi `usageTotals.cost || usingSubscription` 门一致。
  - 额度簇 `5h: {remaining}% ↻{countdown} · 7d: ...`：数据经共享协议
    `usage/codingPlanQuota`（attach/additive，见 tui-attach-shared-core.md）
    由 core 用 provider 凭据拉监控端点，返回共享 `UsageQuotaSnapshot`；
    `tui-pi/src/quota.ts` 持有与刷新（provider-balance 同策略：空闲 60s
    ±15s 抖动、turn 沿刷新 ≥30s 间隔、读数 30min TTL、失败保留上次读数并
    stderr 诊断、`options.readUsageQuota` 缺席时静默）。失败诊断不刷屏
    （2026-10-28）：同一失败消息只诊断一次（消息变化或成功落地后重新
    允许一次），空闲拍在失败后 60s（FAILURE_BACKOFF_MS）退避窗口内跳过，
    turn 沿/启动/reset 等权威拍仍真实尝试——provider-balance
    「opportunistic 让路、authoritative 重试」同分工；永久失败（无凭据）
    不再每 60s 一行 stderr。格式化同
    provider-balance：unit/number → 窗口标签（d/h/m）、`percentage`
    （已用口径）翻转为剩余、`nextResetTime` 秒/毫秒双容差、窗口按秒升序、
    倒计时 `now/m/h/d/d{h}` 空格紧凑式、百分比 0–100 收敛。
  - 紧凑计数与 pi-mono `formatTokens` 等值：<1k 原值、<10k 一位小数 `k`、
    <1M 整数 `k`、<10M 一位小数 `M`、否则整数 `M`。
  `busy`/`activeTurnId` 时活动行 spinner 转动；busy 不锁输入（steer 语义经 `sendInput`
  `delivery:"steer"`——attach 模式经协议 `session/send delivery:"steer"` 直驱 core
  `steerTurn`，进程内模式映射 `steer_active_turn`；被拒时回退 follow-up 队列，见
  turn-steering.md attach lane 节）。mode 显示协作模式（来自快照 `settings.mode.current`，
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
  `submitPrompt`；`busy`→`sendInput`（Enter 缺省 `delivery:"steer"`，
  Ctrl+Q 显式 `delivery:"queue"`），queued → 队列区（`TurnSteerQueued`/
  `Drained`/`Discarded` 同步；steer 项来自 core 真实事件、follow-up 项
  来自 attach 本地合成事件，按 `pendingInputId` 幂等；行首按 lane 标注
  `Steering:`/`Follow-up:`，pi-mono 对齐；busy Enter 的 status 报
  "Steering active turn."、Ctrl+Q 报 "Input queued."，两条 lane 的
  反馈不混同），`Drained` 按 payload `drainedInputs`（含原文）把已注入
  输入补成 transcript user row（队列区行同步移除——user 行只由本地乐观
  追加与 drained 事件产生，steer/重放输入在屏幕上永远可见，见
  turn-steering.md TUI/GUI 行为节），rejected →
  status 提示。`queue` lane 只在 attach（v4 bridge 的 auto-drain 提升
  器）真实存在；进程内宿主对 `delivery:"queue"` 显式回
  `queue_unavailable`（TuiSendInputResult 变体），UI 提示
  "Follow-up queuing is unavailable in this mode; input restored to the
  composer." 并恢复草稿——不显示"已排队"（core 队列 lane 进程内无人
  消费，会随回合收尾静默丢失，2026-10-26 追踪）。本地 user row 乐观追加，
  `/login *-api-key` 文本在 transcript 中脱敏；`/compact` 渲染为
  compact-timeline row 且不回显 response。`TurnSteerDrained` 除清队列区外，
  按 `drainedInputs`（自带文本与持久 messageId，resume 侧 product projection
  同一依据）把每条被消费的输入落成 transcript user 行——live 投影此前只清
  队列，排队消息从转写中凭空消失；messageId 作行 id 天然幂等（缺
  messageId 的畸形事件退到必填且稳定的 pendingInputId，绝不生成一次性
  id 破坏幂等）。可见性不按 intent/text 猜测：drain 事实出现即表示该输入
  已被 persistUserPrompt 持久成 semantics.uiVisibility=visible 的 user
  message，可见与否是 CLI 权威（与 `transcript-hydration`「UI 不得再靠
  文本覆盖 CLI visibility authority」一致）；两个 resume 权威同样不跳过
  （product projection 对每条 drained item 无条件 row.appended，compact
  只抑制 canonical-target 注册；冷 hydration 对带显式
  visibility/semantics 的消息一律原样下发），任何 live 跳过都会造成
  live 不显示而 resume 显示的前后不一致（共享 reducer `app-events.ts`，
  两个 TUI 前端同享）。
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
  `appendWorkflowInterruptedNotices`）。回放/列举失败不阻断启动，但每次
  失败写单行 `options.stderr` 诊断（不污染协议 stdout）。`WorkflowCard`
  内联渲染在转写与交互区之间：每 run 一行（状态 | label | settled/used |
  actors），空草稿 `+`/`-` 切换展开 actors、reports 预览与 log tail；
  全部行经宽度感知截断（`truncateToWidth`，CJK/ANSI 安全）并按面板宽度
  硬截——超宽行会让 pi-tui doRender 抛错崩客户端。
- 信息面板：`Ctrl+O` 直开/关（`Ctrl+X` leader 已退役，见上节），
  `SessionInfoPanel` 经 `tui.showOverlay` 右栏呈现：mode/model/thought、ctx、
  token 用量、最近事件、todos、修改文件、subagents（running/ended）、MCP
  servers、最近网络请求；Esc 关闭。subagents 段渲染 `store.state.subagents`
  （`SubagentDirectory` 为唯一 owner），面板打开时主动触发 refresh 并经 store
  变更通知获得活体更新；MCP servers 无事件源，仍为打开时一次性拉取。

## `!` 本地 shell 逃逸

- composer 内 `!cmd`（trim 后以 `!` 开头且长度 > 1）不进入模型回合：在客户端
  workspace（`workspaceDirectory ?? cwd`）本地执行；`!cmd` 头行 + 退出状态 +
  输出（stdout/stderr 合并、120s 超时）作为 system 消息行写入 transcript；
  捕获输出以 `<shell-output …>` 块前置到下一条真实 prompt（slash 命令不消费
  缓冲，缓冲只交付一次）。core 没有「追加本地消息」的协议面，上下文交接只能
  在提交时发生；transcript 展示端把该块折叠为 `⤷ shell output:` 一行
  （截断时附 full output 路径），未闭合的手写标记原样保留。
- 执行 shell（fork 有意偏离 pi-mono 的确定性 bash 解析，恢复早期
  `80729ec8`/`f5241576` 交互式变体的动机：操作者的 rc alias/函数对 `!gs`
  这类手敲命令必须生效）：Unix 下可执行 bash/zsh 的 `$SHELL` 优先，以
  `+m -ic` 交互执行（交互 rc 加载——zsh 读 `.zshenv`/`.zshrc`、bash 读
  `.bashrc`，login rc（`.zprofile`/`.bash_profile`）不读；alias、函数、
  rc 导出的变量生效；不能用非交互 `-c` + 前缀注入替代——zsh 对 `-c` 串
  整体先解析，串内定义的 alias 对串内命令不生效）；`$SHELL`
  缺失/不可执行/非 bash-zsh 时回退 pi 链（`/bin/bash` → `which bash` →
  `sh`，非交互 `-c`，不加载 rc）。`-i` 无控制 tty 时 bash/zsh 的启动期
  stderr 诊断（job control / tty pgrp）属 shell 启动噪声：仅交互分支在
  finish 时从流首剔除**至多 2 行**带 shell 名前缀的已知诊断行——诊断只
  出现在启动、任何命令输出之前，限位保证长得像诊断的用户输出行（如
  `!echo 'no job control in this shell'`）不被无声吃掉；本地化措辞不
  匹配时漏删只是外观问题，反向才是数据丢失。spill 文件保留原始流首
  （清理后全文的定位不变）。Windows 维持 Git Bash 链（`where bash.exe`、
  旧 WSL bash.exe 走 stdin `-s`），绝不交互。POSIX detached（新 session、
  无控制终端）spawn——`+m` 关 monitor 且 detached 根除启动期 tcsetpgrp
  抢占（客户端 stdin read 不再 SIGTTIN 挂起）；超时/中止按进程树
  SIGKILL；completion 按 `exit` + idle-pipe grace 等待（pi#5303，
  detached 孙进程占住 stdout 管道不得挂起或截尾）。
- 输出按 pi-mono bash-executor 语义「保尾 + 落盘」：超过 64k 字符 / 2000 行
  （先到者）截断，保留尾部完整行；首行（从尾往前第一个超限行）单独超限到
  字符上限时保留该行末尾 64k 字符。截断发生时完整输出在
  `<tmpdir>/piz-shell-<hex>.log`（0600、`wx`）：累计越过 64k 字符阈值时懒
  开启并回填已缓冲块，行数超限而字符未越界时在完成时兜底开启；内存滚动
  缓冲上限 128k 字符（阈值 2 倍，与 pi 相同）。输出流与 pi 一致：逐块先
  清理（控制字符剔除）再计数、缓冲与落盘——控制字符密集的输出不会让滚动
  淘汰跑赢截断阈值，spill 文件即清理后全文；与 pi 的剩余差异仅阈值单位
  （64k 字符 vs 50KB 字节）。spill 存在即交付路径（展示端仍按截断门控），
  避免留下无人引用的文件。
- 截断告知三处同步：`<shell-output>` 块头加 `truncated=true` 与
  `full_output="<path>"` 属性，块尾与 transcript 行追加
  `[Output truncated. Full output: <path>]`（状态行同样提示）；展示折叠的
  `⤷ shell output:` 通知在截断时附路径。spill 写失败降级为无路径的截断
  标记并写单行 stderr 诊断，不影响命令结果本身。
- `!!cmd` 输出不进上下文（pi excludeFromContext 语义），但同样截断/落盘，
  transcript 行与状态行照常给出 full output 路径供操作者查看。

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
  工具行；权限/选择/问题面板可交互；`Ctrl+P/L/X/N/T/O`、`Shift+Tab`、双 Esc、
  Ctrl+C 语义符合本文件键位表。
- `--tui-frontend` 非法值报错；缺省走 opentui 行为不变（回归）。
- `node:test` 用例：投影（事件→Message[]）、提交分支、审批结果合成、
  选择/问题状态机、草稿命令解析、键位守卫；`VirtualTerminal` 冒烟渲染；
  转写渲染（`transcript-markdown.test.ts`）：表格分段/对齐/转义竖线、
  列宽配比与保底、无边框契约、流式半截表格、围栏内表格不切分（含未闭合
  fence）、json 围栏重新缩进与字面量保真、thought/tool 行形态与 part 间
  呼吸位，所有行宽不超给定宽度。
- 已知裁剪（后续按需）：子代理转写下钻浏览、workflow 卡与工具卡详情页联动、
  i18n copy 全量接线；先以英文 status 文案起步，结构预留。
