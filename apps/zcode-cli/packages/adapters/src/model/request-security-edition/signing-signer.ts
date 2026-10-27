import {
  CLIENT_SIGNING_APP_ID,
  CLIENT_SIGNING_NONCE_BYTES,
  CLIENT_SIGNING_POW_BITS,
  ClientRequestSigningError,
  isFailOpenEligible,
  signingError,
  type ClientSigningObservation,
  type ClientSigningObservationEvent,
  type ClientSigningUnsignedReason,
} from "./signing-protocol.js";
import {
  parseClientSigningCredential,
  type ClientSigningCredential,
} from "./signing-credential.js";
import { createClientRequestProofOfWork, randomHex, signBusinessMessage } from "./signing-crypto.js";
import { performClientSigningHandshake } from "./signing-handshake.js";
import { createClientSigningKeyState, type ClientSigningKeyState } from "./signing-key-state.js";
import {
  bufferSigningRequest,
  buildSigningInit,
  readRefreshableClientSignatureReason,
  resolveHandshakeUrl,
  sanitizeClientSigningHeaders,
  waitForPromiseOrAbort,
  REQUEST_ID_HEADER,
  SESSION_HEADER,
  type BufferedSigningRequest,
} from "./signing-request.js";

const DEFAULT_CLIENT_VERSION = "0.0.0-dev";

export interface ClientSigningRequestInput {
  apiKey: string;
  baseURL: string;
  clientVersion: string;
  providerId: string;
}

export interface ClientSigningSignerOptions {
  allowInsecureHttp?: boolean;
  keyState?: ClientSigningKeyState;
  observer?: (event: ClientSigningObservationEvent) => void;
  /** 观测回调抛错时的诊断出口；该出口自身失败仍保持静默，不影响请求主路径。 */
  observerError?: (error: unknown) => void;
}

type SigningTransport = typeof globalThis.fetch;

/**
 * 单个签名作用域：握手一次、缓存私钥、按请求签名并处理验证重试。
 *
 * 失败语义与官方一致：握手类失败 fail-open（未签名直发），已签名后连续两次被
 * 网关拒绝则当前代进入 BYPASS，避免每请求都握手打转。
 */
export class ClientRequestSigningV4Signer {
  readonly #credentialInput: ClientSigningRequestInput;
  readonly #clientVersion: string;
  readonly #businessOrigin: string;
  readonly #handshakeUrl: string;
  readonly #keyState: ClientSigningKeyState;
  readonly #ownsKeyState: boolean;
  readonly #transport: SigningTransport;
  readonly #observer?: (event: ClientSigningObservationEvent) => void;
  readonly #observerError?: (error: unknown) => void;

  #credential?: ClientSigningCredential;
  #activeRequestCount = 0;
  #bypassSigning = false;
  #disposed = false;
  #disposeRequested = false;

  constructor(
    input: ClientSigningRequestInput,
    transport: SigningTransport,
    options: ClientSigningSignerOptions = {},
  ) {
    this.#credentialInput = input;
    this.#clientVersion = input.clientVersion.trim() || DEFAULT_CLIENT_VERSION;
    this.#handshakeUrl = resolveHandshakeUrl(input.baseURL, options.allowInsecureHttp ?? false);
    this.#businessOrigin = new URL(this.#handshakeUrl).origin;
    this.#keyState = options.keyState ?? createClientSigningKeyState();
    this.#ownsKeyState = !options.keyState;
    this.#transport = transport;
    this.#observer = options.observer;
    this.#observerError = options.observerError;
  }

