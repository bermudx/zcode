## 核心原则

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行：

| 用途             | 命令                                                 |
| ---------------- | ---------------------------------------------------- |
| 类型检查         | `pnpm typecheck`                                     |
| Lint             | `pnpm lint` / `pnpm lint:fix`                        |
| 格式检查         | `pnpm fmt:check`                                     |
| 桌面开发         | `pnpm dev:desktop`                                   |
| Web 开发         | `pnpm dev:web`                                       |
| 提交前检查       | `pnpm verify:pre-push`（Lint、架构检查与受影响单测） |
| 架构检查         | `pnpm architecture:check --changed`                  |
| 模块阅读包       | `pnpm architecture:context <module-id>`              |
| 未使用依赖与导出 | `pnpm knip`                                          |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`                |

affected 使用 Vitest 官方选择，只运行选中的根 UT；选中整个套件时说明并跳过 UT，成功退出，不因此阻止 Push；不替代 CLI 测试或桌面 E2E。全量使用 `pnpm test` / `pnpm test:unit`，仅在用户明确要求时调用。范围与输出合同见 [pre-push 说明](docs/testing/pre-push-hook.md)。

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

- `packages/desktop`：Electron main、host、renderer。
- `packages/web`、`packages/server`：Web 客户端与服务端。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `apps/zcode-cli`：Agent CLI 与运行时。
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 有行为改动时先补充对应测试；交互改动需要 E2E 场景。检查测试与实现是否一致，并实际执行可用的验证。未执行或环境受限时如实说明。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- PR 描述须说明背景、设计意图与修改前后行为；包含 bugfix 时逐项说明触发场景、根因证据、修复机制及回归验证，并尽量关联已有工单链接。未确认的根因或引入提交如实标注，不根据模块或时间接近推断归因。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows、macOS 和 Linux。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`，提供严格类型与运行时校验。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。
- Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存任务队列、快照等业务状态。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。

## 本机 ZCode 产物身份（四类名称）

本机并存四种 ZCode 产物，沟通、调试与安装时统一使用下列名称：

| 名称 | 来源 | 入口 / 位置 |
| ---- | ---- | ----------- |
| **zcode-allowance** | 本仓库 `feat/allowance-herdr` 构建（请求签名，150% 编码套餐额度） | `~/.local/bin/zcode`（wrapper → 本仓库 `apps/zcode-cli/packages/cli/dist/zcode.cjs`） |
| **zcode-oss** | 本仓库上游原版构建（无签名补丁，对照基线） | 未单独安装；如需共存，安装为独立入口，不覆盖 `zcode` |
| **zcode-cli** | 官方 CLI（官方安装/升级流程写入的 3.14.5 home） | `~/.local/share/zcode-cli-3.14.5/zcode.cjs`；官方入口备份 `~/.local/bin/zcode.official-wrapper` |
| **Zcode AppImage** | 官方桌面应用 | `~/Applications/zcode.AppImage`；desktop entry `~/.local/share/applications/zcode.desktop` |

- 当前 `zcode` 命令 = zcode-allowance（刻意替换官方入口）；行为改动需重新产出本仓库 `dist/zcode.cjs` 才生效。
- 区分限制（已实测）：`--version` 对 zcode-allowance 当前输出 `0.17.0`（zcode-cli 官方 3.14.5 home 为 `0.16.9`，随上游同步各自变化）；CLI 进程名会被改写为 `zcode-cli`（`apps/zcode-cli/packages/cli/src/process-name.ts`），`ps`/`pgrep` 看不到入口路径。区分只能依据启动入口：wrapper 指向的路径，或 AppImage 运行时（其子进程按 AppImage 惯例带 `APPIMAGE`、`APPDIR`，本机未实测）。运行中的 CLI 目前没有内生身份标记。

## 本分支（feat/allowance-herdr）

