// attach 瘦客户端（TUI/ACP）共用的 Coding Plan 登录面。
// auth/* 协议方法直达共享 core：OAuth init/poll 与凭据落盘全部在 core 进程完成；
// 客户端只负责协议调用、打开浏览器（core 可能无显示）与结果映射。
// 刻意不 import @zcode/bootstrap|adapters|core|provider——瘦客户端边界（
// docs/design/v2/tui-attach-shared-core.md）。
import { spawn, type ChildProcess } from "node:child_process";
import {
  zcodeAuthConfigureApiKeyResultSchema,
  zcodeAuthLoginCompleteResultSchema,
  zcodeAuthLoginStartResultSchema,
  zcodeAuthLogoutResultSchema,
  zcodeProtocolMethods,
  type ZCodeAuthCodingPlanProvider,
} from "@zcode/shared";
import type {
  CommandCenterApiKeyResult,
  CommandCenterDeps,
  CommandCenterLoginAuthorizeData,
  CommandCenterLoginResult,
  CommandCenterLogoutResult,
} from "../command-center/types.js";

export type ThinAuthRequest = (method: string, params?: unknown) => Promise<unknown>;

// 与 adapters/browser.ts 同语义的独立实现：瘦客户端不允许 import adapters，
// 只能按同一行为在 client 侧复制一份（detached + stdio ignore + spawn 事件即算成功）。
export interface ThinBrowserOpenResult {
  command: string;
  opened: boolean;
  reason?: string;
}

export interface ThinBrowserOpenOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
}

const BROWSER_OPEN_SETTLE_TIMEOUT_MS = 1_000;

