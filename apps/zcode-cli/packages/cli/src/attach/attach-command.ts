// `zcode attach` / `tui --shared-core` 入口：解析 socket → ensureServer 拉起
// 共享 core（无则 spawn，detached + --no-plugins）→ 连接握手（协议版本校验）
// → 建 AttachSessionHandle + TuiPromptHandler → runTui。
// 客户端不持有业务状态；退出只断连接，core 端 session 照常存活。
import {
  ZCODE_PROTOCOL_VERSION,
  ZCODE_MODEL_REASONING_SEPARATOR,
  ZCODE_WORKSPACE_IDENTITY_ENV,
  resolveWorkspaceKey,
  resolveZCodeRuntimeEnv,
  zcodeProtocolMethods,
  zcodeSessionStateSnapshotSchema,
  type ZCodeModelOption,
} from "@zcode/shared";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { CliResumeRequest, CliTuiFrontend, RunDependencies } from "../cli-types.js";
import { createNodeClipboardImageReader } from "../clipboard-image.js";
import { createNodeClipboardTextWriter } from "../clipboard-text.js";
import { listSlashCommandSuggestions } from "../command-center.js";
import { ensureServer } from "../app-server-spawn.js";
import { connectAttachClient } from "./attach-client.js";
import { resolveLocale } from "@zcode/i18n";
import { resolveWorkspaceGitBranch } from "../tui-workspace-git.js";
import { loadPiTuiRuntime } from "../tui-pi-runtime-loader.js";
import { loadTuiRuntime } from "../tui-runtime-loader.js";
import { DEFAULT_CLI_WORKFLOW_MODE } from "../workflow-mode.js";
import { AttachSessionHandle } from "./attach-session.js";
import { projectAttachTranscriptMessages } from "./attach-projection.js";
import { listAttachSkillCatalog, toSkillSuggestions } from "./attach-skills.js";
import { listAttachCommandCatalog, toCommandCenterCustomCommandList } from "./attach-commands.js";
import {
  AttachProtocolVersionError,
  AttachRuntime,
  createAttachPromptHandler,
  resolveAttachResumeTarget,
} from "./attach-tui-options.js";
import { createAttachHerdrReporter } from "./herdr-reporter.js";

/** herdr 上报诊断：常开但 ≥60s 节流一行 stderr。TUI 全屏模式下偶发
 *  一行可接受，herdr 长时间不可用时也不至刷屏。 */
