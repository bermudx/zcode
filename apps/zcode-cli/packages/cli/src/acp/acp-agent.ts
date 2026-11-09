// ACP agent 的方法分发与能力声明。
//
// 能力一律如实声明，宁少勿多：
// - 不声明 loadSession：我们不重放历史；T3 在 loadSession=true 时会优先走
//   session/load 并要求重放，声明了却做不到只会得到一个空对话。
// - 声明 sessionCapabilities.resume / close：resume 是会话重连的正路，close
//   是 T3 Stop 的"真停止"通道。
// - 不声明 mcpCapabilities：无插件模式下 core 不跑 MCP，T3 传进来的
//   mcpServers 会被接受、记日志、忽略（规范要求 agent 连上，我们如实不连）。
// - 不声明 authMethods：登录在 ACP 之外（piz login），session/new 不会
//   需要认证。
import {
  ACP_PROTOCOL_VERSION,
  acpErrorCodes,
  acpMethods,
  acpSessionCancelParamsSchema,
  acpSessionCloseParamsSchema,
  acpSessionNewParamsSchema,
  acpSessionPromptParamsSchema,
  acpSessionResumeParamsSchema,
  acpSessionSetConfigOptionParamsSchema,
  acpSessionSetModeParamsSchema,
  acpSessionSetModelParamsSchema,
  acpInitializeParamsSchema,
  isJsonObject,
} from "./acp-protocol.js";
import type { AcpCorePool } from "./acp-core.js";
import { AcpWireError } from "./acp-wire.js";

export type AcpAgentInfo = { name: string; version: string };

export type AcpAgentLogger = {
  warn: (message: string, context?: Record<string, unknown>) => void;
};

export type AcpAgentOptions = {
  clientInfo?: AcpAgentInfo;
  core: AcpCorePool;
  logger: AcpAgentLogger;
};

function parseParams<T>(
  schema: {
    safeParse: (value: unknown) =>
      | { success: true; data: T }
      | { success: false; error: { flatten(): unknown } };
  },
  method: string,
  params: unknown,
): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new AcpWireError(acpErrorCodes.invalidParams, `invalid params for ${method}`, {
      issues: parsed.error.flatten(),
    });
  }
  return parsed.data;
}

/** mcpServers 被忽略这件事必须留痕：静默丢弃等于让人以为 MCP 工具可用。 */
function logIgnoredMcpServers(
  logger: AcpAgentLogger,
  method: string,
  servers: readonly unknown[] | null | undefined,
): void {
  if (!servers || servers.length === 0) return;
  logger.warn("acp ignored client mcp servers", {
    count: servers.length,
    method,
    names: servers
      .map((server) => (isJsonObject(server) && typeof server.name === "string" ? server.name : "?"))
      .slice(0, 8),
  });
}

export class AcpAgent {
  private readonly options: AcpAgentOptions;
  private initialized = false;

  constructor(options: AcpAgentOptions) {
    this.options = options;
  }

