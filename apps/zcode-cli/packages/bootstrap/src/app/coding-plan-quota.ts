// Coding Plan 额度拉取：Registry 里的 zai/bigmodel 族 provider 凭据 →
// 监控端点快照（UsageQuotaSnapshot 同构）。provider-balance 的 zai 适配器
// 同 wire 格式（Bearer apiKey + Accept json；envelope success/code 200 门）。
// 校验分两层：外部 wire 在这里容错验型规整（第三方 payload，desktop mapper
// 同语义），协议面（usage/codingPlanQuota 响应）由客户端用共享 zod schema
// 严格收。端点按 family 分流（zai-family → api.z.ai，bigmodel-family →
// open.bigmodel.cn），路径与 desktop services bigmodelUsageQuotaProvider
// 的 BIGMODEL_QUOTA_PATH 一致。凭据只进 Authorization 头，不进日志。

import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import type {
  UsageQuotaLimit,
  UsageQuotaSnapshot,
  UsageQuotaUsageDetail,
} from "@zcode/shared";

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

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * 外部监控端点 wire 的容错规整（desktop bigmodelUsageQuotaMapper 的
 * normalizeLimits/normalizeUsageDetails 同语义）：第三方 payload 不按协议
 * schema 严格收——未知字段直接缺席、不合型字段丢弃、凑不齐的 entry 整条
 * 丢弃，展示/协议面消费的字段逐一验型后才产出 UsageQuotaLimit。
 * usageDetails 线上可缺席，规整为 []（协议 schema 的必填由这里兜底）。
 */
function normalizeQuotaUsageDetail(value: unknown): UsageQuotaUsageDetail | null {
  if (!isRecord(value) || typeof value.modelCode !== "string") return null;
  const displayName = readString(value.displayName);
  return {
    modelCode: value.modelCode,
    ...(displayName !== undefined && displayName.trim().length > 0
      ? { displayName: displayName.trim() }
      : {}),
    usage: readNumber(value.usage) ?? 0,
  };
}

function normalizeQuotaUsageDetails(value: unknown): UsageQuotaUsageDetail[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeQuotaUsageDetail)
    .filter((detail): detail is UsageQuotaUsageDetail => detail !== null);
}

const QUOTA_LIMIT_STRING_FIELDS = [
  "bucketId",
  "userPlanId",
  "period",
  "meter",
  "unitType",
  "planId",
] as const;
const QUOTA_LIMIT_NUMBER_FIELDS = [
  "periodStart",
  "periodEnd",
  "unit",
  "number",
  "usage",
  "currentValue",
  "remaining",
  "percentage",
  "nextResetTime",
] as const;

function normalizeQuotaLimit(value: unknown): UsageQuotaLimit | null {
  if (!isRecord(value)) return null;
  // type 是展示侧过滤与标签的主键（desktop normalizeLimits 同门）：非空字符串
  // 才收，凑不齐的 entry 丢弃。
  if (typeof value.type !== "string" || value.type.length === 0) return null;
  const limit: UsageQuotaLimit = {
    type: value.type,
    usageDetails: normalizeQuotaUsageDetails(value.usageDetails),
  };
  for (const field of QUOTA_LIMIT_STRING_FIELDS) {
    const read = readString(value[field]);
    if (read !== undefined) limit[field] = read;
  }
  for (const field of QUOTA_LIMIT_NUMBER_FIELDS) {
    const read = readNumber(value[field]);
    if (read !== undefined) limit[field] = read;
  }
  return limit;
}

/**
 * envelope 校验：`success === true && code === 200`（parseZaiQuota 同门），
 * limits 逐条容错验型规整为共享快照（normalizeQuotaLimit），level 缺省 null。
 * 结构失败返回 null，由 fetchCodingPlanQuota 翻成
 * CodingPlanQuotaUnavailableError。不在这里做 token 窗口过滤——展示侧按
 * type（TOKENS_LIMIT/CREDIT_LIMIT）自行取舍。
 */
export function parseCodingPlanQuotaEnvelope(payload: unknown): UsageQuotaSnapshot | null {
  if (!isRecord(payload) || payload.success !== true || payload.code !== 200) return null;
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.limits)) return null;
  const level = typeof data.level === "string" ? data.level : null;
  const limits = data.limits
    .map(normalizeQuotaLimit)
    .filter((limit): limit is UsageQuotaLimit => limit !== null);
  return { level, limits };
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
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    // 200 但 body 非 JSON（代理错误页/空 body）：同一显式出口，不外泄 SyntaxError。
    throw new CodingPlanQuotaUnavailableError(
      `coding-plan quota response was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const snapshot = parseCodingPlanQuotaEnvelope(payload);
  if (snapshot === null) {
    throw new CodingPlanQuotaUnavailableError("coding-plan quota response was invalid");
  }
  return snapshot;
}
