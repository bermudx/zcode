# ACP merged; promotion blocked — 2026-11-08

## Outcome

The operator authorized merge and promotion. Reviewed ACP tip `ce6850cd` was
merged into local main as `17dbfcce2a70e811adf79287ddf016b1abab61ee`.
The earlier sync and OSC merges remain included. An unrelated docs-only main
checkpoint, `106c5998`, was preserved.

Two merge conflicts:

- `FORK.md`: retained both maintenance histories.
- CLI `package.json`: retained both added test entries, OSC reporter and ACP
  commands. Used the package manager's manifest command rather than hand-editing
  the manifest. No dependencies changed.

No source conflict needed manual resolution.

**Promotion did not happen.** The installed pair and existing cores were not
changed. There was no push, dependency install, model call or whole-suite retry.

## Build and static evidence

All checks used pinned Node 24.14.0/pnpm 10.33.2 through mise.

- Root shared/model-option-map declarations rebuilt.
- CLI graph build: **26/26**, 22 cached, then explicit fresh `build:attach`.
  Turbo warned that browser-use-plugin had no configured output files, but its
  required generated artifact existed and the promotion preconditions passed.
- `typecheck:piz`: **36/36** CLI tasks plus root shared surface passed.
- Explicit throwaway TypeScript project over `acp-agent.test.ts` and
  `acp-commands.test.ts`: passed. The normal CLI tsconfig excludes tests.
- Root lint: **0 errors / 84 warnings**.
- CLI lint: **0 errors / 74 warnings / 7 pristine upstream diagnostics**.
- Architecture against installed marker `a2e129f4`: **0 new / 1 baselined**.
  The reviewed ACP branch carries the attach-session baseline.
- Fresh attach bundle contains `acp-goal-`, `Goal paused.`, `7501;` and
  `workflowRunResumeRejected`. Fresh core contains `session-lineage-invalid`,
  `sessionLifecycleWorkspace` and `compactContextWindow`.
- No direct eager `@zcode/bootstrap`, `@zcode/core` or `@zcode/adapters` imports
  were found by the targeted thin-bundle import check. This is not a complete
  resource or no-plugin runtime measurement.

## Promotion run: failed and incomplete

The clean-session verifier started this once:

```sh
mise exec -- node apps/zcode-cli/scripts/fork-tests.mjs \
  --promote-gate --max-workers 2
```

The runner selected the documented full pre-promotion tier, 14 packages with
7 plugin-package tasks explicitly excluded. It isolated HOME/data and used
tmpfs. Its own documented isolated Vitest retries were allowed.

Completed results before interruption:

| Package | Observed result |
| --- | --- |
| adapters | 2,536 results; 0 new, 0 known, 1 flaky |
| bootstrap | 3,407 results; 0 new, 2 known, 1 flaky |
| CLI | **744/745 passed, 1 failure**, no skipped/cancelled tests |
| extra CLI resume-target file | 11/11 passed |
| contracts | 346 results; 0 new, 0 known, 0 flaky |

The failed CLI test is
`zcode-attach.cjs 在真实 pty 中发出 OSC 7501 idle（绑定 + 干净退出）` ("zcode-attach.cjs emits OSC 7501 idle in a real pty (bind + clean exit)")
in `tests/attach-binary.smoke.test.ts:210`.
Its double-Ctrl-C exit assertion expected **0** but observed **130**. The
separate PTY boot/render test passed. The OSC smoke file is unchanged from the
reviewed OSC tip `19ef618e`; that fact does not establish a passing baseline or
explain the failure. Root cause is **not established**. No skip, relaxed
assertion, timeout increase or known-failure waiver was applied.

The verifier's single foreground shell call had a 1,800-second timeout, but the
native delegate watchdog stopped the worker after 900 seconds without session
activity. Core tests had started; no final core report or overall runner status
was produced. Remaining packages and the separately planned real staged ACP
smoke were not completed. These are **not passes**. The verifier did not return
a final verdict. No matching gate/Vitest processes remained when inspected.

Completed bootstrap JSON includes passing regressions for noPlugins config
mapping, disabled plugin/MCP servers, trusted noPlugins command discovery, and
no-plugin snapshots without plugin discovery. This is regression evidence, not
a real provider-signing or allowance-eligibility result.

## Retained local evidence

- Gate output: `/tmp/piz-promote-gate-17dbfcce.axgvVu.log`
- Package reports/logs: `/tmp/piz-fork-tests-run-8UJiUh/`
- Build log: `/tmp/piz-promotion-build.1itG5C.log`
- Typecheck log: `/tmp/piz-promotion-typecheck.WFVoVX.log`
- Static logs: `/tmp/piz-promotion-static.VqWTMO/`
- Explicit test config: `/tmp/piz-acp-tests-20261108.tsconfig.json`

Externally staged candidate:
`/tmp/piz-candidate-17dbfcce.5btpmh/`, with full source SHA in `BUILD_ID`,
both bundles, frozen tui/tui-pi outputs and links to existing dependencies.
The planned real staged ACP command smoke was not reached.

Candidate SHA-256:

```text
core     9d48e95bd5dd27dba49449172181ac84638a2544a7606579bd85d7d4a6a31775
attach   ae8132f266ba466c81d41fcfc796dfeb2dfe74732dc6a4ad23b323491631039e
tui      105659b120e0e39fe167f7f0fcdd22271377b3e74783845baba6635a50843207
tui-pi   1b2d539c29a412c46e4ac0a39435f92b2ab12a3fa715f72ca1066ea7aaf09b8d
```

Prior installed artifacts retained at
`/home/daniel/.local/state/piz/promotions/pre-17dbfcce-20261108.w4ZObU/`.
The actual old `PROMOTED_FROM` marker reads `a2e129f4`, despite the previous
maintenance prose naming a971df4e. No inference was made about why they differ;
the frozen artifacts were preserved as found.

Pre-existing test backups were moved, not deleted, to
`/tmp/piz-promotion-preserved.wkqmbu/adapters-backup`.
The promotion attempt's newly generated backups are retained alongside them
under `gate-generated-adapters-backup`. Neither backup's contents were read.

## Remaining work

1. Diagnose the real PTY exit-130 failure. Fix the cause, establish a matching
   baseline failure with evidence, or obtain an explicit operator waiver.
2. Complete the interrupted/remaining promotion coverage without repeating
   completed suites merely to reconstruct a summary.
3. Complete the real staged client/core ACP smoke without paid model calls or
   live-core changes.
4. Only after the required gate is satisfied, promote from clean main with the
   official script and verify the frozen artifacts match the tested build.

The installed `piz` still uses the previous frozen pair. The new ACP commands
are merged but are not yet installed. Live T3/Zed rendering, authenticated
signing, service-side allowance evidence and resource measurements remain
unverified.
