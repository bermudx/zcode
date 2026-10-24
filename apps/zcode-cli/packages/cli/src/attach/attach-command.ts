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
import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { CliResumeRequest, CliTuiFrontend, RunDependencies } from "../cli-types.js";
import { createNodeClipboardImageReader } from "../clipboard-image.js";
import { createNodeClipboardTextWriter } from "../clipboard-text.js";
import { listSlashCommandSuggestions } from "../command-center.js";
import { ensureServer } from "../app-server-spawn.js";
import type { AttachClient } from "./attach-client.js";
import { resolveLocale } from "@zcode/i18n";
import { resolveWorkspaceGitBranch } from "../tui-workspace-git.js";
import { loadPiTuiRuntime } from "../tui-pi-runtime-loader.js";
import { loadTuiRuntime } from "../tui-runtime-loader.js";
import { DEFAULT_CLI_WORKFLOW_MODE } from "../workflow-mode.js";
import {
  AttachSessionHandle,
  projectAttachTranscriptMessages,
} from "./attach-session.js";
import { listAttachSkillCatalog, toSkillSuggestions } from "./attach-skills.js";
import {
  AttachProtocolVersionError,
  AttachRuntime,
  createAttachPromptHandler,
} from "./attach-tui-options.js";

/**
 * 解析 attach 入口的会话选择目标：
 *   - 无 resume 意图 → undefined（调用方走 session/create，开新会话）
 *   - --resume <id>   → 该会话 id
 *   - -c/--continue   → 本 workspace 最近一次会话
 *
 * “最近”按 updatedAt（退化 createdAt）显式取最大：server 的 session/list 返回
 * 顺序不保证（实测创建序/任意序混排），取末位会恢复到陈旧会话。
 */
export const resolveAttachResumeTarget = async ({
  client,
  continueSession,
  resumeSessionId,
  workspace,
}: {
  client: AttachClient;
  continueSession: boolean;
  resumeSessionId?: string;
  workspace: { workspacePath: string; workspaceIdentity?: string; workspaceKey: string };
}): Promise<string | undefined> => {
  if (resumeSessionId) return resumeSessionId;
  if (!continueSession) return undefined;
  const listed = await client
    .request(zcodeProtocolMethods.sessionList, { workspace })
    .catch(() => undefined);
  const sessions = (
    (listed ?? {}) as {
      sessions?: Array<{
        createdAt?: number;
        sessionId?: string;
        id?: string;
        updatedAt?: number;
      }>;
    }
  ).sessions;
  const byRecency = [...(sessions ?? [])].sort(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
  );
  const last = byRecency[0];
  return last?.sessionId ?? last?.id;
};

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
    const runtime = new AttachRuntime({
      socketPath,
      workspace: workspaceRef,
      // core 死亡后的重连必须重跑 ensureServer：pid/socket 已 stale，原子
      // reclaim 会 detached respawn 新 core 到同一确定性 socketPath。
      ensureConnected: async () => ({
        socketPath: (await ensureServer({ env, version, workspace })).socketPath,
      }),
    });
    const client = await runtime.connect();
    // 瘦客户端（zcode-attach）不带 config 适配器：locale 用轻量路径；
    // monolith 经 deps.resolveAttachStartupLocale 注入完整 createConfig 实现。
    const startupLocale =
      deps.resolveAttachStartupLocale?.({ deps, options, workingDirectory: workspaceDirectory }) ??
      resolveLocale(options.locale, options.detectedLocale);
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
      const resumedSnapshot = resumeTarget
        ? await client
            .request(zcodeProtocolMethods.sessionResume, {
              sessionId: resumeTarget,
              workspace: workspaceRef,
            })
            .catch(() => undefined)
        : undefined;
      // 握手：session/create 直接返回协议快照；版本断言先于任何会话状态依赖。
      const created =
        resumedSnapshot ??
        ((await client.request(zcodeProtocolMethods.sessionCreate, {
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
        // resume-latest：快照自带 messages，按 loadSessionTranscript 的映射
        // 产出 restoredMessages 让 transcript 首帧即历史。
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
          const [customCommands, workspaceGitBranch, skillCatalog] = await Promise.all([
            (deps.listAttachCustomCommands?.(deps) ?? Promise.resolve(undefined)).catch(
              () => undefined,
            ),
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
            slashCommands: listSlashCommandSuggestions(customCommands, {
              workflowMode,
            }),
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
        recallPreviousInput: promptHandler.recallPreviousInput,
        requestStopActiveTurn: promptHandler.requestStopActiveTurn,
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
