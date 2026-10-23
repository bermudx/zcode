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

## TUI 空闲 CPU（2026-10-21 已定位，未修复）

- 现象：空闲 zcode-cli（停在空 transcript 启动屏）每实例持续吃 ~20-25% 单核（实测 PID 30698：17¾h 累计 251 CPU 分钟）。
- 根因：`packages/tui/src/app-motion.tsx` 的 `useShimmerFrame` 以 80ms `setInterval` 永久驱动；`app-view.tsx:184` 默认 `animateEmptyLogo: !options.noColor`；`ShimmerText` 每帧把 logo（6 行 ≈ 250 个 per-char `<text>` 节点 + 逐字符 hex 混色）整棵重渲染，经 react-reconciler → opentui `setStyledText`/WASM 文本整形全量走一遍。放 herdr 后台 pane 的空会话同样烧。
- 放大器：运行时 `require("react")` 在 NODE_ENV 未设为 production 时解析到 `react.development.js`（root node_modules），reconciler 开销再乘 2-4×。
- 修复方向（未实施）：非焦点/后台 pane 暂停动画；或几秒后静置为静态 logo；shimmer 改走 opentui 原生着色而非 React 状态；构建强制 production React；每行用 styled segments 替代 per-char 节点。
- RAM（2026-10-21 实测，对 ~15min 新会话强制 GC 后）：RSS ~0.8-1GB/实例，大头不是业务数据：~100MB opentui WASM 线性内存（83MB WebAssembly.Memory + 16MB cell buffers）+ ~62MB V8 保留的 monolith bundle 源码字符串（zcode.cjs 30MB → UTF-16 57MB，V8 作为 script source 持有）+ ~40MB 已编译 code/closure + ~95MB glibc malloc arena + ~60MB Node 基线；真实应用状态（transcript/React 树/store）仅 ~50-60MB。GC 前 heapTotal 涨到 ~360MB（shimmer 高频垃圾），强制 GC 归还 237MB。每个会话还带 ~200MB 的 zcode-node-repl-mcp 子进程。多开 = 每实例全价，无 Electron 式摊销。
- 每会话子进程才是最大头（同日实测，环境 herdr 多会话）：每个 zcode-cli 会话 eagerly spawn 4×~180MB office 插件 MCP（presentations/documents/pdf/spreadsheets，env 带 ZCODE_PLUGIN_ID 可鉴别）+ 1×~190MB zcode-node-repl-mcp（browser-use/cua 宿主）≈ 930MB/会话；主进程 + 子进程合计 ~1.8-2.2GB/会话。在 /tmp 新目录里插件解析史多（8×zcode-cli + 2×mcp 子进程）——插件集按 workspace 解析，直接乘固定成本。office 插件子进程空闲 CPU≈0，纯内存代价。
- tui-pi 前端实测（worktree rapid-cloud-030e，`tui --tui-frontend=pi`，script 伪终端下）：主进程 468-483MB 稳定、空闲 CPU 0.0%（vs opentui 前端 ~830-950MB + 20-25% CPU）。tui-pi 是 esbuild external（build.mjs resolveBuildExternal 含 @zcode/tui-pi），运行时动态 import，不进 monolith；@earendil-works/pi-tui 3.3MB 无 WASM，deps 仅 get-east-asian-width+marked。注意：script 假终端无 query 应答，TUI 可能未完成首帧绘制——进程成本数据有效，渲染行为另验。MCP 子进程与前端无关（pi 前端同样 spawn）。
- 测量脚本：/tmp/zcode-probe/probe.sh（前端 A/B 空闲成本）、/tmp/zcode-probe/kids.sh（子进程鉴别，env 名单 + cwd）。坑：pgrep -f 会匹配到包含同样模式的自 shell cmdline——模式只写在脚本文件里，别写在内联命令里。

## tui-attach 共享 core 模式（2026-10-21 已实现，worktree rapid-cloud-030e，未推送）

