# Issue #50: surface z.ai login failure reason and re-login hint

## Status

Implemented on `patch/zai-login-failure-reason`, draft PR
https://github.com/bermudx/zcode/pull/55 (labels `enhancement`, `P2`,
matching the issue). No credentials, running cores, wrappers or installed
commands were touched; all tests use stubbed HTTP only.

## Problem (bermudx/zcode#50)

Failed `/api/auth/z/login` exchanges collapsed into a bare
`project_token_login_failed`: the resolver `.catch` discarded the response,
so logs could not distinguish an expired/revoked OAuth token from a server
change, and clients showed only a generic turn failure with no recovery
hint.

## Diff summary (5 files, +292/−12, commit bd1eb742)

- `apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts`
  - New `ZaiLoginFailureReason { httpStatus?, code?, msg? }` (exported,
    typed; no `any`) and `CodingPlanApiKeyError.loginFailure`.
  - New internal `ZaiBusinessLoginError` carrying the reason through the
    cache's shared `pending` so every concurrent waiter gets it.
  - Exchange callback pre-validates the envelope at the resolver boundary
    (`readZaiLoginRejection`): non-success `code` or missing token throws
    the typed error. Success-code set matches the cache contract
    (`[0, 200, "0", "200"]`); successful responses pass through to the
    cache for re-validation.
  - HTTP non-2xx for the login call now throws `ZaiBusinessLoginError`
    with `httpStatus` + envelope `code`/`msg` (`readZaiLoginEnvelope`);
    429/5xx still throw `ProjectAccessTokenTransientError` so the
    cached-JWT degrade is preserved.
  - The `.catch` emits the `observe` event with `httpStatus` / `zaiCode` /
    `zaiMessage` and rethrows `CodingPlanApiKeyError` with the reason.
  - Sanitisation: `code` coerced to a ≤64-char string, `msg` stripped of
    control characters and capped at 200 chars; tokens, Authorization
    headers, request bodies and raw response bodies are never stored on
    errors or logged.
- `apps/zcode-cli/packages/core/src/errors/error-payload.ts`
  - `projectExecutionErrorPayload` maps `project_token_login_failed` to
    `Z.AI login expired or was rejected (<code>: <msg>). Run: /login
    zai-coding-plan`; parentheses omitted when no reason is present.
  - This is the single client-facing projection consumed by the TUI
    (`formatEventError`) and the ACP lane (`acp-project.ts`) via the
    `TurnError` payload — no lane-specific wiring was touched (issue #49
    owns attach/ACP login wiring).
- `apps/zcode-cli/packages/adapters/tests/zai-business-token-refresh.test.ts`
  - 2xx `{code: 1002, msg: "login expired"}` rejection: error carries
    `{code, msg}`, observe event logs them, logged output does not contain
    the OAuth token.
  - HTTP 401 `{code: "401", msg: "unauthorized"}`: error and observe event
    carry `{httpStatus, code, msg}`; no token in logged calls.
- `apps/zcode-cli/packages/core/tests/turn-errors.test.ts`
  - Reason-bearing message asserts the exact
    `Z.AI login expired or was rejected (1002: login expired). Run: /login
    zai-coding-plan` text and that `detail` retains
    `project_token_login_failed`; no-reason case asserts the parenthesis-free
    fallback.
- `docs/model-provider-project-access-token.md`
  - Documents the structured login-failure contract and the field names on
    the observe event.

## Design note — cache file kept upstream-verbatim

An earlier variant put `ZaiBusinessLoginError` inside
`zai-business-token-cache.ts`. That file is `introduced`+`verbatim` in
`scripts/architecture/upstream-snapshot.json`; editing it revokes its
grandfathered admission and `architecture:check --changed` flags it as
`unmanaged-new-file` (the `zcode-cli` module is `managed: false`).
Keeping it verbatim avoids the violation and minimizes upstream-sync
conflicts, so all capture logic lives in `coding-plan-api-key.ts`
(`historical`, exempt). The trade-off is ~10 lines of duplicated envelope
validation (success-code set + token presence), noted in a Chinese comment
at the call site; the cache's `cacheUntil <= now` internal edge still
throws a plain `Error`, which reaches the client as the parenthesis-free
re-login hint.

## Verification (actual outputs)

- `pnpm architecture:check --changed`:
  `violations: 0, baseline: 0, new: 0` (base: merge-base origin/main)
- `turbo run build` (apps/zcode-cli): `26 successful, 26 total`;
  pre-existing WARNING `@zcode/browser-use-plugin#build` has no outputs.
- `turbo run typecheck` (apps/zcode-cli): `36 successful, 36 total`.
- Throwaway `tsc --noEmit` (tsconfig extending each package config with the
  touched test file included): adapters and core both exit 0, no output.
- `oxlint` on the 4 changed files: `Found 0 warnings and 0 errors`.
  Full-package run shows 138 warnings + 2 `max-lines` errors
  (`adapters/src/plugins/index.ts`, `adapters/src/fs/index.ts`) — verified
  identical on a stashed baseline tree; pre-existing, not introduced here.
- `pnpm --dir apps/zcode-cli lint` could not run: the runner does
  `node $npm_execpath exec oxlint`, and under mise, `npm_execpath` resolves
  to the standalone pnpm ELF binary (`SyntaxError: Invalid or unexpected
  token`). oxlint was therefore run directly on the changed files (above).
- `mise exec -- node apps/zcode-cli/scripts/fork-tests.mjs`
  (mode=selected, base 40eb330996), exit 0:

  ```
  ▶ @zcode/adapters [selected]   … 139 tests, 0 new, 0 known, 0 flaky (42s)
  ▶ @zcode/bootstrap [selected]  … 11 tests, 0 new, 0 known, 0 flaky (60s)
  ▶ @zcode/browser-use-plugin    … 0 tests (2s)
  ▶ @zcode/cli [package script]  … pass (+tests/attach-resume-target.test.ts)
  ▶ @zcode/core [selected]       … 3289 tests, 0 new, 0 known, 0 flaky (183s)
  ▶ @zcode/node-repl-host        … 0 tests (2s)
  ▶ @zcode/provider-regression   … 0 tests (7s)
  ▶ @zcode/adapters [always]     … 13 tests, 0 new, 0 known, 0 flaky (3s)
  ▶ @zcode/bootstrap [always]    … 4 tests, 0 new, 0 known, 0 flaky (1s)
  [fork-tests] 3456 vitest results — selected run, not a full-suite result.
  ```

  Targeted suites: adapters auth tests 97/97, core turn-errors 16/16.

## Unverified / limitations

- No live expired-token reproduction against `api.z.ai` — credentials are
  out of scope for this task; coverage is stubbed-HTTP regressions only.
- Envelope `code`/`msg` for the cache-internal `cacheUntil <= Date.now()`
  edge (success code but already-expired token) is not captured; the
  client still gets the re-login hint without the parenthesized reason.
- `pnpm --dir apps/zcode-cli lint` wrapper is broken under mise (see
  above); this is an environment/tooling limitation, not a skipped pass —
  oxlint itself was run on the changed files.
