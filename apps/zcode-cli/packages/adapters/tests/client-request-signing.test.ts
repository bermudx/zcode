import { describe, expect, it, vi } from "vitest";
import { createModelRequestSecurityState } from "../src/model/request-security-edition/index.js";
import { ClientRequestSigningError } from "../src/model/request-security-edition/signing-protocol.js";
import type { ModelRequestSecurityPort } from "../src/model/request-security.js";

const API_KEY_ID = "kid-123";
const API_SECRET = "secret-value";
const API_KEY = `${API_KEY_ID}.${API_SECRET}`;
const BASE_URL = "https://api.z.ai/api/anthropic";
const CLIENT_VERSION = "0.16.9-test";
const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";

const encoder = new TextEncoder();

function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveKey(secret: string, info: string): Promise<Uint8Array> {
  const source = await crypto.subtle.importKey("raw", utf8(secret), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { hash: "SHA-256", info: utf8(info), name: "HKDF", salt: utf8(KDF_SALT) },
      source,
      256,
    ),
  );
}

async function createPrivateCipher(privateKey: CryptoKey): Promise<string> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  const keyBytes = await deriveKey(API_SECRET, "ed25519_priv");
  const aesKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { additionalData: utf8(API_KEY_ID), iv, name: "AES-GCM", tagLength: 128 },
      aesKey,
      utf8(toBase64(pkcs8)),
    ),
  );
  return toBase64(new Uint8Array([...iv, ...ciphertext]));
}

interface HandshakeFixture {
  publicKey: CryptoKey;
  respond: () => Response;
}

async function createHandshakeFixture(): Promise<HandshakeFixture> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const privateCipher = await createPrivateCipher(keyPair.privateKey);
  return {
    publicKey: keyPair.publicKey,
    respond: () =>
      Response.json({ code: 200, data: { privateCipher }, msg: "" }, { status: 200 }),
  };
}

function signingPolicyProvider(overrides: Record<string, unknown> = {}) {
  return {
    access: { type: "zhipu-coding-plan-api-key" },
    apiKey: API_KEY,
    baseURL: BASE_URL,
    headers: { "X-ZCode-App-Version": CLIENT_VERSION },
    ...overrides,
  } as unknown as Parameters<ModelRequestSecurityPort["protectTransport"]>[0]["providerConfig"];
}

function requestFor(requestId: string, sessionId: string | null = "session-1"): Request {
  const headers = new Headers({ "x-request-id": requestId });
  if (sessionId) headers.set("x-session-id", sessionId);
  return new Request(`${BASE_URL}/v1/messages`, { body: '{"hello":"world"}', headers, method: "POST" });
}

async function verifySignature(
  publicKey: CryptoKey,
  signatureBase64: string,
  message: string,
): Promise<boolean> {
  return crypto.subtle.verify("Ed25519", publicKey, fromBase64(signatureBase64), utf8(message));
}

function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const whole = Math.floor(bits / 8);
  for (let index = 0; index < whole; index += 1) if (bytes[index] !== 0) return false;
  const rest = bits % 8;
  if (rest === 0) return true;
  const mask = (255 << (8 - rest)) & 255;
  return ((bytes[whole] ?? 255) & mask) === 0;
}

function createExecution() {
  const state = createModelRequestSecurityState();
  return state.createExecution({});
}

function createTransport(handlers: {
  handshake?: () => Response | Promise<Response>;
  business?: (request: Request) => Response | Promise<Response>;
}) {
  const handshakeCalls: Request[] = [];
  const businessCalls: Request[] = [];
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === HANDSHAKE_PATH) {
      handshakeCalls.push(request);
      return handlers.handshake ? handlers.handshake() : Response.json({ code: 200, msg: "" });
    }
    businessCalls.push(request);
    return handlers.business ? handlers.business(request) : Response.json({ ok: true });
  });
  return { businessCalls, handshakeCalls, transport };
}