- 位置：分支 `worktree/rapid-cloud-030e` 提交 `32dc8799..3b9462af`（spec → server → client → e2e）。设计文档 `apps/zcode-cli/docs/design/v2/tui-attach-shared-core.md` + `tui-attach-client-build.md`。实现在 `packages/cli/src/attach/`（client/session/tui-options/command/argv）+ bootstrap socket listener + `packages/shared/src/app-server-attach/`。
- 用法：`zcode tui --tui-frontend=pi --shared-core`（首客户端自动 detached 拉起 `app-server --socket <~/.zcode/v2/sockets/core-<hash>.sock> --no-plugins`；原子锁防双启；停止 = `kill $(cat <sock>.pid)`）。注意 CLI 里 `--attach` 是 prompt 附件 flag，别混。
- 此模式：零插件/零 MCP/零子进程（noPlugins 是入口级硬门，session/create 参数也重开不了）；服务端会话存活于客户端退出之后；断线 status line 提示 + 指数退避重连（上限 30s）+ session/resume 冷恢复；ephemeral 零轮会话在 core 重启后不可恢复（UI 如实提示）。
- 实测内存（`apps/zcode-cli/scripts/measure-attach.sh`，瘦客户端 `zcode-attach`，N=5）：每客户端 160-166MB（<200 达标）、服务端 420MB、总 1237MB（5 会话 vs 现状 ~9-11GB，≈87% 降幅）。中间态：monolith 路径客户端 418-435MB（未达 <200）→ slice D 用独立 1.5MB client-only bundle（`attach-main.ts` → `dist/zcode-attach.cjs`，DI 注入剥离 bootstrap/adapters 依赖链）收口。客户端 ~160MB ≈ V8+TUI 基线，再降需缩 TUI 面（超范围）。core spawn 可用 ZCODE_SERVER_BIN 覆盖。
- 日常入口：`~/.local/bin/piz`（瘦客户端 wrapper；ZCODE_SERVER_BIN 钉在本 worktree 的 zcode.cjs——PATH zcode 是 allowance 构建，无 --socket。core spawn 可用 env 覆盖）。在 pane 里 cd 到 workspace 后直接 `piz`；第二个 pane 同 workspace 即共享同一 core。停 core：`kill $(cat ~/.zcode/v2/sockets/core-*.pid)`（SIGTERM 后 .sock 会清理，.pid/.info 遗留属设计内，下次 ensureServer 原子回收）。
- 坑（2026-10-21 两次实战）：①会话模型目录由 `session/requestRuntimePreferences`（scope: runtime-materialization）的**应答**物化——应答不合 schema（缺 nativeSearchEnhancementsEnabled 等必填 boolean）= 无 provider 的裸 runtime = 「No selectable models」。桌面端是参照实现。②core 是长寿命进程：dist 重建后**运行中的 core 不会自动更新**，必须 TERM 掉旧 core（.pid 文件）才会被下次 piz 重拉新构建——升级后记得清 core。
- 验证纪律（2026-10-21 实战教训，两次踩坑）：script 假 pty 只能验证进程/内存，不能验证渲染与终端交互——真终端会应答 OSC 10/11/4 + DA 查询，应答泄漏/首帧绘制/输入路径只能在应答终端里暴露。宣称「能用了」之前必须：`tmux new-session -d ... 'piz'` → `capture-pane` 查泄漏序列与渲染 → `send-keys` 实际输入验证 composer 回显 + `ss -xp` 确认 ESTABLISHED。仓内已有 responding-pty 回归测试（tui-pi tests/terminal-drain.test.ts）兜 CI；手工 tmux 检查仍是发货门。坑：shell 变量拼接 `${f%.pid}.sock` 遇 `x.sock.pid` 文件名会拼出 `.sock.sock` 假阳性；pgrep -f 永远会匹配自 shell cmdline（今天第三次白坎：模式用 `[b]e` 字符类绕开）。
- 日常入口：`~/.local/bin/piz`（瘦客户端 wrapper；ZCODE_SERVER_BIN 钉在本 worktree 的 zcode.cjs——PATH zcode 是 allowance 构建，无 --socket。core spawn 可用 env 覆盖）。在 pane 里 cd 到 workspace 后直接 `piz`；第二个 pane 同 workspace 即共享同一 core。停 core：`kill $(cat ~/.zcode/v2/sockets/core-*.pid)`（SIGTERM 后 .sock 会清理，.pid/.info 遗留属设计内，下次 ensureServer 原子回收）。
- 已知 deferred：dwf list/replay/resume、expert workflows、listPlugins 未接（走 optional-port「不可用」语义）；断线全幅 banner 待 TUI 侧设计。
- 诊断手法：对运行中的 node 进程 `kill -USR1 <pid>` 开 inspector → `ss -tlnp`（不带 K！）找端口 → `curl /json` 拿 ws URL → `node /tmp/cpuprof.mjs <ws-url> out.cpuprofile 5000` 走 CDP `Profiler` 采样分析（yama=1 挡 ptrace/eu-stack 时此法可用）；内存用 `/tmp/cdpmem.mjs`（GC 前后 memoryUsage）、`/tmp/cdpsnap.mjs` + `/tmp/snapanalyze.mjs`（heap snapshot 聚合）、`/tmp/snapretainers2.mjs`（retainer 链）。SIGUSR1 开的 inspector 进程内无法关闭，重启会话才消失。

## 本分支（feat/allowance-herdr）