  /** ACP 方法分发入口：wire 的 requestHandler 直接指到这里。 */
  handleRequest = async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case acpMethods.initialize:
        return this.initialize(params);
      case acpMethods.authenticate:
        // 不声明 authMethods 的 agent 不该收到 authenticate。
        throw new AcpWireError(acpErrorCodes.methodNotFound, `method not found: ${method}`);
      case acpMethods.sessionNew:
        this.requireInitialized(method);
        return await this.newSession(params);
      case acpMethods.sessionResume:
        this.requireInitialized(method);
        return await this.resumeSession(params);
      case acpMethods.sessionClose:
        this.requireInitialized(method);
        return await this.closeSession(params);
      case acpMethods.sessionPrompt:
        this.requireInitialized(method);
        return await this.prompt(params);
      case acpMethods.sessionSetMode:
        this.requireInitialized(method);
        return await this.setMode(params);
      case acpMethods.sessionSetModel:
        this.requireInitialized(method);
        return await this.setModel(params);
      case acpMethods.sessionSetConfigOption:
        this.requireInitialized(method);
        return await this.setConfigOption(params);
      default:
        throw new AcpWireError(acpErrorCodes.methodNotFound, `method not found: ${method}`);
    }
  };

  /** session/cancel 是 notification：没有 id，也不回应答。 */
  handleNotification = (method: string, params: unknown): void => {
    if (method !== acpMethods.sessionCancel) return;
    const parsed = acpSessionCancelParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.options.logger.warn("acp dropped invalid session/cancel");
      return;
    }
    const session = this.options.core.findSession(parsed.data.sessionId);
    if (!session) {
      this.options.logger.warn("acp cancel for unknown session", {
        sessionId: parsed.data.sessionId,
      });
      return;
    }
    session.cancel();
  };

  private initialize(params: unknown): unknown {
    const parsed = parseParams(acpInitializeParamsSchema, acpMethods.initialize, params);
    if (parsed.protocolVersion !== ACP_PROTOCOL_VERSION) {
      // 只支持 v1：不尝试降级/猜测。ACP 客户端看到 -32602 会给出自己的提示。
      throw new AcpWireError(
        acpErrorCodes.invalidParams,
        `unsupported ACP protocol version ${parsed.protocolVersion}; this agent speaks v${ACP_PROTOCOL_VERSION}`,
      );
    }
    if (parsed.clientCapabilities?.elicitation?.form == null) {
      // AskUserQuestion / ExitPlanMode 只能靠 form elicitation 表达。
      // 没有 form 能力的客户端仍可用，但这两类交互会被如实 decline。
      this.options.logger.warn("acp client does not advertise form elicitation");
    }
    this.initialized = true;
    const info = this.options.clientInfo ?? { name: "piz", version: "0.0.0" };
    return {
      agentCapabilities: {
        // 不声明 loadSession（见文件头）。
        promptCapabilities: { audio: false, embeddedContext: false, image: false },
        sessionCapabilities: { close: {}, resume: {} },
      },
      agentInfo: { name: info.name, version: info.version },
      authMethods: [],
      protocolVersion: ACP_PROTOCOL_VERSION,
    };
  }

  private async newSession(params: unknown): Promise<unknown> {
    const parsed = parseParams(acpSessionNewParamsSchema, acpMethods.sessionNew, params);
    logIgnoredMcpServers(this.options.logger, acpMethods.sessionNew, parsed.mcpServers);
    const session = await this.options.core.createSession({ cwd: parsed.cwd });
    await this.options.core.subscribeSession(session);
    return {
      configOptions: session.configOptions(),
      modes: session.modeState(),
      sessionId: session.sessionId,
    };
  }

  private async resumeSession(params: unknown): Promise<unknown> {
    const parsed = parseParams(acpSessionResumeParamsSchema, acpMethods.sessionResume, params);
    logIgnoredMcpServers(this.options.logger, acpMethods.sessionResume, parsed.mcpServers);
    const session = await this.options.core.resumeSession({
      cwd: parsed.cwd,
      sessionId: parsed.sessionId,
    });
    await this.options.core.subscribeSession(session);
    return {
      configOptions: session.configOptions(),
      modes: session.modeState(),
    };
  }

  private async closeSession(params: unknown): Promise<unknown> {
    const parsed = parseParams(acpSessionCloseParamsSchema, acpMethods.sessionClose, params);
    const session = this.options.core.findSession(parsed.sessionId);
    if (!session) return {};
    await session.close();
    return {};
  }

  private async prompt(params: unknown): Promise<unknown> {
    const parsed = parseParams(acpSessionPromptParamsSchema, acpMethods.sessionPrompt, params);
    const session = this.options.core.findSession(parsed.sessionId);
    if (!session) {
      throw new AcpWireError(
        acpErrorCodes.invalidParams,
        `unknown session: ${parsed.sessionId}`,
      );
    }
    const outcome = await session.prompt(parsed.prompt as Parameters<typeof session.prompt>[0]);
    return {
      stopReason: outcome.stopReason,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    };
  }

  private async setMode(params: unknown): Promise<unknown> {
    const parsed = parseParams(acpSessionSetModeParamsSchema, acpMethods.sessionSetMode, params);
    const session = this.requireSession(parsed.sessionId);
    await session.setMode(parsed.modeId);
    return {};
  }

  private async setModel(params: unknown): Promise<unknown> {
    const parsed = parseParams(
      acpSessionSetModelParamsSchema,
      acpMethods.sessionSetModel,
      params,
    );
    const session = this.requireSession(parsed.sessionId);
    await session.setModel(parsed.modelId);
    return {};
  }

  private async setConfigOption(params: unknown): Promise<unknown> {
    const parsed = parseParams(
      acpSessionSetConfigOptionParamsSchema,
      acpMethods.sessionSetConfigOption,
      params,
    );
    const session = this.requireSession(parsed.sessionId);
    await session.setConfigOption(parsed.configId, parsed.value);
    return { configOptions: session.configOptions() };
  }

  private requireSession(sessionId: string) {
    const session = this.options.core.findSession(sessionId);
    if (!session) {
      throw new AcpWireError(acpErrorCodes.invalidParams, `unknown session: ${sessionId}`);
    }
    return session;
  }

  private requireInitialized(method: string): void {
    if (this.initialized) return;
    throw new AcpWireError(
      acpErrorCodes.invalidRequest,
      `${method} requires a completed initialize`,
    );
  }
}