- 目的：在 OSS 代码加入 coding-plan 请求签名，产出 zcode-allowance（见上表）。本地分支，**未推送**（origin 为上游 `zai-org/ZCode`，无写权限；推送需先建 fork remote，且浅克隆 push 会被拒 `shallow update not allowed`，需先 `git fetch --unshallow`）。2026-10-20 rebase 到 `3c5b2276`（`chore: sync ZCode source`，v0.17.0，含 session-store 软删除重构与 tui.tsx 启动屏 Ctrl+C 泄漏修复）；最初基于 `aac47556`（`feat: update to v3.15.1`）。
- 签名提交（rebase 后哈希）：`7d7e5304` 协议调研与验收文档 → `df8bc4a7` 共享签名失败 / 验证码策略 → `86ab5b13` CLI 请求签名实现（含 telemetry、规范与用例）。
- 本地 TUI 提交：`090276d9`（空草稿 Ctrl-D 退出）、`43549d6b`（Ctrl-X 前缀；其 Y 复制最后回复已被后续 Ctrl+Y 取代）、`31a770cc`（选择面板 bracketed paste 修复：`app-selection-paste.ts` + 回归用例 `tests/tui-selection-paste.test.ts`）、`c0abfcb1`（键位整合：composer 键处理拆分至 `app-composer-keyboard.ts`，定稿 Ctrl+P/Ctrl+L/Ctrl+Y/双 Esc，oxlint max-lines 修复）。
- TUI 键位（当前行为）：`Ctrl+P` 轮换模型、`Ctrl+L` 打开模型选择器、`Ctrl+Y` 复制最后回复、`Esc` 连按两次（2s 内）暂停输出；`Ctrl+C` 不再复制选中文本，`Ctrl+U` / `Ctrl+R` / `Ctrl+X Y` 取消。实现见 `app-composer-keyboard.ts` 与 `app-keyboard.ts`，用例 `tests/tui-keymap.test.ts`。
- 关键路径：实现 `apps/zcode-cli/packages/adapters/src/model/request-security-edition/`；设计规范 `apps/zcode-cli/docs/design/v2/model/client-request-signing.md`；用例 `apps/zcode-cli/packages/adapters/tests/client-request-signing.test.ts`（9 个）；协议与验收记录 `docs/coding-plan/client-request-signing-and-usage-allowance.md`。
- 构建产物 = 上表 zcode-allowance（`packages/cli/dist/zcode.cjs`）。herdr 集成不在此分支：hook 桥为本机 `~/.zcode/herdr-hook.sh`，代理清单在 herdr fork（`master` `838cb593`）。
- 更新流程：`~/.local/bin/zcode-allowance-update`（脚本与说明在 `~/build/testing/subagents/zcode-allowance-build/`）。默认模式 = fetch + rebase + 门禁（typecheck、9 个签名用例）+ 重建 + 冒烟；`--check` 探测上游是否前移，`--auto` 供定时任务，`--build-only` 手工解决冲突后重建。回滚：标签 `allowance/backup-*`；已构建基线：标签 `allowance/last-built`。wrapper 无需改动，运行中的会话需重启才生效。坑（2026-10-20 实测）：门禁 typecheck 在依赖包重建**之前**运行，上游同步改动 contracts/adapters 源码时旧 dist 会导致 `no exported member 'ToolSearchMode'` 一类假失败——先按脚本同款逻辑重建变更包（`git diff --name-only allowance/last-built HEAD -- apps/zcode-cli/packages` 推导有 build 脚本的包）再跑 `--build-only` 即绿。
- 认证现状（2026-10-19 实测）：OAuth access token 小时级失效（z.ai 业务交换 `project_token_login_failed`；CLI 从不写入/读取 `oauth:zai:refresh_token`，无刷新），因此重启动会反复要求登录；耐久路径 = 手工 coding-plan API key（composer 输入 `/login zai-coding-plan-api-key <KEY>` 单行，或登录面板输入行粘贴）。签名凭据只接受 JWT（`token_use: project_access`）或 `<id>.<secret>`（恰一个点）；解析失败 → `unsigned_sent reason="invalid_credential"` → 服务端 401 `身份验证失败`。身份哈希 = `key-${sha256(去空白).slice(0,24)}`，对照 `~/.zcode/v2/credentials.json`（只查结构，不读值）。诊断入口：`~/.zcode/cli/log/zcode-*.jsonl`。
- 已知基线问题（非本次改动引入）：tui 用例有 3 个 mode 相关失败（`Shift+Tab` 两项 + `mode composer popup`），在纯净上游 `aac47556` 同样失败（上游测试漂移）。CLI 级 `pnpm --dir apps/zcode-cli lint` 直接运行找不到 turbo；用 `PATH="$PWD/node_modules/.bin:$PATH"` 注入后可运行，但 `@zcode/cli`、`@zcode/contracts`、`debug` 仍有既有 max-lines 错误（与 TUI 无关）。`apps/zcode-cli/packages/tui` 的 `oxlint src` 已通过拆分 `app-composer-keyboard.ts`、`app-copy.ts` 与 `app-permission.ts` 的 hooks 修复。

