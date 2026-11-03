# Session-health fixes — 2026-11-03

Implemented against `a27f62f4` in an isolated worktree. Not built, merged,
promoted, pushed, or exercised against a live core.

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
- Final focused runs: **143 passed** across eight complete test files, plus
  **5 passed** selected cases across three larger files (**214 unselected**).
  These include mandatory request-signing and socket-listener regressions,
  real SQLite pre-/post-first-prompt selection and subagent reads, the stale
  parent-read race, no-plugin snapshot/catalog/expansion behavior, catalog
  freshness/workspace isolation, and enabled/disabled plugin discovery.
- Selected runner: adapters completed **137 tests, no failures**. Bootstrap's
  first pass reported **824 passed, 237 failed, 8 skipped**; the overall runner
  hit the 600-second limit during isolated retries. **Not a passing run.**
  Failures include missing runtime exports from copied older dependency builds
  and recorded bundled-plugin fixture failures. The project-plugin-refresh
  assertion was separately reproduced against original `a27f62f4` source with
  the same artifacts; not every broad failure was individually baseline-checked.
- Standard package typechecks are **blocked**, not passed: adapters reported
  17 diagnostics and bootstrap 115 against the copied dependency declarations.
  A no-emit compiler-host comparison substituting original `a27f62f4` source
  reported the same counts and **zero new diagnostics**. This comparison does
  not substitute for matched-artifact CI typechecks.
- Touched-file CLI lint exited 0 with warnings. Architecture check used explicit
  base `a27f62f4` and reported zero violations; the broad `zcode-cli` module is
  unmanaged, so this is not proof of its internal boundaries.
- Read-only independent review found no concrete regressions or blockers.
  `git diff --check` passed.

## Limits

No end-to-end snapshot timing was measured. The removed plugin work was inside
the historically slow build phase, but the earlier 1.2–1.4 second timings were
not causally attributed and no latency improvement is claimed.

No build or installed-pair acceptance was performed; compilation/builds remain
for CI. Signing regression tests passed, but live signing, allowance eligibility,
account metering and memory behavior were not reverified. No model requests,
operator session activation, wrapper changes or live-core restarts occurred.

Focused evidence logs are under `/tmp/piz-health-*`; selected-run reports are
under `/tmp/piz-fork-tests-run-zAUwy9/`. Temporary logs are not durable artifacts.
