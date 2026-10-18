import type { ModelRequestObservation } from "@zcode/contracts";
import type { RequestObservationTarget } from "../request-observation-target.js";
import { integer, safeEnum, safeIdentifier } from "../agent-trace-support.js";

/**
 * 把客户端签名观测映射进模型 attempt span。
 *
 * 只写入稳定枚举与计数，不写入签名、nonce、session id 或请求内容：
 * span 会随 Telemetry 出网，签名头属于凭据级数据。
 */
const CLIENT_SIGNING_ATTRIBUTE = "zcode.model_attempt.client_signing";
const CLIENT_SIGNING_UNSIGNED_REASON_ATTRIBUTE =
  "zcode.model_attempt.client_signing_unsigned_reason";
const CLIENT_SIGNING_ERROR_KIND_ATTRIBUTE = "zcode.model_attempt.client_signing_error_kind";

const SIGNED_STATE = "signed";
const UNSIGNED_STATE = "unsigned";
const FAILED_STATE = "failed";

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function recordRequestObservation(
  writer: RequestObservationTarget,
  observation: ModelRequestObservation,
): void {
  switch (observation.kind) {
    case "signed_sent":
      writer.setAttribute(CLIENT_SIGNING_ATTRIBUTE, SIGNED_STATE);
      return;
    case "unsigned_sent":
      writer.setAttribute(CLIENT_SIGNING_ATTRIBUTE, UNSIGNED_STATE);
      writer.setAttribute(
        CLIENT_SIGNING_UNSIGNED_REASON_ATTRIBUTE,
        safeEnum(readString(observation.reason)),
      );
      return;
    case "request_failed_closed":
      writer.setAttribute(CLIENT_SIGNING_ATTRIBUTE, FAILED_STATE);
      writer.setAttribute(
        CLIENT_SIGNING_ERROR_KIND_ATTRIBUTE,
        safeEnum(readString(observation.errorKind)),
      );
      return;
    case "handshake_failed":
      writer.addEvent("client_signing_handshake_failed", {
        business_code: integer(readNumber(observation.businessCode)),
        error_kind: safeEnum(readString(observation.errorKind)),
        http_status: integer(readNumber(observation.httpStatus)),
        reason: safeIdentifier(readString(observation.reason)),
      });
      return;
    case "verify_rejected":
      writer.addEvent("client_signing_verify_rejected", {
        reason: safeIdentifier(readString(observation.reason)),
        signed_attempt: integer(readNumber(observation.signedAttempt)),
      });
      return;
    case "bypass_entered":
      writer.addEvent("client_signing_bypass_entered");
  }
}
