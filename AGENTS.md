# piz working guide

This is the writable maintained piz fork, not the read-only ZCode reference
clone. Read [FORK.md](FORK.md) before development, syncs or installation work.
It owns fork direction, branch roles, active patches and maintenance policy.

## Working rules

- Product goal: ZCode's extra GLM Coding Plan usage in a preferred CLI, without
  Electron or a heavy core per invocation/session. Thin pi client + shared core
  serves that goal. Standalone zcode-allowance is parked; its extra-usage/signing
  purpose is not. Signing is mandatory: do not ship a candidate that drops or
  breaks it, or call unsigned ordinary-quota operation success. Do not claim
  allowance eligibility from code presence alone.
- Preserve unrelated dirty work and existing history. New carried-change commit
  subjects use `fork:`. Work on `patch/<topic>` or `sync/<date>-<sha>` branches.
- Installed commands: since 2026-10-23 `piz` runs a matched client/core
  pair built in THIS checkout; it does not auto-update. The wrapper execs
  `apps/zcode-cli/packages/cli/dist-runtime/`, a frozen dir written only by
  `apps/zcode-cli/scripts/promote-piz.sh` — run it after the verification
  matrix passes, never as part of a dev build, and only from a clean `main`
  (the script enforces branch + cleanliness; promoting anything main lacks
  regresses the next main-based promotion). Dev builds write
  `packages/*/dist/` and cannot leak into `piz`; frontend externals resolve
  to snapshots inside `dist-runtime/node_modules` (see
  `docs/fork/verification.md`). `zcode` on PATH still points to the old
  allowance tree. Do not change wrappers, restart live cores, push,
  publish or remove old branches/worktrees as incidental cleanup.
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
- Respect architecture boundaries and public package exports. UI uses service
  hooks and IPlatformService, never direct Repo/runtime or window.zcode calls.
- Keep client/core protocol schemas in sync, including root packages/shared.
  Thin client must not import the full runtime; no-plugin startup is a hard gate.
- Errors must surface with context. Use existing project loggers; diagnostics
  go to stderr, never protocol stdout. Do not print credentials or secret config.
- Root and CLI workspace typecheck/lint are separate. Run relevant checks and
  report actual failures/limits. CLI tests on patch branches:
  `mise exec -- node apps/zcode-cli/scripts/fork-tests.mjs` (selected); `--full`
  only for sync/pre-promote or on request. Never `.skip`/delete upstream tests
  for speed. Real terminal/model behavior and resource cost
  require observation, not claims based on compilation or fixtures.
- Fix comments explaining bugs should follow upstream's Chinese-comment rule.
  Preserve license and upstream attribution. No inherited release/upload command
  is authorized for a fork release.

## Historical evidence, not current instructions

- [Imported piz agent notes](docs/fork/archive/rapid-cloud-agent-notes.md).
- [Original main checkout's agent-note snapshot (including uncommitted notes)](docs/fork/archive/main-agent-notes.md).

These preserve investigation history, old build paths and prior claims. Do not
run embedded stop/reset/install commands or treat old measurements/statuses as
current acceptance evidence. Current policy lives in FORK.md and linked guides.
