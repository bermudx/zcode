# Attach 模式自定义命令（/commands）— 设计决策

日期：2026-10-24 · 分支：`patch/attach-custom-commands` · 归属设计文档：
[tui-attach-shared-core.md](../../../apps/zcode-cli/docs/design/v2/tui-attach-shared-core.md)（P004）

## 问题

瘦客户端（`zcode-attach.cjs` / `piz`）缺失用户级（`~/.zcode/commands`）与
workspace 级（`<cwd>/.zcode/commands`）自定义 markdown 命令的 UX：

1. composer `/` 面板不列自定义命令。瘦客户端 bundle 不含 bootstrap
   （`build.mjs`：`无 bootstrap/core/adapters`；实测 dist/zcode-attach.cjs 中
   `listZCodeCustomCommands` 0 次出现），`attach-main.ts` 也不注入
   `listAttachCustomCommands`；`loadStartupOptions` 的 `.catch(() => undefined)`
   把这条路径静默吞掉。
2. `/help` 不列自定义命令：attach commandCenter 无 `listCustomCommands` dep。

## 关键事实（本分支实测/溯源，非推断）

**核心已经在 server 侧展开自定义命令。** `session/send` →
`record.app.sendInput` → input facade `prepareRuntimePrompt` →
`customCommandPromptResolver`（create-app.ts:912，带 `workingDirectory`）→
`resolveZCodeCustomCommandPrompt`。attach 客户端把未知 `/...` 按普通 prompt
转发（P005 `forwardUnknownSlashAsPrompt`）后，core 会展开它：

- 实测探针（tsx 直调 bootstrap `resolveZCodeCustomCommandPrompt`）：
  workspace `.zcode/commands/marker-probe.md` 被展开为
  `Run custom command /marker-probe.\nCommand source: project/zcode.…`；
  不存在的命令返回 `undefined`（原文透传给模型）。
- monolith headless（`prompt-command.ts` `routesToPromptCommandCenter`）同样
  把可解析的自定义命令路由给 facade 展开 —— facade 侧展开是代码库自己的
  新惯例，不是本 fork 的发明。
- core 侧展开器能力**更强**：经 `executionPort` 支持 `` !`cmd` `` 动态 shell
  展开；monolith TUI 的客户端侧展开器（`expandCliCustomCommandPrompt`）对
  同语法直接抛 "unsupported shell expansion"。若瘦客户端改为本地展开，
  反而会砍掉现在经由共享 core 可用的动态命令。

## 决策

**(a) 精简版：只加一个协议方法 `commands/referenceCatalog`（目录），展开留在
core 的 input facade，不加 `commands/load`，不在客户端接
`loadCustomCommand`。**

- 新方法：workspace 级、无会话、每次调用现扫（照 `skills/referenceCatalog`
  的 workspace 权威先例）。返回自定义命令全量元数据投影
  （name/description/scope/source/path/argumentHint/model/allowedTools/
  skills/rootPath/frontmatterKeys/disableNonInteractive + totalDiscovered），
  供 `/` 面板 suggestions 与 `/help` 使用。
- **不加 sessionId / authority 字段**：skills 的 session 权威来自 runtime
  context 初始化时冻结的技能目录；自定义命令没有对应的会话冻结状态
  （facade 在每次 send 时现扫），伪 session 权威是假精度。留 additive 空间。
- **展开不迁移到客户端**：瘦客户端保持把 `/name args` 原文经 session/send
  转发（现有行为），core 展开并把原文记为 `displayInput`。理由见上：能力
  对齐 headless 惯例、保留动态 shell 展开、单一事实源（P004「不在瘦客户端
  本地重扫；session 权威」同款论证 —— 瘦客户端不该持有第二份命令事实）。
- **保留名过滤**：目录剔除 `isReservedZCodeSlashCommandName` 命中项
  （照 `listProtocolSlashCommands` 先例）。与 monolith 本地面板（本地扫描、
  不过滤）有微小分叉：保留名命令在任何面板里都不可真正调用（facade 拒绝
  保留名），列出即是谎话；协议目录不撒谎。`disableNonInteractive` 不过滤、
  仅透传 —— attach TUI 是交互式客户端，interactive-only 命令应显示。
- **删除 `listAttachCustomCommands` dep**（run.ts/cli-types.ts）：monolith
  attach 路径改走同一协议目录，消除「客户端本地重扫 vs core 现扫」双事实源。

## 备选与否决理由

- **(b) 客户端本地扫描**（`listCustomCommandsForTui` 直用）：瘦客户端 bundle
  无 bootstrap；要么把 `createConfig`+`resolveZCodePlugins`+commands adapter
  打进瘦客户端（破坏 P004 瘦客户端边界），要么写第二份扫描器与 core 漂移
  （插件命令根、commandOverrides 禁用路径、workspace 身份语义都会分叉）。否决。
- **复用 session snapshot 的 `slashCommands` 数组**：仅
  name/description/inputHint/source，缺 `/` 面板 usage 提示与 `/help` 所需的
  scope/path；且只在 session create/resume 时刷新，会话中新建的命令不可见；
  skills 先例（专用目录方法）已给出更优形态。否决。
- **客户端侧展开（commands/load + loadCustomCommand dep）**：砍动态 shell
  展开、复制展开逻辑、协议面翻倍。否决（见决策第 2 条）。

## 2026-11-03：受信 `--no-plugins` 发现边界

- `noPlugins` 只来自进程入口 / server dependencies，不接受客户端 workspace、
  session 或 runtimeConfig 参数覆盖。入口持有同一策略：runtime startup、
  session snapshot、`commands/referenceCatalog`、workspace presentation、V4
  workspace config 与 input facade 的命令展开全部传递该门禁。
- 每次命令发现仍使用公共 `createConfig`，受信门禁以既有 CLI override 应用，
  保留 user/workspace 普通命令与 commandOverrides；不缓存、不截断目录，
  不增加跨 workspace 配置根。目录与展开均以本次调用的 workspace 为准。
- 有效 `plugins.enabled=false` 时，自定义命令发现不调用插件 resolver；
  startup 与通用插件 resolver 必须在调用 `resolveOfficialPluginRoots` 之前
  检查开关，避免空结果之前已经 seed/hash 内置插件资产。正常 enabled 路径不变。
- 顺序：trusted entrypoint → server deps / app options → 本次配置解析 →
  plugin gate → 普通命令扫描 → snapshot/catalog/展开。配置文件仍是命令元数据
  的唯一权威，没有第二份目录状态或会话冻结缓存。
- 回归覆盖 disabled config 不解析/seed 插件、no-plugin snapshot 保留 builtin
  与 workspace 命令、目录跨调用与 workspace 的新鲜度及输入展开。此修复只证明
  禁止的发现 IO 被移除；历史 snapshot 1383/1161ms 尚未受控归因，不作为性能收益。

## 已知边界（记录，不修）

- 目录在 attach 启动时取一次（`loadStartupOptions`），会话中新增/删除的命令
  下次启动才进面板 —— 与 monolith TUI（启动时本地扫描）一致的陈旧度。
- 输入历史把 `/review` 记为 prompt 而非 slash_command（monolith 本地展开路径
  记 slash_command）；displayInput 语义下两者展示等价。
- `/review` 不存在时，原文会真的发给模型（forwardUnknownSlashAsPrompt 的既
  有取舍：粘贴的绝对路径也以 `/` 开头，不能一刀切报 Unknown command）。
  monolith 交互式路径同形。