export async function openThinAuthUrl(
  url: string,
  options: ThinBrowserOpenOptions = {},
): Promise<ThinBrowserOpenResult> {
  const platform = options.platform ?? process.platform;
  const command =
    platform === "darwin"
      ? { args: [url], executable: "open" }
      : platform === "win32"
        ? { args: ["/c", "start", "", url], executable: "cmd.exe" }
        : { args: [url], executable: "xdg-open" };
  const spawnProcess = options.spawnProcess ?? spawn;
  try {
    const child = spawnProcess(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    return await waitForBrowserSpawn(
      child,
      command.executable,
      options.timeoutMs ?? BROWSER_OPEN_SETTLE_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      command: command.executable,
      opened: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function waitForBrowserSpawn(
  child: ChildProcess,
  command: string,
  timeoutMs: number,
): Promise<ThinBrowserOpenResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (result: ThinBrowserOpenResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners("error");
      child.removeAllListeners("spawn");
      if (result.opened) child.unref();
      resolve(result);
    };
    timeout = setTimeout(() => settle({ command, opened: true }), timeoutMs);
    child.once("spawn", () => settle({ command, opened: true }));
    child.once("error", (error) => {
      settle({ command, opened: false, reason: error.message });
    });
  });
}

// work 必须是 thunk：已 abort 时连 request 都不能发出（先建请求再判 abort 会多打一次 wire call）。
function withAbort<T>(work: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Login cancelled."));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface ThinLoginOptions {
  abortSignal?: AbortSignal;
  onAuthorizeUrl?: (data: CommandCenterLoginAuthorizeData) => void | Promise<void>;
  openBrowser?: (url: string) => Promise<ThinBrowserOpenResult>;
  providerId: ZCodeAuthCodingPlanProvider;
  request: ThinAuthRequest;
}

/**
 * auth/loginStart → 本地开浏览器 → auth/loginComplete。URL 永远先经
 * onAuthorizeUrl 暴露给调用方展示，浏览器打开失败不阻断登录。
 * start 之后 abortSignal 触发会 best-effort 补发 auth/loginCancel，
 * 中止 core 侧孤儿轮询。
 */
export async function loginViaAttachProtocol(
  options: ThinLoginOptions,
): Promise<CommandCenterLoginResult> {
  const signal = options.abortSignal;
  const start = zcodeAuthLoginStartResultSchema.parse(
    await withAbort(
      () =>
        options.request(zcodeProtocolMethods.authLoginStart, { provider: options.providerId }),
      signal,
    ),
  );
  // start 之后的本地 abort 只断 client 的等待：core 的孤儿轮询会继续跑，还会占住
  // 该连接上的后续普通请求，必须显式发 auth/loginCancel 中止。best-effort——
  // cancel 失败只让 flow 等 expires_at 惰性过期，不改变本地取消语义。
  const cancelCoreFlow = () => {
    void options
      .request(zcodeProtocolMethods.authLoginCancel, { flowId: start.flowId })
      .catch(() => {});
  };
  signal?.addEventListener("abort", cancelCoreFlow, { once: true });
  try {
    await options.onAuthorizeUrl?.({
      authorize_url: start.authorizeUrl,
      expires_at: start.expiresAt,
      flow_id: start.flowId,
      poll_interval_sec: start.pollIntervalSec,
    });
    if (signal?.aborted) throw signal.reason ?? new Error("Login cancelled.");
    const browser = await (options.openBrowser ?? openThinAuthUrl)(start.authorizeUrl);
    const completed = zcodeAuthLoginCompleteResultSchema.parse(
      await withAbort(
        () => options.request(zcodeProtocolMethods.authLoginComplete, { flowId: start.flowId }),
        signal,
      ),
    );
    if (!completed.ok) throw new Error(completed.error);
    return {
      ...(browser ? { browser } : {}),
      configPath: completed.configPath,
      credentialsPath: completed.credentialsPath,
      model: completed.model,
      providerId: completed.provider,
      user: completed.user,
    };
  } finally {
    // 登录已结束（成功/失败/取消）后移除监听，避免晚到的 abort 对一个
    // 已完结的 flowId 再发一次无意义 cancel。
    signal?.removeEventListener("abort", cancelCoreFlow);
  }
}

export async function configureApiKeyViaAttachProtocol(input: {
  apiKey: string;
  providerId: ZCodeAuthCodingPlanProvider;
  request: ThinAuthRequest;
}): Promise<CommandCenterApiKeyResult> {
  const result = zcodeAuthConfigureApiKeyResultSchema.parse(
    await input.request(zcodeProtocolMethods.authConfigureApiKey, {
      apiKey: input.apiKey,
      provider: input.providerId,
    }),
  );
  if (!result.ok) throw new Error(result.error);
  return { configPath: result.configPath, model: result.model, providerId: result.provider };
}

export async function logoutViaAttachProtocol(input: {
  request: ThinAuthRequest;
}): Promise<CommandCenterLogoutResult> {
  const result = zcodeAuthLogoutResultSchema.parse(
    await input.request(zcodeProtocolMethods.authLogout, {}),
  );
  return { credentialsPath: result.credentialsPath };
}

/** command-center auth deps 的 attach 版：四个字段一次配齐，attach/acp 共用。 */
export function createAttachAuthDeps(input: {
  openBrowser?: (url: string) => Promise<ThinBrowserOpenResult>;
  request: ThinAuthRequest;
}): Pick<
  CommandCenterDeps,
  "configureApiKey" | "login" | "loginBigmodel" | "logout"
> {
  return {
    configureApiKey: ({ apiKey, providerId }) =>
      configureApiKeyViaAttachProtocol({ apiKey, providerId, request: input.request }),
    login: (loginOptions) =>
      loginViaAttachProtocol({
        abortSignal: loginOptions?.abortSignal,
        onAuthorizeUrl: loginOptions?.onAuthorizeUrl,
        openBrowser: input.openBrowser,
        providerId: "zai",
        request: input.request,
      }),
    loginBigmodel: async (loginOptions) => {
      const result = await loginViaAttachProtocol({
        abortSignal: loginOptions?.abortSignal,
        onAuthorizeUrl: loginOptions?.onAuthorizeUrl,
        openBrowser: input.openBrowser,
        providerId: "bigmodel",
        request: input.request,
      });
      return {
        ...(result.browser ? { browser: result.browser } : {}),
        configPath: result.configPath,
        model: result.model,
        providerId: "bigmodel" as const,
      };
    },
    logout: () => logoutViaAttachProtocol({ request: input.request }),
  };
}
