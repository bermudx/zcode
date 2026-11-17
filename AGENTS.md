# piz working guide

This is the writable maintained piz fork, not the read-only ZCode reference
clone. Read [FORK.md](FORK.md) before development, syncs or installation work.
It owns fork direction, branch roles, active patches and maintenance policy.

## Working rules

- Product goal: ZCode's extra GLM Coding Plan usage in a preferred CLI, without
  Electron or a heavy core per invocation/session/workspace. One shared core
  process serves all workspaces, sessions and thin clients. The single-core
  transport/ownership candidate is implemented on
  `fix/edit-from-here-last-message` (`99d0b843`): data-root socket +
  Linux `systemd --user` transient service. Isolated source integration verified
  one core across two workspaces and both client transports, surviving original
  client scope retirement; see `docs/fork/reports/2026-11-08-single-core-live-verification.md`.
  Built-pair verification/promotion remain pending; nothing installed
  (operator clarified 2026-11-08). Standalone zcode-allowance is
  parked; its extra-usage/signing purpose is not. Signing is mandatory: do not
  ship a candidate that drops or breaks it, or call unsigned ordinary-quota
  operation success. Do not claim
  allowance eligibility from code presence alone.
- Preserve unrelated dirty work and existing history. New carried-change commit
  subjects use `fork:`. Work on `patch/<topic>` or `sync/<date>-<sha>` branches.
- Installed commands: since 2026-10-23 `piz` runs a matched client/core
  pair built in THIS checkout; it does not auto-update. The wrapper execs
  `apps/zcode-cli/packages/cli/dist-runtime/`, a frozen dir written only by
  the official promotion scripts — run them after the verification
  matrix passes, never as part of a dev build, and only from a clean `main`
  (the scripts enforce branch + cleanliness; promoting anything main lacks
  regresses the next main-based promotion). For CI artifacts,
  `promote-piz-from-ci.sh <run-id>` accepts a different build SHA only when its
  full Git tree equals clean main; keep `PROMOTED_FROM` as the build SHA and
  record `PROMOTED_ON`/`PROMOTED_CI_RUN`. Do not spend another full-suite run
  solely to stamp a merge SHA. See verification.md for provenance and
  `--repo-root`. The local-build script does NOT build: run the
  build (`docs/fork/verification.md`) after the merge, then grep `dist/` for
  the change before promoting — it will happily promote a stale `dist/`. `dist-runtime` resolves npm deps from root
  `node_modules`: after promoting a lockfile change, run
  `pnpm install --frozen-lockfile` here (2026-11-15: 3.18.2 promoted without
  `@napi-rs/keyring` → "System credential storage is unavailable"), then
  unset the `core.hooksPath` its prepare step sets. Dev builds write
  `packages/*/dist/` and cannot leak into `piz`; frontend externals resolve
  to snapshots inside `dist-runtime/node_modules` (see
  `docs/fork/verification.md`). `zcode` on PATH still points to the old
  allowance tree. Feature-branch pushes, draft PRs and CI are part of requested
  work; only pushes to `main` or other protected branches need separate approval
  (operator clarified 2026-11-16). Merges and promotion still need approval.
  Do not change wrappers, restart live cores, publish or remove old
  branches/worktrees as incidental cleanup.
- Dependency install and CLI/attach builds were first verified here on
  2026-10-23 (pinned node 24.14.0/pnpm 10.33.2; root `mise.toml` must be
  trusted or `mise exec` silently uses unpinned tools). Use pinned mise
  tools.
  [Verification](docs/fork/verification.md) records actual script names and gaps;
  [upstream sync](docs/fork/upstream-sync.md) defines integration gates.
- The inherited freshness script assumes origin/main and skips checks here.
  Compare public upstream/main with UPSTREAM instead. Never call a skip a pass.
- Before code changes, read `.agents/skills/architecture-governance/SKILL.md`,
  run architecture checks and load controlled target context. Update the
  corresponding spec before changing behavior; add regressions and run them.
- Read the session-management skill before changing session ownership, identity,
  persistence or migration. Read DESIGN.md before UI changes and relevant
  React/platform skills for the code touched.
- Keep one owner for state and ordering. Respect workspaceIdentity vs path,
  runtime command admission, permission/parentage boundaries and stale-run guards.
  For async/state changes, diagram ownership and event order. Validate external
  input; no TS `any`, no sync network/filesystem IO in production paths.
- ACP rollback diagnosis: T3 starts a replacement process before retiring the
  original scope. A workspace core spawned by the original client can therefore
  be reused by the replacement and then terminated by supervisor cleanup;
  isolated real-binary reproduction confirmed scope inheritance and systemd
  SIGTERM. `detached: true` is not proof of independent ownership. Zero-turn
  draft loss after core restart is already a documented limit; distinguish that
  from the automatic restart during an edit. Check the core's
  shutdown timeline before treating `proto.sessionNotFound` as a bad ID or
  adding resume retries. See `docs/fork/reports/2026-11-08-edit-from-here-session-loss.md`.
- Respect architecture boundaries and public package exports. UI uses service
  hooks and IPlatformService, never direct Repo/runtime or window.zcode calls.
- Keep client/core protocol schemas in sync, including root packages/shared.
  Thin client must not import the full runtime; no-plugin startup is a hard gate.
- Errors must surface with context. Use existing project loggers; diagnostics
  go to stderr, never protocol stdout. Do not print credentials or secret config.
  For ACP model/options discovery, use typed T3 thread configuration metadata,
  never `env`/`printenv` or process-environment dumps: even a model-name filter
  can match `T3_ACP_MCP_AUTHORIZATION`. MCP checks use disposable servers and
  fake credentials until the operator authorizes a post-rotation T3 check.
  Shared credentials use atomic file replacement: a symlink to the live
  credential file is not safe shared write-through access and can be replaced
  with a separate credential copy. Do not use one for isolated live checks.
- Builds, typecheck, lint and tests run in CI ONLY (`ci` workflow). Never run
  them on the operator's machine, and never put them in an agent brief: push
  the branch and read CI on the head SHA (2026-11-13: local fork-tests and
  builds from several agents drove load to 28). The one exception is
  `--promote-gate` before promotion, and only when the operator asks.
  Root and CLI workspace typecheck/lint are separate CI steps; report actual
  failures/limits. Never `.skip`/delete upstream tests
  for speed. Real terminal/model behavior and resource cost
  require observation, not claims based on compilation or fixtures.
  cli `tsconfig.json` covers only `src/**` — test files are never typechecked
  (tsx strips types at run time), so type-level changes in `tests/` need an
  explicit throwaway `tsc --noEmit` over those files to be verified.
- GitHub CLI: always pass `-R bermudx/zcode` to `gh pr`/`gh issue`. On
  2026-11-15 `gh pr create` without it failed with "does not have the correct
  permissions to execute CreatePullRequest"; the same call with `-R` worked.
  Root cause not confirmed (the repo has no GitHub parent).
- Fix comments explaining bugs should follow upstream's Chinese-comment rule.
  Preserve license and upstream attribution. No inherited release/upload command
  is authorized for a fork release.

## Historical evidence, not current instructions

- [Imported piz agent notes](docs/fork/archive/rapid-cloud-agent-notes.md).
- [Original main checkout's agent-note snapshot (including uncommitted notes)](docs/fork/archive/main-agent-notes.md).

These preserve investigation history, old build paths and prior claims. Do not
run embedded stop/reset/install commands or treat old measurements/statuses as
current acceptance evidence. Current policy lives in FORK.md and linked guides.
