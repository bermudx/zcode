/**
 * Coding Plan 安全验证（阿里云 captcha）请求策略。
 *
 * 端口自官方发行版 3.14.5 的 request-verification 策略层，行为与
 * docs/coding-plan/client-request-signing-and-usage-allowance.md §3.5 描述一致：
 * 只有 start-plan 账号模式需要验证票据；票据通过专用 header 携带，并且必须
 * 从普通请求 header 中剥离，避免被当成静态配置或落盘。
 *
 * 与官方的差异：`requestVerificationInteractionAvailable` 保持 false —— 开源版
 * 没有 captcha 交互 UI，不能假装具备交互能力；`REQUEST_VERIFICATION_REQUIRED`
 * 与超时提示文案沿用开源版既有值，避免改变已发布给客户端的错误语义。
 */
export type RequestVerificationConfig = Readonly<Record<string, unknown>>;

/** 验证票据：由验证交互产出，随请求一次性提交。 */
export interface RequestVerificationProof {
  captchaVerifyParam?: string;
  captchaRegion?: string;
}

export type RequestVerificationClientConfig = Readonly<Record<string, unknown>>;

export const requestVerificationReasons = ["model-request", "captcha-retry"] as const;
export type RequestVerificationReason = (typeof requestVerificationReasons)[number];
export const requestVerificationTimeoutMessage =
  "Provider runtime headers request timed out. Please send your message again.";
export const REQUEST_VERIFICATION_REQUIRED = "request_verification_unavailable";

const CAPTCHA_VERIFY_PARAM_HEADER = "X-Aliyun-Captcha-Verify-Param";
const CAPTCHA_VERIFY_REGION_HEADER = "X-Aliyun-Captcha-Verify-Region";
const CAPTCHA_HEADER_NAMES = [CAPTCHA_VERIFY_PARAM_HEADER, CAPTCHA_VERIFY_REGION_HEADER];
const START_PLAN_ACCESS_MODE = "start-plan";
const CHINESE_VERIFICATION_MESSAGE = "请完成安全验证";
const ENGLISH_VERIFICATION_MESSAGE_PATTERN = /security verification/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCaptchaHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return CAPTCHA_HEADER_NAMES.some((candidate) => candidate.toLowerCase() === normalized);
}

export function readRequestVerificationConfig(
  configs: RequestVerificationClientConfig | null | undefined,
): RequestVerificationConfig | null {
  const captcha = asRecord(configs?.captcha);
  if (!captcha) return null;
  const { skip_model_request: skipModelRequest, ...rest } = captcha;
  return {
    ...rest,
    ...(typeof skipModelRequest === "boolean" ? { skipModelRequest } : {}),
  };
}

export function requestVerificationClaimHeaders(
  proof: RequestVerificationProof,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const verifyParam = proof.captchaVerifyParam?.trim();
  if (verifyParam) headers[CAPTCHA_VERIFY_PARAM_HEADER] = verifyParam;
  const region = proof.captchaRegion?.trim();
  if (region) headers[CAPTCHA_VERIFY_REGION_HEADER] = region;
  return headers;
}

export function withoutRequestVerificationHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => !isCaptchaHeaderName(name)),
  );
}

export function allowRequestVerificationHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const canonical = CAPTCHA_HEADER_NAMES.find(
      (candidate) => candidate.toLowerCase() === name.trim().toLowerCase(),
    );
    const trimmed = value.trim();
    if (canonical && trimmed) allowed[canonical] = trimmed;
  }
  return allowed;
}

export function requiresRequestVerification(access: { mode: string } | undefined): boolean {
  return access?.mode === START_PLAN_ACCESS_MODE;
}

export function isRequestVerificationMessage(message: string): boolean {
  return (
    message.includes(CHINESE_VERIFICATION_MESSAGE) ||
    ENGLISH_VERIFICATION_MESSAGE_PATTERN.test(message)
  );
}

export function summarizeRequestVerificationHeaders(
  headers: Record<string, string>,
): Record<string, unknown> {
  const verifyParamName = Object.keys(headers).find(
    (name) => name.toLowerCase() === CAPTCHA_VERIFY_PARAM_HEADER.toLowerCase(),
  );
  const verifyParam = verifyParamName ? (headers[verifyParamName]?.trim() ?? "") : "";
  return { hasCaptchaVerifyParam: verifyParam.length > 0, captchaParamLength: verifyParam.length };
}

export function requestVerificationDiagnostics(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    hasCaptchaVerifyParam: input.hasCaptchaVerifyParam === true,
    captchaParamLength: typeof input.captchaParamLength === "number" ? input.captchaParamLength : 0,
  };
}

export const requestVerificationInteractionAvailable = false;
