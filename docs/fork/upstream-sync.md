# Upstream integration plan

[FORK.md](../../FORK.md) owns policy, patch inventory and the maintenance log.
This file describes the candidate workflow; it is not an unattended updater.
The goal protected by a sync is extra GLM Coding Plan usage in a CLI without
Electron or a heavy core per invocation/session—not merely keeping a TUI alive.

## Recorded baseline

- Integrated upstream: [`UPSTREAM`](../../UPSTREAM).
- Last public check: 2026-10-22; main/HEAD was
  `3c5b227649371507ddc4eb46ac5133afe6db1cab`, committed October 20.
- Incoming mainline commits at that check: **zero**.
- Verify against public source, not upstream's README/app version numbers:

```sh
git ls-remote https://github.com/zai-org/ZCode.git HEAD refs/heads/main
```

Evidence: [commit](https://github.com/zai-org/ZCode/commit/3c5b227649371507ddc4eb46ac5133afe6db1cab),
[main API](https://api.github.com/repos/zai-org/ZCode/commits/main),
[releases API](https://api.github.com/repos/zai-org/ZCode/releases?per_page=5).
No feature branch is implicitly eligible for integration.

## Candidate workflow

1. Compare public main SHA with UPSTREAM. If unchanged, log a no-op review;
   don't rebuild or advance the base.
2. Fetch into this maintained repo, not the reference clone. Pin the target SHA
   and create `sync/<date>-<short-sha>` from maintained `main`; keep installed
   builds and product branch untouched. Preserve unrelated dirty work.
3. Review the entire base-to-target diff. Broad upstream source-sync commits
   require file review, not just reading subjects. Inspect the seams below.
4. Merge the pinned upstream target on the candidate. Keep existing history;
   never use blanket ours/theirs or a clean textual merge as proof of correctness.
   Review rerere resolutions too. Resolve conflicts under
   [fork-deleted paths](#fork-deleted-paths) mechanically before reviewing real
   conflicts.
5. For each P001–P005 patch, record retained/replaced/obsolete/redesign. Confirm
   upstream replacements satisfy our scenarios before removing local behavior.
   Signing is mandatory: reject candidates that drop/break it. Retire local
   signing code only for a verified replacement preserving the signed extra-usage
   path, never merely because unsigned requests still authenticate.
6. Update specs before implementation and add regressions before behavior changes.
   Follow architecture governance and verify both CLI and root protocol consumers.
7. Run [verification](verification.md). Record failures, environmental limits,
   memory measurements and missing coverage honestly; don't call the candidate
   ready while acceptance requirements remain unverified.
8. After successful integration checks, update UPSTREAM to the exact integrated
   ref/SHA and update FORK.md inventory/log together. Failed attempts retain the
   previous base. Include old/new SHA, conflicts, effort, patch retirements,
   actual results and open problems in the log.
9. Stage matched client/core artifacts with source identity; test those actual
   artifacts before switching wrappers. No public release, protected-main merge,
   deletion or live-core disruption is implicit approval from a sync request.
10. Preserve old artifacts and refs. Coordinate restart: rebuilding files cannot
    update a long-running core; don't kill existing sessions indiscriminately.

## Fork-deleted paths

Paths the fork removed while upstream still owns them. When upstream edits one,
the merge reports a modify/delete conflict (`DU`/`UD` in `git status`). Git has
no per-path "ours wins" declaration — merge drivers only see content conflicts
and `-X ours` cannot be scoped — so the policy is procedural: for unmerged paths
under these prefixes, the fork deletion always wins. Never re-add upstream's
version; update this list whenever the fork deletes an upstream-owned path.

- `.agents/skills/agent-browser/` — pre-existing removal; user-level skill suffices
- `.agents/skills/ai-elements/` — no new web chat UI is a fork product
- `.agents/skills/dogfood/` — web-app QA workflow is not a fork activity
- `.agents/skills/e2e-case-lifecycle/` — desktop E2E lifecycle; fork e2e is `apps/zcode-cli/e2e`
- `.agents/skills/electron/` — fork goal is explicitly without Electron
- `apps/zcode-cli/.agents/skills/vercel-react-view-transitions/` — browser API; no browser surface in the CLI app

After `git merge` stops on conflicts, before resolving anything else:

```sh
# Prefixes must mirror the list above.
deleted='^\.agents/skills/(agent-browser|ai-elements|dogfood|e2e-case-lifecycle|electron)/|^apps/zcode-cli/\.agents/skills/vercel-react-view-transitions/'
git diff --name-only --diff-filter=U | grep -E "$deleted" | xargs -r git rm -q --
```

Unmerged paths outside these prefixes are real conflicts: resolve them under
the review rules above, not with this rule.

## Incoming-change map

| Incoming area | Local seam / checks |
|---|---|
| Frontend/TUI APIs, keyboard/input projection | P002/P003: tui exports, tui-pi state projection and input; terminal draining, byte + signal Ctrl-C, history, panels, composer, wrapping, mentions, shell |
| Session RPC, snapshots, model preferences/catalog, attachments | P004: CLI attach adapter; verify real reply shapes, catalog preservation, new/continue/resume, queue/steer, reconnect and wire attachments |
| Bootstrap, plugins/MCP, app-server startup | P004: no-plugin entry gate, socket listener, spawn ownership/races, workspace identity and session lifecycle |
| Root shared protocol/schema changes | P004: runtime validation and matched client/core compatibility; root shared contract test, not only CLI checks |
| Provider auth/request/error handling | P001: preserve the extra-usage request path through the shared core, signing tests and explicit errors; verify allowance eligibility separately from ordinary authentication, and preserve signing independently of the parked standalone build |
| Build tooling / dependency layout | Thin-client import graph and core pairing; rebuild changed dependencies before consumers, then measure client/server memory and child processes |

## One-time allowance audit before parking its development completely

The standalone branch has commits absent from piz: queue/transcript work
`da309372`, notes `bac3682c`, slash-input fix `c6b36ad5`. piz has a different
slash-input fix `2f55f457`. Check behavior and interfaces, not ancestry alone.
Port only requirements needed by piz, with specs/regressions; record deliberate
exclusions. Do not merge the entire allowance branch to make the graph tidy.
