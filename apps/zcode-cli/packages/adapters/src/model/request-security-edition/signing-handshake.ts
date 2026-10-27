import {
  CLIENT_SIGNING_HANDSHAKE_TIMEOUT_MS,
  CLIENT_SIGNING_NONCE_BYTES,
  signingError,
} from "./signing-protocol.js";
import type { ClientSigningCredential } from "./signing-credential.js";
import { createHandshakeSignature, decryptSigningPrivateKey, randomHex } from "./signing-crypto.js";
import { asRecord } from "./signing-request.js";

/**
 * 一次性签名密钥握手。
 *
 * 所有失败都是 `ClientRequestSigningError`：调用方据此判断是否 fail-open
 * （未签名直发）以及要记录哪些观测字段。这里不接触请求级状态。
 */
const HANDSHAKE_SIGNATURE_PREFIX = "get_sign_key";
const HANDSHAKE_SUCCESS_CODE = 200;
const HANDSHAKE_SERVER_ERROR_CODE = 500;
const HANDSHAKE_REASON_PATTERN = /^HANDSHAKE_[A-Z_]+$/u;

export async function performClientSigningHandshake(input: {
  credential: ClientSigningCredential;
  handshakeUrl: string;
  transport: typeof globalThis.fetch;
}): Promise<CryptoKey> {
  const { credential } = input;
  const ts = String(Date.now());
  const nonce = randomHex(CLIENT_SIGNING_NONCE_BYTES);
  let signature: string;
  try {
    signature = await createHandshakeSignature(
      credential.secret,
      `${HANDSHAKE_SIGNATURE_PREFIX}\n${credential.apiKeyId}\n${ts}\n${nonce}`,
    );
  } catch (error) {
    throw signingError("cryptography", "Client signing handshake signature failed.", {
      cause: error,
      failOpenEligible: true,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLIENT_SIGNING_HANDSHAKE_TIMEOUT_MS);
  // 请求可能先于超时结束（或被遗弃）：unref 让孤儿握手不拖住 CLI 事件循环整整 10s。
  timeout.unref?.();
  try {
    let response: Response;
    try {
      response = await input.transport(input.handshakeUrl, {
        body: JSON.stringify({
          [credential.handshakeField]: credential.credential,
          nonce,
          sig: signature,
          ts,
        }),
        headers: {
          Authorization: credential.credential,
          "Content-Type": "application/json",
        },
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      throw signingError(
        timedOut ? "handshake-timeout" : "handshake-network",
        timedOut ? "Client signing handshake timed out." : "Client signing handshake failed.",
        { cause: error, failOpenEligible: true },
      );
    }
    if (response.status !== HANDSHAKE_SUCCESS_CODE) {
      throw signingError("handshake-protocol", "Client signing handshake HTTP status is invalid.", {
        failOpenEligible: true,
        httpStatus: response.status,
      });
    }

    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = await response.json();
      const record = asRecord(parsed);
      if (!record) throw new Error("invalid response envelope");
      envelope = record;
    } catch (error) {
      const timedOut = controller.signal.aborted;
      throw signingError(
        timedOut ? "handshake-timeout" : "handshake-protocol",
        timedOut
          ? "Client signing handshake timed out."
          : "Client signing handshake JSON is invalid.",
        { cause: error, failOpenEligible: true },
      );
    }

    if (envelope.code === HANDSHAKE_SERVER_ERROR_CODE) {
      throw signingError("handshake-server", "Client signing handshake reported code 500.", {
        businessCode: HANDSHAKE_SERVER_ERROR_CODE,
        failOpenEligible: true,
      });
    }
    if (envelope.code !== HANDSHAKE_SUCCESS_CODE) {
      const message = envelope.msg;
      throw signingError("handshake-business", "Client signing handshake was rejected.", {
        ...(typeof envelope.code === "number" ? { businessCode: envelope.code } : {}),
        failOpenEligible: true,
        ...(typeof message === "string" && HANDSHAKE_REASON_PATTERN.test(message)
          ? { reason: message }
          : {}),
      });
    }

    const privateCipher = asRecord(envelope.data)?.privateCipher;
    if (typeof privateCipher !== "string" || !privateCipher) {
      throw signingError(
        "handshake-protocol",
        "Client signing handshake omitted privateCipher.",
        { failOpenEligible: true },
      );
    }
    try {
      return await decryptSigningPrivateKey(
        credential.apiKeyId,
        credential.secret,
        privateCipher,
      );
    } catch (error) {
      throw signingError("cryptography", "Client signing private key is invalid.", {
        cause: error,
        failOpenEligible: true,
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}
