import { signingError } from "./signing-protocol.js";
import type { ClientSigningObservationEvent } from "./signing-protocol.js";
import { ClientRequestSigningV4Signer, type ClientSigningRequestInput } from "./signing-signer.js";
import type { ClientRequestSigningKeyCache, ClientSigningKeyState } from "./signing-key-state.js";

interface SignerScopeEntry {
  apiKey: string;
  baseURL: string;
  clientVersion: string;
  signer: ClientRequestSigningV4Signer;
  transport: typeof globalThis.fetch;
}

interface SignerScope {
  disposed: boolean;
  entry?: SignerScopeEntry;
}

export interface ClientSigningManagerOptions {
  allowInsecureHttp?: boolean;
  keyCache?: ClientRequestSigningKeyCache;
  observer?: (event: ClientSigningObservationEvent) => void;
}

/**
 * 按 provider 维护签名器作用域。
 *
 * 同一个 provider 在一个 execution 内会随每次请求鉴权刷新重建 model/factory；
 * 只有 apiKey、baseURL、clientVersion、transport 都不变时才复用签名器，
 * 否则销毁旧签名器（丢弃其私钥）重新握手，避免跨账号串用私钥。
 */
export class ClientRequestSigningManager {
  readonly #scopes = new Map<string, SignerScope>();
  readonly #keyCache?: ClientRequestSigningKeyCache;
  readonly #observer?: (event: ClientSigningObservationEvent) => void;
  readonly #allowInsecureHttp: boolean;

  constructor(options: ClientSigningManagerOptions = {}) {
    this.#keyCache = options.keyCache;
    this.#observer = options.observer;
    this.#allowInsecureHttp = options.allowInsecureHttp ?? false;
  }

  createFetch(
    input: ClientSigningRequestInput,
    transport: typeof globalThis.fetch,
  ): typeof globalThis.fetch {
    const scope = this.#scope(input.providerId);
    return async (requestInput, init) => {
      if (scope.disposed) {
        throw signingError("disposed", "Client request signer has been disposed.");
      }
      return this.#resolveSigner(scope, input, transport).request(requestInput, init);
    };
  }

  dispose(providerId?: string): void {
    if (providerId) {
      const scope = this.#scopes.get(providerId);
      if (scope) {
        scope.disposed = true;
        scope.entry?.signer.dispose();
      }
      this.#scopes.delete(providerId);
      return;
    }
    for (const scope of this.#scopes.values()) {
      scope.disposed = true;
      scope.entry?.signer.dispose();
    }
    this.#scopes.clear();
  }

  #scope(providerId: string): SignerScope {
    const existing = this.#scopes.get(providerId);
    if (existing) return existing;
    const created: SignerScope = { disposed: false };
    this.#scopes.set(providerId, created);
    return created;
  }

  #resolveSigner(
    scope: SignerScope,
    input: ClientSigningRequestInput,
    transport: typeof globalThis.fetch,
  ): ClientRequestSigningV4Signer {
    const clientVersion = input.clientVersion.trim() || "0.0.0-dev";
    const current = scope.entry;
    if (
      current?.apiKey === input.apiKey &&
      current.baseURL === input.baseURL &&
      current.clientVersion === clientVersion &&
      current.transport === transport
    ) {
      return current.signer;
    }
    current?.signer.dispose();
    const keyState = this.#resolveKeyState(input);
    const signer = new ClientRequestSigningV4Signer(
      { ...input, clientVersion },
      transport,
      {
        allowInsecureHttp: this.#allowInsecureHttp,
        ...(keyState ? { keyState } : {}),
        ...(this.#observer ? { observer: this.#observer } : {}),
      },
    );
    scope.entry = {
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      clientVersion,
      signer,
      transport,
    };
    return signer;
  }

  /** baseURL 非法时让签名器自己报 invalid-config，这里不能提前抛错。 */
  #resolveKeyState(input: ClientSigningRequestInput): ClientSigningKeyState | undefined {
    try {
      return this.#keyCache?.resolve(input.apiKey, input.baseURL);
    } catch {
      return undefined;
    }
  }
}
