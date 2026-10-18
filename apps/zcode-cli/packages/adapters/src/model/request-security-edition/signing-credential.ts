/**
 * 把 Provider API Key 解释为签名凭据。
 *
 * 两种形态（与官方发行版一致）：
 * - Project Access Token（JWT，header `{alg:"HS256",typ:"JWT",sign_type:"SIGN"}`，
 *   payload `{token_use:"project_access", api_key}`）：apiKeyId 取 `api_key` claim，
 *   secret 是整段 JWT，握手字段为 `accessToken`。
 * - `id.secret`（恰好一个点）：左侧 apiKeyId，右侧 secret，握手字段为 `apiKey`。
 *
 * 解析失败返回 undefined，交给调用方决定报错或降级；不能在这里抛错，
 * 否则普通 API Key 的 Provider 会被签名能力误伤。
 */
export interface ClientSigningCredential {
  apiKeyId: string;
  secret: string;
  credential: string;
  handshakeField: "apiKey" | "accessToken";
}

const JWT_SEGMENT_COUNT = 3;
const JWT_HEADER_ALG = "HS256";
const JWT_HEADER_TYPE = "JWT";
const JWT_SIGN_TYPE = "SIGN";
const JWT_TOKEN_USE = "project_access";

function decodeBase64UrlJson(segment: string): unknown {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseProjectAccessToken(raw: string): ClientSigningCredential | undefined {
  const segments = raw.split(".");
  if (segments.length !== JWT_SEGMENT_COUNT) return undefined;
  const signature = segments[2];
  if (!signature) return undefined;
  const header = asRecord(decodeBase64UrlJson(segments[0] ?? ""));
  if (
    !header ||
    header.alg !== JWT_HEADER_ALG ||
    header.typ !== JWT_HEADER_TYPE ||
    header.sign_type !== JWT_SIGN_TYPE
  ) {
    return undefined;
  }
  const payload = asRecord(decodeBase64UrlJson(segments[1] ?? ""));
  if (!payload || payload.token_use !== JWT_TOKEN_USE) return undefined;
  const apiKeyId = typeof payload.api_key === "string" ? payload.api_key.trim() : "";
  if (!apiKeyId) return undefined;
  return { apiKeyId, secret: raw, credential: raw, handshakeField: "accessToken" };
}

export function parseClientSigningCredential(raw: string): ClientSigningCredential | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  try {
    const token = parseProjectAccessToken(value);
    if (token) return token;
  } catch {
    // JWT 解析失败不阻断 `id.secret` 形态：有的 API Key 恰好包含两个点。
  }
  const separator = value.indexOf(".");
  if (separator <= 0 || separator !== value.lastIndexOf(".")) return undefined;
  const apiKeyId = value.slice(0, separator).trim();
  const secret = value.slice(separator + 1).trim();
  if (!apiKeyId || !secret) return undefined;
  return { apiKeyId, secret, credential: value, handshakeField: "apiKey" };
}
