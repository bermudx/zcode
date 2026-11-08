# Combined piz promotion completed — 2026-11-08

## Outcome

The operator authorized checking ready branches, merging, and promotion.
Merged `patch/osc7501-smoke-gate` into local main as
`4caa31d5f1d5efee9931b5bbc9a10838b491df72`, with no conflicts. This adds
the PTY smoke readiness correction and the terminal raw-mode restoration fix.
An independent read-only reviewer found no blockers.

The sync, OSC reporting, ACP commands and effort-sync fixes were already in
main. Independent file comparisons confirmed that the old ACP projector and
stdio review branches were incorporated by `6c7b1e1a` and later changes;
neither needed another merge. The separate lead/sidekick experiment was not
included. No branches or worktrees were removed.

After completing the interrupted gate, rebuilt and tested outputs were
promoted with the official `promote-piz.sh` from clean main at `4caa31d5`.
`dist-runtime/PROMOTED_FROM` contains that full SHA. Both bundles compare
byte-for-byte with tested dist outputs, and recursive comparisons of both
frozen frontend dist trees found no differences.

No push, wrapper edit, live-core restart, or paid model call was made.
No GitHub CI workflow is configured in this checkout; verification was local.

## Gate evidence

The earlier interrupted run's completed package results were preserved rather
than repeated. See [the blocked report](2026-11-08-acp-promotion-blocked.md).
Adapters, bootstrap and contracts source are unchanged since that candidate.
The freshly rebuilt core and attach bundles are also byte-identical to that
candidate. The product change is in the external tui-pi snapshot.

| Coverage | Evidence |
| --- | --- |
| Retained adapters | 2,536 results; 0 new failures, 1 flaky |
| Retained bootstrap | 3,407 results; 0 new failures, 2 known, 1 flaky |
| Retained contracts | 346 results; no failures |
| Retained CLI | 744 passing tests; the one failing smoke is replaced by the fresh 2/2 result below |
| Retained extra CLI resume-target | 11/11 |
| Resumed core | 4,733 results; no failures or flaky results |
| Resumed dynamic-workflow | 2,034 results; no failures or flaky results |
| Resumed dynamic-workflow-runtime | 100 results; no failures or flaky results |
| Resumed i18n / node-repl-host / provider-regression / telemetry / debug | 4 / 83 / 49 / 42 / 16 results; no failures or flaky results |
| Resumed tui | 267/267; no skips |
| Resumed tui-pi | 271/271; no skips |
| Fresh attach-binary PTY smoke file | 2/2; no skips; double Ctrl-C exits 0 |
| Root piz engineering subset | 7 files, 101/101 |
| Typecheck | CLI 36/36 tasks plus root shared surface; explicit test-file projects also passed |
| Changed-file lint | Direct oxlint invocation: three files, 0 warnings/errors |
| Architecture | 0 new violations; 1 existing baselined violation |

Resumed runner exited 0 with 7,061 Vitest results, in addition to its two
passing Node-test packages. No failure-list change, test skip, timeout waiver,
or whole-suite repeat was used. Existing upstream skips remain as found.

The initial engineering selection without an explicit base selected zero
tests; that was not treated as a pass. The actual 101-test run used
`--base a2e129f4`. Root oxlint ignored the nested CLI paths; successful lint
used the actual oxlint entry point from each affected package directory.

Build: pinned Node 24.14.0/pnpm 10.33.2, root shared/model-option-map rebuild,
CLI graph 12/12 tasks followed by explicit `build:attach`. Checked the built
goal, OSC, workflow-rejection and no-plugin markers, and confirmed the
raw-mode reset in the generated tui-pi file before promotion.

## Independent live artifact verification

A clean-session verifier staged both bundles and the real tui/tui-pi package
snapshots. Its comparison covered 401 files with zero mismatches. It used
isolated HOME/data/workspaces and kernel-level denial of IPv4/IPv6 sockets;
Unix sockets remained available. It observed:

- Actual ACP NDJSON initialize, session creation, bare `/goal`, `/target`
  alias, `/dwf list`, and EOF with exit 0.
- Actual core arguments included `--no-plugins`; both owned test cores had
  zero children at inspection.
- Direct PTY startup rendered the footer/workspace. Double Ctrl-C exited 0;
  exit OSC idle preceded the resume hint.
- Reading termios from the still-open slave after client exit, before any
  shell repair, found the entire structure identical to its pre-client value.

The verifier returned FAIL against two incorrect literal expectations in my
brief, not against the product spec. I checked the discrepancies directly
against `docs/design/v2/acp-frontend.md`: only `goal` and `dwf` are advertised;
`target` is an alias. Bare `/goal` reads status; `/goal status` sets an
objective named `status`. No product change was made to satisfy the mistaken
brief. Its initial literal-status probe did set that objective in an isolated
session and attempted continuation, which failed with no model selected.
The verifier disclosed this deviation; kernel network denial and the absent
model prevented a paid call. It terminated that owned core and used a fresh
session for the read-only probes.

Live model/effort options remain unverified because the isolated unauthenticated
catalog returned no options. Authenticated signing, service-side allowance
eligibility/metering, external-SIGINT behavior, T3 rendering and resource cost
were not established by these smokes. Signing regression coverage from the
retained adapters run remains valid; it is not a live allowance claim.

## Retained evidence and rollback

- Resumed gate: `/tmp/piz-final-remaining-gate.log` (exit file contains 0).
- Resumed package reports: `/tmp/piz-fork-tests-run-rcNcG8/`.
- Fresh PTY tests: `/tmp/piz-final-pty-tests.log`.
- Build/typecheck/lint/engineering/architecture:
  `/tmp/piz-final-build.log`, `/tmp/piz-final-typecheck.log`,
  `/tmp/piz-final-lint.log`, `/tmp/piz-final-engineering.log`,
  `/tmp/piz-final-architecture-after.log`.
- Independent staged artifact evidence:
  `/tmp/piz-4caa31d5-artifact-PtWyix/`, including `termios.json`,
  `snapshot-comparison.json`, `acp-result.json` and core-launch evidence.
- Promotion: `/tmp/piz-final-promotion.log`.
- Prior installed pair:
  `/home/daniel/.local/state/piz/promotions/pre-4caa31d5-20261108.ANfybD/`.

Try the installed client with one command: `piz`. For ACP changes, restart
the piz provider in T3, then use bare `/goal` or `/dwf list`. This does not
require rebuilding or modifying a wrapper. Existing live clients/cores were
left untouched; the operator controls when to restart them.