describe("client request signing: policy", () => {
  it("signs coding-plan API keys and z.ai family base URLs, but not unsigned account modes", () => {
    const execution = createExecution();
    const signedProviderIds = [
      { access: { type: "zhipu-coding-plan-api-key" } },
      { access: { type: "zhipu-account", mode: "individual-coding-plan" } },
      { access: { type: "zhipu-account", mode: "team-coding-plan" } },
      { access: { type: "api-key" }, baseURL: "https://api.z.ai/api/anthropic" },
      { access: { type: "api-key" }, baseURL: "https://open.bigmodel.cn/api/anthropic" },
      { access: { type: "api-key" }, baseURL: "https://api.chatglm.site/v1" },
    ];
    for (const [index, provider] of signedProviderIds.entries()) {
      const base = new Response("ok");
      const transport = vi.fn<typeof fetch>(async () => base);
      const wrapped = execution.protectTransport({
        providerId: `provider-${index}`,
        providerConfig: signingPolicyProvider(provider),
        transport,
      });
      expect(wrapped).not.toBe(transport);
    }

    for (const mode of ["start-plan", "off-peak", "highspeed"]) {
      const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
      const wrapped = execution.protectTransport({
        providerId: `unsigned-${mode}`,
        providerConfig: signingPolicyProvider({
          access: { type: "zhipu-account", mode },
        }),
        transport,
      });
      // family 域名下仍会包一层，但只记录 unsigned_sent(access_mode)。
      expect(wrapped).not.toBe(transport);
    }

    const thirdParty = vi.fn<typeof fetch>(async () => new Response("ok"));
    expect(
      execution.protectTransport({
        providerId: "third-party",
        providerConfig: signingPolicyProvider({
          access: { type: "api-key" },
          baseURL: "https://example.test/v1",
        }),
        transport: thirdParty,
      }),
    ).toBe(thirdParty);
  });

  it("records access-mode unsigned observations once per provider", async () => {
    const execution = createExecution();
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
    const wrapped = execution.protectTransport({
      providerId: "offpeak",
      providerConfig: signingPolicyProvider({ access: { type: "zhipu-account", mode: "off-peak" } }),
      transport,
    });
    await wrapped(requestFor("req-offpeak"));
    expect(execution.take("req-offpeak")).toEqual([
      { kind: "unsigned_sent", reason: "access_mode" },
    ]);
  });

  // 回归（P001-F2）：需签名的 Provider 缺少 baseURL 时不能静默退回未签名发送。
  it("fails closed with invalid-config when a signing-required provider has no baseURL", () => {
    const execution = createExecution();
    const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
    for (const baseURL of [undefined, ""]) {
      let caught: unknown;
      try {
        execution.protectTransport({
          providerId: "coding-plan",
          providerConfig: signingPolicyProvider({ baseURL }),
          transport,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ClientRequestSigningError);
      expect(caught).toMatchObject({ kind: "invalid-config" });
      expect((caught as ClientRequestSigningError).message).toMatch(/baseURL/u);
    }
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("client request signing: handshake and signature", () => {
  it("performs the handshake and writes verifiable signing headers", async () => {
    const fixture = await createHandshakeFixture();
    const { transport, businessCalls, handshakeCalls } = createTransport({
      handshake: fixture.respond,
    });
    const execution = createExecution();
    const wrapped = execution.protectTransport({
      providerId: "coding-plan",
      providerConfig: signingPolicyProvider(),
      transport,
    });

    const response = await wrapped(requestFor("req-1"));
    expect(response.ok).toBe(true);
    expect(handshakeCalls).toHaveLength(1);
    expect(businessCalls).toHaveLength(1);

    const sent = businessCalls[0]!;
    const ts = sent.headers.get("x-client-ts") ?? "";
    const nonce = sent.headers.get("x-client-nonce") ?? "";
    const signature = sent.headers.get("x-client-sig") ?? "";
    const pow = sent.headers.get("x-client-pow") ?? "";
    expect(sent.headers.get("x-app-id")).toBe("zcode");
    expect(sent.headers.get("x-client-version")).toBe(CLIENT_VERSION);
    expect(sent.headers.get("x-session-id")).toBe("session-1");
    expect(ts).toMatch(/^\d{13}$/u);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/u);
    expect(pow).toMatch(/^[0-9a-f]{32}$/u);

    const canonical = `${API_KEY_ID}\n${ts}\n${CLIENT_VERSION}\nsession-1\n${nonce}`;
    await expect(verifySignature(fixture.publicKey, signature, canonical)).resolves.toBe(true);

    const prefix = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          utf8(`${API_KEY_ID}\nzcode\nsession-1\n${ts}`),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    )
      .join("")
      .slice(0, 32);
    const powHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", utf8(`${prefix}\n${pow}`)),
    );
    expect(hasLeadingZeroBits(powHash, 8)).toBe(true);

    expect(await sent.text()).toBe('{"hello":"world"}');
    expect(execution.take("req-1")).toEqual([{ kind: "signed_sent", signedAttempt: 1 }]);
  });

  it("strips stale signing headers before writing its own signature", async () => {
    const fixture = await createHandshakeFixture();
    const { transport, businessCalls } = createTransport({ handshake: fixture.respond });
    const execution = createExecution();
    const wrapped = execution.protectTransport({
      providerId: "coding-plan",
      providerConfig: signingPolicyProvider(),
      transport,
    });

    const request = requestFor("req-stale");
    request.headers.set("x-client-sig", "stale-signature");
    request.headers.set("x-app-id", "other-app");
    await wrapped(request);

    const sent = businessCalls[0]!;
    expect(sent.headers.get("x-client-sig")).not.toBe("stale-signature");
    expect(sent.headers.get("x-app-id")).toBe("zcode");
  });
});

describe("client request signing: recovery and fail-open", () => {
  it("re-handshakes and replays once on VERIFY_SIGNATURE_INVALID", async () => {
    const fixture = await createHandshakeFixture();
    let businessCallCount = 0;
    const { transport, handshakeCalls } = createTransport({
      handshake: fixture.respond,
      business: () => {
        businessCallCount += 1;
        return businessCallCount === 1
          ? Response.json({ code: 401, msg: "VERIFY_SIGNATURE_INVALID" }, { status: 401 })
          : Response.json({ ok: true });
      },
    });
    const execution = createExecution();
    const wrapped = execution.protectTransport({
      providerId: "coding-plan",
      providerConfig: signingPolicyProvider(),
      transport,
    });

    await wrapped(requestFor("req-retry"));
    expect(handshakeCalls).toHaveLength(2);
    expect(businessCallCount).toBe(2);
    expect(execution.take("req-retry")).toEqual([
      { kind: "signed_sent", signedAttempt: 1 },
      { kind: "verify_rejected", reason: "VERIFY_SIGNATURE_INVALID", signedAttempt: 1 },
      { kind: "signed_sent", signedAttempt: 2 },
    ]);
  });

  it("enters bypass after two verified rejections and stops signing", async () => {
    const fixture = await createHandshakeFixture();
    const { transport } = createTransport({
      handshake: fixture.respond,
      business: () =>
        Response.json({ code: 401, msg: "VERIFY_APIKEY_EXPIRED" }, { status: 401 }),
    });
    const execution = createExecution();
    const wrapped = execution.protectTransport({
      providerId: "coding-plan",
      providerConfig: signingPolicyProvider(),
      transport,
    });

    await wrapped(requestFor("req-bypass"));
    expect(execution.take("req-bypass")).toEqual([
      { kind: "signed_sent", signedAttempt: 1 },
      { kind: "verify_rejected", reason: "VERIFY_APIKEY_EXPIRED", signedAttempt: 1 },
      { kind: "signed_sent", signedAttempt: 2 },
      { kind: "verify_rejected", reason: "VERIFY_APIKEY_EXPIRED", signedAttempt: 2 },
      { kind: "bypass_entered" },
      { kind: "unsigned_sent", reason: "verify_refresh_exhausted" },
    ]);

    // 已进入 BYPASS：下一个请求不再握手、不再签名。
    await wrapped(requestFor("req-bypass-2"));
    expect(execution.take("req-bypass-2")).toEqual([
      { kind: "unsigned_sent", reason: "bypass" },
    ]);
  });

  it("sends unsigned when the handshake fails", async () => {
    const { transport } = createTransport({
      handshake: () => {
        throw new Error("connection reset");
      },
    });
    const execution = createExecution();
    const wrapped = execution.protectTransport({
      providerId: "coding-plan",
      providerConfig: signingPolicyProvider(),
      transport,
    });

    const response = await wrapped(requestFor("req-handshake"));
    expect(response.ok).toBe(true);
    const observations = execution.take("req-handshake");
    expect(observations).toEqual([
      {
        kind: "handshake_failed",
        errorKind: "handshake-network",
      },
      { kind: "unsigned_sent", reason: "handshake_failed" },
    ]);
  });

  it("sends unsigned without a session id or without a parsable credential", async () => {
    const execution = createExecution();
    const { transport } = createTransport({});
    const wrapped = execution.protectTransport({
      providerId: "coding-plan",
      providerConfig: signingPolicyProvider(),
      transport,
    });
    await wrapped(requestFor("req-no-session", null));
    expect(execution.take("req-no-session")).toEqual([
      { kind: "unsigned_sent", reason: "missing_session" },
    ]);

    const plainKeyExecution = createExecution();
    const plainKey = createTransport({});
    const plainWrapped = plainKeyExecution.protectTransport({
      providerId: "plain-key",
      providerConfig: signingPolicyProvider({ apiKey: "sk-plain-api-key" }),
      transport: plainKey.transport,
    });
    await plainWrapped(requestFor("req-plain-key"));
    expect(plainKeyExecution.take("req-plain-key")).toEqual([
      { kind: "unsigned_sent", reason: "invalid_credential" },
    ]);
  });

  it("sends unsigned when the request origin differs from the provider origin", async () => {
    const execution = createExecution();
    const { transport } = createTransport({});
    const wrapped = execution.protectTransport({
      providerId: "coding-plan",
      providerConfig: signingPolicyProvider(),
      transport,
    });
    await wrapped(new Request("https://other.example.test/v1/messages", { method: "POST" }));
    expect(transport).toHaveBeenCalledOnce();
    expect(wrapped).not.toBe(transport);
  });
});
