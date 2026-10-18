import { resolveModelProviderFamilyIdByBaseURL } from "@zcode/shared";

/**
 * 哪些 Provider 需要客户端签名（官方 `OfficialRequestSecurity.protectTransport` 策略）：
 *
 * 签名：`zhipu-coding-plan-api-key`；`zhipu-account` 的 individual/team coding plan；
 * 任意 family 域名（`*.z.ai` / `*.bigmodel.cn`）或 chatglm 站点。
 * 不签名：`zhipu-account` 的 start-plan / off-peak / highspeed —— 空闲队列与加速卡
 * 按设计走免签通道，不能因为域名命中就补签名。
 */
const UNSIGNED_ACCOUNT_MODES = new Set(["start-plan", "off-peak", "highspeed"]);
const SIGNED_ACCOUNT_MODES = new Set(["individual-coding-plan", "team-coding-plan"]);
const CLIENT_SIGNING_HOSTS = new Set(["api.chatglm.site", "zcode.chatglm.site"]);

export interface ClientSigningProviderAccess {
  type: string;
  mode?: string;
}

export interface ClientSigningProviderInput {
  access: ClientSigningProviderAccess;
  baseURL: string;
  headers?: Record<string, string>;
}

export function requiresClientRequestSigning(provider: ClientSigningProviderInput): boolean {
  const { access, baseURL } = provider;
  if (access.type === "zhipu-account" && UNSIGNED_ACCOUNT_MODES.has(access.mode ?? "")) {
    return false;
  }
  if (
    access.type === "zhipu-coding-plan-api-key" ||
    (access.type === "zhipu-account" && SIGNED_ACCOUNT_MODES.has(access.mode ?? "")) ||
    resolveModelProviderFamilyIdByBaseURL(baseURL) !== null
  ) {
    return true;
  }
  try {
    return CLIENT_SIGNING_HOSTS.has(new URL(baseURL).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 是否属于 family 域名但访问模式免签：此时仍要记录 `unsigned_sent(access_mode)`。 */
export function isAccessModeUnsignedBaseURL(baseURL: string): boolean {
  return resolveModelProviderFamilyIdByBaseURL(baseURL) !== null;
}

/** 大小写不敏感地读取 provider header；值 trim 后为空视为未设置。 */
export function readProviderHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  return (
    Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1]?.trim() || undefined
  );
}
