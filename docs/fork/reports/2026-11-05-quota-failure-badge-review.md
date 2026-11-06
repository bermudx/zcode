# Quota failure badge review — 2026-11-05

Reviewed commit `550281a594ee870ca70d06c152c02959610b1c7d` on
`patch/quota-failure-badge`, against its parent `315d9ff1`.
Original review scope: no production code changes, builds, promotion, network
probes, model requests, wrapper changes or live-core restarts. The subsequently
requested fix and its verification are recorded below.

## Finding

**P2 — The only interactive failure indicator can disappear even when the
badge alone would fit.**

`apps/zcode-cli/packages/tui-pi/src/footer.ts:76–87` joins elapsed time,
cached quota readings and `quota !` into a single string.
`src/status-line.ts:214–229` discards that entire right zone when it
cannot fit beside the cwd/status with a two-column gap.
`src/app.ts:240` now suppresses quota diagnostics on TTY stderr.
Together, these changes can leave an interactive refresh failure with
neither a badge nor a diagnostic.

Reproduced using the real `PiTuiApp` test harness and footer renderer:

- Workspace `/tmp/review`, status `Ready.`, width **45**.
- Cached windows: `5h: 99% ↻4h · 7d: 32% ↻5d`.
- Set the failure through `QuotaCluster.noteFailure(new Error(...))`.
- The rendered activity row contains only cwd/status; `quota !` is absent.
- Clear only `quotaBalance`: the same 45-column row now shows `quota !`.
- At width 80 the cached windows and badge both appear.

The whole-zone drop policy predates this commit. The new issue is making
that optional zone the sole TTY failure outlet. Keep status/cwd priority,
but fall back to the failure badge without cached readings/elapsed when
the complete cluster does not fit. Add a constrained-width regression.

The new footer test uses a roomy default width, directly calls private
`noteFailure()`, and clears `quotaError` manually. It does not cover this
case or the app-level TTY diagnostic gate.

## Confirmed behavior

- Thin attach passes `process.stderr` through `attach-main.ts` and
  `attach-command.ts` unchanged. The new `isTTY` gate receives the actual
  stream capability, not a write-only wrapper.
- Failure state flows through `AppStore.set()` → `onStateChanged()` →
  `updateFooter()` → render request; failure does not need a separate
  `requestRender()` call inside `noteFailure()`.
- Additional inline harness checks exercised actual `readUsageQuota`
  promise rejection, rather than calling `noteFailure()`:
  - `stderr.isTTY: true`: zero quota stderr writes, badge visible.
  - `stderr.isTTY: false`: one quota stderr write, badge visible.
  - For both cases, a reset followed by a successful nonempty snapshot
    cleared the failure state/badge and displayed the new reading.
- Reset/dispose generation guards were inspected. No additional concrete
  regression was found. Repeated empty snapshots resetting diagnostic
  deduplication before window validation is pre-existing in the parent.
- An independent read-only review identified the same width problem.

## Checks

All commands used pinned `mise` tools:

```sh
mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/tui-pi test
mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/tui-pi typecheck
mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/tui-pi lint
mise exec -- pnpm architecture:check --changed --base 550281a5^
git diff --check 550281a5^ 550281a5
```

Results: **268/268 tests passed**, zero skipped; typecheck and package lint
passed; architecture reported zero violations against the explicit parent;
whitespace check passed. This is the current observed test count, rather
than the quoted completion message's 267.

Temporary suite logs: `/tmp/piz-quota-review-tests.log` and
`/tmp/piz-quota-review-architecture.log`. The extra inline harness checks
are review experiments, not committed regression tests.

## Limits and claims

The quote's endpoint checks were not repeated. Even accepting the reported
HTTP 200 responses, they do not establish the cause of earlier failures in
the core's authenticated quota-fetch path. “Intermittent network” remains
an unproven diagnosis.

Quota-specific failure handling was exercised with synthetic promises and
streams in the real app harness, not a live provider or physical terminal.
The package suite includes its existing PTY test, but it does not establish
live quota-failure behavior. Full-workspace checks, build/promotion gates,
signing, allowance eligibility and resource measurements were not rerun.
Installed frozen runtime artifacts were not changed.

An unrelated untracked `apps/zcode-cli/packages/adapters/backup/` directory
was present before review and left untouched; its contents were not inspected.

## Follow-up fix — 2026-11-06

Operator requested the fix after review. The frontend spec now defines the
fallback explicitly: try the complete right cluster, then `quota !` alone.
Both attempts use the existing `appendFooterRightZone` width/gap policy.
If even the badge cannot fit, preserve cwd/status instead of truncating them
or increasing footer height. Healthy rendering is unchanged.

State ownership and event order are unchanged:

```text
readUsageQuota rejection → QuotaCluster → store.quotaError
  → onStateChanged → updateFooter → ActivityLine.render
  → full cluster if it fits, otherwise badge alone if it fits
```

No extra state, timer, diagnostic path or network request was introduced.

The original private-method footer test was replaced with two regressions
using actual rejected `readUsageQuota` promises and explicit TTY/non-TTY
stderr streams. They cover cached readings plus elapsed time at roomy and
30/45-column widths, diagnostic gating, crowded status preservation, and
reset followed by a successful read through the public app result entry.
A third regression covers the exact two-column gap boundary, ASCII/CJK
cwd widths, and unchanged rendering after clearing the failure.
All three reproduced missing badges before the implementation change.
Independent read-only review of the fix found no additional defect.

Verification:

- Selected `fork-tests.mjs` run completed successfully: tui-pi **270/270**,
  CLI **642/642 + 11/11**, mandatory signing **13/13**, socket listener
  **4/4**. Other selected Vitest packages had zero reachable tests; they
  are not full-package test passes.
- Root typecheck passed; CLI-workspace typecheck **36/36** passed.
- Root lint: **0 errors / 83 warnings**; CLI lint:
  **0 errors / 74 warnings / 7 accepted upstream line-count diagnostics**.
  Package source lint passed. Additional lint on the changed test file
  reported its pre-existing ANSI-stripping `no-control-regex` warning.
- Architecture against `550281a5^`: **0 violations**; whitespace check passed.
- The initial selected test command reached its 120-second harness timeout;
  the complete rerun with a longer limit passed. Final selected-run logs:
  `/tmp/piz-fork-tests-run-lx68fI/` and
  `/tmp/piz-quota-badge-fix-tests.log`.

The existing Turbo typecheck graph also rebuilt development dependency
artifacts, including tui-pi, as prerequisites. No explicit release build,
full matched-pair acceptance or promotion was performed; frozen
`dist-runtime`, wrappers and operator live cores were not changed.
Quota failure coverage remains harness-based with synthetic promises, not
a live-provider quota failure. No allowance or network-root-cause claim.
The pre-existing untracked backup directory remains untouched.
