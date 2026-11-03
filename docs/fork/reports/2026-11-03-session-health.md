# Session-health fixes — 2026-11-03

Implemented against `a27f62f4` in an isolated worktree, merged to `main` as
`9abdd086`, promoted in the `e37ed9d9` pair on 2026-11-03, and smoke-tested
through the installed wrapper in an isolated scratch workspace/data dir.
Not pushed. No model turn or operator live core was exercised.

## Fixes

- **Draft reads:** `session/subagents` returns an empty projection for a live,
  unpersisted session without creating a durable row. Runtime persistence state
  is authoritative, not the protocol publication policy. One reread handles
  first persistence completing during the initial lookup. Real missing durable
  parents and storage errors still fail.
- **No-plugin discovery:** trusted process policy reaches command discovery for
  startup, input expansion, snapshots, dedicated catalogs and workspace/V4
  presentation. Disabled plugins are gated before bundled asset root resolution,
  seeding and hashing. Ordinary workspace/user commands remain freshly scanned;
  enabled-plugin discovery is retained. No catalog cache was introduced.
- **Usage diagnostics:** only exact, allowlisted numeric usage counters bypass
  credential-key redaction. Values must be finite, nonnegative integers.
  Sensitive parents, strings, unknown names and credential fields stay redacted.
- Current main already includes upstream's model-selection deferral diagnostics.
  Its real-SQLite regressions were retained and extended, not replaced with eager
  persistence of empty drafts.

## Evidence

- New draft regressions failed before the fix: both immediate/deferred live
  sessions incorrectly returned `sessionUnavailable`. Both now pass.
- Logging regressions reproduced the redaction defect before the fix; the
  focused logging suite now passes.
- Branch-stage focused runs: **143 passed** across eight complete test files,
  plus **5 passed** selected cases across three larger files (**214
  unselected**). These include mandatory request-signing and socket-listener
  regressions, real SQLite pre-/post-first-prompt selection and subagent
  reads, the stale parent-read race, no-plugin snapshot/catalog/expansion
  behavior, catalog freshness/workspace isolation, and enabled/disabled
  plugin discovery.
- Promotion-stage verification on merged `main` (after restoring workspace
  dependencies with `pnpm install --frozen-lockfile`): root typecheck passed;
  CLI typecheck **36/36**; root lint **0 errors / 83 warnings**; CLI lint
  **0 errors / 74 warnings / 7 accepted**; architecture check against
  explicit base `a27f62f4`: **0 violations**. The broad `zcode-cli` module is
  unmanaged, so architecture is not proof of its internal boundaries.
- Full CLI-workspace test coverage was completed in package batches:
  adapters **2529**, bootstrap **3369** (0 new failures, 5 known failures,
  21 stale known entries now passing), contracts **342**, core **4681**,
  CLI package script **637/637 + 11/11**, dynamic-workflow **2034**,
  dynamic-workflow-runtime **100**, and all remaining packages passed with
  0 new failures. Total vitest results reported across the full batches:
  **13,420**, plus node:test package suites (CLI **637 + 11**, tui **256**,
  tui-pi **265**, plugin-creator **8**; CUA runs its SDK check). The first bootstrap pass also
  had one dynamic-workflow stack-trace failure that passed its solo rerun;
  the rerun after the config-scope fix had 0 new failures.
- Fresh pair built on final `main`: CLI graph **12/12**, `build:attach`, and
  root `@zcode/model-option-map`. Freshness greps found `isSessionPersisted`
  ×6, `noPlugins` ×16, `usageInputTokens` ×2, and `NUMERIC_USAGE_FIELDS` ×3
  in both `dist/zcode.cjs` and frozen `dist-runtime/zcode.cjs`.
- `promote-piz.sh` ran from clean `main` at `e37ed9d9`. Installed-pair smoke
  (real `piz`, pty, scratch workspace + isolated `ZCODE_DATA_BASE_DIR`):
  boot → double Ctrl-C → exit 0 and hint for
  `sess_3e4ef4d4-8432-4d2e-a1c6-bf3d84446505`; the printed
  `piz --resume` command run verbatim → exit 0 and the same id re-hinted.
  Scratch core was stopped through its own pid file after `/proc/<pid>/cwd`
  and socket-info workspace checks; operator cores/clients were untouched.
- Read-only independent review found no concrete regressions or blockers.
  `git diff --check` passed.

## Limits

No end-to-end snapshot timing was measured. The removed plugin work was inside
the historically slow build phase, but the earlier 1.2–1.4 second timings were
not causally attributed and no latency improvement is claimed.

Signing regression tests passed, but live signing, allowance eligibility,
account metering and memory behavior were not reverified. No model requests,
operator session activation, wrapper changes or live-core restarts occurred.

Focused evidence logs are under `/tmp/piz-health-*`; promotion test reports
are under `/tmp/piz-fork-tests-run-G4OzBX/`, `/tmp/piz-fork-tests-run-nZrJJQ/`,
`/tmp/piz-fork-tests-run-ZiYSKI/`, and `/tmp/piz-fork-tests-run-lKH06g/`.
Temporary logs are not durable artifacts.
