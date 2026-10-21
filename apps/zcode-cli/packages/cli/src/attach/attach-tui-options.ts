// attach 运行时：持有 socket client、会话句柄注册表与断线重连状态机。
// TuiPromptHandler 与 CommandCenterApp 是同一层的两面——提交/输入走 commandCenter
// 的 slash 路由（client 侧），业务事实全部在 core。
import type { SessionEvent } from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type ZCodeSessionRawEvent,
} from "@zcode/shared";
import type {
  TuiPromptInput,
  TuiSubmitPromptResult,
} from "@zcode/tui";
import { connectAttachClient, type AttachClient } from "./attach-client.js";
import { AttachSessionHandle, asCommandCenterApp } from "./attach-session.js";
import type { CommandCenterApp, CommandCenterDeps } from "../command-center.js";
import { createCommandCenter } from "../command-center.js";
import type { TuiPromptHandler } from "../tui-command-state.js";

const RECONNECT_BACKOFF_START_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const CONNECTION_LOST_TYPE = "session_notice";
const METHOD_NOT_FOUND = -32601;

export type AttachRuntimeLogger = {
  warn?: (message: string, context?: Record<string, unknown>) => void;
  info?: (message: string, context?: Record<string, unknown>) => void;
};

export interface AttachRuntimeOptions {
  /** 测试注入点：默认 connectAttachClient。 */
  connect?: (socketPath: string) => Promise<AttachClient>;
  /** 测试注入点：默认 ensureServer 结果里的 socketPath 直连。 */
  ensureConnected?: () => Promise<{ socketPath: string }>;
  socketPath: string;
  logger?: AttachRuntimeLogger;
  locale?: TuiSubmitPromptResult["locale"];
  runtimePreferences?: Record<string, unknown>;
}

export class AttachProtocolVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachProtocolVersionError";
  }
}

/** 断线横幅：投影能容忍未知 type（跳过），但仍造一条 SessionEvent 形态的通知行。 */
function connectionNoticeEvent(sessionId: string, text: string): SessionEvent {
  return {
    id: `attach-conn-${Date.now()}`,
    payload: { message: text, role: "system" },
    sequenceNumber: 0,
    sessionId,
    timestamp: new Date(),
    traceId: "attach",
    type: CONNECTION_LOST_TYPE,
  } as unknown as SessionEvent;
}

export class AttachRuntime {
  client: AttachClient | undefined;
  private readonly options: AttachRuntimeOptions;
  private readonly sessions = new Map<string, AttachSessionHandle>();
  private current: AttachSessionHandle | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay = RECONNECT_BACKOFF_START_MS;
  private connecting: Promise<AttachClient> | undefined;
  private stopped = false;

  constructor(options: AttachRuntimeOptions) {
    this.options = options;
  }

  async connect(): Promise<AttachClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const socketPath =
        this.options.socketPath ??
        (await this.options.ensureConnected?.())?.socketPath;
      if (!socketPath) throw new Error("attach socket path unavailable");
      const client = await (
        this.options.connect ?? ((path: string) => connectAttachClient(path))
      )(socketPath);
      this.installClient(client);
      this.reconnectDelay = RECONNECT_BACKOFF_START_MS;
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private installClient(client: AttachClient): void {
    this.client = client;
    client.onNotification((method, params) => this.routeNotification(method, params));
    client.setRequestHandler(async (method, params) =>
      this.routeReverseRequest(method, params),
    );
    void client.closed.then(() => this.onDisconnected());
  }

  private routeNotification(method: string, params: unknown): void {
    if (method !== zcodeProtocolNotifications.sessionRawEvent) return;
    const raw = params as ZCodeSessionRawEvent;
    this.sessions.get(String(raw.sessionId))?.ingestRawEvent(raw);
  }

  private async routeReverseRequest(method: string, params: unknown): Promise<unknown> {
    if (method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
      return { nativeSearchEnhancementsEnabled: false, ...this.options.runtimePreferences };
    }
    if (method === "interaction/requestPermission") {
      const sessionId = (params as { sessionId?: string })?.sessionId;
      const handle = sessionId
        ? this.sessions.get(String(sessionId))
        : this.current;
      const callback = handle?.activeRequestPermission;
      if (!callback) {
        return { decision: "deny", reason: "no interactive permission handler" };
      }
      return await callback(params);
    }
    const error = new Error(`method not found: ${method}`) as Error & { code: number };
    error.code = METHOD_NOT_FOUND;
    throw error;
  }

  private onDisconnected(): void {
    if (this.stopped) return;
    this.client = undefined;
    for (const handle of this.sessions.values()) {
      for (const sink of [handle]) void sink; // sinks live inside handle; emit via ingest
      handle.ingestRawEvent(
        connectionNoticeEvent(
          handle.sessionId,
          "Connection to shared core lost — reconnecting…",
        ) as unknown as ZCodeSessionRawEvent,
      );
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_BACKOFF_MAX_MS);
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.options.ensureConnected) await this.options.ensureConnected();
      await this.connect();
    } catch {
      this.scheduleReconnect();
      return;
    }
    for (const handle of this.sessions.values()) {
      try {
        await handle.resubscribe();
        handle.ingestRawEvent(
          connectionNoticeEvent(
            handle.sessionId,
            "Reconnected to shared core.",
          ) as unknown as ZCodeSessionRawEvent,
        );
      } catch (error) {
        this.options.logger?.warn?.("attach resubscribe failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: handle.sessionId,
        });
        this.scheduleReconnect();
      }
    }
  }

  registerSession(handle: AttachSessionHandle): void {
    this.sessions.set(handle.sessionId, handle);
    this.current = handle;
  }

  get currentSession(): AttachSessionHandle | undefined {
    return this.current;
  }

  /** 会话句柄经此拿当前连接；重连换 client 后旧句柄自动跟随。 */
  currentClient(): AttachClient {
    if (!this.client) throw new Error("attach client is not connected");
    return this.client;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.client?.close();
    this.client = undefined;
  }
}

