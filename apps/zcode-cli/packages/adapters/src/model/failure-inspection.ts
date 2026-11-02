import { APICallError, RetryError } from "ai";

export function unwrapRetryError(error: unknown): unknown {
  if (RetryError.isInstance(error)) {
    return error.lastError ?? error;
  }
  return error;
}

export function getStatusCode(error: unknown): number | undefined {
  return getStatusCodeFromError(error, new WeakSet<object>());
}

export function getHttpResponseStatus(error: unknown): number | undefined {
  return getHttpResponseStatusFromError(error, new WeakSet<object>());
}

function getHttpResponseStatusFromError(error: unknown, seen: WeakSet<object>): number | undefined {
  if (markSeen(error, seen)) {
    return undefined;
  }

  if (APICallError.isInstance(error) && error.statusCode !== undefined) {
    return error.statusCode;
  }

  const record = asRecord(error);
  const responseStatus = numberProperty(record, "responseStatus");
  if (responseStatus !== undefined) {
    return responseStatus;
  }

  const response = asRecord(record.response);
  const nestedResponseStatus =
    numberProperty(response, "status") ?? numberProperty(response, "statusCode");
  if (nestedResponseStatus !== undefined) {
    return nestedResponseStatus;
  }

  const cause = record.cause;
  return cause && cause !== error ? getHttpResponseStatusFromError(cause, seen) : undefined;
}

function getStatusCodeFromError(error: unknown, seen: WeakSet<object>): number | undefined {
  if (markSeen(error, seen)) {
    return undefined;
  }

  if (APICallError.isInstance(error)) {
    const statusCode = error.statusCode;
    if (statusCode !== undefined) {
      return statusCode;
    }
  }

  const record = asRecord(error);
  const statusCode = numberProperty(record, "statusCode") ?? numberProperty(record, "status");
  if (statusCode !== undefined) {
    return statusCode;
  }

  const response = asRecord(record.response);
  const responseStatus =
    numberProperty(response, "status") ?? numberProperty(response, "statusCode");
  if (responseStatus !== undefined) {
    return responseStatus;
  }

  const cause = record.cause;
  return cause && cause !== error ? getStatusCodeFromError(cause, seen) : undefined;
}

export function getApiCallResponseBody(error: unknown): unknown {
  if (!APICallError.isInstance(error)) {
    return undefined;
  }

  const { responseBody } = error;
  if (typeof responseBody === "string") {
    try {
      return JSON.parse(responseBody) as unknown;
    } catch {
      return undefined;
    }
  }

  return responseBody;
}

export function getApiCallErrorData(error: unknown): unknown {
  return APICallError.isInstance(error) ? error.data : undefined;
}

/**
 * 原始响应正文（未解析）：诊断日志需要保留 provider 自己的错误形状，而
 * `getApiCallResponseBody` 在 JSON 解析失败时直接返回 undefined。
 * 流终止包装器（如 TerminalStreamChunkError）只复制 cause，所以这里沿 cause 向下查找。
 */
export function getApiCallResponseBodyText(error: unknown): string | undefined {
  return getApiCallResponseBodyTextFromError(error, new WeakSet<object>());
}

function getApiCallResponseBodyTextFromError(
  error: unknown,
  seen: WeakSet<object>,
): string | undefined {
  if (markSeen(error, seen)) {
    return undefined;
  }

  if (APICallError.isInstance(error) && typeof error.responseBody === "string") {
    return error.responseBody.trim().length > 0 ? error.responseBody : undefined;
  }

  const record = asRecord(error);
  const body = record.responseBody;
  if (typeof body === "string" && body.trim().length > 0) {
    return body;
  }

  const cause = record.cause;
  return cause && cause !== error ? getApiCallResponseBodyTextFromError(cause, seen) : undefined;
}

const AUTH_FAILURE_STATUS_CODES: ReadonlySet<number> = new Set([401, 403]);
const MAX_PROVIDER_AUTH_BODY_CHARS = 1_500;

/**
 * 凭据形状兜底脱敏。provider 认证失败正文理论上只含它自己的错误描述，但一旦上游回显
 * 请求头或密钥片段，日志就会变成泄漏面；这里按形状擦除，不依赖具体 provider。
 */
const PROVIDER_AUTH_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/gu, "sk-[redacted]"],
  [
    /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization[_-]?token)"\s*:\s*")[^"]*(")/giu,
    "$1[redacted]$2",
  ],
];

export interface ProviderAuthFailureLogFields {
  providerErrorType?: string;
  providerErrorMessage?: string;
  providerErrorCode?: string;
  providerResponseBody?: string;
}

/**
 * 401/403 会被归一成 "Provider authentication failed."，provider 自己的 error.type/message
 * 和响应正文全部丢失，线上只能看到一个状态码（2026-11-02 z.ai SSE 中途 401 的排查现场）。
 * 这里在日志边界补回有界、脱敏的原始 payload；只进日志，不进 status event / session 事件。
 */
