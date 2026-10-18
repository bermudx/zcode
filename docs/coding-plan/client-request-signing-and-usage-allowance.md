# ZCode client request signing & the 150% usage allowance

Research notes — measured on this machine (g7), October 2026. Covers the
separate billing mechanisms on the Z.AI coding plan, the wire protocol that
distinguishes official-client traffic, and how delegated/headless traffic
(e.g. Goblin subagents) obtains the ZCode usage allowance.

Status of evidence: **observed** = reproduced on the wire or in the billing
ledger this session; **inferred** = consistent with observations but not
independently proven.

---

## 1. The four billing mechanisms — keep them separate

| # | Mechanism | Window | Surface | Status |
|---|-----------|--------|---------|--------|
| 1 | Idle-time tasks (ticketed queue) | 24/7 | `account:zai-offpeak-idle-plan`, ticket lifecycle via app-server | Working; zero billing footprint. **Explicitly out of scope.** |
| 2 | Off-peak 50% discount | Non-peak hours only | All endpoints, all clients | Documented + observed |
| 3 | **ZCode 150% usage allowance** | **24/7** | Signed requests on `*.z.ai` family endpoints | **Observed — the subject of this doc** |
| 4 | "Global Build" free-Flash event | 9:00–19:00 CST claim | Official client, GLM-5.3-Flash | **Not reproduced** — billed normally on the normal route |

Mechanism 2 (off-peak): docs.z.ai/devpack states usage is charged at 50% of
the standard credit rate during off-peak hours; peak = **Mon–Fri
14:00–18:00 SGT (UTC+8)**. Weekends are all-day off-peak.

Mechanism 3 (allowance): signed official-client traffic consumes quota at
~2/3 of what unsigned traffic consumes for identical work. Stacks with
mechanism 2. This is what the Discord/tweet "150% usage allowance" refers
to: the same token workload consumes ~2/3 as much allowance, i.e. you get
~1.5× the effective quota.

Mechanism 4 (Global Build Flash event): despite the announcement wording,
in-window Flash calls on the normal route billed normally in every test
(see §4). Treated as ended/narrower than advertised or gated elsewhere.

