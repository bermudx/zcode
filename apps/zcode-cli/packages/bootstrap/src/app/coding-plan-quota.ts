// Coding Plan 额度拉取：Registry 里的 zai/bigmodel 族 provider 凭据 →
// 监控端点快照（UsageQuotaSnapshot 同构）。provider-balance 的 zai 适配器
// 同 wire 格式（Bearer apiKey + Accept json；envelope success/code 200 门）。
// 端点按 family 分流（zai-family → api.z.ai，bigmodel-family →
// open.bigmodel.cn），路径与 desktop services bigmodelUsageQuotaProvider
// 的 BIGMODEL_QUOTA_PATH 一致。凭据只进 Authorization 头，不进日志。

import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import type { UsageQuotaLimit, UsageQuotaSnapshot } from "@zcode/shared";

const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const BIGMODEL_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const QUOTA_FETCH_TIMEOUT_MS = 10_000;

const CODING_PLAN_FAMILY_HOSTS: Record<string, string> = {
  "zai-family": ZAI_QUOTA_URL,
  "bigmodel-family": BIGMODEL_QUOTA_URL,
};

export interface ResolvedCodingPlanQuotaProvider {
  readonly providerId: string;
  readonly url: string;
  readonly apiKey: string;
}

/**
 * 第一个「coding plan 族 + API key 访问」的 provider（Registry 视图序，
 * 确定性）。zhipu-account 访问态的凭据不经 provider config 持有，此处
 * 不覆盖——它的额度面走账号通道，另行接入。
 */
export function resolveCodingPlanQuotaProvider(
  registry: ProviderRegistryModelSource,
): ResolvedCodingPlanQuotaProvider | null {
  for (const provider of registry.getView().providers) {
    const host = CODING_PLAN_FAMILY_HOSTS[provider.config.group ?? ""];
    if (!host) continue;
    const access = provider.config.access;
    if (access.type === "zhipu-account") continue;
    const apiKey = access.apiKey;
    if (typeof apiKey !== "string" || apiKey.length === 0) continue;
    return { apiKey, providerId: provider.providerId, url: host };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * envelope 校验：`success === true && code === 200`（parseZaiQuota 同门），
 * data.limits 数组透传为共享快照；level 缺省 null。不在这里做 token 窗口
 * 过滤——展示侧按 type（TOKENS_LIMIT/CREDIT_LIMIT）自行取舍。
 */
export function parseCodingPlanQuotaEnvelope(payload: unknown): UsageQuotaSnapshot | null {
  if (!isRecord(payload) || payload.success !== true || payload.code !== 200) return null;
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.limits)) return null;
  const level = typeof data.level === "string" ? data.level : null;
  return { level, limits: data.limits as UsageQuotaLimit[] };
}

export class CodingPlanQuotaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodingPlanQuotaUnavailableError";
  }
}

export interface CodingPlanQuotaFetchOptions {
  registry: ProviderRegistryModelSource;
  fetchImpl?: typeof fetch;
}

/** 拉取 Coding Plan 额度快照；无可用 provider / 端点失败都抛显式错误。 */
export async function fetchCodingPlanQuota(options: CodingPlanQuotaFetchOptions): Promise<UsageQuotaSnapshot> {
  const resolved = resolveCodingPlanQuotaProvider(options.registry);
  if (!resolved) {
    throw new CodingPlanQuotaUnavailableError("no coding-plan provider with an API key in the registry");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(resolved.url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new CodingPlanQuotaUnavailableError(
      `coding-plan quota request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!response.ok) {
    throw new CodingPlanQuotaUnavailableError(`coding-plan quota request failed: ${response.status}`);
  }
  const snapshot = parseCodingPlanQuotaEnvelope(await response.json());
  if (snapshot === null) {
    throw new CodingPlanQuotaUnavailableError("coding-plan quota response was invalid");
  }
  return snapshot;
}
