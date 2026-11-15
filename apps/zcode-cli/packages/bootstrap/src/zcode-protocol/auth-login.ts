import { createSharedZCodeCredentialStore } from "@zcode/adapters";
import type { EnvRecord } from "@zcode/adapters/model";
import {
  zcodeAuthConfigureApiKeyParamsSchema,
  zcodeAuthConfigureApiKeyResultSchema,
  zcodeAuthLoginCancelParamsSchema,
  zcodeAuthLoginCancelResultSchema,
  zcodeAuthLoginCompleteParamsSchema,
  zcodeAuthLoginCompleteResultSchema,
  zcodeAuthLoginStartParamsSchema,
  zcodeAuthLoginStartResultSchema,
  zcodeAuthLogoutParamsSchema,
  zcodeAuthLogoutResultSchema,
  type ZCodeAuthConfigureApiKeyResult,
  type ZCodeAuthLoginCancelResult,
  type ZCodeAuthLoginCompleteResult,
  type ZCodeAuthLoginStartResult,
  type ZCodeAuthLogoutResult,
} from "@zcode/shared";
import {
  completeCliOAuthLoginFlow,
  configureCodingPlanApiKey,
  logoutZCodeCli,
  startCliOAuthLoginFlow,
  type CliOAuthLoginFlow,
  type LoginZCodeCliOptions,
} from "../auth-login.js";
import {
  parseParams,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * attach 瘦客户端（TUI/ACP）的 Coding Plan 登录面。
 *
 * 边界：core 只做 OAuth init/poll 与凭据/配置落盘（browser 可能在无显示环境）；
 * 浏览器打开与 URL 展示始终在 client 侧。apiKey/token 只进 params 与凭据文件，
 * 日志只记 method、provider、outcome，绝不回显凭据内容。
 *
 * Registry 刷新：凭据写入发生在 core 进程内，同路径的
 * SharedZCodeCredentialStore.onDidChange 监听（process-provider-registry-runtime
 * 的 standalone 订阅）会在写返回前完成 Account Source + Registry 重建，
 * 运行中的 core 不重启即可看到新的授权态。
 */

export interface ProtocolAuthLoginDeps {
  apiKeyResolver?: LoginZCodeCliOptions["apiKeyResolver"];
  credentialStore?: LoginZCodeCliOptions["credentialStore"];
  httpClient?: LoginZCodeCliOptions["httpClient"];
  now?: () => number;
  personalProviderConfigPath?: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

interface PendingOAuthFlow {
  // client 侧取消只断它自己的等待，够不到 core 的轮询；每个 flow 持有独立
  // AbortController，auth/loginCancel 才能精确中止在途 loginComplete。
  abort: AbortController;
  env: EnvRecord;
  flow: CliOAuthLoginFlow;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createProtocolAuthLoginHandlers(deps: ProtocolAuthLoginDeps = {}) {
  // flowId → pending flow。client 断线不丢（core 进程级）；OAuth 失败允许
  // 同 flowId 重试 complete，成功或过期才清。过期条目标惰性清扫。
  const pendingFlows = new Map<string, PendingOAuthFlow>();

  const envFor = (context: ZCodeProtocolAgentServerContext): EnvRecord =>
    context.deps.env ?? process.env;
  const storeFor = (env: EnvRecord) =>
    deps.credentialStore ?? createSharedZCodeCredentialStore({ env });
  // 轮询同时受两条取消源约束：client socket 断线（detach）与 auth/loginCancel。
  // 缺 detach 的 context（测试/独立调用）只受 flow 自身 controller 控制。
  const flowSignal = (
    abort: AbortController,
    context: ZCodeProtocolAgentServerContext,
  ): AbortSignal => {
    const detach = context.getClientDetachSignal?.();
    return detach ? AbortSignal.any([detach, abort.signal]) : abort.signal;
  };
  const sweepExpired = (now: () => number): void => {
    const nowSec = now() / 1_000;
    for (const [flowId, pending] of pendingFlows) {
      if (pending.flow.initData.expires_at <= nowSec) pendingFlows.delete(flowId);
    }
  };

  const loginStart = async (
    context: ZCodeProtocolAgentServerContext,
    rawParams: unknown,
  ): Promise<ZCodeAuthLoginStartResult> => {
    const params = parseParams(zcodeAuthLoginStartParamsSchema, rawParams);
    const env = envFor(context);
    sweepExpired(deps.now ?? Date.now);
    const abort = new AbortController();
    try {
      const flow = await startCliOAuthLoginFlow({
        abortSignal: flowSignal(abort, context),
        credentialStore: deps.credentialStore,
        env,
        httpClient: deps.httpClient,
        providerId: params.provider,
      });
      pendingFlows.set(flow.initData.flow_id, { abort, env, flow });
      context.logger?.info("coding plan oauth flow started", {
        event: "zcode_protocol.auth.login_start",
        outcome: "ok",
        provider: params.provider,
      });
      return zcodeAuthLoginStartResultSchema.parse({
        authorizeUrl: flow.initData.authorize_url,
        expiresAt: flow.initData.expires_at,
        flowId: flow.initData.flow_id,
        pollIntervalSec: flow.initData.poll_interval_sec,
      });
    } catch (error) {
      context.logger?.warn("coding plan oauth init failed", {
        error: toErrorMessage(error),
        event: "zcode_protocol.auth.login_start",
        outcome: "failed",
        provider: params.provider,
      });
      throw error;
    }
  };

  const loginComplete = async (
    context: ZCodeProtocolAgentServerContext,
    rawParams: unknown,
  ): Promise<ZCodeAuthLoginCompleteResult> => {
    const params = parseParams(zcodeAuthLoginCompleteParamsSchema, rawParams);
    sweepExpired(deps.now ?? Date.now);
    const pending = pendingFlows.get(params.flowId);
    if (!pending) {
      return zcodeAuthLoginCompleteResultSchema.parse({
        error: "Login flow expired or unknown. Run /login again.",
        ok: false,
      });
    }
    try {
      const result = await completeCliOAuthLoginFlow({
        abortSignal: flowSignal(pending.abort, context),
        apiKeyResolver: deps.apiKeyResolver,
        credentialStore: deps.credentialStore,
        env: pending.env,
        flow: pending.flow,
        httpClient: deps.httpClient,
        now: deps.now,
        personalProviderConfigPath: deps.personalProviderConfigPath,
        sleep: deps.sleep,
        timeoutMs: deps.timeoutMs,
      });
      // 成功的 flow 不能重放：服务端 OAuth 会话一次性，凭据也已落盘。
      pendingFlows.delete(params.flowId);
      context.logger?.info("coding plan oauth login completed", {
        event: "zcode_protocol.auth.login_complete",
        outcome: "ok",
        provider: pending.flow.providerId,
      });
      return zcodeAuthLoginCompleteResultSchema.parse({
        configPath: result.configPath,
        credentialsPath: result.credentialsPath,
        model: result.model,
        ok: true,
        provider: pending.flow.providerId,
        user: result.user,
      });
    } catch (error) {
      context.logger?.warn("coding plan oauth login failed", {
        error: toErrorMessage(error),
        event: "zcode_protocol.auth.login_complete",
        outcome: "failed",
        provider: pending.flow.providerId,
      });
      // 登录失败走结果体而非协议错误：client 要渲染可读提示 + standalone fallback。
      return zcodeAuthLoginCompleteResultSchema.parse({
        error: toErrorMessage(error),
        ok: false,
      });
    }
  };

  const loginCancel = async (
    context: ZCodeProtocolAgentServerContext,
    rawParams: unknown,
  ): Promise<ZCodeAuthLoginCancelResult> => {
    const params = parseParams(zcodeAuthLoginCancelParamsSchema, rawParams);
    const pending = pendingFlows.get(params.flowId);
    if (pending) {
      // abort reason 会成为在途 loginComplete 结果体的 error 文本，与 client 侧
      // 取消文案保持一致；flow 立即摘除，防止取消后同 flowId 重新 complete。
      pending.abort.abort(new Error("Login cancelled."));
      pendingFlows.delete(params.flowId);
    }
    // 取消按目标状态幂等：flow 未知/已完成/已过期时同样回 ok。
    context.logger?.info("coding plan oauth login cancel requested", {
      event: "zcode_protocol.auth.login_cancel",
      outcome: pending ? "ok" : "unknown_flow",
      provider: pending?.flow.providerId ?? "unknown",
    });
    return zcodeAuthLoginCancelResultSchema.parse({ ok: true });
  };

  const configureApiKey = async (
    context: ZCodeProtocolAgentServerContext,
    rawParams: unknown,
  ): Promise<ZCodeAuthConfigureApiKeyResult> => {
    // params 里含 apiKey：只做 schema 校验与透传，绝不进入日志或返回体。
    const params = parseParams(zcodeAuthConfigureApiKeyParamsSchema, rawParams);
    const env = envFor(context);
    try {
      const result = await configureCodingPlanApiKey({
        apiKey: params.apiKey,
        credentialStore: storeFor(env),
        env,
        personalProviderConfigPath: deps.personalProviderConfigPath,
        providerId: params.provider,
      });
      context.logger?.info("coding plan api key configured", {
        event: "zcode_protocol.auth.configure_api_key",
        outcome: "ok",
        provider: params.provider,
      });
      return zcodeAuthConfigureApiKeyResultSchema.parse({
        configPath: result.configPath,
        model: result.model,
        ok: true,
        provider: params.provider,
      });
    } catch (error) {
      context.logger?.warn("coding plan api key configure failed", {
        error: toErrorMessage(error),
        event: "zcode_protocol.auth.configure_api_key",
        outcome: "failed",
        provider: params.provider,
      });
      return zcodeAuthConfigureApiKeyResultSchema.parse({
        error: toErrorMessage(error),
        ok: false,
      });
    }
  };

  const logout = async (
    context: ZCodeProtocolAgentServerContext,
    rawParams: unknown,
  ): Promise<ZCodeAuthLogoutResult> => {
    const params = parseParams(zcodeAuthLogoutParamsSchema, rawParams ?? {});
    const env = envFor(context);
    const result = await logoutZCodeCli({
      credentialStore: storeFor(env),
      env,
    });
    context.logger?.info("coding plan logout completed", {
      event: "zcode_protocol.auth.logout",
      outcome: "ok",
      provider: params.provider ?? "all",
    });
    return zcodeAuthLogoutResultSchema.parse({
      credentialsPath: result.credentialsPath,
      ok: true,
    });
  };

  return {
    configureApiKey,
    loginCancel,
    loginComplete,
    loginStart,
    logout,
  };
}

const defaultHandlers = createProtocolAuthLoginHandlers();
export const authLoginStart = defaultHandlers.loginStart;
export const authLoginComplete = defaultHandlers.loginComplete;
export const authLoginCancel = defaultHandlers.loginCancel;
export const authConfigureApiKey = defaultHandlers.configureApiKey;
export const authLogout = defaultHandlers.logout;
