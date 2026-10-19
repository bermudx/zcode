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
- 区分限制（已实测）：`--version` 对 zcode-allowance 与 zcode-cli 均输出 `0.16.9`；CLI 进程名会被改写为 `zcode-cli`（`apps/zcode-cli/packages/cli/src/process-name.ts`），`ps`/`pgrep` 看不到入口路径。区分只能依据启动入口：wrapper 指向的路径，或 AppImage 运行时（其子进程按 AppImage 惯例带 `APPIMAGE`、`APPDIR`，本机未实测）。运行中的 CLI 目前没有内生身份标记。

## 本分支（feat/allowance-herdr）

- 目的：在 OSS 代码加入 coding-plan 请求签名，产出 zcode-allowance（见上表）。本地分支，**未推送**（origin 为上游 `zai-org/ZCode`，无写权限；推送需先建 fork remote，且浅克隆 push 会被拒 `shallow update not allowed`，需先 `git fetch --unshallow`）；基于 `aac47556`（`feat: update to v3.15.1`）。
- 签名提交：`b84362b2` 协议调研与验收文档 → `a1956570` 共享签名失败 / 验证码策略 → `e94d47a5` CLI 请求签名实现（含 telemetry、规范与用例）。相对基线共 18 个文件、+2507/−41。
- 本地 TUI 提交：`fb5dfd5a`（空草稿 Ctrl-D 退出）、`51d1a420`（Ctrl-X 前缀 + Y 复制最后回复）、`4e8106ba`（选择面板 bracketed paste 修复：`app-selection-paste.ts` + 回归用例 `tests/tui-selection-paste.test.ts`）。
- 关键路径：实现 `apps/zcode-cli/packages/adapters/src/model/request-security-edition/`；设计规范 `apps/zcode-cli/docs/design/v2/model/client-request-signing.md`；用例 `apps/zcode-cli/packages/adapters/tests/client-request-signing.test.ts`（9 个）；协议与验收记录 `docs/coding-plan/client-request-signing-and-usage-allowance.md`。
- 构建产物 = 上表 zcode-allowance（`packages/cli/dist/zcode.cjs`）。herdr 集成不在此分支：hook 桥为本机 `~/.zcode/herdr-hook.sh`，代理清单在 herdr fork（`master` `838cb593`）。
- 更新流程：`~/.local/bin/zcode-allowance-update`（脚本与说明在 `~/build/testing/subagents/zcode-allowance-build/`）。默认模式 = fetch + rebase + 门禁（typecheck、9 个签名用例）+ 重建 + 冒烟；`--check` 探测上游是否前移，`--auto` 供定时任务，`--build-only` 手工解决冲突后重建。回滚：标签 `allowance/backup-*`；已构建基线：标签 `allowance/last-built`。wrapper 无需改动，运行中的会话需重启才生效。
- 认证现状（2026-10-19 实测）：OAuth access token 小时级失效（z.ai 业务交换 `project_token_login_failed`；CLI 从不写入/读取 `oauth:zai:refresh_token`，无刷新），因此重启动会反复要求登录；耐久路径 = 手工 coding-plan API key（composer 输入 `/login zai-coding-plan-api-key <KEY>` 单行，或登录面板输入行粘贴）。签名凭据只接受 JWT（`token_use: project_access`）或 `<id>.<secret>`（恰一个点）；解析失败 → `unsigned_sent reason="invalid_credential"` → 服务端 401 `身份验证失败`。身份哈希 = `key-${sha256(去空白).slice(0,24)}`，对照 `~/.zcode/v2/credentials.json`（只查结构，不读值）。诊断入口：`~/.zcode/cli/log/zcode-*.jsonl`。
- 已知基线问题（非本次改动引入）：tui 用例有 3 个 mode 相关失败（`Shift+Tab` 两项 + `mode composer popup`），在纯净上游 `aac47556` 同样失败（上游测试漂移）；`apps/zcode-cli/packages/tui` 的 `oxlint src` 在 `app-keyboard.ts`（413 行）与 `app.tsx`（416 行）超过 max-lines 400（有效行），由本地 TUI 提交引入，需按高内聚拆分模块修复，暂未处理；CLI 级 `pnpm --dir apps/zcode-cli lint`（turbo）在本机不可运行（turbo 未安装）。
