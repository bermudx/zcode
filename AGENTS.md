# piz working guide

This is the writable maintained piz fork, not the read-only ZCode reference
clone. Read [FORK.md](FORK.md) before development, syncs or installation work.
It owns fork direction, branch roles, active patches and maintenance policy.

## Working rules

- Product focus: thin pi terminal client + shared headless core. Standalone
  zcode-allowance is parked. Do not remove inherited signing by association.
- Preserve unrelated dirty work and existing history. New carried-change commit
  subjects use `fork:`. Work on `patch/<topic>` or `sync/<date>-<sha>` branches.
- Installed commands still point to the old trees. Changing this checkout does
  not update those commands. Do not change wrappers, restart live cores, push,
  publish or remove old branches/worktrees as incidental cleanup.
- No dependency install/build has been verified here. Use pinned mise tools.
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
  report actual failures/limits. Real terminal/model behavior and resource cost
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
