export { ZCodeCliLoginError } from "./auth-login-contract.js";
export type {
  CodingPlanProviderId,
  LoginZCodeCliOptions,
  LoginZCodeCliResult,
  LoginBigmodelCodingPlanOptions,
  LoginBigmodelCodingPlanResult,
  ConfigureCodingPlanApiKeyOptions,
  ConfigureCodingPlanApiKeyResult,
  LogoutZCodeCliOptions,
  LogoutZCodeCliResult,
} from "./auth-login-contract.js";
import {
  ZCodeCliLoginError,
  type CodingPlanProviderId,
  type LoginZCodeCliOptions,
  type LoginZCodeCliResult,
  type LoginBigmodelCodingPlanOptions,
  type LoginBigmodelCodingPlanResult,
  type ConfigureCodingPlanApiKeyOptions,
  type ConfigureCodingPlanApiKeyResult,
  type LogoutZCodeCliOptions,
  type LogoutZCodeCliResult,
} from "./auth-login-contract.js";
import {
  createCodingPlanApiKeyResolver,
  createSharedZCodeCredentialStore,
  createCliOAuthClient,
  createCliOAuthPollToken,
  openUrlInBrowser,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type CliOAuthClient,
  type CliOAuthInitData,
  type SharedCredentialRecoveryGuard,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters";
import { createConfig } from "@zcode/adapters/config";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import type { EnvRecord } from "@zcode/adapters/model";
import { buildZCodeEndpointUrls, resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";
import { setTimeout as delay } from "node:timers/promises";
import {
  createStandaloneAccountIdentityFromSecret,
  hasStandaloneCodingPlanAccess,
  readStandaloneCodingPlanProviders,
  resolveStandaloneCodingPlanProvider,
  standaloneAccountIdentityCredentialKey,
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "./app/standalone-account-provider-runtime.js";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { dirname, join } from "node:path";
import { readLegacyCliPersonalProviderConfig } from "./app/legacy-cli-personal-provider-config-importer.js";
import { throwIfAborted, waitWithAbort } from "./auth-login-abort.js";
import { pollUntilReady } from "./auth-login-polling.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

// auth/loginStart → auth/loginComplete 之间在 core 进程内传递的 OAuth 会话。
// 客户端只持有 flowId，不接触 pollToken 与 HTTP client。
export interface CliOAuthLoginFlow {
  // loginStart 时在 init 前捕获的凭据代次：授权期间 Desktop 恢复（或其它进程）
  // 改写共享凭据库时，迟到的 ready 结果不得重新填充新库。
  credentialGuard: SharedCredentialRecoveryGuard;
  credentialStore: SharedZCodeCredentialStore;
  expectedSession: Record<string, string | null>;
  initData: CliOAuthInitData;
  oauthClient: CliOAuthClient;
  pollToken: string;
  providerId: CodingPlanProviderId;
}

export interface StartCliOAuthLoginFlowOptions {
  abortSignal?: AbortSignal;
  baseUrl?: string;
  credentialStore?: LoginZCodeCliOptions["credentialStore"];
  env?: EnvRecord;
  httpClient?: LoginZCodeCliOptions["httpClient"];
  pollToken?: string;
  providerId?: CodingPlanProviderId;
}

/** OAuth init 半段：只拿授权地址；浏览器打开与展示始终归 client（core 可能无显示）。 */
export async function startCliOAuthLoginFlow(
  options: StartCliOAuthLoginFlowOptions = {},
): Promise<CliOAuthLoginFlow> {
  const env = options.env ?? process.env;
  const providerId = options.providerId ?? "zai";
  throwIfAborted(options.abortSignal);
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env });
  // CLI 也可能与 Desktop 恢复并发：在 init 前保留代次，迟到结果不得重新填充新空库。
  const credentialGuard = await credentialStore.captureRecoveryGuard();
  const expectedSession = await credentialStore.loadOAuthSessionSnapshot();
  // Bug 原因：空库快照不访问系统库，库不可用要等用户完成授权、写入凭据时才暴露。
  // 授权前先确认写入能力，原始安全存储错误直接上抛，与已有会话时快照解密失败一致。
  await waitWithAbort(credentialStore.assertWritable(), options.abortSignal);
  const pollToken = options.pollToken ?? createCliOAuthPollToken();
  const oauthClient = createCliOAuthClient({
    baseUrl:
      options.baseUrl ?? buildZCodeEndpointUrls(resolveCliZCodeEndpointOrigin(env)).apiBaseUrl,
    providerId,
    httpClient: options.httpClient ?? createDefaultHttpClient(env),
  });
  const initData = await waitWithAbort(
    oauthClient.init({ pollToken }, { signal: options.abortSignal }),
    options.abortSignal,
  );
  return {
    credentialGuard,
    credentialStore,
    expectedSession,
    initData,
    oauthClient,
    pollToken,
    providerId,
  };
}

export interface CompleteCliOAuthLoginFlowOptions {
  abortSignal?: AbortSignal;
  apiKeyResolver?: LoginZCodeCliOptions["apiKeyResolver"];
  credentialStore?: LoginZCodeCliOptions["credentialStore"];
  env?: EnvRecord;
  flow: CliOAuthLoginFlow;
  httpClient?: LoginZCodeCliOptions["httpClient"];
  now?: () => number;
  onPollStatus?: LoginZCodeCliOptions["onPollStatus"];
  personalProviderConfigPath?: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * OAuth poll + 落盘半段：轮询到 ready/超时，再解析项目访问材料并写入凭据与默认模型。
 * OAuth 登录不落盘派生 API Key，运行时按 `authSource: "oauth"` 用访问令牌换取请求凭据。
 * 凭据写入发生在 core 进程内，进程级 credentialStore.onDidChange 会直接触发
 * Provider Registry 重建，运行中的 core 无需重启即可看到新的授权态。
 */
export async function completeCliOAuthLoginFlow(
  options: CompleteCliOAuthLoginFlowOptions,
): Promise<Omit<LoginZCodeCliResult, "browser">> {
  const env = options.env ?? process.env;
  const { flow } = options;
  const providerId = flow.providerId;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const timeoutError = () =>
    new ZCodeCliLoginError("auth_timeout", "Authorization timed out. Please retry login.");
  const timer = setTimeout(() => timeoutController.abort(timeoutError()), timeoutMs);
  try {
    throwIfAborted(signal);
    const credentialStore = options.credentialStore ?? flow.credentialStore;
    // 调用方显式换成另一个 store 时，init 前捕获的代次不再适用，须在新 store 上重捕。
    const credentialGuard =
      credentialStore === flow.credentialStore
        ? flow.credentialGuard
        : await credentialStore.captureRecoveryGuard();
    const expectedSession =
      credentialStore === flow.credentialStore
        ? flow.expectedSession
        : await credentialStore.loadOAuthSessionSnapshot();
    const readyData = await pollUntilReady({
      abortSignal: signal,
      initData: flow.initData,
      now,
      oauthClient: flow.oauthClient,
      onPollStatus: options.onPollStatus,
      pollToken: flow.pollToken,
      sleep: options.sleep ?? ((ms) => delay(ms, undefined, { signal })),
      timeoutMs,
      createError: (code) =>
        code === "auth_timeout"
          ? timeoutError()
          : new ZCodeCliLoginError(code, "Authorization failed. Please retry login."),
    });
    const resolver =
      options.apiKeyResolver ??
      createCodingPlanApiKeyResolver({
        httpClient: options.httpClient ?? createDefaultHttpClient(env),
      });
    const accessToken =
      providerId === "zai"
        ? await waitWithAbort(
            resolver.exchangeZaiBusinessToken(readyData.accessToken),
            signal,
          )
        : readyData.accessToken;
    const material = await waitWithAbort(
      resolveCodingPlanMaterial({
        accessToken,
        env,
        httpClient: options.httpClient,
        family: providerId,
        resolver,
        signal,
      }),
      signal,
    );
    // 已取消或已超时的登录不能把迟到的 ready 响应写入凭据。
    throwIfAborted(signal);
    // Z.ai 以账号用户 ID 作为连接身份；BigModel 的项目令牌按组织与项目签发，
    // 连接身份沿用组织与项目的稳定摘要，与运行时的令牌缓存范围一致。
    const accountIdentity =
      providerId === "zai"
        ? readyData.user.user_id
        : createStandaloneAccountIdentityFromSecret(
            JSON.stringify([material.organizationId, material.projectId]),
          );
    try {
      await credentialGuard.run(async () => {
        if (providerId === "zai") {
          await credentialStore.saveZaiLoginCredentials(
            {
              accessToken,
              jwtToken: readyData.token,
              user: readyData.user,
            },
            expectedSession,
            () => throwIfAborted(signal),
          );
        } else {
          const displayName = readyData.user.name || readyData.user.email || readyData.user.user_id;
          const committed = await credentialStore.updateMany(
            {
              ...Object.fromEntries(
                Object.values(SHARED_ZCODE_CREDENTIAL_KEYS).map((key) => [key, null]),
              ),
              [SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider]: providerId,
              [SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken]: readyData.token,
              [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelAccessToken]: readyData.accessToken,
              ...(readyData.refreshToken
                ? { [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelRefreshToken]: readyData.refreshToken }
                : {}),
              [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelUserInfo]: JSON.stringify({
                id: accountIdentity,
                username: displayName,
                displayName,
                rawProfile: readyData.user,
              }),
            },
            { expected: expectedSession, assertCurrent: () => throwIfAborted(signal) },
          );
          if (!committed) throw new Error("OAuth session changed before login commit");
        }
      });
    } catch (error) {
      throw new ZCodeCliLoginError(
        "credential_write_failed",
        "Login succeeded but writing credentials failed.",
        { cause: error },
      );
    }
    throwIfAborted(signal);
    let configPatch: StandaloneCodingPlanPersistenceResult;
    try {
      configPatch = await credentialGuard.run(() =>
        persistStandaloneCodingPlanConnection({
          accountIdentity,
          authSource: "oauth",
          commitGuard: credentialGuard.commit,
          credentialStore,
          env,
          personalProviderConfigPath: options.personalProviderConfigPath,
          providerId,
        }),
      );
    } catch (error) {
      throw new ZCodeCliLoginError(
        "config_update_failed",
        "Login succeeded but updating ZCode config failed.",
        { cause: error },
      );
    }
    return {
      configPath: configPatch.path,
      credentialsPath: credentialStore.filePath,
      model: configPatch.mainModel,
      providerId,
      user: readyData.user,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Z.ai 与 BigModel 共用服务端轮询登录：init 拿授权地址，浏览器授权后轮询到 ready，
 * 再解析项目访问材料并写入凭据与默认模型。OAuth 登录不落盘派生 API Key，
 * 运行时按 `authSource: "oauth"` 用访问令牌换取请求凭据。
 */
export async function loginZCodeCli(
  options: LoginZCodeCliOptions = {},
): Promise<LoginZCodeCliResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadlineMs = now() + timeoutMs;
  const timeoutController = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const timeoutError = () =>
    new ZCodeCliLoginError("auth_timeout", "Authorization timed out. Please retry login.");
  let timer = setTimeout(() => timeoutController.abort(timeoutError()), timeoutMs);
  try {
    throwIfAborted(signal);
    const flow = await startCliOAuthLoginFlow({
      abortSignal: signal,
      baseUrl: options.baseUrl,
      credentialStore: options.credentialStore,
      env,
      httpClient: options.httpClient,
      pollToken: options.pollToken,
      providerId: options.providerId,
    });
    const remainingMs = Math.min(deadlineMs, flow.initData.expires_at * 1_000) - now();
    if (remainingMs <= 0) throw timeoutError();
    clearTimeout(timer);
    timer = setTimeout(() => timeoutController.abort(timeoutError()), remainingMs);
    await options.onAuthorizeUrl?.(flow.initData);
    throwIfAborted(signal);
    const browser = options.noBrowser
      ? undefined
      : await waitWithAbort(
          (options.openBrowser ?? openUrlInBrowser)(flow.initData.authorize_url),
          signal,
        );
    if (browser) await options.onBrowserOpen?.(browser);
    const result = await completeCliOAuthLoginFlow({
      abortSignal: signal,
      apiKeyResolver: options.apiKeyResolver,
      credentialStore: options.credentialStore,
      env,
      flow,
      httpClient: options.httpClient,
      now,
      onPollStatus: options.onPollStatus,
      personalProviderConfigPath: options.personalProviderConfigPath,
      sleep: options.sleep,
      timeoutMs: Math.max(0, deadlineMs - now()),
    });
    return { ...(browser ? { browser } : {}), ...result };
  } finally {
    clearTimeout(timer);
  }
}

export async function loginBigmodelCodingPlan(
  options: LoginBigmodelCodingPlanOptions = {},
): Promise<LoginBigmodelCodingPlanResult> {
  return {
    ...(await loginZCodeCli({ ...options, providerId: "bigmodel" })),
    providerId: "bigmodel",
  };
}

export async function configureCodingPlanApiKey(
  options: ConfigureCodingPlanApiKeyOptions,
): Promise<ConfigureCodingPlanApiKeyResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ZCodeCliLoginError("config_update_failed", "API key must not be empty.");
  }
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  // 手填 Key 也可能等待配置锁；必须沿用入口代次，避免恢复后仍提交旧默认模型。
  const credentialGuard = await credentialStore.captureRecoveryGuard();
  const configPatch = await credentialGuard.run(() =>
    persistStandaloneCodingPlanConnection({
      accountIdentity: createStandaloneAccountIdentityFromSecret(apiKey),
      apiKey,
      commitGuard: credentialGuard.commit,
      credentialStore,
      env: options.env ?? process.env,
      personalProviderConfigPath: options.personalProviderConfigPath,
      providerId: options.providerId,
    }),
  );
  return {
    configPath: configPatch.path,
    model: configPatch.mainModel,
    providerId: options.providerId,
  };
}

function resolveCliZCodeEndpointOrigin(env: EnvRecord): string {
  return resolveRuntimeZCodeEndpointOrigin(env);
}

function createDefaultHttpClient(env: EnvRecord) {
  const config = createConfig({ env });
  return createNodeHttpClientAdapter({
    env,
    proxyUrl: config.config.network.httpProxy,
    noProxy: config.config.network.noProxy,
    caCertFile: config.config.network.caCertFile,
    timeoutMs: config.config.network.timeout,
  });
}

async function resolveCodingPlanMaterial(input: {
  accessToken: string;
  env: EnvRecord;
  httpClient?: Parameters<typeof createCodingPlanApiKeyResolver>[0]["httpClient"];
  family: CodingPlanProviderId;
  signal?: AbortSignal;
  resolver?: ReturnType<typeof createCodingPlanApiKeyResolver>;
}) {
  const resolver =
    input.resolver ??
    createCodingPlanApiKeyResolver({
      httpClient: input.httpClient ?? createDefaultHttpClient(input.env),
    });
  return resolver.resolveMaterial(
    {
      accessToken: input.accessToken,
      family: input.family,
    },
    { signal: input.signal },
  );
}

interface StandaloneCodingPlanPersistenceResult {
  readonly mainModel: string;
  readonly path: string;
}

async function persistStandaloneCodingPlanConnection(input: {
  readonly accountIdentity: string;
  readonly apiKey?: string;
  readonly authSource?: "oauth";
  readonly credentialStore: SharedZCodeCredentialStore;
  readonly commitGuard?: (write: () => Promise<void>) => Promise<void>;
  readonly env: EnvRecord;
  readonly personalProviderConfigPath?: string;
  readonly providerId: CodingPlanProviderId;
}): Promise<StandaloneCodingPlanPersistenceResult> {
  const configuredProvider = await resolveStandaloneCodingPlanProvider(input.providerId, input.env);
  const providerId = configuredProvider.providerId;
  const modelId = configuredProvider.modelId;
  const credentialKey = standaloneAccountProviderCredentialKey({
    providerId,
    accountIdentity: input.accountIdentity,
  });
  await input.credentialStore.saveMany({
    [standaloneAccountIdentityCredentialKey(providerId)]: input.accountIdentity,
    [standaloneAccountAuthSourceCredentialKey(providerId)]: input.authSource ?? "manual",
    ...(input.apiKey ? { [credentialKey]: input.apiKey } : {}),
  });
  const path =
    input.personalProviderConfigPath ??
    input.env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim() ??
    join(dirname(input.credentialStore.filePath), PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  // 登录与运行时共享文件和事务；首次写入仍先保留旧用户 Provider，不能仅写默认值。
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath: path,
    commitGuard: input.commitGuard,
    importLegacy: () => readLegacyCliPersonalProviderConfig({}),
    pollingIntervalMs: false,
  });
  const repository = new NodeModelSelectionConfigRepository({
    personalRepository,
  });
  try {
    await repository.saveConfiguredDefault({ providerId, modelId });
  } finally {
    repository.dispose();
    personalRepository.dispose();
  }
  return {
    mainModel: `${providerId}/${modelId}`,
    path,
  };
}

export async function hasConfiguredStandaloneCodingPlan(
  options: {
    credentialStore?: SharedZCodeCredentialStore;
    env?: EnvRecord;
  } = {},
): Promise<boolean> {
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  return hasStandaloneCodingPlanAccess(credentialStore, options.env ?? process.env);
}

export async function logoutZCodeCli(
  options: LogoutZCodeCliOptions = {},
): Promise<LogoutZCodeCliResult> {
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  const providerIds = (await readStandaloneCodingPlanProviders(options.env ?? process.env)).map(
    ({ providerId }) => providerId,
  );
  const identityKeys = providerIds.map(standaloneAccountIdentityCredentialKey);
  const sourceKeys = providerIds.map(standaloneAccountAuthSourceCredentialKey);
  const identities = await credentialStore.loadMany([...identityKeys, ...sourceKeys]);
  const dynamicApiKeyKeys = providerIds.flatMap((providerId) => {
    // OAuth 退出不能解密旧派生 Key；坏密文不应阻止清理当前登录态。
    if (identities[standaloneAccountAuthSourceCredentialKey(providerId)] !== "manual") return [];
    const identity = identities[standaloneAccountIdentityCredentialKey(providerId)]?.trim();
    return identity
      ? [
          standaloneAccountProviderCredentialKey({
            providerId,
            accountIdentity: identity,
          }),
        ]
      : [];
  });
  const keys = [
    ...Object.values(SHARED_ZCODE_CREDENTIAL_KEYS),
    ...identityKeys,
    ...sourceKeys,
    ...dynamicApiKeyKeys,
  ];
  const current = await credentialStore.loadMany(keys);
  // 整组比较后整组删除；逐键比较会把新会话中内容相同的用户资料误删。
  const committed = await credentialStore.updateMany(
    Object.fromEntries(Object.keys(current).map((key) => [key, null])),
    { expected: current },
  );
  if (!committed) throw new Error("OAuth session changed during logout; retry logout");
  return {
    credentialsPath: credentialStore.filePath,
  };
}
