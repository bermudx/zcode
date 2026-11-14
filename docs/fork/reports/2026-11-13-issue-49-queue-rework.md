# Issue #49 PR #57 — auth/loginComplete serial-queue rework

PR: https://github.com/bermudx/zcode/pull/57 (`patch/thin-client-login`)
Finding: verifier FAIL on `29412e11` —
https://github.com/bermudx/zcode/pull/57#issuecomment-6871897979 (P2, proven).
Verification run: pending — updated after CI on the new head.

## Finding

`auth/loginComplete` polls OAuth for up to `DEFAULT_LOGIN_TIMEOUT_MS` (5 min)
inside the per-connection serial request queue in the protocol transport.
Every later ordinary request on the same connection (`session/create`,
`session/prompt`, catalog fetches) waited behind it. ACP/TUI cancel is
client-side only (`AbortController`), so an orphaned core poll kept the queue
blocked and the next prompt on the lane hung for up to ~5 min.

## Fix

Three parts, matching the accepted plan.

### 1. Concurrent bypass set (transport)

`AUTH_FLOW_CONCURRENT_METHODS` in
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts` admits
`auth/loginStart`, `auth/loginComplete`, and `auth/loginCancel` immediately,
following the existing `SESSION_LIFECYCLE_CONCURRENT_METHODS` pattern — no
serial-queue wait, no `lastQueuedMessageStarted` wait.

Ordering safety, confirmed by reading the handlers
(`zcode-protocol/auth-login.ts`): the only state shared between auth requests
is the `pendingFlows` map, keyed by `flowId` and self-contained per flow. Auth
handlers never read session state, and session methods never touch
`pendingFlows`, so concurrent admission needs no ordering against `session/*`.

### 2. `auth/loginCancel` protocol method

- Schemas `zcodeAuthLoginCancelParamsSchema` / `...ResultSchema` and method
  constant `authLoginCancel: "auth/loginCancel"` added in the single shared
  contract `packages/shared/src/zcode-protocol/index.ts` (only one physical
  `@zcode/shared` exists; `apps/zcode-cli` resolves the same package).
- `PendingOAuthFlow` now carries an `AbortController`. A new `flowSignal`
  helper merges it with `context.getClientDetachSignal?.()` via
  `AbortSignal.any`, so a flow aborts on client detach or on explicit cancel.
- `loginCancel {flowId}` aborts the controller with
  `Error("Login cancelled.")` and deletes the flow. The abort reason becomes
  the in-flight `loginComplete` result text via `waitWithAbort`/`throwIfAborted`
  → `{ok: false, error: "Login cancelled."}`. Unknown/finished flowIds also
  return `{ok: true}` — cancel is idempotent by target state.
- Dispatch wired in `server.ts` (import + `case`).

### 3. Thin client (`attach-auth.ts`)

`loginViaAttachProtocol` registers an abort listener right after `loginStart`
returns: on abort it fires `auth/loginCancel {flowId}` best-effort
(`void request(...).catch(() => {})`) and rejects locally as before. The
listener is removed in `finally`, so a late abort after a completed login does
not emit a meaningless cancel. An abort during the in-flight `loginStart`
itself still cannot be cancelled (no `flowId` yet); that flow expires lazily
at `expires_at` — bounded, unchanged.

### Spec

`apps/zcode-cli/docs/design/v2/auth-login.md` updated: five-method surface,
`loginCancel` semantics, and the queue-bypass rationale.

## Tests added (CI runs them)

- (a) `transport.test.ts`: a pending `auth/loginComplete` does not delay a
  following `session/create` on the same connection — asserted via handler
  order `[login:start, create:start, login:done]`. Deterministic (no timers);
  on `29412e11` the order is `[login:start, login:done, create:start]`, so it
  fails there as required.
- (b) `zcode-protocol-auth-login.test.ts`: `loginCancel` aborts an in-flight
  `loginComplete` (poll never resolves) → `{ok:false, "Login cancelled."}`;
  retry on the same `flowId` hits the unknown-flow branch, proving removal.
- (c) `attach-auth-login.test.ts`: abort after `loginStart` sends
  `auth/loginCancel {flowId}` while still rejecting locally.
- (d) `zcodeProtocolAuth.test.ts`: `loginCancel` schema round-trip + method
  constant; method-count test updated four → five.

## Files changed

- `packages/shared/src/zcode-protocol/index.ts` — cancel schemas + method.
- `packages/shared/test/zcodeProtocolAuth.test.ts` — (d).
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts` —
  bypass set.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.test.ts` —
  (a).
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/auth-login.ts` —
  per-flow AbortController, `flowSignal`, `loginCancel`, export.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` — dispatch.
- `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol-auth-login.test.ts`
  — (b).
- `apps/zcode-cli/packages/cli/src/attach/attach-auth.ts` — cancel on abort.
- `apps/zcode-cli/packages/cli/tests/attach-auth-login.test.ts` — (c).
- `apps/zcode-cli/docs/design/v2/auth-login.md` — spec.

No local builds/tests run (fork rule: CI-only). Verification = `ci` workflow
on the pushed head.