**Do not conflate these.** Idle-time tasks (#1) are excluded by operator
decision; everything below concerns #3 and its interaction with #2.

---

## 2. The wire path

Two endpoints were exercised on the same account/API key, same hour:

| Path | URL | Signing headers |
|------|-----|-----------------|
| Raw API | `https://api.z.ai/api/anthropic/v1/messages` | none needed — works with plan key alone |
| ZCode gateway | `https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages` | attestation family (below) |

`GET https://zcode.z.ai/api/v1/agent/configs` returns the remote client
config: `codingPlanSignature.enable: true` plus a `proxyEndpoint.mapping`
list that rewrites standard API URLs onto the ZCode gateway. The config
exposes **no** promo/allowance flag — the allowance is purely server-side
billing policy applied to verified-signed traffic.

Signed model requests carry this header family (captured via mitmproxy on
an official `-p` call):

```
X-App-Id: zcode
X-Client-Ts: <unix ms>
X-Client-Version: <client version>
X-Client-Nonce: <32 hex>
X-Client-Sig: <base64 Ed25519 signature>
X-Client-Pow: <hashcash token>
X-Session-Id: <sess_…>
X-Device-Mid: <machine id from ~/.zcode/v2/telemetry-state.json>
X-Release-Channel: production
X-Platform / X-Os-Category / X-Os-Version / X-Client-Language / X-Client-Timezone
User-Agent: ZCode/<version>
```

---

## 3. The client signing protocol (reverse-engineered from `zcode.cjs`)

The official bundle contains `ClientRequestSigningV4Signer` +
`OfficialRequestSecurity` (the transport wrapper). **No secret is compiled
into the binary** — the signing private key is issued by the server via an
authenticated handshake. All crypto is standard WebCrypto.

### 3.1 Credential parsing (`parseClientSigningCredential`)

The provider API key is reinterpreted as a signing credential:

| Form | apiKeyId | secret | handshakeField |
|------|----------|--------|----------------|
| JWT (`h.p.s`) — header `{alg:"HS256",typ:"JWT",sign_type:"SIGN"}`, payload `{token_use:"project_access",api_key}` | `api_key` claim | whole JWT | `accessToken` |
| `id.secret` (single dot) | left part | right part | `apiKey` |

### 3.2 Signing handshake (once per apiKey + origin, cached in-process)

```
POST {providerOrigin}/api/paas/c1f3a7e2/v2/client     (HTTPS required, 10s timeout)
Authorization: <credential>
Content-Type: application/json

{ "<handshakeField>": "<credential>", "nonce": "<32hex>", "ts": "<ms>",
  "sig": "<base64>" }

sig = base64( HMAC-SHA256(
        key = HKDF(secret, salt="WD_CLIENT_SIGN_KDF_SALT",
                   info="getSignKey_hmac", bits=256),
        msg = "get_sign_key\n{apiKeyId}\n{ts}\n{nonce}" ) )
```

Response `{code:200, data:{privateCipher}}`:

```
privateKey = Ed25519 pkcs8 key, recovered by:
  cipherBytes = base64decode(privateCipher)
  plain = AES-256-GCM-decrypt(
            key = HKDF(secret, salt="WD_CLIENT_SIGN_KDF_SALT",
                       info="ed25519_priv", bits=256),
            iv  = cipherBytes[0:12], aad = apiKeyId, tag = last 16 bytes)
  privateKey = importKey("pkcs8", base64decode(utf8(plain)), "Ed25519")
```

Business-code errors map to `HANDSHAKE_*` reasons. Handshake failures are
**fail-open** (`failOpenEligible`) — the client sends unsigned rather than
erroring.

### 3.3 Per-request signing

Requires `X-Session-Id` on the request (absent → throws; the field also
appears in the signed payload and PoW).

```
ts    = Date.now()  (ms, decimal string)
nonce = randomHex(16 bytes)          → 32 hex chars

pow:  n = hex(SHA-256("{apiKeyId}\n{appId}\n{sessionId}\n{ts}"))[0:32]
      o = randomHex(12 bytes)
      for i in 0..2^32-1:
          candidate = o + i.toString(16).padStart(8,"0")   → 32 hex chars
          if SHA-256("{n}\n{candidate}") has ≥ 8 leading zero bits:
              pow = candidate; break
      (8 bits ≈ 256 hashes average — trivially cheap, pure rate-limit)

sig = base64( Ed25519-sign(privateKey,
        "{apiKeyId}\n{ts}\n{clientVersion}\n{sessionId}\n{nonce}") )
```

Headers written (after stripping any stale `X-Client-*`/`X-App-Id`/
`X-Client-Sign-Verified`):

```
X-Client-Ts, X-Client-Version, X-Client-Sig, X-Session-Id,
X-Client-Nonce, X-App-Id: zcode, X-Client-Pow
```

### 3.4 Signing policy (`OfficialRequestSecurity.protectTransport`)

A provider's transport is wrapped with signing iff:

- access type `zhipu-coding-plan-api-key`, **or**
- access type `zhipu-account` with mode `individual-coding-plan` or
  `team-coding-plan`, **or**
- the provider `baseURL` hostname is inside a known family domain —
  `*.z.ai` or `*.bigmodel.cn`, **or**
- hostname ∈ {`api.chatglm.site`, `zcode.chatglm.site`}.

Explicitly **unsigned**: `zhipu-account` modes `start-plan`, `off-peak`,
`highspeed` — the idle-time queue rides unsigned by design.

`clientVersion` = provider's `X-ZCode-App-Version` header, else
`__ZCODE_VERSION__` build constant.

### 3.5 Refresh & failure handling

- `401` with `VERIFY_SIGNATURE_INVALID`, `VERIFY_APIKEY_EXPIRED`, or
  business code `3007` → invalidate cached key, re-handshake, replay the
  buffered request (`makeReplayableSigningRequest` buffers the body).
- Observations logged: `signed_sent`, `unsigned_sent` (reason:
  `origin_mismatch` | `bypass` | `handshake_failed` | `access_mode`),
  `verify_rejected`, `bypass_entered`, `request_failed_closed`.
- The handshake path segment `c1f3a7e2` looks like a scheme identifier —
  the protocol is designed for server-driven rotation (clients re-handshake
  transparently on 401).

---

## 4. Measured evidence (all on account Pro, Sun Oct 18 2026 = all-day off-peak)

Standard-rate formula (docs.z.ai/devpack, GLM-5.3-Flash):
`credits = (input_tokens × 2.3 + cache_read_tokens × 0.56 + output_tokens × 8) / 10 000`.
`input_tokens` in usage events **includes** cache-read tokens — do not
double-count.

### 4.1 Three-arm A/B/C — same account, same hour

Quota counter `/api/monitor/usage/quota/limit` sampled every 30–45s; deltas
attributed by timestamp against a verified-flat baseline.

| Arm | Headers | Usage | Std credits | Counter delta | Effective rate |
|-----|---------|-------|-------------|---------------|----------------|
| Raw `api.z.ai`, unsigned | none | 43 815 in + 30 out | 10.10 | **+5** | ~50% → off-peak only |
| `zcode.z.ai` gateway, unsigned | none | 47 416 in + 30 out | 10.93 | **+6** | ~55% → off-peak only |
| `zcode.z.ai` via official `zcode -p` | full attestation | 35 581 in (incl. 9 856 cache-read) + 263 out | 6.68 | **+2** | ~30% → off-peak × allowance |

Reading: hitting the gateway endpoint alone grants **nothing**; the signed
headers are what trigger the allowance. Expected deltas at off-peak-only
vs off-peak×⅔: raw arm 5.05/3.37, gateway-unsigned arm 5.46/3.65, signed
arm 3.34/2.23 — observed +5/+6/+2 lands on the right side each time
(integer counter, ±1 noise; direction consistent).

Corroboration, same-hour billing bucket (`credit-usage/usage-detail`):
17 local calls, 65.20 cr at standard rate → **26.59 cr billed** (~41%,
mix of signed and unsigned traffic).

### 4.2 Historical mass data

- **Oct 14**: local `model_usage` shows 2 843 `account:zai-individual-coding-plan`
  `GLM-5.3-Flash` calls during the claimed free window (~364 M tokens).
  Billing ledger for the same window: **~10 100 cr / ~330 M tokens** —
  the free-Flash event (#4) did not apply on the normal route.
- **Oct 17 matched pair**: one `-p` Flash call (26.7k tok) ↔ its hourly
  bucket at 0.7 cr / 17k — single-call attribution, billed.

---

## 5. `zcode.cjs` — the official CLI bundle

| Fact | Value |
|------|-------|
| File | `~/.local/share/zcode-cli-3.14.5/zcode.cjs` (15 MB, minified but readable CJS) |
| Provenance | `apps/zcode-cli/packages/cli/dist/zcode.cjs` per `.node-bundle-meta.json` (`runtime: electron-node`) — same artifact the AppImage spawns |
| Wrapper | `~/.local/bin/zcode` = `exec node zcode.cjs "$@"` — pure Node, no Electron/X |
| Versions | bundle extracted from app 3.14.5; CLI self-reports `0.16.9`; running AppImage observed at 3.15.3 |
| Sidecars | `packages/` (first-party plugins: browser-use, pdf, presentations, simulators, skills), `provider/zcode-builtin.json`, `default.json` |
| Modes | TUI (default) · `-p` headless print · **`app-server`** (NDJSON stdio protocol) · `login`/`logout` · `plugins` · `skills` · `doctor` · `commands` |
| Headless flags | `-p`, `--attach`, `--cwd`, `--mode build/edit/plan/yolo`, `--surface terminal|desktop`, `--workflow-mode`, `--resume`, `-c`, `--json`, `--disallowed-tools` |

Local state it consumes/creates:

- `~/.zcode/v2/credentials.json` — `enc:v1:{iv}.{tag}.{ct}` (base64url)
  AES-256-GCM values; local key =
  `sha256("zcode-credential-fallback:{platform}:{home}:{username}")`.
  **Never print decrypted values — in-process use only.**
- `~/.zcode/cli/db/db.sqlite` — `model_usage` ledger (provider, model,
  tokens incl. cache-read, session id, timestamps; no credits column).
- `~/.zcode/v2/telemetry-state.json` — `deviceMid` → `X-Device-Mid`.
- `~/.zcode/v2/runtime/provider/<arch>/0.0.0-dev/endpoint-*/zcode-builtin.json` —
  resolved builtin provider catalog.

---

## 6. How to get the 150% allowance

The server grants the allowance to **cryptographically signed requests on
`*.z.ai` family endpoints**. Nothing else — not the endpoint alone, not
the plan key, not an AppImage process — was observed to trigger it.

### Path A — spawn the official bundle (proven on the wire)

Zero porting risk; byte-identical to AppImage traffic at the billing layer.

- One-shot: `zcode -p "<prompt>" --mode yolo --json`
- Delegation seam: `node zcode.cjs app-server` — NDJSON stdio protocol.
  Drive startup/storage messages, send provider config
  (`account:zai-individual-coding-plan` + model), create session
  (yields `sess_…` id → `X-Session-Id`), answer provider-runtime header
  requests, send turns.
- Requires the local credential state (`~/.zcode/v2/credentials.json`,
  provider catalog) — produced by any prior `zcode login` or AppImage run.
- **This is the recommended Goblin delegate path.** Working probe:
  `~/build/testing/subagents/zcode-quota-probe/` (`offpeak-probe.mjs`
  for protocol shape, `quota-monitor.mjs` for counter sampling).

### Path B — reimplement the signer (algorithm portable, acceptance unverified)

The whole protocol is ~150 lines of WebCrypto; the only secret is the
user's plan API key (server issues the Ed25519 key to any holder via the
handshake). Nothing cryptographically binds signing to the official binary.

```text
privKey  = handshake(apiKey)                      // §3.2, cache per key+origin
headers += X-App-Id: zcode
headers += X-Session-Id: <sess id>
headers += X-Client-Ts / X-Client-Version / X-Client-Nonce
headers += X-Client-Sig  (Ed25519 canonical string, §3.3)
headers += X-Client-Pow  (8-bit hashcash, §3.3)
POST to the same gateway URL
```

Caveats: must mint session ids; must handle `VERIFY_*` 401s by
re-handshaking + replaying; scheme can rotate server-side (the
`c1f3a7e2` path segment) — a port breaks until re-ported while the
official bundle self-heals. Validate with the §4 counter A/B before
trusting the rate.

### What does NOT get the allowance

- Unsigned calls — to `api.z.ai` *or* to the `zcode.z.ai` gateway itself
  (200 OK, plain off-peak rate — the endpoint is not gated, the sig is).
- Forged/garbage sig headers (server verifies Ed25519; `VERIFY_SIGNATURE_INVALID`).
- OSS ZCode as shipped — emits no `X-Client-*` signing family; its own
  wire test asserts `x-device-mid` absent
  (`apps/zcode-cli/packages/bootstrap/tests/model-default-headers-wire.test.ts`).

### Effective rate (standard = 1.0)

| Client | Peak hrs | Off-peak hrs |
|--------|----------|--------------|
| Unsigned | 1.0 | 0.5 |
| Signed ZCode path | **~0.67** | **~0.33** |

(Allowance = consume ~2/3 → ~1.5× effective quota; off-peak stacks.)

---

## 7. Risks & unknowns

- **Integer-counter noise**: quota counter is whole credits; single-call
  attribution needs ~5+ std-credit calls or a flat baseline. Ledger lags
  ~40 min.
- **Cache pricing**: `input_tokens` in usage already includes cache-read
  tokens; bill formula splits them (2.3 vs 0.56 per token).
- **Scheme rotation**: `c1f3a7e2` segment suggests versioned signing;
  clients re-handshake on 401. Path B ports carry maintenance risk.
- **Version drift**: extracted bundle is app 3.14.5 / CLI 0.16.9; the
  running AppImage observed newer (3.15.3). Re-extract on upgrade.
- **Enforcement surface is policy, not crypto**: TLS/HTTP2 fingerprints,
  telemetry/behavioral analysis, and ToS are the real differentiators
  between official and reimplemented clients — see design intent
  discussion in §3 (fail-open signing + PoW reads as abuse/rate
  resistance, not binary attestation). Path A eliminates this risk.
- **Concurrent usage contaminates buckets**: foreign (AppImage) traffic
  shares the same hourly bucket and counter; tests need flat windows.
- **Free-Flash event (#4)** remains unexplained — billed in every
  in-window normal-route test.

## 8. Artifacts

| Artifact | Location |
|----------|----------|
| Probe workspace | `~/build/testing/subagents/zcode-quota-probe/` (RUNBOOK.md, offpeak-probe.mjs, usage-probe.mjs, billing-probe.mjs, quota-monitor.mjs, provider_config.json) |
| Official bundle | `~/.local/share/zcode-cli-3.14.5/` |
| Wrapper | `~/.local/bin/zcode` |
| Usage ledger | `~/.zcode/cli/db/db.sqlite` → `model_usage` |
| Monitor APIs | `zcode.z.ai/api/monitor/usage/quota/limit` · `credit-usage/usage-detail` · `credit-usage/activity` · `/api/v1/agent/configs` |
| Signing impl | `zcode.cjs` ~offset 3 783 000 (`ClientRequestSigningV4Signer`, `OfficialRequestSecurity`) |
| OSS wire-test proof (no sig headers) | `apps/zcode-cli/packages/bootstrap/tests/model-default-headers-wire.test.ts` |
