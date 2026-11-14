import type { ExecutionShellSelection, SessionId } from "@zcode/contracts";
import { resolveExecutionState, type ExecutionState } from "@zcode/shared";
import type { ZCodeApp, ZCodeAppOptions } from "../../src/app/types.js";

export function createFakeApp(
  options?: ZCodeAppOptions,
  overrides: Partial<ZCodeApp> = {},
): ZCodeApp {
  const sessionId = options?.sessionId ?? ("sess_test" as SessionId);
  const traceId = options?.traceContext?.traceId ?? ("trace_test" as never);
  let mode = options?.runtimeConfig?.mode ?? "build";
  // 与真实 runtime 的 ExecutionState 同构：plan 是叠加开关而非 mode 值。
  // runtimeConfig.mode="plan" 的直写种子按 resolveExecutionState 归一化为
  // planEnabled=true（真实 getMode() 会原样回 "plan"，这里保留同一行为）。
  let planEnabled = options?.runtimeConfig?.planEnabled ?? mode === "plan";
  let model = options?.runtimeConfig?.modelSelection
    ? `${options.runtimeConfig.modelSelection.providerId}/${options.runtimeConfig.modelSelection.modelId}`
    : "glm/glm-4.6";
  let thoughtLevel = options?.runtimeConfig?.modelSelection?.options?.reasoningLevel ?? "medium";
  let bashShellSelection = options?.runtimeConfig?.bashShellSelection;
  let runtimeContextWindow = options?.runtimeConfig?.contextWindow ?? 128_000;
  let foregroundPromotionLeaseId: string | undefined;
  const modelProperties = {
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
  } as const;
  const baseModels = [
    {
      ref: { providerId: "glm", modelId: "glm-4.6" },
      label: "GLM 4.6",
      providerLabel: "glm",
      properties: modelProperties,
    },
    {
      ref: { providerId: "glm", modelId: "glm-4-air" },
      label: "GLM 4 Air",
      providerLabel: "glm",
      properties: modelProperties,
    },
  ];
  let models = [...baseModels];
  let thoughtLevelsByModel = new Map<string, string[]>([
    ["glm/glm-4.6", ["medium", "deep"]],
    ["glm/glm-4-air", ["medium", "deep"]],
  ]);

  return {
    clearTarget: async () => false,
    close: async () => {},
    connectMcpServer: async () => {
      throw new Error("MCP is not available in fake app");
    },
    continueActiveTarget: async () => null,
    disconnectMcpServer: async () => undefined,
    forkFromCheckpoint: async () => {
      throw new Error("Fork is not available in fake app");
    },
    getLocale: () => "en-US",
    getMode: () => mode,
    getModel: () => model,
    getTheme: () => "auto",
    getDefaultThoughtLevel: () => thoughtLevelsByModel.get(model)?.[0],
    getThoughtLevel: () => thoughtLevel,
    generateWorkspaceText: async () => {
      throw new Error("Workspace text generation is not available in fake app");
    },
    testModelConnectivity: async () => {
      throw new Error("Model connectivity testing is not available in fake app");
    },
    listCheckpoints: async () => [],
    listMcpServers: async () => ({}),
    listModels: () => models,
    listPlugins: async () => ({ loaded: [], failed: [] }) as never,
    listThoughtLevels: () => thoughtLevelsByModel.get(model) ?? [],
    loadSessionTranscript: async () => [],
    readToolResultArtifact: async (uri) => ({
      bytes: 0,
      content: "",
      contentType: "text/plain",
      uri,
    }),
    readTodos: async () => [],
    readTarget: async () => null,
    recallPreviousInputHistory: async () => null,
    recordInputHistory: async () => null,
    resume: async () => ({
      directory: options?.runtimeConfig?.workingDirectory ?? "/workspace/app",
      interruptedToolCount: 0,
      messageCount: 0,
      partCount: 0,
      persistedMessagesReloadRequired: false,
      restoredMessages: [],
      traceId,
    }),
    runtime: {
      beginShutdown: () => {},
      acquireForegroundPromotionLease: ({ leaseId }) => {
        if (foregroundPromotionLeaseId && foregroundPromotionLeaseId !== leaseId) {
          return { kind: "conflict", leaseId: foregroundPromotionLeaseId };
        }
        foregroundPromotionLeaseId = leaseId;
        return { kind: "acquired", leaseId };
      },
      emitModelSelected: async () => undefined,
      setCompactContextWindowCap: () => undefined,
      setMcpClientAttached: async () => {},
      getProjection: async () =>
        ({
          activeToolCalls: [],
          backgroundTasks: [],
          contextUsed: 0,
          contextWindow: runtimeContextWindow,
          createdAt: new Date(1),
          id: sessionId,
          mode,
          pendingPermissions: [],
          pendingSteerInputs: [],
          status: "idle",
          streamingToolLedger: [],
          target: null,
          totalTokenCount: 0,
          turnCount: 0,
          updatedAt: new Date(1),
        }) as never,
      getActiveTurnInfo: () => undefined,
      getPlanEnabled: () => planEnabled,
      hasActiveOrQueuedTurnWork: () => false,
      hasResidencyBlockingWork: () => false,
      hasRunningBackgroundTasks: () => false,
      isSessionPersisted: () => false,
      getActiveForegroundExecutionId: () => undefined,
      getSessionModelSelection: () => {
        const [providerId = "", modelId = ""] = model.split("/", 2);
        return {
          providerId,
          modelId,
          ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}),
        };
      },
      getSessionShellSelection: () => bashShellSelection,
      initializeSessionShellEnvironmentIfNeeded: (selection) => {
        if (bashShellSelection) {
          return false;
        }
        bashShellSelection = resolveShellInitializationCandidate(selection);
        return true;
      },
      subscribeEvents: () => () => {},
      releaseForegroundPromotionLease: (leaseId) => {
        if (foregroundPromotionLeaseId !== leaseId) return false;
        foregroundPromotionLeaseId = undefined;
        return true;
      },
      stopActiveForegroundExecution: () => ({ kind: "idle" }),
      updateConfig: (patch) => {
        if ("contextWindow" in patch) {
          runtimeContextWindow = patch.contextWindow ?? 0;
        }
      },
    } as never,
    sendInput: async () => ({ kind: "rejected", reason: "no_active_turn" }),
    sessionId,
    setLocale: async (locale) => ({
      configPath: "/tmp/zcode/config.json",
      locale: locale === "zh-CN" ? "zh-CN" : "en-US",
      previousLocale: "en-US",
      requestedLocale: locale,
      traceId,
    }),
    setMode: async (nextMode) => {
      const previousMode = mode;
      // 忠实复刻 AgentRuntime.setExecutionState：mode 值域不含 "plan"，
      // "plan" 只翻转 planEnabled、保留原 permission mode。直写 mode=nextMode
      // 会把 plan 会话伪装成 mode==="plan"，掩盖 settings.mode.current 的
      // planEnabled 推导缺口。
      const resolved = resolveExecutionState(
        { mode: nextMode },
        { mode: mode as ExecutionState["mode"], planEnabled },
      );
      mode = resolved.mode;
      planEnabled = resolved.planEnabled;
      return { mode, previousMode, traceId };
    },
    setPluginEnabled: async () => {
      throw new Error("Plugins are not available in fake app");
    },
    setTarget: async () => {
      throw new Error("Targets are not available in fake app");
    },
    setModel: async (nextModel) => {
      const nextIdentity =
        typeof nextModel === "string" ? nextModel : `${nextModel.providerId}/${nextModel.modelId}`;
      if (
        !models.some((option) => `${option.ref.providerId}/${option.ref.modelId}` === nextIdentity)
      ) {
        throw new Error(`Unsupported model in fake app: ${nextModel}`);
      }
      const previousModel = model;
      model = nextIdentity;
      if (typeof nextModel !== "string") thoughtLevel = nextModel.options?.reasoningLevel ?? "";
      return { model, previousModel, traceId };
    },
    setThoughtLevel: async (level) => {
      const previousThoughtLevel = thoughtLevel;
      thoughtLevel = level;
      return { previousThoughtLevel, thoughtLevel, traceId };
    },
    steerTurn: async () => ({ kind: "rejected", reason: "no_active_turn" }),
    submitPrompt: async () => {
      throw new Error("Prompt execution is not available in fake app");
    },
    traceId,
    updateTargetStatus: async () => null,
    ...overrides,
  } as ZCodeApp;
}

type ShellInitializationCandidate = Parameters<
  ZCodeApp["runtime"]["initializeSessionShellEnvironmentIfNeeded"]
>[0];

function resolveShellInitializationCandidate(
  candidate: ShellInitializationCandidate,
): ExecutionShellSelection {
  return typeof candidate === "function" ? candidate() : candidate;
}
