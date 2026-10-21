// `zcode attach` / `tui --shared-core` 入口：解析 socket → ensureServer 拉起
// 共享 core（无则 spawn，detached + --no-plugins）→ 连接握手（协议版本校验）
// → 建 AttachSessionHandle + TuiPromptHandler → runTui。
// 客户端不持有业务状态；退出只断连接，core 端 session 照常存活。
import {
  ZCODE_PROTOCOL_VERSION,
  ZCODE_WORKSPACE_IDENTITY_ENV,
  resolveWorkspaceKey,
  resolveZCodeRuntimeEnv,
  zcodeProtocolMethods,
  zcodeSessionStateSnapshotSchema,
} from "@zcode/shared";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { CliTuiFrontend, RunDependencies } from "../cli-types.js";
import { createNodeClipboardImageReader } from "../clipboard-image.js";
import { createNodeClipboardTextWriter } from "../clipboard-text.js";
import { listSlashCommandSuggestions } from "../command-center.js";
import { ensureServer } from "../app-server-spawn.js";
import { resolveLocale } from "@zcode/i18n";
import { resolveWorkspaceGitBranch } from "../tui-workspace-git.js";
import { loadPiTuiRuntime } from "../tui-pi-runtime-loader.js";
import { loadTuiRuntime } from "../tui-runtime-loader.js";
import { DEFAULT_CLI_WORKFLOW_MODE } from "../workflow-mode.js";
import { AttachSessionHandle } from "./attach-session.js";
import {
  AttachProtocolVersionError,
  AttachRuntime,
  createAttachPromptHandler,
} from "./attach-tui-options.js";

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
): Promise<number> => {
  try {
    const workspaceDirectory = (deps.cwd ?? process.cwd)();
    const env = deps.env ?? process.env;
    const workspace = {
      workspaceIdentity: env[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim() || undefined,
      workspacePath: workspaceDirectory,
    };
    // session/create exige le ref complet : workspaceKey = identité résolue
    // (workspaceIdentity || workspacePath), même helper que resolveSocketPath.
    const workspaceRef = {
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      workspaceKey: resolveWorkspaceKey(workspace),
    };
    const { socketPath } = await ensureServer({ env, version, workspace });
    const runtime = new AttachRuntime({ socketPath, workspace: workspaceRef });
    const client = await runtime.connect();
    // 瘦客户端（zcode-attach）不带 config 适配器：locale 用轻量路径；
    // monolith 经 deps.resolveAttachStartupLocale 注入完整 createConfig 实现。
    const startupLocale =
      deps.resolveAttachStartupLocale?.({ deps, options, workingDirectory: workspaceDirectory }) ??
      resolveLocale(options.locale, options.detectedLocale);
    try {
      // 握手：session/create 直接返回协议快照；版本断言先于任何会话状态依赖。
      const created = (await client.request(zcodeProtocolMethods.sessionCreate, {
        workspace: workspaceRef,
      })) as unknown;
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
      return await runTui({
        developerMode,
        getMainSessionId: promptHandler.getMainSessionId,
        initialMode: handle.getMode(),
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
          const [customCommands, workspaceGitBranch] = await Promise.all([
            (deps.listAttachCustomCommands?.(deps) ?? Promise.resolve(undefined)).catch(
              () => undefined,
            ),
            (deps.resolveWorkspaceGitBranch ?? resolveWorkspaceGitBranch)({
              workspaceDirectory,
            }).catch(() => undefined),
          ]);
          return {
            initialMode: handle.getMode(),
            initialModel: handle.getModel(),
            initialThoughtLevel: handle.getThoughtLevel(),
            locale: startupLocale,
            modelOptions: handle.snapshot.settings.model.available as never,
            slashCommands: listSlashCommandSuggestions(customCommands, {
              workflowMode,
            }),
            theme: "auto" as const,
            workspaceGitBranch,
          };
        },
        locale: startupLocale,
        noColor: options.noColor,
        readClipboardImage: deps.readClipboardImage ?? createNodeClipboardImageReader(),
        readSubagentTranscript: promptHandler.readSubagentTranscript,
        readSubagents: promptHandler.readSubagents,
        recallPreviousInput: promptHandler.recallPreviousInput,
        sendInput: promptHandler.sendInput,
        setMode: promptHandler.setMode,
        stderr: ctx.stderr,
        stdin: ctx.stdin,
        stdout: ctx.stdout,
        submitPrompt: promptHandler,
        // tui-attach : la ligne de status pi-tui lit ce port de niveau options,
        // pas une propriété du handler — l'émission vient de runtime (reconnect).
        subscribeConnectionStatus: (listener) => runtime.onConnectionStatus(listener),
        subscribeSessionEvents: promptHandler.subscribeSessionEvents,
        version,
        workspaceDirectory,
        writeClipboardText:
          deps.writeClipboardText ?? createNodeClipboardTextWriter({ stdout: ctx.stdout }),
      });
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
