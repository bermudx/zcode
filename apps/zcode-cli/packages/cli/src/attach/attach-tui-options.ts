// attach 运行时：持有 socket client、会话句柄注册表与断线重连状态机。
// TuiPromptHandler 与 CommandCenterApp 是同一层的两面——提交/输入走 commandCenter
// 的 slash 路由（client 侧），业务事实全部在 core。
import type { SessionEvent } from "@zcode/contracts";
import {
  zcodeProtocolErrorCodes,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type ZCodeSessionRawEvent,
} from "@zcode/shared";
import type {
  TuiPromptInput,
  TuiSubmitPromptResult,
} from "@zcode/tui";
import { connectAttachClient, AttachProtocolError, type AttachClient } from "./attach-client.js";
import { AttachSessionHandle, asCommandCenterApp } from "./attach-session.js";
import type { CommandCenterApp, CommandCenterDeps } from "../command-center.js";
import { createCommandCenter, parseSlashCommand } from "../command-center.js";
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
  /** session/resume 冷恢复所需的 workspace ref（core 重启后 session/subscribe 找不到 record）。 */
  workspace?: { workspacePath: string; workspaceKey: string; workspaceIdentity?: string };
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
  private readonly statusListeners = new Set<(status: string) => void>();

  /** Écoute de l'état de connexion (port TuiOptions.subscribeConnectionStatus). */
  onConnectionStatus(listener: (status: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private emitStatus(status: string): void {
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

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
    if (method === "state.updated") {
      // legacy mutation（session/setModel 等）只走 state.updated settings patch，不发 raw 事件；
      // 不合并会让已挂 TUI 的状态行停在旧模型（Ctrl+P 后看似切模失败）。
      const notification = params as { sessionId?: string; patch?: unknown };
      const handle = notification.sessionId
        ? this.sessions.get(String(notification.sessionId))
        : this.current;
      handle?.applyStatePatch(notification.patch);
      return;
    }
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
    this.emitStatus("Connexion au core perdue — reconnexion…");
    for (const handle of this.sessions.values()) {
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
    let recovered = 0;
    const total = this.sessions.size;
    for (const handle of this.sessions.values()) {
      if (await this.recoverSession(handle)) {
        recovered++;
        handle.ingestRawEvent(
          connectionNoticeEvent(
            handle.sessionId,
            "Reconnected to shared core.",
          ) as unknown as ZCodeSessionRawEvent,
        );
      } else {
        this.options.logger?.warn?.("attach resubscribe failed", {
          sessionId: handle.sessionId,
        });
      }
    }
    if (total === 0 || recovered === total) {
      this.emitStatus("Reconnecté au core");
    } else {
      // core 重连但会话不可恢复（新 core registry 无 record、store 未持久化）——
      // 如实显示并继续退避：core 若在下一轮可恢复（异步物化），仍会补上。
      this.emitStatus("Reconnecté au core — session indisponible, nouvelle tentative…");
      this.scheduleReconnect();
    }
  }

  /** subscribe 失败若是 sessionUnavailable，先经 session/resume 冷物化再重试一次。 */
  private async recoverSession(handle: AttachSessionHandle): Promise<boolean> {
    try {
      await handle.resubscribe();
      return true;
    } catch (error) {
      if (
        !(error instanceof AttachProtocolError) ||
        error.code !== zcodeProtocolErrorCodes.sessionUnavailable ||
        !this.client ||
        !this.options.workspace
      ) {
        return false;
      }
      try {
        await this.client.request(zcodeProtocolMethods.sessionResume, {
          sessionId: handle.sessionId,
          workspace: this.options.workspace,
        });
        await handle.resubscribe();
        return true;
      } catch {
        return false;
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
  workspace: { workspacePath: string; workspaceKey: string; workspaceIdentity?: string };
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
    const created = (await client.request(zcodeProtocolMethods.sessionCreate, {
      workspace: options.workspace,
    })) as { session: { sessionId: string } };
    current = await toHandle(created.session.sessionId);
    return asCommandCenterApp(current);
  };

  const resumeApp = async (sessionId?: string): Promise<CommandCenterApp> => {
    if (!sessionId) {
      const listed = (await client.request(zcodeProtocolMethods.sessionList, {
        workspace: options.workspace,
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
  submitPrompt.sendInput = async (input: TuiPromptInput, sendOptions) => {
    // /model /effort 是客户端侧命令（Ctrl+P 轮换、Ctrl+L 选择器都走 sendInput），
    // 必须经 commandCenter → handle.setModel/setThoughtLevel；直接 session/send
    // 会把命令文本当 prompt 发给模型（曾导致"轮换"只是模型聊了一句命令名）。
    const command = parseSlashCommand(
      typeof input === "string" ? input : input.text,
    );
    if (
      command?.type === "known" &&
      (command.name === "model" || command.name === "effort")
    ) {
      return {
        kind: "command_result",
        result: await submitPrompt(input, {
          ...sendOptions,
          abortSignal: sendOptions?.abortSignal ?? new AbortController().signal,
        }),
      };
    }
    return current.sendInput(input, sendOptions as never);
  };
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