## tui-attach 共享 core（piz）——本 worktree 的日常入口

- 入口 `~/.local/bin/piz` → `dist/zcode-attach.cjs`；core 由 `ZCODE_SERVER_BIN` 钉在本 worktree 的 `dist/zcode.cjs`。**tui-pi 改动不重建就不生效**：`pnpm --dir apps/zcode-cli/packages/tui-pi build`（tsc + esbuild → `dist/index.js`，运行时动态 import）之后 `pnpm --dir apps/zcode-cli/packages/cli build:attach`（≈0.5s）。core 是长寿命进程，改协议/服务端才需要重建 `zcode.cjs` 并 `kill $(cat <sock>.pid)`。
- 协议事实（2026-10-22 实测，勿凭直觉）：`session/create` 的 `settings.model.available` 是**完整 catalog**；`session/subscribe`、`session/setModel` 等 mutation 回包与 `state.updated` patch 的 `available` 是 `modelAvailability:"current"` **过滤投影（只剩当前项）**。任何“整包替换快照”的写法都会让 Ctrl+P/Ctrl+L 的可选项缩成 1 项——`/new`（newApp → toHandle → subscribe includeSnapshot）就是这条路径，症状是首次 Ctrl+P 报 `Model is not available`、随后 `Only one model available`（失败回包会把 1 项列表写回 TUI store）。修法：`attach-catalog.ts` 只增不减合并 + `adoptSnapshot()`/`mergeSettings()` 统一走它。
- `session/send` 的附件协议形状是 `{kind, localPath | dataBase64 | textContent, filename}`（server `mapProtocolPromptAttachment` 只认这些键）；TUI 的 `{type, path, content}` 必须经 `attach-attachments.ts` 转换，否则**静默丢弃**——提交成功、模型什么都没收到。
- 重连会换 client：attach 里的会话级 request 一律走 `runtime.currentClient()`，捕获构造期 client 会让 `/new`、`/resume`、`/fork` 打到死 socket。
- 读 core 会话历史做验证时，`session/messages` 常报 `Session is not active`：空闲会话会被移出活跃 registry（session residency）。先 `session/resume {sessionId, workspace}` 再读。
- pi-tui 渲染不变量：**任何一行超过终端宽度，`TuiMainScreen.doRender` 直接 throw 终止进程**（崩溃签名 `Rendered line N exceeds terminal width (X > Y)`，日志 `/tmp/pi-tui-crash.log`）。所有吃外部文本的组件（用户输入/粘贴、system notice、`!` 输出、工具输出）必须先 `wrapTextWithAnsi` 折到 `width` 再上色；`MessageRow.render` 末尾另有 `truncateToWidth` 兜底。实测：211 列终端粘贴一行 212 列即崩。
- composer 能力：`@path` 补全需要 PATH 上有 `fd`/`fdfind`（pi-tui 的 `CombinedAutocompleteProvider` 没 fd 时 `getFuzzyFileSuggestions` 直接返回 []，弹窗完全不出现）；提交时 `mentions.ts` 把 `@token`（含 `@"带空格 的路径"`）解析成 file attachment。`!cmd` 在**客户端**工作区执行（`shell.ts`，120s、输出截断），打印 `!cmd` + 输出行，并把输出以 `<shell-output …>` 块前置到下一条 prompt——core 没有“追加本地消息”的协议面，所以上下文交接只能在提交时做；slash 命令不消费缓冲。transcript 里该块折叠成一行 `⤷ shell output: …`。
- 架构门禁：`pnpm architecture:check --changed` 上限 800 行/文件；`tui-pi/src/app.ts` 已到 797，下一次加代码必须再拆（现有拆分：`model-chords.ts` Ctrl+P/Ctrl+L、`shell-prompt.ts` `!` 交接、`rows.ts` 渲染、`mentions.ts`）。
- 验证配方（真终端才有意义，script 假 pty 只能测进程）：`tmux new-session -d -s probe -x 120 -y 40 'cd <ws> && piz'` → `capture-pane -p` 看渲染 → `send-keys` 验证 `@` 弹窗、`/new` 后 Ctrl+P、`!cmd`、长粘贴（`load-buffer` + `paste-buffer -p`）。models-probe 一类脚本在 `/tmp/zcode-probe/`（自己 spawn core + 自己应答 `session/requestRuntimePreferences`，否则无 provider）。