- 目的：在 OSS 代码加入 coding-plan 请求签名，产出 zcode-allowance（见上表）。本地分支，**未推送**（origin 为上游 `zai-org/ZCode`，无写权限；推送需先建 fork remote，且浅克隆 push 会被拒 `shallow update not allowed`，需先 `git fetch --unshallow`）。2026-10-20 rebase 到 `3c5b2276`（`chore: sync ZCode source`，v0.17.0，含 session-store 软删除重构与 tui.tsx 启动屏 Ctrl+C 泄漏修复）；最初基于 `aac47556`（`feat: update to v3.15.1`）。
- 签名提交（rebase 后哈希）：`7d7e5304` 协议调研与验收文档 → `df8bc4a7` 共享签名失败 / 验证码策略 → `86ab5b13` CLI 请求签名实现（含 telemetry、规范与用例）。
- attach 分支（worktree-rapid-cloud-030e，本地未推）：`32dc8799` spec → `e1b11b32` server 入口 → `214ec873` 瘦客户端 → `3b9462af` e2e → `ab49b084` 独立 attach 产物 → `fix(tui-pi)` 终端应答泄漏修复 → `ba027b0d` 行宽截断 → `c3159c08` daily-driver 加固（模型轮换/队列/重连/自登记）→ `aae1783b` 会话选择语义 + Ctrl-C 字节/信号同义。
- attach 实战教训（2026-10-22 gauntlet，全部实测定位）：①legacy `session/setModel` 回包是快照本体（无 `{snapshot}` 包装）且 `available` 被 `modelAvailability:"current"` 过滤成仅当前模型——客户端必须认直返形状 + 过滤形状保旧 catalog；②该链路只发 `state.updated` patch 不发 raw `ModelSelected`，客户端要合并后补发合成事件；③`session/list` 返回顺序不保证，「最近会话」必须按 `updatedAt` 显式取最大，`at(-1)` 恢复到陈旧会话；④`.pid/.info` 只能由 bind 成功的 server 在 listen 后自写——客户端写会在双 spawn 竞争下登记死进程（`probeSocket` 只证明“有人在听”，不证明“我的 child 在听”）；⑤给 Devin 报验收标准时必须要求“真模型回合”而非状态行——模型 LIST 本地就能渲染，回合才是鉴权/物化路径；⑥fuser 输出含路径数字，解析 pid 用 `tr -cd '0-9\n' | tail -1`。
- attach 会话选择与 Ctrl-C（2026-10-22 用户实测报障，根因已修）：
  - **默认不得 resume**：attach 入口曾无条件 resume 本 workspace 最近会话 → piz 永远进旧对话、无法开新会话。主 CLI 语义是「默认新会话，`-c` 才继续」；现 attach 对齐：默认 `session/create`、`-c/--continue` 最近会话、`--resume <id>` 指定会话。瘦客户端 `zcode-attach` 自带 parseArgs，必须同步补 `-c/--continue/--resume`（piz wrapper 用 `"$@"` 透传，旗标能到）。
  - **Ctrl-C 有两条投递路径**：字节（raw 模式 0x03）与信号（SIGINT）。herdr pane 把 Ctrl-C 递送为**信号**；缺 SIGINT handler 时 Node 默认直接终止（exit 130）→ 首按即死。字节路径的双击确认一直是对的，坑只在信号路径。现由 `tui-pi/src/ctrl-c-intent.ts` 做唯一 owner：两条路径共享同一 guard/状态，`run-tui` 装 SIGINT handler 转发到同一 intent，**退出时必须 `process.off`**（signal handler 是 ref 句柄，不摘会让进程在 TUI 退出后挂着不退）。
  - 教训：**“终端发的是字节还是信号”要看部署环境**——tmux 走字节、herdr 走信号，只在 tmux 里测会漏掉信号路径。同类教训：分叉/上游同步类改动要在**两个**环境各验一遍。
  - 诊断手法：`stty -a -F <tty>` 看 `-isig`（raw 模式）判断字节路径；`kill -INT <pid>` 后看进程是否存活判断信号路径有无 handler。
