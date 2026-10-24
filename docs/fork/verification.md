# piz verification and build acceptance

These commands were inspected in the imported source. **They have not been run
in this new checkout.** No dependencies or dist artifacts were copied. This is a
verification plan, not a working-install claim.

## Tooling and boundaries

Use Node/pnpm pinned in root `mise.toml` (`mise exec -- ...`). Read the existing
bootstrap and workspace configuration before installing dependencies: root and
CLI have separate workspace checks. Never hand-edit dependency manifests.
Read `.agents/skills/architecture-governance/SKILL.md` before code changes; run
architecture checks and load target module context. Specs precede behavior work.

The inherited `scripts/check-workspace-freshness.mjs` hardcodes `origin/main`.
This repo intentionally has `upstream/main`, not origin. The script currently
skips comparisons and prints success: **do not treat that as verification**.
Compare public main with UPSTREAM as described in [upstream-sync.md](upstream-sync.md).
Do not rename remotes solely to satisfy that script.

## Static and targeted regression checks

From repository root, with dependencies available:

```sh
mise exec -- pnpm typecheck
mise exec -- pnpm lint
mise exec -- pnpm architecture:check --changed
mise exec -- pnpm --dir apps/zcode-cli typecheck
npm_execpath="$(ls -d ~/.local/share/pnpm/.tools/pnpm/10.33.2/node_modules/pnpm/bin/pnpm.cjs)" \
  mise exec -- pnpm --dir apps/zcode-cli lint
mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/tui-pi test
mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/client-request-signing.test.ts
mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/socket-listener.test.ts
```

2026-10-24 note: `pnpm --dir apps/zcode-cli typecheck` failed here with
`turbo: command not found` (apps/zcode-cli/node_modules/.bin has no turbo;
the hoisted root bin is not prepended in this shell). Working form:
`cd apps/zcode-cli && mise exec -- ../../node_modules/.bin/turbo run typecheck`
(34/34 packages). Same class of PATH gap as the lint workaround below.

`pnpm --dir apps/zcode-cli lint` (run-cli-lint.mjs) spawns
`node "$npm_execpath" exec oxlint`; under mise `npm_execpath` resolves to the
ELF binary and the spawn fails with a SyntaxError before any package runs.
Point it at the real JS entry (`pnpm/bin/pnpm.cjs` under
`~/.local/share/pnpm/.tools/pnpm/<ver>/`) as above — verified 2026-10-24,
0 errors / 71 upstream warnings.
2026-10-24 correction: pnpm **run** overrides `npm_execpath` for script
children, so exporting it in front of `pnpm --dir apps/zcode-cli lint` does
NOT reach run-cli-lint.mjs (re-verified: the child still sees the mise ELF
shim). `pnpm exec` preserves it. Working invocation:

```sh
npm_execpath="$HOME/.local/share/pnpm/.tools/pnpm/10.33.2/node_modules/pnpm/bin/pnpm.cjs" \
  mise exec -- node scripts/run-cli-lint.mjs
```

Interactive shells inside a piz/core-managed session can inherit
`ZCODE_WORKSPACE_IDENTITY` (and `ZCODE_SERVER_BIN`/`ZCODE_ATTACH_CORE`).
`runAttachCommand` derives the socket path hash from that identity, so
attach tests that fake a core on a `resolveSocketPath`-derived path resolve
a *different* socket inside `runAttachCommand`, fail the reuse probe, and
spawn a real core ("app-server exited before accepting"). 2026-10-24: the
whole attach suite requires `env -u ZCODE_WORKSPACE_IDENTITY`; it is an
environment gap, not a regression (22/22 adapter + 48/48 attach set pass
with it unset).

Rebuild changed dependency packages before consumer typechecks when checks use
dist declarations. Do not suppress missing-export errors; determine whether
source or stale artifacts are responsible. Root typecheck does not replace CLI
workspace typecheck. Report unrelated failures separately; do not label them passed.

CLI uses Node tests with tsx. Its package test script contains attach tests but
omits the existing `attach-resume-target.test.ts`; select it explicitly:

```sh
mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/cli exec node \
  --disable-warning=DEP0205 --import tsx --test \
  tests/app-server-spawn.test.ts tests/attach-argv.test.ts \
  tests/attach-client.test.ts tests/attach-adapter.test.ts \
  tests/attach-resume-target.test.ts tests/attach-binary.smoke.test.ts
```

Also run `packages/shared/src/app-server-attach/contract.test.ts` with the root
suite's current Vitest configuration. `packages/shared` has no test script:
inspect the root test config to choose the correct invocation rather than
inventing a package test command. Expand coverage for changed protocol/bootstrap
behavior. Run broad/full suites only when requested; focused checks are not a
claim that the full upstream suite passed.

## Build and artifact checks

Observed CLI scripts (not a complete clean-bootstrap recipe):

```sh
mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/cli build
mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/cli build:attach
```

Build the dependency graph first as required by the current bootstrap/build
configuration. Core output: CLI `dist/zcode.cjs`; thin client:
`dist/zcode-attach.cjs`. Verify the full core and thin client are built from the
same source/dependency state. The actual generated binaries must pass smoke
checks; tests against only source adapters are insufficient. Check thin-client
imports have not pulled in the monolith runtime.

## Real acceptance before install or sync delivery

- Responding terminal: first-frame rendering, no leaked query responses, input
  echo, history/composer/panels; a silent pseudo-terminal is not enough.
- Both Ctrl-C delivery paths: terminal byte and SIGINT. tmux alone misses the
  signal path used by the existing deployment environment. Follow the herdr
  skill only if the operator explicitly asks to operate Herdr.
- Actual authenticated model turn using only the operator-specified provider and
  model. Do not choose a different provider/model or incur a paid request as an
  incidental documentation check.
- Mandatory signing gate: verify the supported provider-request path through
  the actual shared core signs requests correctly. Missing/broken signing blocks
  delivery; an unsigned ordinary-quota model turn is not an acceptable substitute.
  Keep signing regressions even if the local implementation is replaced upstream.
- Extra-usage acceptance is distinct from authentication: verify that the actual
  piz client → shared core → provider request path qualifies for the intended
  150% ZCode GLM Coding Plan allowance using observable service/account evidence
  when available. Record the evidence and its limits without exposing credentials
  or account data. A signing unit test or successful model turn alone is not
  proof of extra allowance; mark eligibility/metering unverified if it cannot
  be observed. Do not exhaust a quota merely to test the multiplier.
- Model switching, attachments, fresh default session, explicit continue/resume,
  queued submission/steering, disconnect/reconnect and core restart recovery.
- Idle CPU/RSS with 1 and 5 clients, recording server separately; observe process
  children and confirm the no-plugins/MCP promise. Verify invocations/sessions
  reuse the intended shared core rather than spawning one heavy core per client;
  measure core count as well as total memory. Establish a fresh old-piz
  baseline; archived numbers are historical. No material regression is the
  proposed gate, not a fabricated numeric performance guarantee.
- Client exit must not destroy shared sessions or a core used by other clients.
- Test matched staged artifacts and build identity before changing wrappers.
  Coordinate core restart and preserve previous artifacts for rollback.

No model calls, process restarts, installs, wrapper changes or publications have
been performed by establishing these records.

## 2026-10-23 — first verified build + `piz` wrapper repoint (this checkout)

Context: the old `~/.local/bin/piz` wrapper pinned client and core to the deleted
herdr worktree `worktree-rapid-cloud-030e`; `piz` failed with MODULE_NOT_FOUND.
All dist artifacts here predated the last four fork commits, so everything was
rebuilt before repointing.

Actually run here, all passing unless stated:

- Root `mise.toml` had to be `mise trust`-ed first — until then `mise exec`
  silently used unpinned node 24.22.0 instead of the pinned 24.14.0. The
  pnpm engine warning is the tell; treat `node --version` under `mise exec`
  as the ground truth.
- `PATH="$PWD/node_modules/.bin:$PATH" mise exec -- pnpm --dir apps/zcode-cli build`
  — turbo lives only in the root workspace `node_modules/.bin`, not the nested
  `apps/zcode-cli` workspace; 25/25 tasks green (12 rebuilt, 13 cached).
