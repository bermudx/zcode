# Issue #49 — thin-client login (`/login` from attach TUI and ACP)

Date: 2026-11-13
Branch: `patch/thin-client-login` (base `40eb3309`)
Issue: bermudx/zcode#49 — `/login` must work from terminal `piz` (attach TUI)
and T3 (ACP lane), running login **in the shared core** through new protocol
methods. The thin client stays free of bootstrap/adapters/core/provider
imports.
Discovery: `docs/fork/reports/2026-11-13-issue-49-login-discovery.md`
(in sibling worktree `t3-8d2b88d1`).
Spec: `apps/zcode-cli/docs/design/v2/auth-login.md` — new section
“Attach Thin-Client Login (`auth/*` protocol)”.
Status: implemented; verification matrix below.

## Design

```
attach TUI / ACP ── auth/loginStart {provider} ──▶ shared core
        │                                          │
        │◀── {flowId, authorizeUrl, expiresAt, ────┤  OAuth init only;
        │       pollIntervalSec}                   │  flow state + pollToken
        ▼                                          │  stay in core process
  client opens browser (open / cmd start /
  xdg-open, detached, stdio ignore, best-effort)
  AND always shows the URL to the user
        │
        └── auth/loginComplete {flowId} ──────────▶ core polls → ready/timeout
                                                     persists credentials +
                                                     provider_config exactly
                                                     like `zcode login`
        ◀── {ok:true, provider, model, paths, user} | {ok:false, error}
```

- `auth/configureApiKey {provider, apiKey}` reuses `configureCodingPlanApiKey`.
- `auth/logout {provider?}` reuses `logoutZCodeCli` (clears all Coding Plan
  accounts; the provider field is reserved for future per-provider logout).