  dispose(): void {
    if (this.#disposeRequested || this.#disposed) return;
    this.#disposeRequested = true;
    if (this.#activeRequestCount === 0) this.finalizeDispose();
  }

  async request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.beginRequest();
    let buffered: BufferedSigningRequest | undefined;
    try {
      buffered = await bufferSigningRequest(input, init);
      if (new URL(buffered.url).origin !== this.#businessOrigin) {
        return this.sendUnsigned(buffered, "origin_mismatch");
      }
      // BYPASS 读取共享 key state：transport 身份变化会重建签名器，但同一把 key
      // 已经被网关拒绝的事实不随签名器代消亡。
      if (this.#bypassSigning || this.#keyState.bypassed) {
        return this.sendUnsigned(buffered, "bypass");
      }
      // 没有 session 就没有签名载荷的可变因子：不要先握手再失败，直接按未签名发送。
      if (!buffered.headers.get(SESSION_HEADER)?.trim()) {
        return this.sendUnsigned(buffered, "missing_session");
      }

      let privateKey = await this.getKeyOrSendUnsigned(buffered);
      if (privateKey instanceof Response) return privateKey;

      const first = await this.sendSigned(buffered, privateKey, 1);
      const firstReason = await readRefreshableClientSignatureReason(first);
      if (!firstReason) return first;

      this.observe(buffered, { kind: "verify_rejected", reason: firstReason, signedAttempt: 1 });
      this.invalidatePrivateKey(privateKey);
      privateKey = await this.getKeyOrSendUnsigned(buffered);
      if (privateKey instanceof Response) return privateKey;

      const second = await this.sendSigned(buffered, privateKey, 2);
      const secondReason = await readRefreshableClientSignatureReason(second);
      if (!secondReason) return second;

      this.observe(buffered, { kind: "verify_rejected", reason: secondReason, signedAttempt: 2 });
      this.invalidatePrivateKey(privateKey);
      // 同时写入签名器代与共享 key state：前者约束本代，后者让后续重建的签名器
      // （每次请求的 routing fetch 闭包都是新 transport 身份）不再重复握手打转。
      this.#bypassSigning = true;
      this.#keyState.bypassed = true;
      this.observe(buffered, { kind: "bypass_entered" });
      return this.sendUnsigned(buffered, "verify_refresh_exhausted");
    } catch (error) {
      // 只有可判定错误才记录失败观测；中断和上层重试错误保持静默，避免噪声。
      if (error instanceof ClientRequestSigningError && !buffered?.signal?.aborted) {
        this.observe(buffered, { kind: "request_failed_closed", errorKind: error.kind });
      }
      throw error;
    } finally {
      this.endRequest();
    }
  }

  private beginRequest(): void {
    if (this.#disposeRequested || this.#disposed) {
      throw signingError("disposed", "Client request signer has been disposed.");
    }
    this.#activeRequestCount += 1;
  }

  private endRequest(): void {
    this.#activeRequestCount -= 1;
    if (this.#activeRequestCount === 0 && this.#disposeRequested) this.finalizeDispose();
  }

  private finalizeDispose(): void {
    this.#disposed = true;
    if (!this.#ownsKeyState) return;
    this.#keyState.epoch += 1;
    this.#keyState.privateKey = undefined;
    this.#keyState.handshakePromise = undefined;
  }

  private observe(
    request: BufferedSigningRequest | undefined,
    observation: ClientSigningObservation,
  ): void {
    if (!this.#observer) return;
    const requestId = request?.headers.get(REQUEST_ID_HEADER)?.trim() || undefined;
    const sessionId = request?.headers.get(SESSION_HEADER)?.trim() || undefined;
    try {
      this.#observer({
        observation,
        providerId: this.#credentialInput.providerId,
        ...(requestId ? { requestId } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
    } catch (error) {
      // 观测失败不能影响请求主路径，但也不能无声消失：交给诊断出口（其自身失败仍静默）。
      try {
        this.#observerError?.(error);
      } catch {
        // 诊断出口失败同样不能影响请求主路径。
      }
    }
  }

  private async getKeyOrSendUnsigned(
    request: BufferedSigningRequest,
  ): Promise<CryptoKey | Response> {
    try {
      return await this.ensurePrivateKey(request);
    } catch (error) {
      // 凭据形态不支持签名（例如普通 sk- API Key）时降级为未签名发送：
      // 签名是增值能力，不能让本来可用的 Provider 直接失败。
      if (error instanceof ClientRequestSigningError && error.kind === "invalid-config") {
        return this.sendUnsigned(request, "invalid_credential");
      }
      if (isFailOpenEligible(error)) return this.sendUnsigned(request, "handshake_failed");
      throw error;
    }
  }

  private async sendSigned(
    request: BufferedSigningRequest,
    privateKey: CryptoKey,
    signedAttempt: number,
  ): Promise<Response> {
    const credential = this.resolveCredential();
    const sessionId = request.headers.get(SESSION_HEADER)?.trim();
    // 官方实现此时直接抛 invalid-config。开源版存在无 session 的后台/工具类请求，
    // 不能因为它们让整个请求失败：降级为未签名发送，只损失该请求的用量系数。
    if (!sessionId) return this.sendUnsigned(request, "missing_session");

    const headers = sanitizeClientSigningHeaders(request.headers);
    const ts = String(Date.now());
    const nonce = randomHex(CLIENT_SIGNING_NONCE_BYTES);
    let pow: string;
    try {
      pow = await createClientRequestProofOfWork({
        apiKeyId: credential.apiKeyId,
        appId: CLIENT_SIGNING_APP_ID,
        powBits: CLIENT_SIGNING_POW_BITS,
        sessionId,
        signal: request.signal ?? undefined,
        ts,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw signingError("cryptography", "Client request proof of work failed.", { cause: error });
    }

    let signature: string;
    try {
      signature = await signBusinessMessage(
        privateKey,
        `${credential.apiKeyId}\n${ts}\n${this.#clientVersion}\n${sessionId}\n${nonce}`,
      );
    } catch (error) {
      throw signingError("cryptography", "Client request signing failed.", { cause: error });
    }

    headers.set("X-Client-Ts", ts);
    headers.set("X-Client-Version", this.#clientVersion);
    headers.set("X-Client-Sig", signature);
    headers.set(SESSION_HEADER, sessionId);
    headers.set("X-Client-Nonce", nonce);
    headers.set("X-App-Id", CLIENT_SIGNING_APP_ID);
    headers.set("X-Client-Pow", pow);
    this.observe(request, { kind: "signed_sent", signedAttempt });
    return this.#transport(request.url, buildSigningInit(request, headers));
  }

  private async sendUnsigned(
    request: BufferedSigningRequest,
    reason: ClientSigningUnsignedReason,
  ): Promise<Response> {
    this.observe(request, { kind: "unsigned_sent", reason });
    return this.#transport(
      request.url,
      buildSigningInit(request, sanitizeClientSigningHeaders(request.headers)),
    );
  }

  private invalidatePrivateKey(privateKey: CryptoKey): void {
    if (this.#keyState.privateKey !== privateKey) return;
    this.#keyState.epoch += 1;
    this.#keyState.privateKey = undefined;
    this.#keyState.handshakePromise = undefined;
  }

  private async ensurePrivateKey(request: BufferedSigningRequest): Promise<CryptoKey> {
    const signal = request.signal;
    if (this.#disposed) throw signingError("disposed", "Client request signer has been disposed.");
    if (this.#keyState.privateKey) return this.#keyState.privateKey;
    // 先解析凭据：无效凭据会在这里决定“降级”还是硬失败。
    this.resolveCredential();
    if (this.#keyState.handshakePromise) {
      return waitForPromiseOrAbort(this.#keyState.handshakePromise, signal);
    }

    const epoch = this.#keyState.epoch;
    const handshake = this.performHandshake()
      .catch((error: unknown) => {
        if (error instanceof ClientRequestSigningError) {
          this.observe(request, {
            kind: "handshake_failed",
            errorKind: error.kind,
            ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
            ...(error.businessCode !== undefined ? { businessCode: error.businessCode } : {}),
            ...(error.reason ? { reason: error.reason } : {}),
          });
        }
        throw error;
      })
      .then((privateKey) => {
        if ((this.#ownsKeyState && this.#disposed) || this.#keyState.epoch !== epoch) {
          throw signingError("disposed", "Client request signer changed during handshake.");
        }
        this.#keyState.privateKey = privateKey;
        return privateKey;
      });

    this.#keyState.handshakePromise = handshake;
    const clearHandshake = () => {
      if (this.#keyState.handshakePromise === handshake) this.#keyState.handshakePromise = undefined;
    };
    handshake.then(clearHandshake, clearHandshake);
    return waitForPromiseOrAbort(handshake, signal);
  }

  private async performHandshake(): Promise<CryptoKey> {
    return performClientSigningHandshake({
      credential: this.resolveCredential(),
      handshakeUrl: this.#handshakeUrl,
      transport: this.#transport,
    });
  }

  private resolveCredential(): ClientSigningCredential {
    if (this.#credential) return this.#credential;
    const credential = parseClientSigningCredential(this.#credentialInput.apiKey);
    if (!credential) {
      throw signingError(
        "invalid-config",
        "Client signing requires an API Key or Project Access Token.",
      );
    }
    this.#credential = credential;
    return credential;
  }
}
