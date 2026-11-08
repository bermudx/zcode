# Reviewed sync and OSC merges — 2026-11-08

## Scope and result

The operator authorized merging the reviewed upstream sync and OSC status
branches, excluding the still-active ACP goal/dwf branch.

| Input | Reviewed tip | Merge into local main |
| --- | --- | --- |
| `sync/2026-11-07-a9fe401e` | `5ae77e79` | `7d9fa0ca` |
| `patch/osc7501-status` | `19ef618e` | `cfc84c03` |

Both merges use `--no-ff`. The starting main was `a971df4e`.
The only conflict was the two branches appending different maintenance records
to `FORK.md`; both records were retained. No source resolution was needed.

Herdr's default session was reachable. Its OSC pane reported the completed
review and fix pass. The ACP worktree had an active working pane. No input,
focus change, restart or close was sent to any pane.

Ancestry checks confirmed both authorized branch tips are in main and excluded
ACP tip `52926bb7` is not. The OSC implementation and focused test files match
the reviewed OSC tip. `attach-session.ts` matches starting main byte-for-byte.
The adapters request-security-edition directory and attach herdr reporter also
have no diff from starting main.

## Checks on the combined source

Pinned tools: Node 24.14.0 and pnpm 10.33.2 through `mise exec`.
Each test ran once. Tests used temporary HOME/data directories and stripped
ambient ZCode/Herdr session variables; they did not use the operator's live core
or real provider credentials.

| Check | Observed result |
| --- | --- |
| CLI OSC reporter, exit-resume hint, attach adapter | **89/89 passed** |
| Bootstrap active-resume lineage and socket listener | **8/8 passed** |
| Adapters client-request-signing | **13/13 passed** |
| CLI `tsc --noEmit` | Passed |
| Seven OSC-touched TypeScript files, oxlint | 0 errors, 7 warnings |
| Architecture, explicit base `a971df4e` | Failed: unchanged `attach-session.ts`, 814 lines vs 800 |

The CLI checks assert emitted OSC bytes, the TTY/entry gates, exit-idle ordering
before the resume hint, startup-error status, interaction routing, and silence
after finish. The lineage tests assert wrong-workspace resume rejection before
the compact cap can be changed. These are source-level harness tests, not new
live terminal/model acceptance.

The architecture failure was observed before either merge as well as after.
The file has no diff from starting main. No baseline was changed to hide it.
The lint warnings are six optional-chaining warnings and one unused test
variable in `attach-adapter.test.ts`; no source fixes were included.

The first root-relative lint invocation found no files because root oxlint
ignores `apps/zcode-cli`; that invocation is not counted as a pass. The actual
lint ran from the CLI package with `--no-ignore` on the seven explicit paths.

Logs retained locally:

- CLI: `/tmp/piz-merge-cli.5mC0mp/results.log`
- Bootstrap: `/tmp/piz-merge-core.no8muJ/bootstrap.log`
- Signing: `/tmp/piz-merge-core.no8muJ/signing.log`
- Typecheck and architecture: `/tmp/piz-merge-checks.ZvisvC/`

## Quick reproduction

From the maintained checkout, this runs the OSC byte/state regressions in
seconds with the existing dependencies; it does not start a model or live core:

```sh
mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/cli exec node \
  --import tsx --test tests/attach-osc-status-reporter.test.ts
```

## Limits and untouched state

- No full suite was repeated. The sync and OSC branches' earlier verification
  records remain historical evidence, not CI on this combined commit.
- No `.github` workflow directory is present in this checkout. Remote CI was
  not queried; no push or other network operation was performed.
- No build or promotion was requested or run. The installed frozen `piz`
  client/core pair and running cores are unchanged.
- Real model-turn statuses, terminal badge rendering, service-side allowance
  eligibility and the combined fresh-binary terminal smoke remain unverified.
- The pre-existing untracked
  `apps/zcode-cli/packages/adapters/backup/` directory was not read, staged or
  removed. It remains a clean-tree promotion obstacle.
- The ACP branch, other worktrees, all live sessions and old branches were left
  alone.