const createHerdrDiagnosticWriter = (
  stderr: { write(chunk: string): unknown },
): ((error: unknown) => void) => {
  let lastWrittenAt = 0;
  return (error) => {
    const now = Date.now();
    if (now - lastWrittenAt < 60_000) return;
    lastWrittenAt = now;
    stderr.write(
      `herdr report failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  };
};

/** attach 传输诊断：与 herdr 同款 ≥60s 节流的 stderr writer。传输内建信号
 *  （丢畸形行、坏协议消息、socket 错误、resubscribe 失败）若不接 logger 就
 *  全部静默成 no-op——坏流静默降级违背“跑了就要有信号”。诊断走 stderr，
 *  绝不进协议 stdout。 */
const createAttachTransportLogger = (
  stderr: { write(chunk: string): unknown },
): { warn: (message: string, context?: Record<string, unknown>) => void } => {
  let lastWrittenAt = 0;
  return {
    warn: (message, context) => {
      const now = Date.now();
      if (now - lastWrittenAt < 60_000) return;
      lastWrittenAt = now;
      const detail = context === undefined ? "" : ` ${JSON.stringify(context)}`;
      stderr.write(`attach transport: ${message}${detail}\n`);
    },
  };
};

/**
 * 解析 attach 入口的会话选择目标（-c/--resume/默认新会话）：实现与 TUI 内
 * /resume <id> 共用（裸 /resume 走 picker，不走这里），见
 * attach-tui-options.ts 的 resolveAttachResumeTarget。
 */
export { resolveAttachResumeTarget } from "./attach-tui-options.js";

/**
 * attach 入口：瘦客户端只负责传输与呈现，core 承载会话/运行时/存储。
 * 版本不匹配直接失败并给出恢复指引——不尝试协议降级。
 */
export const runAttachCommand = async (
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  version: string,
  tuiFrontend: CliTuiFrontend = "pi",
  resumeRequest?: CliResumeRequest,
  // `--model <ref>`：会话物化后、TUI 接管前应用启动模型（create/resume
  // 均适用）。校验复用 setModel 的目录链路，见 resolveInitialModelRef。
  initialModel?: string,
  // "piz" 仅 zcode-attach 专用入口（attach-main）传：进程名/产品即 piz，
  // herdr reporter 报 --agent piz。monolith 入口进程是 zcode，不传。
  attachHerdrAgent?: "piz",
): Promise<number> => {
  try {
    const workspaceDirectory = (deps.cwd ?? process.cwd)();
    const env = deps.env ?? process.env;
    const workspace = {
      workspaceIdentity: env[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim() || undefined,
      workspacePath: workspaceDirectory,
    };
    // session/create 需要完整 ref：workspaceKey = 解析出的身份
    // （workspaceIdentity || workspacePath），与 resolveSocketPath 同一 helper。
    const workspaceRef = {
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      workspaceKey: resolveWorkspaceKey(workspace),
    };
    // 瘦客户端（zcode-attach）不带 config 适配器：locale 用轻量路径；
    // monolith 经 deps.resolveAttachStartupLocale 注入完整 createConfig 实现。
    // 在 AttachRuntime 构造前解析：断线状态行（tui.connection.*）按同一 locale。
    const startupLocale =
      deps.resolveAttachStartupLocale?.({ deps, options, workingDirectory: workspaceDirectory }) ??
      resolveLocale(options.locale, options.detectedLocale);
    const { socketPath } = await ensureServer({ env, version, workspace });
    // 传输诊断（丢畸形行/socket 错误等）经节流 stderr logger 接进客户端连接
    // 与 runtime 自身；不传则传输层全部 optional-chain 成静默 no-op。
    const transportLogger = createAttachTransportLogger(ctx.stderr);
    const runtime = new AttachRuntime({
      socketPath,
      workspace: workspaceRef,
      // core 死亡后的重连必须重跑 ensureServer：pid/socket 已 stale，原子
      // reclaim 会 detached respawn 新 core 到同一确定性 socketPath。
      ensureConnected: async () => ({
        socketPath: (await ensureServer({ env, version, workspace })).socketPath,
      }),
      connect: (path) => connectAttachClient(path, { logger: transportLogger }),
      logger: transportLogger,
      locale: startupLocale,
    });
    // herdr reporter：必须在 createAttachPromptHandler 注册首个句柄前挂好
    // onSessionBound，才能收到初始绑定（否则 pane 无 session/resume 元数据）。
    // 诊断常开（reporter 重试耗尽才回调），stderr 按 ≥60s 节流——herdr 长
    // 时间不可用时心跳级失败不至于刷屏 TUI；不再仅 --verbose。
    const herdrReporter =
      attachHerdrAgent === "piz"
        ? createAttachHerdrReporter({
            env,
            onError: createHerdrDiagnosticWriter(ctx.stderr),
          })
        : undefined;
    if (herdrReporter) {
      runtime.onSessionBound((handle) => herdrReporter.bind(handle));
    }
    const client = await runtime.connect();
    try {
      // 会话选择与主 CLI 语义一致（不再默认 resume）：
      //   默认          → session/create（开新会话）
      //   -c/--continue → 恢复本 workspace 最近一次会话
      //   --resume <id> → 恢复指定会话
      // 之前的实现无条件 resume 最近会话，piz 永远进旧对话、无法开新会话。
      const resumeTarget = await resolveAttachResumeTarget({
        client,
        continueSession: resumeRequest?.continueSession === true,
        resumeSessionId: resumeRequest?.resumeSessionId,
        workspace: workspaceRef,
      });
      // 显式 resume 意图（-c/--resume）失败直接抛错退出（stderr + exit 1），
      // 不再静默回退 session/create：截断 id / 已删会话曾无声变成空新会话。
      const resumedSnapshot = resumeTarget
        ? await client.request(zcodeProtocolMethods.sessionResume, {
            sessionId: resumeTarget,
            workspace: workspaceRef,
          })
        : undefined;
      // 握手：session/create 直接返回协议快照；版本断言先于任何会话状态依赖。
      // persistence:"deferred"——启动新会话在首条 prompt 被 accepted 前只是
      // 草稿：core 的 session/list 跳过 deferred record，空启动会话不会被
      // 本 pane 或其他 pane 的 /resume picker、-c 误选中；首发时 core 在
      // admission 提升为 immediate（与 desktop 新建 draft 同一规则）。
      const created =
        resumedSnapshot ??
        ((await client.request(zcodeProtocolMethods.sessionCreate, {
          persistence: "deferred",
          workspace: workspaceRef,
        })) as unknown);
      // 版本断言先于全量 schema 校验：snapshot.protocol.version 是 z.literal 断言位，
      // 直接 parse 会把版本漂移报成模糊 ZodError，先单独读出再给可操作错误。
      const advertisedVersion = (
        created as { protocol?: { version?: unknown } } | undefined
      )?.protocol?.version;
      if (advertisedVersion !== ZCODE_PROTOCOL_VERSION) {
        throw new AttachProtocolVersionError(
          `Shared core protocol v${String(advertisedVersion)} but this client expects v${String(ZCODE_PROTOCOL_VERSION)}. ` +
            `Restart the core: kill $(cat '${socketPath}.pid')`,
        );
      }
      const snapshot = zcodeSessionStateSnapshotSchema.parse(created);
      const handle = new AttachSessionHandle({
        client: () => runtime.currentClient(),
        locale: startupLocale,
        sessionId: snapshot.session.sessionId,
        snapshot,
      });
      await handle.subscribe(undefined, false);
      // --model：Ctrl+P//model 同一条 setModel 链路，仅在启动期执行一次；
      // 失败必须在 TUI 接管屏幕前暴露（stderr + 退出码 1）。
      if (initialModel !== undefined) {
        if (initialModel.trim() === "") {
          throw new Error("--model requires a non-empty value");
        }
        try {
          await handle.setModel(
            resolveInitialModelRef(
              initialModel,
              handle.snapshot.settings.model.available,
              handle.snapshot.settings.model.current?.providerId,
            ),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`--model: ${message}`);
        }
      }
      // 压缩窗口上限跟随当前模型；--model 走 setModel 已经同步过一次，不重复下发。
      if (initialModel === undefined) await handle.syncCompactContextWindow();
      const promptHandler = createAttachPromptHandler({
        client,
        initialHandle: handle,
        runtime,
        workspace: workspaceRef,
      });
      const runTui =
        deps.runTui ??
        (tuiFrontend === "pi"
          ? (await loadPiTuiRuntime()).runTui
          : (await loadTuiRuntime()).runTui);
      const developerMode = resolveZCodeRuntimeEnv(env) === "development";
      const workflowMode = DEFAULT_CLI_WORKFLOW_MODE;
      const exitCode = await runTui({
        developerMode,
        getMainSessionId: promptHandler.getMainSessionId,
        initialMode: handle.getMode(),
        // resume-latest：快照自带 messages，按 loadSessionTranscript 的映射
        // 产出 restoredMessages 让 transcript 首帧即历史；sessionSnapshotSeed
        // 把快照的 ctx 水位与 session 累计用量带给页脚（接入前流量不再显示为 0）。
        ...(resumedSnapshot
          ? {
              initialResult: {
                locale: startupLocale,
                mode: handle.getMode(),
                model: handle.getModel(),
                response: "",
                restoredMessages: projectAttachTranscriptMessages(
                  snapshot.messages,
                ),
                sessionId: snapshot.session.sessionId,
                thoughtLevel: handle.getThoughtLevel(),
                traceId: snapshot.session.traceId,
                ...handle.sessionSnapshotSeed(),
              } satisfies TuiSubmitPromptResult,
            }
          : {}),
        listMcpServers: async () => ({}),
        listModelOptions: promptHandler.listModelOptions,
        ...(deps.createAttachPathSuggestions
          ? {
              listWorkspacePathSuggestions: deps.createAttachPathSuggestions({
                workspaceDirectory,
              }),
            }
          : {}),
        loadStartupOptions: async () => {
          // 自定义命令目录与技能目录同源：core 现扫（commands/referenceCatalog），
          // 瘦客户端不本地重扫（bundle 无 bootstrap，双扫只会漂移）；失败只丢
          // 面板条目不阻塞启动。展开不走这里 —— 未知 /name 原文转发，core 的
          // input facade 负责（含 !`cmd` 动态展开，客户端侧展开器不支持）。
          const [customCommandCatalog, workspaceGitBranch, skillCatalog] = await Promise.all([
            listAttachCommandCatalog({
              request: (method, params) => runtime.currentClient().request(method, params),
              workspace: workspaceRef,
            }).catch(() => undefined),
            (deps.resolveWorkspaceGitBranch ?? resolveWorkspaceGitBranch)({
              workspaceDirectory,
            }).catch(() => undefined),
            // composer `/skill <Tab>` 补全用 session 权威快照；失败只丢补全不阻塞启动。
            listAttachSkillCatalog({
              request: (method, params) => runtime.currentClient().request(method, params),
              sessionId: promptHandler.getMainSessionId?.(),
              workspace: workspaceRef,
            }).catch(() => undefined),
          ]);
          return {
            initialMode: handle.getMode(),
            initialModel: handle.getModel(),
            initialThoughtLevel: handle.getThoughtLevel(),
            locale: startupLocale,
            modelOptions: handle.snapshot.settings.model.available as never,
            slashCommands: listSlashCommandSuggestions(
              customCommandCatalog
                ? toCommandCenterCustomCommandList(customCommandCatalog)
                : undefined,
              {
                workflowMode,
              },
            ),
            ...(skillCatalog
              ? { skillSuggestions: toSkillSuggestions(skillCatalog) }
              : {}),
            theme: "auto" as const,
            workspaceGitBranch,
          };
        },
        locale: startupLocale,
        noColor: options.noColor,
        readClipboardImage: deps.readClipboardImage ?? createNodeClipboardImageReader(),
        readSubagentTranscript: promptHandler.readSubagentTranscript,
        readSubagents: promptHandler.readSubagents,
        readUsageQuota: promptHandler.readUsageQuota,
        recallPreviousInput: promptHandler.recallPreviousInput,
        removeQueuedInputs: promptHandler.removeQueuedInputs,
        requestStopActiveTurn: promptHandler.requestStopActiveTurn,
        sendInput: promptHandler.sendInput,
        setMode: promptHandler.setMode,
        stderr: ctx.stderr,
        stdin: ctx.stdin,
        stdout: ctx.stdout,
        submitPrompt: promptHandler,
        // tui-attach：pi-tui 状态行从 options 层的这个端口读连接状态（不是
        // handler 的属性）——发射方是 runtime（重连）。
        subscribeConnectionStatus: (listener) => runtime.onConnectionStatus(listener),
        subscribeSessionEvents: promptHandler.subscribeSessionEvents,
        version,
        workspaceDirectory,
        writeClipboardText:
          deps.writeClipboardText ?? createNodeClipboardTextWriter({ stdout: ctx.stdout }),
      });
      // 退出续接提示（spec「退出续接提示」）：只在正常退出（exit 0）且有绑定
      // 会话时打——此时 TUI 已拆屏、终端已恢复，stdout 回到主屏缓冲。非 0 退出
      // 没有可续接的会话；信号退出走 reap-then-reraise，到不了这里。
      if (exitCode === 0) {
        const sessionId = promptHandler.getMainSessionId?.();
        if (sessionId) {
          ctx.stdout.write(
            formatExitResumeHint(
              attachHerdrAgent === "piz" ? "piz" : "zcode attach",
              sessionId,
            ),
          );
        }
      }
      return exitCode;
    } finally {
      // 只断连接；core 端会话与运行时继续存活（共享 core 的全部意义）。
      await runtime.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return error instanceof AttachProtocolVersionError ? 2 : 1;
  }
};

/** 退出续接提示的两行文案。会话 id 只在 core 侧记录里可查，退出时打出来
 *  省得事后翻 session/list；命令名由入口决定（piz / zcode attach）。 */
export const formatExitResumeHint = (command: string, sessionId: string): string =>
  `Resume this session with:\n${command} --resume ${sessionId}\n`;

/** bare id 不区分大小写，但必须回填目录拼写，否则 setModel 的精确校验仍会失败。
 *  同名模型优先当前 provider，不按目录顺序猜账单；完整 ref 继续原样交给 setModel。 */
export function resolveInitialModelRef(
  value: string,
  available: readonly ZCodeModelOption[],
  currentProviderId?: string,
): string {
  const trimmed = value.trim();
  if (trimmed.includes("/")) return trimmed;
  const selectable = available.filter((option) => !option.disabledReason);
  const literalMatches = selectable.filter(
    (option) => option.ref.modelId.toLowerCase() === trimmed.toLowerCase(),
  );
  // 先保留字面含 `$` 的 modelId，再拆档位；空后缀仍按未知模型报错。
  const separatorIndex = trimmed.indexOf(ZCODE_MODEL_REASONING_SEPARATOR);
  const hasEffort =
    literalMatches.length === 0 &&
    separatorIndex > 0 &&
    separatorIndex < trimmed.length - 1;
  const modelId = hasEffort ? trimmed.slice(0, separatorIndex) : trimmed;
  const effort = hasEffort ? trimmed.slice(separatorIndex + 1) : undefined;
  const enabled =
    literalMatches.length > 0
      ? literalMatches
      : selectable.filter((option) => option.ref.modelId.toLowerCase() === modelId.toLowerCase());
  const currentProviderMatches = enabled.filter(
    (option) => option.ref.providerId === currentProviderId,
  );
  const matches = currentProviderMatches.length > 0 ? currentProviderMatches : enabled;
  if (matches.length === 1) {
    const option = matches[0];
    const ref = `${option.ref.providerId}/${option.ref.modelId}`;
    if (effort === undefined) return ref;
    const level = option.reasoning?.levels.find(
      (candidate) => candidate.value.toLowerCase() === effort.toLowerCase(),
    );
    if (!level) {
      throw new Error(
        `Select a supported reasoning effort for ${ref}: ${
          option.reasoning?.levels.map((candidate) => candidate.value).join(", ") || "none available"
        }`,
      );
    }
    return `${ref}${ZCODE_MODEL_REASONING_SEPARATOR}${level.value}`;
  }
  const refs = selectable.map((option) => `${option.ref.providerId}/${option.ref.modelId}`);
  if (matches.length > 1) {
    const candidates = matches
      .map((option) => `${option.ref.providerId}/${option.ref.modelId}`)
      .join(", ");
    throw new Error(
      `"${trimmed}" matches multiple providers: ${candidates}. Use the full provider/model ref.`,
    );
  }
  throw new Error(
    `"${trimmed}" is not available. Available models: ${
      refs.length > 0 ? refs.join(", ") : "(none)"
    }. Use the full provider/model form for exact matching.`,
  );
}
