import { readClientSignatureFailureReason } from "@zcode/shared";
import { CLIENT_SIGNING_HANDSHAKE_PATH, signingError } from "./signing-protocol.js";

/**
 * 签名请求的缓冲与重建。
 *
 * 签名与重试必须能原样重放请求体，因此先把 Request 归一成字节；重建时保留
 * cache / credentials / redirect / referrerPolicy 等 fetch 语义，避免因为签名
 * 改变 Provider 请求行为。
 */

/** 必须从下游请求中剥离的签名/验证头；重建 Headers 时统一按名字删除，避免大小写残留。 */
export const CLIENT_SIGNING_MANAGED_HEADERS = [
  "X-Client-Ts",
  "X-Client-Version",
  "X-Client-Sig",
  "X-Client-Nonce",
  "X-Client-Pow",
  "X-App-Id",
  "X-Client-Sign-Verified",
];

export const SESSION_HEADER = "X-Session-Id";
export const REQUEST_ID_HEADER = "x-request-id";

const UNAUTHORIZED_STATUS = 401;
const ABORT_MESSAGE = "The operation was aborted.";

export interface BufferedSigningRequest {
  url: string;
  method: string;
  headers: Headers;
  signal: AbortSignal | null;
  body?: Uint8Array<ArrayBuffer>;
  init: Omit<RequestInit, "body" | "headers" | "method" | "signal">;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function resolveHandshakeUrl(baseURL: string, allowInsecureHttp: boolean): string {
  let target: URL;
  try {
    target = new URL(baseURL);
  } catch (error) {
    throw signingError("invalid-config", "Client signing requires a valid baseURL.", {
      cause: error,
    });
  }
  if (target.protocol !== "https:" && !(allowInsecureHttp && target.protocol === "http:")) {
    throw signingError("invalid-config", "Client signing handshake requires HTTPS.");
  }
  return new URL(CLIENT_SIGNING_HANDSHAKE_PATH, target.origin).toString();
}

export function waitForPromiseOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | null,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException(ABORT_MESSAGE, "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException(ABORT_MESSAGE, "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** 把请求体读成字节，后续签名重试可以原样重放。 */
export async function bufferSigningRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<BufferedSigningRequest> {
  const request = new Request(input, init);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : new Uint8Array(await request.arrayBuffer());
  return {
    body,
    headers: request.headers,
    init: {
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    },
    method: request.method,
    signal: request.signal,
    url: request.url,
  };
}

export function sanitizeClientSigningHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  for (const name of CLIENT_SIGNING_MANAGED_HEADERS) sanitized.delete(name);
  return sanitized;
}

export function buildSigningInit(request: BufferedSigningRequest, headers: Headers): RequestInit {
  return {
    ...request.init,
    ...(request.body ? { body: request.body } : {}),
    headers,
    method: request.method,
    signal: request.signal,
  };
}

/** 401 响应里是否表明“私钥需要重新握手”；其它状态码一律按普通失败处理。 */
export async function readRefreshableClientSignatureReason(
  response: Response,
): Promise<string | undefined> {
  if (response.status !== UNAUTHORIZED_STATUS) return undefined;
  try {
    return readClientSignatureFailureReason(await response.clone().json());
  } catch {
    return undefined;
  }
}