export function providerAuthFailureLogFields(error: unknown): ProviderAuthFailureLogFields {
  if (error === undefined || error === null) return {};

  const unwrapped = unwrapRetryError(error);
  const statusCode = getStatusCode(unwrapped);
  if (statusCode === undefined || !AUTH_FAILURE_STATUS_CODES.has(statusCode)) return {};

  const bodyText = getApiCallResponseBodyText(unwrapped);
  const parsedBody = firstNonEmptyRecord(
    parseJsonRecord(bodyText),
    getApiCallResponseBody(unwrapped),
    getApiCallErrorData(unwrapped),
  );
  const providerError = firstNonEmptyRecord(parsedBody?.error) ?? parsedBody;

  const providerErrorType = scalarText(providerError?.type);
  const providerErrorMessage = scalarText(providerError?.message);
  const providerErrorCode = scalarText(providerError?.code);
  const bodyPayload = bodyText ?? safeJson(parsedBody);
  const providerResponseBody = bodyPayload ? boundProviderAuthBody(bodyPayload) : undefined;

  return {
    ...(providerErrorType === undefined ? {} : { providerErrorType }),
    ...(providerErrorMessage === undefined ? {} : { providerErrorMessage }),
    ...(providerErrorCode === undefined ? {} : { providerErrorCode }),
    ...(providerResponseBody === undefined ? {} : { providerResponseBody }),
  };
}

function boundProviderAuthBody(body: string): string {
  const redacted = PROVIDER_AUTH_REDACTIONS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    body,
  );
  return redacted.length > MAX_PROVIDER_AUTH_BODY_CHARS
    ? `${redacted.slice(0, MAX_PROVIDER_AUTH_BODY_CHARS)}…[truncated ${
        redacted.length - MAX_PROVIDER_AUTH_BODY_CHARS
      } chars]`
    : redacted;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim().slice(0, 256);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseJsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    return optionalRecord(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstNonEmptyRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    const record = optionalRecord(value);
    if (record && Object.keys(record).length > 0) return record;
  }
  return undefined;
}

export function getResponseHeaders(error: unknown): Record<string, string> | undefined {
  return getResponseHeadersFromError(error, new WeakSet<object>());
}

function getResponseHeadersFromError(
  error: unknown,
  seen: WeakSet<object>,
): Record<string, string> | undefined {
  if (markSeen(error, seen)) {
    return undefined;
  }

  if (APICallError.isInstance(error)) {
    const headers = asStringRecord(error.responseHeaders);
    if (headers) {
      return headers;
    }
  }

  const record = asRecord(error);
  const headers = asStringRecord(record.responseHeaders) ?? asStringRecord(record.headers);
  if (headers) {
    return headers;
  }

  const response = asRecord(record.response);
  const responseHeaders = asStringRecord(response.headers);
  if (responseHeaders) {
    return responseHeaders;
  }

  // AI SDK/stream chunk 可能把 ProviderBusinessError 包在 cause 里；
  // 外层 APICallError 没有 responseHeaders 时，必须继续读取内层错误。
  const cause = record.cause;
  return cause && cause !== error ? getResponseHeadersFromError(cause, seen) : undefined;
}

export function getErrorCode(error: unknown): string | undefined {
  return getErrorCodeFromError(error, new WeakSet<object>());
}

function getErrorCodeFromError(error: unknown, seen: WeakSet<object>): string | undefined {
  if (markSeen(error, seen)) {
    return undefined;
  }

  const record = asRecord(error);
  const code = stringProperty(record, "code");
  if (code) {
    return code;
  }

  const cause = record.cause;
  if (cause && cause !== error) {
    return getErrorCodeFromError(cause, seen);
  }

  return undefined;
}

export function isAbortFailure(error: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) {
    return true;
  }
  const record = asRecord(error);
  return (
    stringProperty(record, "name") === "AbortError" ||
    stringProperty(record, "code") === "ABORT_ERR"
  );
}

export function isTimeoutFailure(error: unknown, code?: string, statusCode?: number): boolean {
  if (statusCode === 408) {
    return true;
  }

  const normalizedCode = code?.toUpperCase();
  if (
    normalizedCode === "ETIMEDOUT" ||
    normalizedCode === "ETIMEOUT" ||
    normalizedCode === "UND_ERR_CONNECT_TIMEOUT" ||
    normalizedCode === "UND_ERR_HEADERS_TIMEOUT" ||
    normalizedCode === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true;
  }

  const name = stringProperty(asRecord(error), "name")?.toLowerCase();
  return name === "timeouterror" || name === "timeout_error";
}

export function isContextExceededFailure(error: unknown): boolean {
  return hasContextExceededSignal(error, new WeakSet<object>());
}

