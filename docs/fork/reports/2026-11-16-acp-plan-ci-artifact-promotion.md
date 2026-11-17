# ACP plan approval: promotion of the original tested artifact

Date: 2026-11-16 (operator machine local date; CI timestamps use UTC).

## Result

Installed the matched client/core artifact from successful dispatched CI run
`43980559348`, without rebuilding it or relabeling its source commit.
PR #84 was merged as `a49e077d6a37096cf4c92b7162860d5b4c5b9989`.
The merge used `[skip ci]` with operator approval because its complete Git tree
exactly matches the already-verified source tree:

```text
Build commit: 6f150d75532e50d9c7f8646437ad849839b12e81
Target main:  a49e077d6a37096cf4c92b7162860d5b4c5b9989
Shared tree:  7d2f2ffbbe376d95196f281bca00737319fa57b6
Artifact:     dist-runtime-6f150d75532e50d9c7f8646437ad849839b12e81
CI run:       43980559348
```

## Promotion command

The independently reviewed promoter from PR #88 was run against the clean
installed checkout **before** merging that tooling-only change into main:

```sh
sh apps/zcode-cli/scripts/promote-piz-from-ci.sh \
  43980559348 --repo-root /home/daniel/build/piz
```

The command was run from the tooling worktree. Its target checkout was main at
`a49e077d`. Source-run identity, successful dispatch status, entire Git-tree
equality, artifact identity and required client/core/frontend files were checked
before the installation swap. Target branch, cleanliness and HEAD were checked
again after download.

Installed markers:

```text
PROMOTED_FROM=6f150d75532e50d9c7f8646437ad849839b12e81
PROMOTED_ON=a49e077d6a37096cf4c92b7162860d5b4c5b9989
PROMOTED_CI_RUN=43980559348
```

The source-build marker was not rewritten to the merge SHA. Later tooling/docs
commits are not claimed to be the source of this runtime.

## Evidence

- Runtime CI `43980559348`: build, typecheck, lint, selected tests, full tests
  and artifact upload succeeded. Full tier reported 14,599 Vitest results;
  13 bootstrap tests passed on isolated rerun. Lint had warnings, no errors.
- Tooling CI `43990516821` on `e155e9c2`: successful selected CLI suite,
  including 17 isolated promotion regressions. Git/filesystem operations in
  these tests are real, but GitHub responses/artifacts and rename failure are
  fixtures. No full tier or runtime artifact dispatch was requested for #88.
- Both independent verifiers posted PASS+NOTES on their respective PRs.
- CI's default architecture step selected its own tracking ref, so its empty
  diff was not treated as changed-file coverage (separate issue #89).
  An explicit-base architecture check of #88 against `6de8e04c` passed with
  zero violations, using the installed checkout's existing dependencies
  through a worktree-local link. No build, typecheck, lint or test suite ran
  locally.
- Actual installed directory compared equal to a separately downloaded copy
  of the original artifact, excluding only the added `PROMOTED_ON` and
  `PROMOTED_CI_RUN` markers.
- Installed wrapper `piz --version` returned `0.17.2`.
- Target checkout remained clean after installation.

Installed bundle SHA-256:

```text
zcode.cjs:
8bb66edfc0c92379e277ac1825121a7b666451f4ad43f159b74bab82d1f53816

zcode-attach.cjs:
33ddfb08e4a2a5a8a6c310eebd6b52ca7c572ac8249d46d409339298a33d1d09
```

## Rollback

The previous pair (`92c8c465054a5a6737a1894d3e0de865d6b120c3`) is retained:

```text
/home/daniel/build/piz/apps/zcode-cli/packages/cli/.dist-runtime.ci.rcBLPp.rollback/
```

Both retained bundle checksums match the capture taken immediately before
promotion. Actual rollback restoration was not exercised; final-rename failure
and restoration were exercised only by the isolated CI fixture.

## Limits

Actual T3 rendering of the complete plan remains **unverified**. The operator
authorized proceeding with that limitation; acceptance is not verification.
Protocol regressions use a fake core.

No model call, credential access/copy, wrapper edit, dependency install,
live-core restart, force-push, branch deletion or old-worktree removal occurred.
The signing path was unchanged; no new allowance/metering claim is made.

For the next visual check, start a new ACP client/thread using the normal
installed `piz acp`, select plan mode, request a plan with a distinctive heading,
and inspect the approval field before choosing reject. Existing clients are not
automatically replaced by promotion.
