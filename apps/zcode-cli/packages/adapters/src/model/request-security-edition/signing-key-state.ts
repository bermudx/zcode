/**
 * 单个签名作用域的 Ed25519 私钥状态。
 *
 * 私钥由服务端在握手时下发，按 `apiKey + origin` 进程内缓存复用；
 * `epoch` 用于丢弃“握手进行中被失效”的过期结果。
 */
export interface ClientSigningKeyState {
  epoch: number;
  privateKey?: CryptoKey;
  handshakePromise?: Promise<CryptoKey>;
}

export function createClientSigningKeyState(): ClientSigningKeyState {
  return { epoch: 0 };
}

/** 进程级私钥缓存：apiKey -> origin -> keyState。只共享可复用资源，不共享请求状态。 */
export class ClientRequestSigningKeyCache {
  private readonly entries = new Map<string, Map<string, ClientSigningKeyState>>();

  resolve(apiKey: string, handshakeUrl: string): ClientSigningKeyState {
    let byOrigin = this.entries.get(apiKey);
    if (!byOrigin) {
      byOrigin = new Map();
      this.entries.set(apiKey, byOrigin);
    }
    const origin = new URL(handshakeUrl).origin;
    const existing = byOrigin.get(origin);
    if (existing) return existing;
    const created = createClientSigningKeyState();
    byOrigin.set(origin, created);
    return created;
  }
}