- 本地 TUI 提交：`090276d9`（空草稿 Ctrl-D 退出）、`43549d6b`（Ctrl-X 前缀；其 Y 复制最后回复已被后续 Ctrl+Y 取代）、`31a770cc`（选择面板 bracketed paste 修复：`app-selection-paste.ts` + 回归用例 `tests/tui-selection-paste.test.ts`）、`c0abfcb1`（键位整合：composer 键处理拆分至 `app-composer-keyboard.ts`，定稿 Ctrl+P/Ctrl+L/Ctrl+Y/双 Esc，oxlint max-lines 修复）、`da309372`（busy 提交本地队列 + settle flush + 空输入 Enter steer；`-c`/`--resume` 首屏 transcript 回放）。
- TUI busy 提交语义（2026-10-21 实测验证）：busy 提交进 TUI 本地待发队列（不进 runtime queue lane——plain app 上该 lane 没有晋升者，输入会随 turn 结束丢失）；turn settle（complete/error/取消）后逐条自动 flush 为新 turn；composer 为空且有队列时按 Enter = 全部以 `queueDelivery: "guide"` steer 进当前 turn（tool/text 边界 drain）。本地队列易失，不做持久化。实现见 `app-submit.ts` / `app-submit-controller.ts` / `app.tsx`（flush effect + `steerQueuedInputs`），用例 `tests/tui-queue-steer.test.ts`。测试坑：testRender 里把 typeText 和 pressEnter 放同一 act 会把草稿更新批进一个 commit，opentui 的 content-change 回声会把旧 buffer 内容拼进下一次输入——分 act 并在提交后留 2-3 帧即可。
- `-c` / `--resume` 首屏：`loadResumedTranscript`（`tui-prompt-handler-queries.ts`）经 `loadSessionTranscript` 读 store，经 `initialResult.restoredMessages` 注入 TUI 首屏（103 条消息实测渲染）；transcript 读取失败静默退回空首屏。runtime hydration 仍延迟到首次提交。
- TUI 键位（当前行为）：`Ctrl+P` 轮换模型、`Ctrl+L` 打开模型选择器、`Ctrl+Y` 复制最后回复、`Esc` 连按两次（2s 内）暂停输出；`Ctrl+C` 不再复制选中文本，`Ctrl+U` / `Ctrl+R` / `Ctrl+X Y` 取消。实现见 `app-composer-keyboard.ts` 与 `app-keyboard.ts`，用例 `tests/tui-keymap.test.ts`。
- 关键路径：实现 `apps/zcode-cli/packages/adapters/src/model/request-security-edition/`；设计规范 `apps/zcode-cli/docs/design/v2/model/client-request-signing.md`；用例 `apps/zcode-cli/packages/adapters/tests/client-request-signing.test.ts`（9 个）；协议与验收记录 `docs/coding-plan/client-request-signing-and-usage-allowance.md`。
- 构建产物 = 上表 zcode-allowance（`packages/cli/dist/zcode.cjs`）。herdr 集成不在此分支：hook 桥为本机 `~/.zcode/herdr-hook.sh`，代理清单在 herdr fork（`master` `838cb593`）。
- 更新流程：`~/.local/bin/zcode-allowance-update`（脚本与说明在 `~/build/testing/subagents/zcode-allowance-build/`）。默认模式 = fetch + rebase + 门禁（typecheck、9 个签名用例）+ 重建 + 冒烟；`--check` 探测上游是否前移，`--auto` 供定时任务，`--build-only` 手工解决冲突后重建。回滚：标签 `allowance/backup-*`；已构建基线：标签 `allowance/last-built`。wrapper 无需改动，运行中的会话需重启才生效。坑（2026-10-20 实测）：门禁 typecheck 在依赖包重建**之前**运行，上游同步改动 contracts/adapters 源码时旧 dist 会导致 `no exported member 'ToolSearchMode'` 一类假失败——先按脚本同款逻辑重建变更包（`git diff --name-only allowance/last-built HEAD -- apps/zcode-cli/packages` 推导有 build 脚本的包）再跑 `--build-only` 即绿。
- 认证现状（2026-10-19 实测）：OAuth access token 小时级失效（z.ai 业务交换 `project_token_login_failed`；CLI 从不写入/读取 `oauth:zai:refresh_token`，无刷新），因此重启动会反复要求登录；耐久路径 = 手工 coding-plan API key（composer 输入 `/login zai-coding-plan-api-key <KEY>` 单行，或登录面板输入行粘贴）。签名凭据只接受 JWT（`token_use: project_access`）或 `<id>.<secret>`（恰一个点）；解析失败 → `unsigned_sent reason="invalid_credential"` → 服务端 401 `身份验证失败`。身份哈希 = `key-${sha256(去空白).slice(0,24)}`，对照 `~/.zcode/v2/credentials.json`（只查结构，不读值）。诊断入口：`~/.zcode/cli/log/zcode-*.jsonl`。
- 已知基线问题（非本次改动引入）：tui 用例有 3 个 mode 相关失败（`Shift+Tab` 两项 + `mode composer popup`），在纯净上游 `aac47556` 同样失败（上游测试漂移）。CLI 级 `pnpm --dir apps/zcode-cli lint` 直接运行找不到 turbo；用 `PATH="$PWD/node_modules/.bin:$PATH"` 注入后可运行，但 `@zcode/cli`、`@zcode/contracts`、`debug` 仍有既有 max-lines 错误（与 TUI 无关）。`apps/zcode-cli/packages/tui` 的 `oxlint src` 已通过拆分 `app-composer-keyboard.ts`、`app-copy.ts` 与 `app-permission.ts` 的 hooks 修复。
