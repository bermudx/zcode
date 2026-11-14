# Issue #50 rework: keep z.ai login failure reason through runner wrappers (F1)

## Status

Verifier FAIL finding F1 on
https://github.com/bermudx/zcode/pull/55#issuecomment-6871823921 fixed on
`patch/zai-login-failure-reason`, code head `6ef89bd2` (report commit on
top). CI `check + build` green on the code head (run 43557825713). No
builds, tests, typecheck or lint were run locally; verification is CI-only
per the operator rule. No credentials, running cores, wrappers or
installed commands touched.

## F1 root cause (confirmed against source)

`projectZaiLoginFailureMessage` picked the **first** frame whose
`originalMessage === "project_token_login_failed"`. In the real turn path
the runner wraps the error twice, copying the same message but not the
structured reason:

1. `RuntimeHeadersRefreshError` (`adapters/src/model/runner-runtime-headers.ts:9`)
   does `super(cause.message, { cause })` — same message, `cause` kept.
2. `runner-stream.ts:753` copies `error.message` into the classification.
3. `toAdapterError` (`runner-retry.ts:159`) builds
   `new AiSdkModelAdapterError(code, "project_token_login_failed", { cause })`;
   `errors.ts:59` stores `cause`.
4. `createTurnFailureError` wraps once more as a `CoreError` with a
   `wrapper` payload role.

The first same-message frame is therefore the `AiSdkModelAdapterError`
wrapper, which has no `loginFailure`, so the client got the
parenthesis-free hint even though the reason existed deeper in the chain.

## Cause-chain walk needed no fix

`collectErrorPayloadFrames` (`core/src/errors/error-payload.ts:226`)
follows `cause ?? lastError ?? error` to depth 12 with a `WeakSet` cycle
guard. Both wrappers preserve `.cause`, so the inner
`CodingPlanApiKeyError` frame — the one carrying `loginFailure` — is
present in `frames`; only the frame *selection* was wrong. No walk change
was made.

## Diff (2 files, +34/−2, commit 6ef89bd2)

- `core/src/errors/error-payload.ts` — `projectZaiLoginFailureMessage`
  now prefers a same-message frame that carries `loginFailure`
  (`find(msg && loginFailure) ?? find(msg)`), with a Chinese F1 comment at
  the fix point.
- `core/tests/turn-errors.test.ts` — new regression builds the real
  chain: `CodingPlanApiKeyError`-shaped error with
  `loginFailure { code: "1002", msg: "login expired" }` → real
  `RuntimeHeadersRefreshError` → real `AiSdkModelAdapterError`
  (`ModelErrorCode.ModelRequestFailed`, message
  `project_token_login_failed`, `cause`) → `createTurnFailureError` →
  `projectExecutionErrorPayload`. Asserts the exact client message
  `Z.AI login expired or was rejected (1002: login expired). Run:
  /login zai-coding-plan` and that `detail` retains the internal code.
  Adapter classes are imported via the existing
  `../../adapters/src/...` convention already used by other core test
  files (e.g. `deferred-call-todo-runtime`, `bash-run-conformance`).

The test fails on `b1f5ed6d` (verified by code reading, not execution):
the unfixed `find` returns the adapter wrapper frame, `loginFailure` is
absent, and the projection emits the parenthesis-free hint the assertion
rejects.

## Verification (CI run 43557825713 on 6ef89bd2)

All steps `success`:

- Build (root shared surface, CLI turbo, model-option-map) ✓
- Typecheck (piz gate) ✓
- Lint (root) ✓ / Lint (CLI workspace) ✓
- Architecture check (changed) ✓ — no new violation from the test's
  adapter imports.
- Fork tests (selected, base origin/main): 3457 vitest results —
  `@zcode/core` 3290 tests (+1 = the new regression), adapters 139,
  bootstrap 11, cli package script pass; **0 new, 0 known, 0 flaky**.
- `Fork tests (full)` skipped — `if: github.ref == 'refs/heads/main' ||
  workflow_dispatch`, expected on a patch branch.
- `dist-runtime` assembled and artifact uploaded.

## Unverified / limitations

- No local execution of any check (hard rule); the claim that the new
  test fails on `b1f5ed6d` rests on reading the code path, not a run.
- No live turn against `api.z.ai`; the real wrapper classes are used but
  the upstream `CodingPlanApiKeyError` is shaped (same as the pre-existing
  test at line ~372, and as the brief specified).
- The wrapper frames' `retryable`/`context` fields still feed detail and
  attribution as before; only the visible message selection changed.
