# piz build and promotion policy

One page: when CI builds an installable artifact, when that artifact is
installed, and how Blacksmith runner minutes are spent. Per-promotion evidence
stays in [verification.md](verification.md); direction and the installed-pair
record stay in [FORK.md](../../FORK.md). Terms: [GLOSSARY.md](../../GLOSSARY.md).

## Decision table — what to do

| Situation | Action | Runner cost |
|---|---|---|
| PR branch pushed | Nothing extra. The push run checks only; it uploads no artifact. | ~5–25 min, automatic |
| Merged to `main`; operator wants it installed | Dispatch `ci` on `main` once. Wait green. Promote that run id. | ~15–25 min |
| Merging with intent to promote right away | Merge with `[skip ci]`, then dispatch on `main`. The dispatch runs every check on the exact main tree, so nothing is lost. | one full run instead of two |
| `[skip ci]` merge whose tree is identical to a green dispatched run | No dispatch. Promote the existing run id (script verifies tree equality). | 0 |
| Docs/test/tooling-only merge; no install needed | Nothing. No dispatch, no promote. | 0 |
| Green artifact exists but `main` moved (any file) | One new dispatch on `main`. Never relabel an artifact. | ~15–25 min |

## Build rules

1. Only a manual dispatch of `ci` assembles and uploads `dist-runtime-<sha>`
   (issue #81). Push runs — `main` included — check and build packages, but
   never produce an installable artifact.
2. Dispatch on `main`, after merge, only when the operator asked to promote.
   Do not dispatch a patch branch to build a promotable artifact.
3. A dispatch run executes every check plus the selected and `--full`
   fork-test tiers; its artifact is the gate evidence for the tree it built.
4. One dispatch per promotion. Never dispatch again only to stamp a merge SHA
   (`PROMOTED_ON` records it) or to rebuild an identical tree.

## Promote procedure

From the installed checkout (`/home/daniel/build/piz`): clean, on `main`,
`HEAD == origin/main`:

```sh
gh workflow run ci.yml -R bermudx/zcode --ref main            # 1. build once
gh run watch <run-id> -R bermudx/zcode --exit-status           # 2. wait green
sh apps/zcode-cli/scripts/promote-piz-from-ci.sh <run-id>      # 3. install
```

The script verifies the run (completed, success, `workflow_dispatch`,
`ci.yml` in bermudx/zcode), requires the build commit locally, compares the
**entire Git tree** of the build with the target `main` tree, checks the
artifact's embedded `PROMOTED_FROM` and required matched files, re-checks
branch/cleanliness/HEAD after download, writes `PROMOTED_ON` +
`PROMOTED_CI_RUN`, and retains the previous pair as a rollback directory it
prints. Pass the run id explicitly; the no-argument lookup can pick a push
run and the event check will refuse it.

After promoting:

4. Verify `dist-runtime/PROMOTED_FROM` = the run's build SHA, and
   `piz --version` answers.
5. If anything changed `pnpm-lock.yaml` or a dependency manifest since the
   previous `PROMOTED_FROM`: run `pnpm install --frozen-lockfile` at the repo
   root, then unset the `core.hooksPath` the prepare step sets
   (2026-11-15: 3.18.2 promoted without `@napi-rs/keyring` → "System
   credential storage is unavailable").
6. Record the promotion: update the FORK.md "Builds and installation" row and
   add a maintenance log entry; verification.md evidence when the run had
   surprises.

## Artifact reuse (tree identity)

A green dispatched artifact may install again when its full Git tree equals
clean `main` — the promoter compares whole trees, not runtime paths. Then
`PROMOTED_FROM` stays the build SHA, and `PROMOTED_ON`/`PROMOTED_CI_RUN`
record the `main` commit and the source run. Changed code always needs its
own dispatch; tree equality never replaces CI evidence for it.

## Runner budget (Blacksmith)

- Ceiling: **3000 2vCPU-minutes per month**. The Blacksmith dashboard is the
  billing truth; the numbers below come from GitHub timestamps (one job per
  ci run, so wall-clock ≈ runner-minutes).
- Measured 2026-11-01..19, `ci` workflow only: **100 runs ≈ 850 min** —
  success 460, failure 364 (43 %), cancelled 26. The 7 dispatches cost
  ≈ 95 min (13–24 min each). The 36 failures cluster on Nov 9–16 (3.18.2 sync
  bring-up and the tsbuildinfo cache bug); a red run costs nearly a full
  green run because checks fail late.
- Keep the burn down:
  1. Dispatch only to promote (decision table). One dispatch per promotion.
  2. Let the per-ref `concurrency` group cancel superseded pushes. Do not
     push twice to retrigger one branch.
  3. Do not push a branch you already know is red just to watch it fail;
     each red push is ~10–25 min.
  4. Docs-only or tooling-only trees may merge with `[skip ci]` when no
     shipped code changed (precedent: #84, #88).
  5. Near the month ceiling, sum usage before dispatching:

     ```sh
     gh api 'repos/bermudx/zcode/actions/workflows/ci.yml/runs?created=<from>..<to>&per_page=100' \
       --jq '.workflow_runs[] | [.run_started_at, .updated_at] | @tsv'
     ```

     Sum the durations; that is ≈ runner-minutes used.
- Capacity caveat: other repos in this org with `runs-on: blacksmith-*` can
  consume the same provisioned capacity.