export interface CreateAttachHandlerOptions {
  runtime: AttachRuntime;
  client: AttachClient;
  /** create 结果快照（含 protocol.version 已由入口校验）。 */
  initialHandle: AttachSessionHandle;
  workspace: { workspacePath: string; workspaceIdentity?: string };
  deps?: Partial<CommandCenterDeps>;
  logger?: AttachRuntimeLogger;
}

/**
 * 与 createTuiSubmitPrompt 同形的协议版：内部 createCommandCenter 复用 slash 路由，
 * app 面由 AttachSessionHandle 提供；/new /resume /fork 经 session/* 建新句柄。
 */
export function createAttachPromptHandler(
  options: CreateAttachHandlerOptions,
): TuiPromptHandler {
  const { client, runtime } = options;
  let current = options.initialHandle;
  runtime.registerSession(current);

  const toHandle = async (sessionId: string): Promise<AttachSessionHandle> => {
    const handle = new AttachSessionHandle({
      client: () => runtime.currentClient(),
      locale: options.initialHandle.getLocale(),
      sessionId,
      snapshot: options.initialHandle.snapshot,
    });
    runtime.registerSession(handle);
    await handle.subscribe(undefined, true);
    return handle;
  };

  const getApp = async (): Promise<CommandCenterApp> => asCommandCenterApp(current);

  const newApp = async (): Promise<CommandCenterApp> => {
    const result = (await client.request(zcodeProtocolMethods.sessionCreate, {
      workspace: {
        workspaceIdentity: options.workspace.workspaceIdentity,
        workspacePath: options.workspace.workspacePath,
      },
    })) as { sessionId: string };
    current = await toHandle(result.sessionId);
    return asCommandCenterApp(current);
  };

  const resumeApp = async (sessionId?: string): Promise<CommandCenterApp> => {
    if (!sessionId) {
      const listed = (await client.request(zcodeProtocolMethods.sessionList, {
        workspacePath: options.workspace.workspacePath,
      })) as { sessions?: Array<{ id?: string; sessionId?: string }> };
      const last = listed.sessions?.at(-1);
      const id = last?.sessionId ?? last?.id;
      if (!id) return asCommandCenterApp(current);
      sessionId = id;
    }
    const resumed = (await client.request(zcodeProtocolMethods.sessionResume, {
      sessionId,
    })) as { sessionId?: string };
    current = await toHandle(resumed.sessionId ?? sessionId);
    return asCommandCenterApp(current);
  };

  const commandCenter = createCommandCenter({
    forkApp: async (targetCheckpointId) => {
      const active = current;
      const result = (await client.request(zcodeProtocolMethods.sessionFork, {
        sessionId: active.sessionId,
        target: targetCheckpointId
          ? { checkpointId: targetCheckpointId, kind: "checkpoint" }
          : { kind: "latestCheckpoint" },
      })) as { forkedSessionId: string; response: string };
      current = await toHandle(result.forkedSessionId);
      return {
        forkedSessionId: result.forkedSessionId,
        response: result.response,
      } as never;
    },
    getApp,
    getLocale: () => current.getLocale(),
    getMode: () => current.getMode() ?? "build",
    newApp,
    recordInputHistory: async (input) => {
      await current.recordInputHistory(input);
    },
    resumeApp,
    setMode: async (mode) => {
      const result = await current.setMode(mode as string);
      return (result.mode as never) ?? mode;
    },
    ...options.deps,
  });

  const submitPrompt: TuiPromptHandler = async (input, submitOptions) => {
    if (submitOptions?.requestPermission) {
      current.activeRequestPermission = submitOptions.requestPermission as never;
    }
    return await commandCenter(input, submitOptions);
  };

  submitPrompt.getMainSessionId = () => current.sessionId;
  submitPrompt.listMcpServers = async () => ({});
  submitPrompt.readSubagents = (input) => current.readSubagents(input);
  submitPrompt.readSubagentTranscript = (childSessionId) =>
    current.readSubagentTranscript(childSessionId);
  submitPrompt.recallPreviousInput = (skip) => current.recallPreviousInputHistory(skip);
  submitPrompt.sendInput = async (input: TuiPromptInput, sendOptions) =>
    current.sendInput(input, sendOptions as never);
  submitPrompt.setMode = async (mode) => {
    const result = await current.setMode(mode as string);
    return { mode: result.mode as never };
  };
  submitPrompt.listModelOptions = async () =>
    current.snapshot.settings.model.available as never;
  submitPrompt.subscribeSessionEvents = (sink) => current.addSink(sink);
  submitPrompt.close = async () => {
    await runtime.close();
  };

  return submitPrompt;
}