function hasContextExceededSignal(error: unknown, seen: WeakSet<object>): boolean {
  if (markSeen(error, seen)) {
    return false;
  }

  const record = asRecord(error);
  const responseBody = getApiCallResponseBody(error);
  if (
    isContextExceededCode(stringProperty(record, "code")) ||
    // 标准 response body 会先被归一为 ProviderBusinessError，
    // 此时真实 provider code 位于 providerCode，外层 code 只是包装码。
    isContextExceededCode(stringProperty(record, "providerCode")) ||
    isContextExceededCode(standardResponseBodyCode(responseBody)) ||
    isContextExceededMessage(stringProperty(record, "message")) ||
    isContextExceededMessage(standardResponseBodyMessage(responseBody))
  ) {
    return true;
  }

  const cause = record.cause;
  return cause && cause !== error ? hasContextExceededSignal(cause, seen) : false;
}

function isContextExceededCode(value: string | undefined): boolean {
  const code = value?.toLowerCase();
  return (
    code === "context_length_exceeded" ||
    code === "context_window_exceeded" ||
    code === "model_context_exceeded" ||
    code === "model_context_window_exceeded"
  );
}

function isContextExceededMessage(value: string | undefined): boolean {
  const message = value?.toLowerCase();
  if (!message) return false;

  return (
    message === "model_context_window_exceeded" ||
    (message.includes("context") && message.includes("exceed")) ||
    // 部分 OpenAI-compatible provider 只在 invalid_request 文本中报告
    // maximum context length 和 token 统计，不会在文案中包含 exceeded。
    (message.includes("maximum context length") &&
      message.includes("tokens") &&
      (message.includes("requested") || message.includes("resulted"))) ||
    // 官方 provider 的这些文案都明确指向输入超过上下文窗口；
    // 保持短语级匹配，避免把通用 400/422 或 max_tokens 参数错误归为超窗。
    message.includes("prompt is too long") ||
    (message.includes("input token count") &&
      message.includes("exceed") &&
      message.includes("maximum number of tokens allowed")) ||
    message.includes("range of input length should be") ||
    (message.includes("total message token length") &&
      message.includes("exceed") &&
      message.includes("model limit"))
  );
}

function standardResponseBodyCode(body: unknown): string | undefined {
  const record = asRecord(body);
  const nestedError = asRecord(record.error);
  return stringProperty(nestedError, "code") ?? stringProperty(record, "code");
}

function standardResponseBodyMessage(body: unknown): string | undefined {
  const record = asRecord(body);
  const nestedError = asRecord(record.error);
  return stringProperty(nestedError, "message") ?? stringProperty(record, "message");
}

export function isProxyFailure(code?: string): boolean {
  return code?.toUpperCase().includes("PROXY") ?? false;
}

export function isNetworkFailure(code?: string): boolean {
  const normalized = code?.toUpperCase();
  return (
    normalized === "ECONNRESET" ||
    normalized === "ECONNREFUSED" ||
    normalized === "EAI_AGAIN" ||
    normalized === "ENOTFOUND" ||
    normalized === "ENETUNREACH" ||
    normalized === "EHOSTUNREACH" ||
    normalized === "UND_ERR_SOCKET" ||
    normalized === "UND_ERR_CONNECT_TIMEOUT"
  );
}

export function isProviderMarkedRetryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    return error.isRetryable;
  }

  const retryable = asRecord(error).isRetryable;
  return typeof retryable === "boolean" ? retryable : false;
}

export function parseRetryAfterMs(headers?: Record<string, string>): number | undefined {
  if (!headers) {
    return undefined;
  }
  // 部分 provider 会同时返回 retry-after 和 x-should-retry=false；
  // 此时 retry-after 只能作为诊断信息，不能驱动 adapter 等待。
  if (isShouldRetryHeaderFalse(headers)) {
    return undefined;
  }

  const retryAfterMs = parseNumericHeaderMs(findHeaderValue(headers, "retry-after-ms"));
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }

  const value = findHeaderValue(headers, "retry-after")?.trim();
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return undefined;
}

function findHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function isShouldRetryHeaderFalse(headers: Record<string, string>): boolean {
  const value = findHeaderValue(headers, "x-should-retry")?.trim().toLowerCase();
  return value === "false" || value === "0";
}

function parseNumericHeaderMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const milliseconds = Number(value.trim());
  return Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds)) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const headersLike = headersLikeToRecord(value);
  if (headersLike) {
    return headersLike;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function headersLikeToRecord(value: object): Record<string, string> | undefined {
  const forEach = (value as { forEach?: unknown }).forEach;
  if (typeof forEach !== "function") {
    return undefined;
  }

  const entries: Array<[string, string]> = [];
  try {
    forEach.call(value, (headerValue: unknown, headerName: unknown) => {
      if (typeof headerName === "string" && typeof headerValue === "string") {
        entries.push([headerName, headerValue]);
      }
    });
  } catch {
    return undefined;
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function markSeen(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return true;
  }
  seen.add(value);
  return false;
}

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
