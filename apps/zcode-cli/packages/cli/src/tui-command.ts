import type { ToolSearchMode } from "@zcode/contracts";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import { resolveZCodeRuntimeEnv, type DynamicWorkflowMode } from "@zcode/shared";
import { createNodeClipboardImageReader } from "./clipboard-image.js";
import { createNodeClipboardTextWriter } from "./clipboard-text.js";
import { listSlashCommandSuggestions } from "./command-center.js";
import { registerCliShutdownHandlers } from "./shutdown.js";
import {
  listCustomCommandsForTui,
  listSkillsForTui,
  loadInitialTuiSessionMetadata,
} from "./tui-command-data.js";
import { toTuiSkillSuggestions } from "./skill-suggestions.js";
import { createTuiSubmitPrompt } from "./tui-prompt-handler.js";
import { loadTuiRuntime } from "./tui-runtime-loader.js";
import { resolveTuiStartupLocale } from "./tui-startup-locale.js";
import { createWorkspacePathSuggestionProvider } from "./tui-workspace-paths.js";
import { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";
import { createCliModeState, currentCliMode } from "./tui-command-state.js";
import type {
  CliPermissionMode,
  CliResumeRequest,
  CliTuiFrontend,
  RunDependencies,
} from "./cli-types.js";
import { loadPiTuiRuntime } from "./tui-pi-runtime-loader.js";
import { DEFAULT_CLI_WORKFLOW_MODE } from "./workflow-mode.js";

export const runTuiCommand = async (
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  version: string,
  mode?: CliPermissionMode,
  resumeRequest?: CliResumeRequest,
  toolDisallowlist?: readonly string[],
  forceMcs = false,
  toolsearchMode: ToolSearchMode = "off",
  workflowMode: DynamicWorkflowMode = DEFAULT_CLI_WORKFLOW_MODE,
  tuiFrontend: CliTuiFrontend = "opentui",
): Promise<number> => {
  try {
    const modeState = createCliModeState(mode);
    const runTui =
      deps.runTui ??
      (tuiFrontend === "pi"
        ? (await loadPiTuiRuntime()).runTui
        : (await loadTuiRuntime()).runTui);
    const workspaceDirectory = (deps.cwd ?? process.cwd)();
    const env = deps.env ?? process.env;
    const developerMode = resolveZCodeRuntimeEnv(env) === "development";
    const startupLocale = resolveTuiStartupLocale({
      deps,
      options,
      workingDirectory: workspaceDirectory,
    });
    const promptHandler = createTuiSubmitPrompt(
      deps,
      modeState,
      version,
      resumeRequest,
      options.locale,
      options.detectedLocale,
      startupLocale,
      toolDisallowlist,
      forceMcs,
      toolsearchMode,
      options.browserUse,
      options.browserExecutable,
      workflowMode,
    );
    const unregisterShutdownHandlers = registerCliShutdownHandlers({
      cleanup: async () => {
        await promptHandler.close?.();
      },
      cleanupTimeoutMs: deps.shutdownCleanupTimeoutMs,
      exitProcess: deps.exitProcess,
      process: deps.shutdownProcess,
    });
    try {
      return await runTui({
        loadStartupOptions: async () => {
          const [metadata, customCommands, workspaceGitBranch, skillOutcome] =
            await Promise.all([
              loadInitialTuiSessionMetadata(promptHandler),
              listCustomCommandsForTui(deps).catch(() => undefined),
              (deps.resolveWorkspaceGitBranch ?? resolveWorkspaceGitBranch)({
                workspaceDirectory,
              }).catch(() => undefined),
              // pi composer `/skill <Tab>` 补全；失败只丢补全不阻塞启动。
              listSkillsForTui(deps).catch(() => undefined),
            ]);
          return {
            initialMode: currentCliMode(modeState),
            initialModel: metadata.model,
            initialThoughtLevel: metadata.thoughtLevel,
            loginRequired: metadata.loginRequired,
            locale: metadata.locale ?? startupLocale,
            theme: metadata.theme ?? "auto",
            modelOptions: metadata.modelOptions,
            effortOptions: metadata.effortOptions,
            slashCommands: listSlashCommandSuggestions(customCommands, { workflowMode }),
            ...(skillOutcome
              ? { skillSuggestions: toTuiSkillSuggestions(skillOutcome.skills) }
              : {}),
            workspaceGitBranch,
          };
        },
        locale: startupLocale,
        developerMode,
        version,
        workspaceDirectory,
        noColor: options.noColor,
        readClipboardImage: deps.readClipboardImage ?? createNodeClipboardImageReader(),
        listModelOptions: promptHandler.listModelOptions,
        listWorkspacePathSuggestions: createWorkspacePathSuggestionProvider({
          workspaceDirectory,
        }),
        listMcpServers: promptHandler.listMcpServers,
        readSubagents: promptHandler.readSubagents,
        readUsageQuota: promptHandler.readUsageQuota,
        readSubagentTranscript: promptHandler.readSubagentTranscript,
        listWorkflowRuns: promptHandler.listWorkflowRuns,
        replayWorkflowRuns: promptHandler.replayWorkflowRuns,
        getMainSessionId: promptHandler.getMainSessionId,
        writeClipboardText:
          deps.writeClipboardText ?? createNodeClipboardTextWriter({ stdout: ctx.stdout }),
        stderr: ctx.stderr,
        stdin: ctx.stdin,
        stdout: ctx.stdout,
        recallPreviousInput: promptHandler.recallPreviousInput,
        removeQueuedInputs: promptHandler.removeQueuedInputs,
        sendInput: promptHandler.sendInput,
        setMode: promptHandler.setMode,
        submitPrompt: promptHandler,
        subscribeSessionEvents: promptHandler.subscribeSessionEvents,
      });
    } finally {
      unregisterShutdownHandlers();
      await promptHandler.close?.();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
};
