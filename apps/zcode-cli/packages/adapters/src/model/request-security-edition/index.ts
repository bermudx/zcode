import type { Logger } from "@zcode/contracts";
import { ZCODE_VERSION } from "@zcode/shared";
import { readRequestObservationId, RequestObservationStore } from "../request-observations.js";
import type { ModelRequestSecurityPort, ModelRequestSecurityState } from "../request-security.js";
import { ClientRequestSigningKeyCache } from "./signing-key-state.js";
import { ClientRequestSigningManager } from "./signing-manager.js";
import {
  isAccessModeUnsignedBaseURL,
  readProviderHeader,
  requiresClientRequestSigning,
} from "./signing-policy.js";
import { signingError } from "./signing-protocol.js";
import type { ClientSigningObservationEvent } from "./signing-protocol.js";

const APP_VERSION_HEADER = "X-ZCode-App-Version";
const ACCESS_MODE_UNSIGNED_REASON = "access_mode";

/**
 * 官方版客户端请求签名装配。
 *
 * 装配顺序由 model-execution 保证：SDK 请求 → business-error/option-map 观察 →
 * **签名** → provider endpoint routing → 网络代理。签名器看到的是配置里的原始
 * `baseURL` 与最终请求头（含 `x-session-id`、`x-request-id`），URL 重写发生在其后，
 * 因此 origin 校验针对 Provider 自身域名，而实际流量仍落到 ZCode 网关。
 */
class OfficialRequestSecurity implements ModelRequestSecurityPort {
  readonly #logger?: Logger;
  readonly #signing: ClientRequestSigningManager;
  readonly #observations = new RequestObservationStore();
  readonly #accessModeLoggedProviders = new Set<string>();

  constructor(keyCache: ClientRequestSigningKeyCache, logger?: Logger) {
    this.#logger = logger;
    this.#signing = new ClientRequestSigningManager({
      keyCache,
      observer: (event) => this.observeClientSigning(event),
      observerError: (error) => this.logClientSigningObservationFailure(error),
    });
  }

  take(requestId: string) {
    return this.#observations.take(requestId);
  }

  protectTransport(
    input: Parameters<ModelRequestSecurityPort["protectTransport"]>[0],
  ): typeof globalThis.fetch {
    const { providerId, providerConfig, transport } = input;
    if (requiresClientRequestSigning(providerConfig)) {
      // 需签名的 Provider 缺少 baseURL 属于配置错误：静默退回未签名会把 Coding Plan
      // 凭据未签名、未归因地发往错误端点，必须 fail-closed（区别于下方 fail-open 降级）。
      if (!providerConfig.baseURL) {
        throw signingError(
          "invalid-config",
          "Client request signing requires a provider baseURL.",
        );
      }
      return this.#signing.createFetch(
        {
          apiKey: providerConfig.apiKey ?? "",
          baseURL: providerConfig.baseURL,
          clientVersion: readProviderHeader(providerConfig.headers, APP_VERSION_HEADER) ?? ZCODE_VERSION,
          providerId,
        },
        transport,
      );
    }
    // family 域名但访问模式免签（start-plan / off-peak / highspeed）：按设计不签名，
    // 只为用量归因记录一次 unsigned_sent(access_mode)。
    if (isAccessModeUnsignedBaseURL(providerConfig.baseURL)) {
      return this.createAccessModeUnsignedFetch(providerId, transport);
    }
    return transport;
  }

  private observeClientSigning(event: ClientSigningObservationEvent): void {
    const { observation } = event;
    if (event.requestId) this.#observations.record(event.requestId, observation);
    const { kind, ...rest } = observation;
    const context = {
      ...rest,
      event: `model.client_signing.${kind}`,
      providerId: event.providerId,
      requestId: event.requestId,
      sessionId: event.sessionId,
    };
    switch (kind) {
      case "signed_sent":
        this.#logger?.debug("Client request signing applied", context);
        return;
      case "unsigned_sent":
        this.#logger?.info("Client request sent without signature", context);
        return;
      case "handshake_failed":
        this.#logger?.warn("Client signing handshake failed", context);
        return;
      case "verify_rejected":
        this.#logger?.warn("Client signing rejected by gateway", context);
        return;
      case "bypass_entered":
        this.#logger?.warn("Client signing entered BYPASS for current signer generation", context);
        return;
      case "request_failed_closed":
        this.#logger?.warn("Client signing failed closed", context);
    }
  }

  /** 观测回调自身抛错时的诊断出口：走 debug 日志，且绝不能再影响请求主路径。 */
  private logClientSigningObservationFailure(error: unknown): void {
    this.#logger?.debug("Client signing observation failed", {
      event: "model.client_signing.observation_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private createAccessModeUnsignedFetch(
    providerId: string,
    transport: typeof globalThis.fetch,
  ): typeof globalThis.fetch {
    return (requestInput, init) => {
      const requestId = readRequestObservationId(requestInput, init);
      const observation = { kind: "unsigned_sent", reason: ACCESS_MODE_UNSIGNED_REASON } as const;
      if (requestId) this.#observations.record(requestId, observation);
      if (!this.#accessModeLoggedProviders.has(providerId)) {
        this.#accessModeLoggedProviders.add(providerId);
        this.#logger?.info("Client request signing skipped by provider access mode", {
          event: "model.client_signing.unsigned_sent",
          providerId,
          reason: ACCESS_MODE_UNSIGNED_REASON,
          requestId,
        });
      }
      return transport(requestInput, init);
    };
  }
}

export function createModelRequestSecurityState(): ModelRequestSecurityState {
  // 私钥缓存按进程共享，每个模型执行器仍拿到独立的签名器与观测存储。
  const keyCache = new ClientRequestSigningKeyCache();
  return {
    createExecution: ({ logger }) => new OfficialRequestSecurity(keyCache, logger),
  };
}