- Login failures return `{ok:false,error}` **in the result body**, not as
  protocol errors — the client must render readable text plus the standalone
  fallback `Or run: zcode login zai` (issue ask #4).
- Registry refresh is free: writes happen inside the core process, and
  `SharedZCodeCredentialStore.onDidChange` listeners are keyed by file path in
  a module-level map — a write through any store instance notifies the
  standalone account source + provider registry subscription created by
  `startProcessProviderRegistryRuntime`. No core restart needed.
- apiKey / OAuth token / pollToken never appear in results or logs; core logs
  only method, provider, outcome.

## Changes

### Protocol — `packages/shared/src/zcode-protocol/index.ts`

- `zcodeAuthCodingPlanProviderSchema` (`"zai" | "bigmodel"`).
- `zcodeAuthLoginStart{Params,Result}Schema` — params `{provider}`; result
  `{authorizeUrl, expiresAt, flowId, pollIntervalSec}`.
- `zcodeAuthLoginComplete{Params,Result}Schema` — params `{flowId}`; result is
  a discriminated union on `ok` (success carries provider/model/configPath/
  credentialsPath/user; failure carries `error`).
- `zcodeAuthConfigureApiKey{Params,Result}Schema` — same union shape.
- `zcodeAuthLogout{Params,Result}Schema` — result `{ok:true, credentialsPath}`.
- Method table entries `authLoginStart` / `authLoginComplete` /
  `authConfigureApiKey` / `authLogout`. All schemas `.strict()`; results carry
  no secrets.
- `zcodeProtocolSessionMethodContracts` untouched — it is a `Partial<>` minimal
  set for legacy session methods; process-level methods like
  `provider/refreshRegistry` are not registered there either.

### Core — `apps/zcode-cli/packages/bootstrap`

- `src/auth-login.ts`: `loginZCodeCli` split into
  `startCliOAuthLoginFlow` (OAuth init → `CliOAuthLoginFlow {initData,
  oauthClient, pollToken, providerId}`) and `completeCliOAuthLoginFlow` (poll →
  persist → model/config/user). `loginZCodeCli` remains as a wrapper preserving
  standalone `zcode login` behaviour exactly (deadline math, browser open,
  onAuthorizeUrl/onBrowserOpen hooks unchanged).
- `src/zcode-protocol/auth-login.ts` (new): `createProtocolAuthLoginHandlers`
  keeps `flowId → {env, flow}` pending map; `loginStart` returns URL metadata,
  `loginComplete`/`configureApiKey`/`logout` write credentials+config and
  return redacted results. Failure → `{ok:false,error}`; abort propagates.
  Params validated via `parseParams`.
- `src/zcode-protocol/server.ts`: four dispatch cases.

### Thin client — `apps/zcode-cli/packages/cli`

- `src/attach/attach-auth.ts` (new): protocol-only helpers — no
  bootstrap/adapters/core/provider imports (hard boundary).
  - `openThinAuthUrl`: `open` / `cmd.exe /c start` / `xdg-open`, `detached` +
    `stdio:"ignore"` + `windowsHide`, success = spawn event or 1s settle
    timeout; failure returns `{opened:false, reason}` and never blocks login.
  - `loginViaAttachProtocol`: start → `onAuthorizeUrl` (URL always surfaced
    first) → open browser → complete; `ok:false` throws the error text;
    `withAbort` takes a thunk so a pre-aborted signal never issues a wire call.
  - `createAttachAuthDeps`: the four `CommandCenterDeps` fields
    (`login`, `loginBigmodel`, `configureApiKey`, `logout`) in one factory.
- `src/attach/attach-tui-options.ts`: `CreateAttachHandlerOptions.openBrowser`
  test seam; `createCommandCenter` receives `createAttachAuthDeps({request,
  openBrowser})`. `/login` no longer reports “not available in this client”.
- `src/command-center/login-flow.ts`: `loginFailureResponse` +
  `MONOLITH_LOGIN_FALLBACK_HINT` shared by both lanes.
- `src/command-center/create.ts`: all four auth branches wrapped —
  non-abort failures become `loginFailureResponse` (ends with
  `Or run: zcode login zai`); abort rethrows as cancellation.
- `src/acp/acp-sessions.ts`: `AcpCorePort.coreRequest(sessionId, method,
  params?)` — process-level protocol ops routed through the session's
  workspace lane (`lane.runtime.currentClient().request`), follows reconnects.
- `src/acp/acp-commands.ts`: `parseLocalSlashCommand` accepts `login`/`logout`;
  `runLoginCommand` (OAuth + both api-key variants, URL sent as
  `agent_message_chunk`, apiKey never echoed) and `runLogoutCommand`;
  catalog advertises both commands; reserved-name list updated.
- `src/acp/acp-agent.ts`: `AcpAgentOptions.openBrowser` seam; login/logout
  dispatched inside the local-command branch — never reach `submitPrompt`.

### Tests

- `packages/shared/test/zcodeProtocolAuth.test.ts` (new, 5 tests):
  schema round-trips, strictness, secret-free result shapes, method table.
  Registered in `scripts/engineering-test-files.json`.
- `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol-auth-login.test.ts`
  (new, 6 tests): loginStart/complete with stubbed OAuth HTTP client;
  failure-in-result-body; unknown flowId; apiKey never logged (asserts
  serialized log entries contain neither the key nor the project token);
  **live registry refresh** — `startProcessProviderRegistryRuntime` +
  real credential store in a `mkdtemp` data dir: provider absent before
  login, present after complete, absent after logout, present after
  configureApiKey — all without restart.
- `apps/zcode-cli/packages/cli/tests/attach-auth-login.test.ts` (new, 9
  tests): wire shape of all helpers; abort-before-request; platform browser
  command selection + spawn failure; **end-to-end TUI `/login` against a fake
  core over a real socket** — protocol sequence `auth/loginStart` →
  `auth/loginComplete`, URL surfaced via `assistant_message` event, browser
  opened client-side, “not available in this client” gone; bigmodel +
  api-key variants; `/logout`; failure reply ends with `zcode login zai`.
  Registered in the cli package test script.
- `tests/acp-commands.test.ts` / `tests/acp-agent.test.ts` (extended):
  parser routes login/logout locally; usage/unknown-arg text; api-key wire
  shape (key in params only, never in visible text); `/login` end-to-end in
  the ACP agent against a fake core — intercepted locally, URL + result
  chunks emitted, `submitPrompt` never called; `/logout`; failure chunk ends
  with `zcode login zai`; advertised-command lists updated for the two new
  local commands.
- `tests/zcode-protocol-auth-login.test.ts` uses a disposable
  `ZCODE_DATA_BASE_DIR` (`mkdtemp`), real `ZCODE_CREDENTIAL_SECRET` fixture —
  no real z.ai login, no credential reads.

## Architecture

- New bootstrap file registered as an `app-server-attach` module root in
  `architecture-policy.yaml` (same file-granularity precedent as
  `socket-listener.ts`); `cli/src/attach` and `cli/src/acp` are already
  covered roots — `attach-auth.ts` needed no new registration.
- `attach-tui-options.ts` was pushed to 820 lines by the dep wiring; the auth
  deps moved into `createAttachAuthDeps` in `attach-auth.ts` → 789 lines,
  back under the 800-line rule.
- `architecture:check --changed`: **OK** (0 new violations, 1 pre-existing
  baseline).

## Verification

| Check | Result |
|---|---|
| `vitest run --project engineering packages/shared/test/zcodeProtocolAuth.test.ts` | 5/5 pass |
| bootstrap `vitest run tests/zcode-protocol-auth-login.test.ts` | 6/6 pass |
| cli `node --test tests/attach-auth-login.test.ts` | 9/9 pass |
| cli `node --test tests/acp-commands.test.ts tests/acp-agent.test.ts` | 77/77 pass |
| throwaway `tsc --noEmit` over both new test files (tests/ not covered by tsconfig) | clean |
| `pnpm lint` (root) | 0 errors, 84 warnings (pre-existing) |
| `node scripts/run-cli-lint.mjs` (via `npm_execpath=<pnpm.cjs>` per CI recipe) | 0 errors, 74 warnings (pre-existing) |
| `pnpm --dir apps/zcode-cli` typecheck equivalent (`tsc --noEmit` in bootstrap + cli) | new files clean; `saved-workflows*.ts` (bootstrap) and `acp-project.ts` (cli) errors reproduce identically at base `40eb3309` — pre-existing, unrelated |
| `pnpm architecture:check --changed` | OK — 0 new violations |
| `mise exec -- node apps/zcode-cli/scripts/fork-tests.mjs` | PENDING — see below |
| `node scripts/build.mjs --client-only` (zcode-attach) | builds clean |

### Baseline noise (not caused by this change)

- `@zcode/contracts` zod-type errors and bootstrap `saved-workflows*`/
  `product-projection`/`projection-rows`/`interaction-broker`/
  `workspace-hook-trust` typecheck errors reproduce on a clean checkout of
  `40eb3309` — recorded, not hidden.
- CLI `protocol-lifecycle.ts`/`acp-project.ts` typecheck errors likewise
  reproduce at baseline.

### Bundle size — `dist/zcode-attach.cjs`

- before (`40eb3309`, built in a temp worktree with linked node_modules):
  **2,361,332 B**
- after (this branch): **2,356,925 B** (−4,407 B, −0.19 %)
- Bundle contains `auth/loginStart` + the thin browser-open code
  (`xdg-open`/`cmd.exe` strings present); `bootstrap`/`adapters`/`core` source
  absent except a pre-existing doc-comment string — thin-client boundary
  verified at bundle level.

### Commands that could not run as written

- `pnpm --dir apps/zcode-cli build` → `turbo: command not found` (CI documents
  the gap: turbo's bin lives only in root `node_modules/.bin`; the equivalent
  `cd apps/zcode-cli && mise exec -- ../../node_modules/.bin/turbo run build`
  reaches the pre-existing `@zcode/contracts` baseline failures above).
- `pnpm --dir apps/zcode-cli typecheck` — same turbo dependency chain;
  per-package `tsc --noEmit` was run instead and reported above.
- `pnpm exec vitest|tsx` inside nested packages initially failed because a
  prior partial `pnpm install` inside `apps/zcode-cli` left dangling
  `node_modules/.bin` symlinks; the stale dir was removed and the documented
  root `pnpm install --frozen-lockfile` reprovisioned it (root workspace
  covers `apps/zcode-cli/packages/*`). All tool invocations then ran through
  pinned `mise exec --`.

## Constraints honored

- `adapters/src/auth/coding-plan-api-key.ts` untouched (issue #50 owner).
- No real z.ai login, no credential reads, no `promote-piz.sh`, no core
  restart, no live T3 checks. Runtime tests use disposable
  `ZCODE_DATA_BASE_DIR` directories.

## PR

PENDING — draft PR closes #49, labels `bug`/`P1`/`attach`.