- `mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/cli build:attach`.
- Attach regression set from the command block above: 37/37 pass, including
  `zcode-attach.cjs boots under a pty, spawns core, renders TUI status line`
  against the freshly built binaries.
- Wrapper `~/.local/bin/piz` repointed to `~/build/piz/apps/zcode-cli/packages/cli/dist`
  (matched pair, core pin + `ZCODE_SERVER_BIN` override kept). Later moved to
  `packages/cli/dist-runtime/` + `scripts/promote-piz.sh` so dev rebuilds can
  no longer leak into the installed client: `dist-runtime/` is written only by
  the promote step (atomic dir swap), and `import("@zcode/tui-pi")` /
  `import("@zcode/tui")` resolve to frozen snapshots in
  `dist-runtime/node_modules/@zcode/` instead of the live workspace symlinks.
- End-to-end boot: `piz` under a pty (throwaway cwd, isolated
  `ZCODE_DATA_BASE_DIR`), rendered live TUI until killed by timeout; no
  MODULE_NOT_FOUND; spawned core exited cleanly with the client.

Still NOT done (full acceptance gate above remains open): authenticated model
turn, signing gate against the real provider request, allowance-eligibility
evidence, both Ctrl-C delivery paths in a real terminal, client-count memory
measurements, model switching/attachments/resume matrix.

## 2026-10-24 — footer rework promotion (branch `patch/pi-footer-pwd-stats-rows`)

tui-pi footer: constant three rows (activity + pwd/branch + two-zone stats
row), ctx gauge moved beside the usage cluster, branch from
`TuiStartupOptions.workspaceGitBranch`. `attach-binary.smoke.test.ts`
assertions updated from the retired `mode:` pipe format to the pwd row +
mode token. All passing unless stated:

- tui-pi: 165/165 tests, typecheck, lint; `architecture:check --changed` clean.
- CLI workspace typecheck (34 turbo tasks) and lint via the corrected direct
  invocation above (0 errors / 71 upstream warnings / 13 accepted).
- Focused sets with `env -u ZCODE_WORKSPACE_IDENTITY`: adapters signing
  regression 9/9, bootstrap socket-listener pass, attach set 48/48,
  shared attach contract 4/4.
- `PATH="$PWD/node_modules/.bin:$PATH" mise exec -- pnpm --dir apps/zcode-cli
  build` (25/25) + `--filter @zcode/cli build:attach`; pty smoke re-run
  against the fresh bundle, pass.
- `promote-piz.sh` atomic swap; installed `piz` booted under a pty in a
  throwaway git workspace with isolated `ZCODE_DATA_BASE_DIR` (inherited
  `ZCODE_WORKSPACE_IDENTITY`/`ZCODE_SERVER_BIN`/`ZCODE_ATTACH_CORE` unset):
  banner + pwd row `/…/ws (main)` + stats row mode render; core exited with
  the client.
- First promotion attempt this cycle surfaced the stale pipe-format footer:
  dist-runtime had been promoted from a dist built before the two-zone footer
  commits — same freshness lesson as 2026-10-23, now also covered by the
  smoke test's footer assertions.

Still NOT done: the full acceptance gate above (model turn, signing against
the real provider request, allowance evidence, Ctrl-C signal path, memory
matrix) remains open and unchanged.

## 2026-10-24 — /commands attach support (ff36a0fd) + piz --model (810629b3 merge of 3db70344)

- `patch/attach-custom-commands` verified in a clean-session detached
  worktree by a second agent: full battery re-run (root+CLI typecheck,
  lint, architecture:check, cli suite, bootstrap, tui-pi, signing) plus
  live attach check (/ panel, /help metadata, core-side expansion probe)
  — verdict APPROVE, no blocking findings. Reports:
  ~/goblin/state/delegations/6 (builder) and 8 (verifier).
- `patch/model-flag` verified by its builder with 16 new tests, attach
  suite 73/73, live pty check against the real catalog; full isolated
  build deferred to promotion (worktree shared node_modules with the
  main checkout during the /commands build — deliberate isolation
  avoidance, noted in report ~/goblin/state/delegations/7).
- Merged to main: ff (fast-forward), model-flag via --no-ff 810629b3.
