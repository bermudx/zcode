/**
 * 客户端请求签名的共享策略。
 *
 * 与官方发行版保持一致（见 docs/coding-plan/client-request-signing-and-usage-allowance.md §3.4）：
 * - `x-client-sig` / `x-client-pow` 是请求签名与工作量证明，属于凭据级敏感头，
 *   必须进入所有 header 脱敏清单，不能落盘或进入日志。
 * - `x-aliyun-captcha-verify-param` 是安全验证票据，同样按凭据处理。
 */
export const requestSecuritySensitiveHeaders: readonly string[] = [
  "x-client-sig",
  "x-client-pow",
  "x-aliyun-captcha-verify-param",
];

/** 服务端拒绝签名的稳定原因；与 `isRequestSecurityFailure` 共用同一份枚举。 */
const CLIENT_SIGNATURE_REJECTION_REASONS = [
  "VERIFY_SIGNATURE_INVALID",
  "VERIFY_APIKEY_EXPIRED",
] as const;

/**
 * 业务码 3007 表示安全验证（captcha）未通过，与签名失败同属“鉴权材料不可用”，
 * 因此项目 Token 刷新必须让位给验证重试，不能把它当作可刷新的 401。
 */
const REQUEST_SECURITY_FAILURE_CODES = [...CLIENT_SIGNATURE_REJECTION_REASONS, "3007"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 从错误响应 envelope 中读取服务端拒绝签名的原因。
 *
 * 网关把原因放在顶层 `msg` / `reason`，也可能放在 `data.reason` 或 `error.reason`
 * /`error.message`；这里按官方顺序查找，只返回两个稳定原因之一。
 */
export function readClientSignatureFailureReason(body: unknown): string | undefined {
  const root = asRecord(body);
  if (!root) return undefined;
  const data = asRecord(root.data);
  const error = asRecord(root.error);
  const candidates = [root.msg, root.reason, data?.reason, error?.reason, error?.message];
  return candidates.find(
    (candidate): candidate is string =>
      candidate === CLIENT_SIGNATURE_REJECTION_REASONS[0] ||
      candidate === CLIENT_SIGNATURE_REJECTION_REASONS[1],
  );
}

export function isRequestSecurityFailure(
  body: unknown,
  codes: readonly (string | undefined)[],
): boolean {
  return (
    readClientSignatureFailureReason(body) !== undefined ||
    codes.some((code) => code !== undefined && REQUEST_SECURITY_FAILURE_CODES.includes(code))
  );
}
