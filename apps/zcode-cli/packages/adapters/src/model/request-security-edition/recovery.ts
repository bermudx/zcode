import type { RequestVerificationReason } from "@zcode/shared";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "../runner-runtime.js";
import { ProviderBusinessError } from "../model-execution.js";
import type { AiSdkProviderKind } from "../model-execution.js";
import { inspectProviderFailure } from "../failure-classifier.js";

/**
 * Coding Plan 安全验证（captcha）恢复路径。
 *
 * 端口自官方发行版：业务码 3007 表示验证票据缺失/失效，start-plan 账号在
 * 刷新一次鉴权材料（Host 会补充 captcha header）后重试一次；仍失败则按普通
 * 业务错误终止，不再消耗通用 retry budget。
 */
const CAPTCHA_REJECTION_CODE = "3007";
const CAPTCHA_VERIFY_PARAM_HEADER = "x-aliyun-captcha-verify-param";
const CAPTCHA_VERIFY_FAILED_MESSAGE =
  "Captcha verification failed or the verify token was rejected.";
const CAPTCHA_EMPTY_STREAM_RESPONSE_STATUS = 200;
const CAPTCHA_EMPTY_STREAM_STATUS_CODE = 403;
const START_PLAN_ACCOUNT_MODE = "start-plan";
const ALIYUN_CAPTCHA_PROVIDER_KIND: AiSdkProviderKind = "openai-compatible";

export function isCaptchaRejection(error: unknown): boolean {
  return inspectProviderFailure(error).providerErrorCode === CAPTCHA_REJECTION_CODE;
}

export class RequestVerificationRetry {
  readonly #request: AiSdkModelTextRequest;
  readonly #model: ResolvedAiSdkModel;
  #used = false;
  #pending = false;

  constructor(request: AiSdkModelTextRequest, model: ResolvedAiSdkModel) {
    this.#request = request;
    this.#model = model;
  }

  get extraAttempts(): number {
    return Number(this.#used);
  }

  takeReason(): RequestVerificationReason {
    const reason: RequestVerificationReason = this.#pending ? "captcha-retry" : "model-request";
    this.#pending = false;
    return reason;
  }

  claim(error: unknown, blocked = false): boolean {
    if (
      blocked ||
      this.#used ||
      this.#request.abortSignal?.aborted ||
      !this.#request.refreshRuntimeHeadersBeforeAttempt ||
      this.#model.accountAccess?.mode !== START_PLAN_ACCOUNT_MODE ||
      !isCaptchaRejection(error)
    ) {
      return false;
    }
    this.#used = true;
    this.#pending = true;
    return true;
  }
}

/**
 * 验证拒绝必须直接上抛：它既不是可重试的传输错误，也不允许被
 * “空响应修复”或项目 Token 刷新逻辑吞掉。
 */
export function isRequestVerificationRejection(error: unknown): boolean {
  return isCaptchaRejection(error);
}

function readCaptchaVerifyParam(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === CAPTCHA_VERIFY_PARAM_HEADER,
  );
  const value = entry?.[1]?.trim();
  return value ? value : undefined;
}

/**
 * HTTP 200 但空流的验证失败识别。
 *
 * 只有 start-plan + openai-compatible + 本次请求确实带了验证票据时才成立：
 * 说明票据已被服务端拒绝，而不是普通的容量不足或空响应。
 */
export function createRequestVerificationEmptyStreamError(input: {
  accountMode?: string;
  headers: Record<string, string> | undefined;
  providerId: string;
  providerKind: AiSdkProviderKind;
}): ProviderBusinessError | undefined {
  if (
    input.providerKind !== ALIYUN_CAPTCHA_PROVIDER_KIND ||
    input.accountMode !== START_PLAN_ACCOUNT_MODE ||
    !readCaptchaVerifyParam(input.headers)
  ) {
    return undefined;
  }
  return new ProviderBusinessError({
    providerCode: CAPTCHA_REJECTION_CODE,
    providerId: input.providerId,
    providerKind: input.providerKind,
    providerMessage: CAPTCHA_VERIFY_FAILED_MESSAGE,
    responseStatus: CAPTCHA_EMPTY_STREAM_RESPONSE_STATUS,
    statusCode: CAPTCHA_EMPTY_STREAM_STATUS_CODE,
  });
}
