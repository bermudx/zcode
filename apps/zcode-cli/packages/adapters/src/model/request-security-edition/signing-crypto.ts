/**
 * 客户端签名协议的密码学原语。
 *
 * 算法与官方发行版一致（docs/coding-plan/client-request-signing-and-usage-allowance.md §3.2/§3.3）：
 * HKDF-SHA256（salt `WD_CLIENT_SIGN_KDF_SALT`）派生握手 HMAC 与私钥解密密钥，
 * AES-256-GCM 解出 Ed25519 pkcs8 私钥，签名使用 WebCrypto Ed25519，
 * 请求工作量证明为 8 bit hashcash。
 *
 * 密钥材料只在内存中短暂存在，派生出的字节数组在用完后清零。
 */
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const HMAC_INFO = "getSignKey_hmac";
const PRIVATE_KEY_INFO = "ed25519_priv";
const GCM_IV_BYTES = 12;
const GCM_TAG_BITS = 128;
const MIN_PRIVATE_CIPHER_BYTES = GCM_IV_BYTES + GCM_TAG_BITS / 8;
const DERIVED_KEY_BITS = 256;
const POW_PREFIX_BYTES = 12;
const POW_MAX_BITS = 32;
const POW_CANDIDATE_HEX_DIGITS = 8;
const MAX_POW_ITERATIONS = 0xffffffff;
const HASH_PREFIX_CHARS = 32;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(value));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!value || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new Error("invalid base64");
  }
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/** 生成 `bytes` 字节的随机十六进制串（每字节两位）。 */
export function randomHex(bytes: number): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveBytes(secret: string, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const source = await crypto.subtle.importKey("raw", encodeUtf8(secret), "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        hash: "SHA-256",
        info: encodeUtf8(info),
        name: "HKDF",
        salt: encodeUtf8(KDF_SALT),
      },
      source,
      DERIVED_KEY_BITS,
    ),
  );
}

/** 握手签名：HMAC-SHA256(HKDF(secret, getSignKey_hmac), message)。 */
export async function createHandshakeSignature(secret: string, message: string): Promise<string> {
  const keyBytes = await deriveBytes(secret, HMAC_INFO);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encodeUtf8(message)));
    try {
      return bytesToBase64(signature);
    } finally {
      signature.fill(0);
    }
  } finally {
    keyBytes.fill(0);
  }
}

/**
 * 解密服务端下发的 Ed25519 私钥：`iv || ciphertext || tag`，AAD = apiKeyId。
 */
export async function decryptSigningPrivateKey(
  apiKeyId: string,
  secret: string,
  privateCipher: string,
): Promise<CryptoKey> {
  const cipher = base64ToBytes(privateCipher);
  if (cipher.byteLength <= MIN_PRIVATE_CIPHER_BYTES) {
    throw new Error("privateCipher is too short");
  }
  let keyBytes: Uint8Array<ArrayBuffer> | undefined;
  let plain: Uint8Array<ArrayBuffer> | undefined;
  try {
    keyBytes = await deriveBytes(secret, PRIVATE_KEY_INFO);
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          additionalData: encodeUtf8(apiKeyId),
          iv: cipher.slice(0, GCM_IV_BYTES),
          name: "AES-GCM",
          tagLength: GCM_TAG_BITS,
        },
        key,
        cipher.slice(GCM_IV_BYTES),
      ),
    );
    const pkcs8 = base64ToBytes(new TextDecoder().decode(plain));
    try {
      return await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
    } finally {
      pkcs8.fill(0);
    }
  } finally {
    keyBytes?.fill(0);
    plain?.fill(0);
  }
}

export async function signBusinessMessage(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", privateKey, encodeUtf8(message)),
  );
  try {
    return bytesToBase64(signature);
  } finally {
    signature.fill(0);
  }
}

/**
 * 请求工作量证明：n = hex(sha256(apiKeyId\nappId\nsessionId\nts))[0:32]，
 * 找到一个 8 bit 前导零的 `randomHex(12) + counter` 候选。
 * 目标只是服务端限速，平均约 256 次哈希。
 */
export async function createClientRequestProofOfWork(input: {
  apiKeyId: string;
  appId: string;
  powBits: number;
  sessionId: string;
  signal?: AbortSignal;
  ts: string;
}): Promise<string> {
  if (
    !Number.isInteger(input.powBits) ||
    input.powBits < 0 ||
    input.powBits > POW_MAX_BITS
  ) {
    throw new Error(`powBits must be an integer between 0 and ${POW_MAX_BITS}`);
  }
  input.signal?.throwIfAborted();
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encodeUtf8(`${input.apiKeyId}\n${input.appId}\n${input.sessionId}\n${input.ts}`),
    ),
  );
  const prefix = bytesToHex(digest).slice(0, HASH_PREFIX_CHARS);
  const random = randomHex(POW_PREFIX_BYTES);
  for (let counter = 0; counter <= MAX_POW_ITERATIONS; counter += 1) {
    input.signal?.throwIfAborted();
    const candidate = `${random}${counter.toString(16).padStart(POW_CANDIDATE_HEX_DIGITS, "0")}`;
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encodeUtf8(`${prefix}\n${candidate}`)),
    );
    if (hasLeadingZeroBits(hash, input.powBits)) return candidate;
  }
  throw new Error("Unable to solve client request proof of work");
}

export function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const wholeBytes = Math.floor(bits / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  const remainingBits = bits % 8;
  if (remainingBits === 0) return true;
  const mask = (255 << (8 - remainingBits)) & 255;
  return ((bytes[wholeBytes] ?? 255) & mask) === 0;
}
