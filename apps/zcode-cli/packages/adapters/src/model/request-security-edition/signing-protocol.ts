/**
 * 客户端请求签名的协议常量、观测类型与可判定错误。
 *
 * 观测类型必须满足 contracts 的 `ModelRequestObservation` 约束（`kind` + 原始标量字段），
 * 因为它会经 Telemetry Sink 进入 span，不允许携带请求内容或凭据。
 */
export const CLIENT_SIGNING_APP_ID = "zcode";
export const CLIENT_SIGNING_HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
export const CLIENT_SIGNING_POW_BITS = 8;
export const CLIENT_SIGNING_NONCE_BYTES = 16;
export const CLIENT_SIGNING_HANDSHAKE_TIMEOUT_MS = 10_000;

/** 未签名发送的稳定原因；`missing_session` 是开源版对无 session 请求的降级路径。 */
export type ClientSigningUnsignedReason =
  | "origin_mismatch"
  | "bypass"
  | "handshake_failed"
  | "access_mode"
  | "verify_refresh_exhausted"
  | "missing_session"
  | "invalid_credential";

export type ClientSigningObservation =
  | { kind: "signed_sent"; signedAttempt: number }
  | { kind: "unsigned_sent"; reason: ClientSigningUnsignedReason }
  | {
      kind: "handshake_failed";
      errorKind?: string;
      httpStatus?: number;
      businessCode?: number;
      reason?: string;
    }
  | { kind: "verify_rejected"; reason?: string; signedAttempt: number }
  | { kind: "bypass_entered" }
  | { kind: "request_failed_closed"; errorKind?: string };

export interface ClientSigningObservationEvent {
  observation: ClientSigningObservation;
  providerId: string;
  requestId?: string;
  sessionId?: string;
}

export type ClientSigningErrorKind =
  | "invalid-config"
  | "cryptography"
  | "handshake-timeout"
  | "handshake-network"
  | "handshake-protocol"
  | "handshake-server"
  | "handshake-business"
  | "disposed";

export class ClientRequestSigningError extends Error {
  readonly kind: ClientSigningErrorKind;
  readonly failOpenEligible: boolean;
  readonly reason?: string;
  readonly httpStatus?: number;
  readonly businessCode?: number;

  constructor(input: {
    kind: ClientSigningErrorKind;
    message: string;
    cause?: unknown;
    failOpenEligible?: boolean;
    reason?: string;
    httpStatus?: number;
    businessCode?: number;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "ClientRequestSigningError";
    this.kind = input.kind;
    this.failOpenEligible = input.failOpenEligible ?? false;
    this.reason = input.reason;
    this.httpStatus = input.httpStatus;
    this.businessCode = input.businessCode;
  }
}

export function signingError(
  kind: ClientSigningErrorKind,
  message: string,
  extra: Omit<ConstructorParameters<typeof ClientRequestSigningError>[0], "kind" | "message"> = {},
): ClientRequestSigningError {
  return new ClientRequestSigningError({ kind, message, ...extra });
}

/** 只有握手阶段的失败允许降级为未签名发送；余下错误必须向上抛出。 */
export function isFailOpenEligible(error: unknown): boolean {
  return error instanceof ClientRequestSigningError && error.failOpenEligible;
}
