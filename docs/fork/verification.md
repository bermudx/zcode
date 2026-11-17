# piz verification and build acceptance

These commands were inspected in the imported source. **They have not been run
in this new checkout.** No dependencies or dist artifacts were copied. This is a
verification plan, not a working-install claim.

## CI (Blacksmith, added 2026-11-08, issue #11)

`.github/workflows/ci.yml` runs on every branch push and manual dispatch on
`blacksmith-4vcpu-ubuntu-2404` (free tier: 3000 x64 2vCPU-min/month; the 4vCPU
tag consumes at 2x rate): mise toolchain from `mise.toml` → root install (the
root workspace also covers `apps/zcode-cli/packages/*`; the nested CLI
workspace cannot install standalone — its `workspace:*` deps point at root
packages) → shared `tsc -b` → `turbo run build` → `typecheck:piz` → root and
CLI lint → `architecture:check --changed` → `fork-tests.mjs --max-workers 2`
(selected). On `main` pushes and manual dispatches it additionally runs
`--full`. Superseded runs on the same ref are cancelled (`concurrency`,
cancel-in-progress), and turbo's local cache (`apps/zcode-cli/.turbo`) is
cached between runs, so unchanged packages replay instead of rebuilding
(2026-11-16, issue #81: per-push cold batteries and never-installed artifacts
had burned 1,490/3,000 free-tier minutes by mid-month). `*.tsbuildinfo` is
deliberately **not** cached: the root `tsc -b` dist outputs it describes are
not in the cache, and a restored tsbuildinfo makes tsc report TS6305
(observed in run 43939000283); turbo replays outputs together with its cache
and is safe. Generated runtime assets outside `dist/` must be declared as
package-specific build `outputs` or a cache hit restores a tree without them:
`@zcode/browser-use-plugin#build` declares `scripts/browser-client.mjs`
(issue #85, run 43974790321 — the SEA plugin-asset test failed on an otherwise
green cache-replayed build; pinned by cli `tests/turbo-build-outputs.test.mjs`).

`dist-runtime-<sha>` is assembled and uploaded **only on manual dispatch**
(issue #81): a dispatched run executes every check first, so its artifact is
itself the gate evidence for the sha it uploads. Push runs — `main` included —
build nothing installable. Dispatch once on the candidate and let it finish green.
A merge-only commit does not require another dispatch when the candidate's full
Git tree is identical to clean `main`.

`sh apps/zcode-cli/scripts/promote-piz-from-ci.sh [run-id] [--repo-root <path>]`
installs a verified artifact into clean `main`. Without a run id it looks for a
successful run on that exact `HEAD`; pass the already-tested candidate's run id
to reuse its artifact after merging.

The promoter verifies the run through GitHub: completed, successful,
`workflow_dispatch`, and `.github/workflows/ci.yml` in `bermudx/zcode`. It reads
the build SHA from that run, requires its commit object locally, and compares
the **entire Git tree** with the target `main` tree. Any changed file or dependency
manifest rejects reuse; matching only runtime paths is not sufficient. Artifact
name and embedded `PROMOTED_FROM` must match the actual build SHA, never a
replacement main SHA. Required matched client/core and frontend files must exist.
The target branch, tracked cleanliness and HEAD are checked again after download.

`PROMOTED_FROM` stays the actual build commit (also the next promote-gate base).
The promoter adds `PROMOTED_ON` for target `main` and `PROMOTED_CI_RUN` for the
source run. It stages on the destination filesystem, retains the previous
installed directory as a printed rollback path, and restores it if the final
rename fails. Failed staging directories are retained for diagnosis, not deleted.
Diagnostics go to stderr; no live core is restarted.

`--repo-root` permits running reviewed promotion tooling from another checkout
against the installed checkout. All source-tree and branch gates apply to the
**target**, not the tooling checkout. This permits promoting an identical tested
tree before a tooling-only PR changes `main`; it is not a dirty-main bypass.
Merge commits whose tree was already verified may use `[skip ci]` in the merge
message, with the successful source run and tree comparison recorded on the PR.
New code still needs its own CI evidence; tree equality never replaces that.

`.github/workflows/allowance-build.yml` is manual-only: it builds a chosen
allowance ref (default `feat/allowance-herdr`, must be pushed to origin),
smokes `dist/zcode.cjs --version`, and uploads `zcode-allowance-dist-<sha>.tar.gz`.
Untar it over the allowance checkout's `apps/zcode-cli/packages/cli/dist/` to
refresh what PATH `zcode` execs.

Runner caveat: Blacksmith runs jobs only in repos where its GitHub App is
installed (installed on bermudx/zcode 2026-11-08); other repos with
`runs-on: blacksmith-*` in this org can steal the provisioned capacity.

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
Since 2026-11-08 the socket path derives from the data root only, so the
identity no longer redirects the attach socket — but it still changes the
session `workspaceRef`/`workspaceKey` sent to the core, and it is
deliberately excluded from the spawned service env. Keep stripping it for
attach tests (`env -u ZCODE_WORKSPACE_IDENTITY`, also handled by
`fork-tests.mjs` STRIPPED_ENV): ambient identity otherwise produces a
different workspace key than the fake-core fixtures assume.

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

### Selected vs full runs: `fork-tests.mjs`

Don't `.skip` or delete upstream tests to save time. That adds sync conflicts and
blinds `sync/*` branches, where upstream changes exactly the code those tests
cover. Select tests instead:

```sh
# patch/* branches — tests reachable from what the branch changed (vs merge-base with main)
mise exec -- node apps/zcode-cli/scripts/fork-tests.mjs            # --dry-run shows the plan
# sync/* branches — every CLI-workspace package
mise exec -- node apps/zcode-cli/scripts/fork-tests.mjs --full
# before promote-piz.sh, from main — tier chosen from the diff, see "Promotion gate"
mise exec -- node apps/zcode-cli/scripts/fork-tests.mjs --promote-gate
```

### Promotion gate

`--promote-gate` diffs HEAD against the last promoted commit, which
`promote-piz.sh` records in `dist-runtime/PROMOTED_FROM`. Until a promotion has
written that file, pass `--base <last promoted sha>` (FORK.md names it).

- **Selected tier:** every changed path is in `packages/tui`, `packages/tui-pi`,
  `docs/`, `FORK.md` or `AGENTS.md`. Runs the changed packages and dependents,
  plus the always-run signing and socket tests.
- **Full tier (`--full --exclude-plugins`):** anything else, including core,
  bootstrap, adapters, contracts, shared, CLI, dependencies and lockfiles. The
  list is an allowlist, so unrecognised paths land here.
- **Build first, or results mean nothing.** Full mode refuses to start without
  the workspace build (`turbo run build`), `browser-use-plugin` output
  (`scripts/browser-client.mjs`, declared as a turbo build output since #85, so
  cached builds restore it) and root `tsc -b packages/shared
  packages/model-option-map`.
- **Load changes results.** On 2026-11-06 bootstrap at `--max-workers 2` had no
  new failures in about 8 minutes; the default worker count gave 31, with
  `STACK_TRACE_ERROR` and count mismatches. Use `--max-workers 2` before calling a failure real.
- **Runner isolation.** The runner gives tests a throwaway HOME, since seeding
  and starting plugins from the real `~/.zcode` is the suspected cause of the
  11-18s `app-unbound-resume` tests (about 1s isolated; not separately tested).
- **Both tiers also need:** `typecheck:piz`, lint, architecture checks, a matched
  client/core build, the no-plugin startup regression and a terminal smoke test
  against those artifacts.
- **A new failure blocks promotion.** To proceed, show the same failure on the
  pre-merge commit and add it to the known-failures file with that evidence, or
  get the operator's explicit waiver and record it. Passing a failing test once
  with a longer timeout is neither.
- **Delegate watchdog:** on 2026-11-08 a full gate exceeded the native delegate's
  900-second inactivity limit inside one foreground shell call; its 1800-second
  shell timeout did not prevent the worker and unfinished tests being stopped.
  Run long full gates from the parent rather than one delegated foreground call.
  Preserve completed package reports after interruption; never call a partial
  run a pass or repeat completed suites just to recover a missing summary.

Sync branches still run plain `--full`.

### Bootstrap test timeouts under plugin startup

Each bootstrap test app seeds and starts the bundled plugins. Under Vitest, the
plugin host command re-runs `process.argv[1]`, which is Vitest's own `forks.js`.
Measured 2026-11-06, `app-unbound-resume` solo on tmpfs: 11-18s per test, about
274s CPU for the file, failing the 5s limit. `fsync` is not the cause here. No
fix is in place yet.

- Moving `argv[1]` looks like a fix (under 3.5s per test) only because plugin
  discovery then finds nothing. It breaks the plugin tests.
- Making the host exit at once, by a missing script or an `--import` guard, does
  not fix it: the tests still time out.
- These tests rewrite manifests in the real `~/.zcode` plugin cache. A `--import`
  or changed `argv[1]` experiment gets written there too, so don't run one
  against the real home directory.
- `mise` can hang under a fresh `HOME`: set one inside `mise exec`, not around it.

- Selection: turbo `...[base]` gives the changed packages plus their dependents.
  Inside vitest packages, `vitest --changed <base>` narrows that to the test files
  whose import graph reaches a changed file. On attach-v4, that was 26 of 232
  bootstrap files. node:test packages (cli, tui, tui-pi) run their whole package
  script, and cli also runs `attach-resume-target.test.ts`. Signing and
  socket-listener always run.
- cli tests exec `packages/cli/dist/*.cjs`. If dist is missing, cli is
  reported NOT RUN (exit 1, never a pass). Build first: CLI-workspace
  `turbo run build` plus root `@zcode/model-option-map` (SEA tests). A stale
  dist is your responsibility.
- The script itself strips the session-env list (above), so the `env -u …`
  prefix isn't needed.
- TMPDIR goes to a fresh `/dev/shm` dir. Bootstrap SQLite tests fsync on
  every write, and on btrfs `/tmp` that dominates. Measured 2026-11-03:
  `dynamic-workflow-report-reads` 65,536-item test 23s wall on tmpfs vs
  19 min idle (1146s, then fails its 120s timeout) and 26 min under suite
  load on btrfs.
  `session-persistence.test.ts:1135` fails on btrfs and passes on tmpfs.
- Each failing vitest file gets one rerun, alone and at `--maxWorkers=1`.
  If it passes then, it's reported as FLAKY, which is visible but doesn't
  fail the run. Retrying failing files together didn't work: under load
  (another agent's suite, load average ~28), `protocol-unbound-resume`
  failed 11/11 in a batch and passed 11/11 solo.
- Tests can leave artifacts in package dirs (adapters' full suite left an
  untracked `packages/adapters/backup/`). Turbo then counts that package as
  changed. Check `git status` after full runs.
- Failures are classified against
  [known-test-failures.txt](known-test-failures.txt): NEW (exit 1), known,
  and STALE (a known entry that now passes; remove it). Add entries only
  with a baseline run on main as evidence.
- Changed files outside `apps/zcode-cli` are reported as NOT COVERED: root
  vitest is broken (see the 2026-11-01 battery). A selected run is never a
  full-suite result.

### Lean fork gates: typecheck, engineering subset, plugin tier (2026-11-03)

Desktop/Web/Electron tests are already excluded from every fork gate (root
Vitest discovers no app unit tests; the 644 desktop WebdriverIO E2E files run
only under the desktop package's own `test:e2e`). Do not delete them. The lean
gates below shrink what patch/pre-promote runs *select*; sync branches still
run the upstream sets in full.

**A — piz typecheck** (`pnpm typecheck:piz`, `scripts/fork-typecheck.mjs`):
CLI-workspace turbo typecheck (35 packages) plus the root shared surface the
CLI core actually imports (`packages/shared` incl. its testing fixtures,
`rpc`, `provider`, `provider-node`, `model-option-map` via `tsc -b`). It does
not compile desktop (main/host/e2e/remote-main), ui, web, e2e-report,
dev-docs or zcode-cua. This replaces root `pnpm typecheck` on patch and
pre-promote gates; root typecheck remains the sync-branch gate.

**B — engineering subset** (`pnpm test:engineering:piz-affected`,
`scripts/run-affected-engineering-tests.mjs --set piz`): the upstream
engineering list has 161 files, 151 of them desktop. The fork default runs
only `scripts/fork-engineering-test-files.json` (7 files). A file earns its
place only when its *subject* is in the shipped/shared surface — not because
it transitively imports `@zcode/shared/test-ids`, and not when it tests a
desktop E2E helper under `packages/desktop/test/e2e/helpers/` (coding-plan
mock servers, provider seed writers, upstream-model fixtures are E2E
harness, excluded on that basis). Keepers: the 4 `packages/shared` contract/
schema tests (attach P004, signing-policy P001, coding-plan quota, protocol),
`credentialFault` (subject is `@zcode/shared/node` atomic private write +
file lock), `customOpenAIProviderStore` and `modelProviderRestartConfig`
(subjects are `@zcode/provider` / `@zcode/provider-node` config round-trips).
The runner validates the manifest against the upstream list (unknown or
duplicate entries are a script error, never a silent pass). The upstream
`--set all` behaviour is the default and unchanged; run
`pnpm test:engineering` in full on sync branches. `verify:pre-push` uses the
piz-affected variant.

**C — plugin tier in `fork-tests.mjs`** (`--full --exclude-plugins`,
pre-promote only): excludes the test tasks of plugin packages the no-plugin
shared core does not load — `@zcode/android-emulator-plugin`,
`@zcode/ios-simulator-plugin`, `@zcode/browser-use-plugin`,
`@zcode/office-runtime`, `@zcode/zcode-site-plugin`,
`@zcode/plugin-creator-plugin`, `@zcode/zcode-cua-plugin`. Excluded packages
are printed, never silently skipped. Bootstrap's bundled-plugin *seeding*
tests are not in this tier (seeding still runs at startup) and
`@zcode/node-repl-host` stays (built-in host, not a plugin package). Sync
branches run plain `--full`.

Measured on this machine (warm caches, 2026-11-03): the piz engineering
subset runs 7 files / 101 tests in ~7s; `typecheck:piz` took ~54s (turbo 36
tasks, 29 cached) against ~12s for the incremental root `tsc -b` — the saving
is not running *both* gates plus the desktop projects on patch branches, not
beating warm `tsc -b`; cold-cache figures are unmeasured. `--full
--exclude-plugins` plans 14 packages against 21 for plain `--full`.

## Build and artifact checks

Install from the repo root only. The root workspace and `pnpm-lock.yaml` own
every CLI package. `apps/zcode-cli/pnpm-lock.yaml` is inherited and stale (no
`@withfig/autocomplete`), and pnpm cannot regenerate it because the nested
workspace lacks root packages such as `@zcode/model-option-map`. A frozen install
inside `apps/zcode-cli` therefore always fails. Only the
`e2e/compact-microcompact` Dockerfile copies it.

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

## 2026-10-24 — promotion of the c6130f43 pair (commands + model flag)

Full battery re-run in the main checkout before promote, all green unless
stated:

- Root typecheck; CLI workspace typecheck (34/34 turbo tasks); root lint
  (0 errors, 96 warnings — upstream noise); CLI lint via the direct
  `run-cli-lint.mjs` invocation (0 errors / 71 warnings / 13 accepted);
  `architecture:check --changed` clean.
- CLI suite = package `test` script + explicit `attach-resume-target` and
  `attach-model-option` files, `env -u ZCODE_WORKSPACE_IDENTITY`:
  607/610 pass, 3 fails exactly the known pre-existing set (build.test.mjs
  clientOnly deep-equal + 2 SEA asset tests; delegation 8's verifier
  confirmed identical on baseline 3c32875b). One extra flake observed once
  under full-suite load (`tui-subagents.test.ts` file-level timeout,
  10/10 pass isolated and on suite re-run) — load flakiness, not a
  regression.
- tui-pi 165/165; adapters client-request-signing 9/9; bootstrap
  socket-listener 4/4; shared attach contract (root vitest) 4/4.
- Fresh dist pair: `PATH="$PWD/node_modules/.bin:$PATH" … build` (25/25,
  mostly cached) + `build:attach`; bundle grep confirms both new symbols
  (`commands/referenceCatalog`, `resolveInitialModelRef`) before promote.
- `promote-piz.sh` atomic swap to dist-runtime.
- Installed-pair smoke (real `piz` wrapper, util-linux `script` pty):
  - scratch workspace, isolated `ZCODE_DATA_BASE_DIR`: banner `piz v0.17.0`,
    footer pwd row + `yolo` mode token, `/` panel lists the user's global
    commands `good-prompt` and `review` (filtered via `/good`, `/rev`).
  - scratch workspace, default data dir (unset): `piz --model GLM-5.3`
    boots with banner `models: GLM-5.3, GLM-5.3-Flash, GLM-5.3-FlashX`
    (real account catalog) and exits cleanly on double Ctrl-C. One scratch
    session record in the operator's store is the only side effect
    (same class as the 10-24 model-flag live check).
  - Environment lesson: `ZCODE_DATA_BASE_DIR` is a HOME-like base — the
    core appends `.zcode/v2` (provider config, sockets). Setting it to
    `~/.zcode` yields `~/.zcode/.zcode/v2` (nothing there → catalog
    `(none)`, `--model` fails listing zero models). Unset = `homedir()`
    is the supported way to reach the real `~/.zcode/v2`.
  - Scratch cores killed by pid file under their own data dir; verified by
    `/proc/<pid>/cwd` + socket `.sock.info` `workspaceIdentity` matching
    only scratch paths. Operator's live cores/clients untouched.

## 2026-10-24 — promotion of the 9b46915f pair (resume prefix expansion + surfaced resume failures)

Fix for `piz --resume sess_99f180d5 restores an empty screen` (three core
`session.resume_persisted_missing` warnings 10-24 14:47/15:28, all against
the pre-fix promoted pair). The fix commit landed 16:18 but had NOT been
promoted — `dist-runtime` was still the 15:36 c6130f43 build; installed
`resolveAttachResumeTarget` was the raw-passthrough version. Full battery
re-run in the main checkout before promote, all green unless stated:

- Root typecheck; CLI workspace typecheck (34/34); root lint 0 errors /
  96 warnings (upstream noise); CLI lint via a faithful `npm_execpath`
  JS shim driving `run-cli-lint.mjs` (mise's pnpm is an ELF binary the
  wrapper cannot `node`-spawn): **0 errors / 71 warnings / 13 accepted**,
  exact baseline match; `architecture:check --changed` 0 violations.
- CLI suite (package script + explicit attach-resume-target,
  attach-resume-fallback, attach-model-option): 619 total, 616 pass,
  3 fail = exactly the known pre-existing set (build.test.mjs clientOnly
  deep-equal + 2 SEA asset tests). Total grew from the documented 610
  because 9b46915f itself added tests (11-case rewrite + 4 new).
- tui-pi 165/165; adapters client-request-signing 9/9; bootstrap
  socket-listener 4/4; shared attach contract (root vitest) 4/4.
- Fresh dist pair (25/25) + `build:attach`; bundle grep confirmed the fix
  strings (`is ambiguous: matches`, `Use a longer prefix or the full id`)
  in `dist/zcode-attach.cjs` before promote.
- `promote-piz.sh` atomic swap to dist-runtime (17:47).
- Installed-pair smoke (real `piz` wrapper, util-linux `script` pty):
  - isolated `ZCODE_DATA_BASE_DIR` scratch ws: `piz --resume sess_bogus123`
    exits 1 with `Error: Session not found: sess_bogus123`, no TUI, and no
    session store ever created in the isolated dir (no silent create).
    Scratch core killed by its own-data-dir pid file after `/proc/<pid>/cwd`
    check; operator's live cores/clients untouched.
  - real store, `~/Documents/NewsWiki`: `piz --resume sess_99f180d5`
    (the user's exact 8-char prefix) renders the restored transcript
    (user prompt + assistant reply visible, marker ×4), banner + footer
    correct, clean exit 0 on double Ctrl-C, and zero new session rows in
    the operator's store (newest NewsWiki session still 2026-10-14).

## 2026-10-24 — promotion of the a590c7e4 pair (herdr reporter durability + footer stats-row) + promote-from-main gate

Operator policy after the earlier branch-only promotion: **piz is promoted
from `main` only**. Encoded mechanically — `promote-piz.sh` now refuses when
HEAD is not `main` or the tracked tree is dirty (both refusal paths tested;
positive path exercised by this promotion). `main` was first fast-forwarded
to the promoted 9b46915f content, then the two noon patches were rebased
onto it and ff-merged: `0e1b3d4b` (herdr reporter durability) and
`94f9dd1d` (footer stats-row right-zone <4-col bow-out), plus a lint fixup
commit (`a590c7e4`, the promoted content). One rebase conflict in FORK.md
P004 (custom-commands vs durability wording) resolved keeping both.

Battery on final main, all green unless stated:

- Root typecheck; CLI typecheck (34/34); root lint 0 errors / 96 warnings;
  CLI lint via `npm_execpath` shim: 0 errors / 71 warnings / 13 accepted
  (one new `no-useless-spread` warning from the herdr patch was fixed
  rather than carried); `architecture:check --changed` 0 violations.
- CLI suite + explicit attach files: 621 total, 618 pass, 3 fail = exactly
  the known pre-existing set. One transient `app-server-spawn` flake on a
  combined first run (56ms test); 10/10 isolated and 33/33 ×2 combined
  reruns — load flake, not a regression.
- tui-pi 166/166 (incl. the new stats-row case); adapters signing 9/9;
  bootstrap socket-listener 4/4; shared attach contract 4/4.
- Fresh dist pair (18:27-18:30) + `build:attach`; bundle greps before
  promote: `SEND_ATTEMPTS`/`HEARTBEAT_MS` ×4, resume `is ambiguous:` ×1 in
  `zcode-attach.cjs`; `MIN_RIGHT_WIDTH` ×2 in tui-pi `dist/index.js`.
- `promote-piz.sh` from clean main (gate positive path).
- Installed-pair smoke (real `piz`, pty): isolated-dir `--resume sess_bogus123`
  → `Error: Session not found`, exit 1, no TUI, scratch core cleaned by
  pid file; real-store `piz --resume sess_99f180d5` in `~/Documents/NewsWiki`
  still restores the transcript (marker ×4), footer pwd/stats rows render,
  clean exit 0, zero new session rows.
- Live herdr-socket reporting was NOT exercised (no herdr session in the
  smoke path): retry/backoff/heartbeat/argv-reuse covered by unit tests
  only; label herdr durability live behavior **unverified** until a real
  herdr pane cycle is observed.

## 2026-10-25 — promotion of the 6537f416 pair (app-server ready budget 60s + lock/ready split)

Fix for the boot-storm restore failure: herdr session restore spawned 16+
panes at once; `piz --resume` clients each spawned a shared core whose
spawn→listen exceeded the spec'd 10s ready deadline under cold-boot load;
every client timed out and SIGTERMed a core that was mid-startup.
Observed in `~/.zcode/cli/log`: six `startup.failed` with
"Protocol received SIGTERM" at 16:27:08–14Z; calm-system spawn→listen is
~2s. `session/resume` on the affected session verified live (883ms, full
snapshot) before the fix — session data was never at risk.

Change: `APP_SERVER_READY_TIMEOUT_MS` 10s→60s, and the ready window now
starts at spawn completion instead of sharing the entry/lock-wait deadline.
Spec `tui-attach-shared-core.md` updated. Merge note: the patch branch was
initially cut from `patch/tui-pi-steer-queue-parity`'s tip, so the first
ff-merge pulled the steer-queue feature into main; main was reset and the
fix rebased alone — steer stays on its own branch unpromoted.

Battery on final main, all green unless stated:

- Root typecheck; CLI workspace typecheck (34/34 turbo tasks); root lint
  0 errors / 96 warnings; CLI lint via `run-cli-lint.mjs` from repo root:
  0 errors / 71 warnings / 13 accepted; `architecture:check --changed`
  0 violations.
- CLI suite (package script): 588/591, 3 fail = exactly the known
  pre-existing set (build.test.mjs clientOnly deep-equal + 2 SEA asset
  tests). Extra attach files (resume-target, resume-fallback,
  model-option, interactions): 43/43. New regression test "full ready
  window after a contested lock wait" passes (1.5s).
- tui-pi 175/175 on rerun; first run had one transient load flake
  (`!cmd runs locally`, passes isolated and on suite rerun — same class
  as the documented 2026-10-24 flake).
- adapters signing 9/9; bootstrap socket-listener 4/4; shared attach
  contract 4/4.
- Fresh dist pair (25/25) + `build:attach`; bundle grep confirms
  `APP_SERVER_READY_TIMEOUT_MS = 6e4` and `readyDeadline = now() +
  waitForSocketMs` in `zcode-attach.cjs` before promote.
- `promote-piz.sh` from clean main.
- Installed-pair smoke (real `piz`, util-linux `script` pty): scratch
  workspace + isolated `ZCODE_DATA_BASE_DIR`, banner `piz v0.17.0`,
  footer pwd row `/tmp/piz-smoke-ws (main)` + `yolo` token; scratch core
  confirmed via `/proc/<pid>/cwd` and stopped by its own pid file.

## 2026-10-25 — promotion of the 4855b2b4 pair (steer-queue parity merged, same cycle)

Operator confirmed the steer-queue feature (`fbe7dbee`,
`patch/tui-pi-steer-queue-parity`) was meant to ship; merged to main via
`--no-ff` 4855b2b4 (busy Enter steers, Ctrl+Q queues, Alt+Up restores;
spans shared protocol schema + bootstrap server-ops + attach client +
tui-pi chords). First recorded battery for this feature; full re-run on
the merged tree, all green unless stated:

- Root typecheck; CLI workspace typecheck (34/34); root lint 0 errors /
  96 warnings; CLI lint 0 errors / 71 warnings / 13 accepted;
  `architecture:check --changed` 0 violations.
- CLI suite (package script): 594/597, 3 fail = exactly the known
  pre-existing set (build.test.mjs clientOnly deep-equal + 2 SEA asset
  tests). Suite grew by steer's 6 attach-adapter steer tests — all pass.
  Extra attach files: 43/43.
- bootstrap 9/9 (socket-listener 4 + new protocol-steer-queue 5);
  adapters signing 9/9; shared attach contract 4/4; tui-pi 185/185
  (steer added 10 tests; no flake this run).
- Fresh dist pair (25/25) + `build:attach`; bundle greps:
  `delivery:"steer"` in zcode-attach.cjs, `delivery: "steer"` +
  `steerRejected` in zcode.cjs, `APP_SERVER_READY_TIMEOUT_MS = 6e4`.
- `promote-piz.sh` from clean main; dist-runtime greps confirm both.
- Installed-pair smoke (real `piz`, pty, isolated `ZCODE_DATA_BASE_DIR`):
  banner + pwd row + `yolo` render; scratch core stopped by pid file.

NOT exercised live: an actual busy-Enter steer against a real model turn
(unit-tested end-to-end at protocol level only). Label steer UX
**unverified live** until observed in a real session.

Still NOT done: the full acceptance gate above (model turn, signing against
the real provider request, allowance evidence, Ctrl-C signal path, memory
matrix) remains open and unchanged.

## 2026-10-25 — live defect in the 4855b2b4 pair fixed and re-promoted (086f08c7 pair)

Operator's first live use of steer/queue reported both behaviors broken.
Artifact diagnosis (session `sess_0a87550a`, real data dir): the core lane
was fully correct — busy Enter sent `session/send delivery:"steer"` at
04:41:29, core queued it (`session_input` guide), promoted it into
`MessageHistory` at the next model-request boundary (04:41:37, msg seq 28),
and the model reacted to the mid-turn reminder in-request. The TUI was the
defect: `turn_steer_drained` only removed the queue-area row; nothing ever
rendered the steered input as a transcript user row (user rows came only
from local optimistic inserts), so the model visibly answered a message
that was nowhere on screen — which also made next-boundary drain read as
"it queued". Ctrl+Q replay had the same gap (flush happens below the TUI).

Fix `a40b6960` (merged `086f08c7`, client-side only, core stays queue-facts
owner): drained events' `drainedInputs` payload (contract already ships
text for exactly this) now appends transcript user rows at the stream
tail; attach flush's synthesized drained event carries the same subset;
queue rows label `Steering:`/`Follow-up:` (pi-mono parity) and busy-Enter
status says "Steering active turn." vs "Input queued.". Specs updated
first (turn-steering.md, tui-pi-frontend.md). Note: `packages/tui`
exports `dist/` — rebuild `@zcode/tui` before running tui-pi tests after
editing it, or tests run stale code (found via a misleading status
assertion failure).

Battery, all green unless stated:

- @zcode/tui 252/252 (new: drained rows in payload order, discarded,
  lane labels); tui-pi 186/186 (new: steer→drained→user-row e2e, labels);
  cli attach-adapter 29/31 (flush now asserts drainedInputs text; the 2
  failures are the known PATH-zcode set, unchanged from clean HEAD).
- Root typecheck; CLI typecheck 34/34; root lint 0 errors; CLI lint
  0 errors / 71 warnings / 13 accepted; `architecture:check --changed` 0.
- `promote-piz.sh` from clean main.

LIVE verification — the gap that shipped the bug, now closed for both
lanes, dev pair AND installed dist-runtime pair (PTY driver, real shared
core + GLM model turn in a scratch workspace): steer pending row + status
<300ms after busy Enter; drained input rendered as transcript user row;
Ctrl+Q `Follow-up:` row, replay-after-settle rendered as user row; core
`session_input` row guide/promoted. Evidence:
[evidence/2026-10-25-live-steer-dev-pair.plain.log](evidence/2026-10-25-live-steer-dev-pair.plain.log),
[evidence/2026-10-25-live-steer-installed-pair.plain.log](evidence/2026-10-25-live-steer-installed-pair.plain.log).
Driver: throwaway PTY script via repo-root node-pty (not kept). The
previous entry's "steer UX unverified live" caveat is resolved for
steer/queue rendering; timing semantics remain next-model-request-boundary
injection by design (pi-mono parity), not mid-stream interruption.

The full acceptance gate (signing against the real provider request,
allowance evidence, Ctrl-C signal path, memory matrix) remains open.

## 2026-10-27 — merges (footer verbatim + quota, transcript-polish) and promotion of the 24866159 pair

`main` fast-forwarded to `patch/pi-footer-verbatim` (`096da491`, 5 commits: verbatim
pi footer parity + core-side `usage/codingPlanQuota` cluster), then `patch/transcript-polish`
(`f4780a2b`) merged as `eb119f46`, plus test-migration fixup `24866159`; promoted from
clean main.

**Merge conflict with real content:** both main (`a40b6960`, 10-26) and transcript-polish
(`c0527374`, 10-25 + `f4780a2b` fixups, 10-27) had implemented drained-input transcript
echo in `@zcode/tui` `app-events.ts` in parallel; the auto-merge kept BOTH definitions.
Resolved to the transcript-polish reducer (strict superset): rows carry stable ids
(`messageId` ?? `pendingInputId`, idempotent under redelivery — main's id-less rows would
duplicate), sensitive prompts redacted on echo, visibility aligned with both resume
authorities. Main's payload-order test (tui) and tui-pi's `submit.test.ts` e2e migrated
to the id-carrying row shape. FORK.md P002/P003 rows composed from both sides. Note:
`tui-pi` `submit.test.ts` had passed on the branch against a **stale `@zcode/tui` dist**
(id-less era) — the documented stale-dist trap, now hit in the other direction.

Battery on merged main, all green unless stated:

- Root typecheck; root lint 0 errors / 96 warnings (baseline); CLI typecheck 34/34;
  CLI lint via `run-cli-lint.mjs` 0 errors / 71 warnings / 13 accepted (baseline);
  `architecture:check --changed` 0 violations.
- `@zcode/tui` 256/256; `@zcode/tui-pi` 243/243 (after the expectation migration; one
  earlier full-suite run showed a 496s file-level hang on `submit.test.ts` — traced to
  orphaned tsx processes from an interrupted run, not reproducible clean, 1.3s isolated).
- CLI suite: 612 tests, 609 pass. **Resolution of the "3 known pre-existing failures":**
  2 of them (`includes TUI workspace runtime package assets`, `loads TUI from an extracted
  SEA runtime dependency closure`) fail because root-workspace `packages/model-option-map/dist`
  is empty — the CLI turbo build never builds it. `mise exec -- pnpm run build` in that
  package makes both pass (`build-sea.test.mjs` 42/42). Only
  `desktop agent builds minify the app-facing JS bundle` (clientOnly deep-equal) remains
  a genuine known failure. Future batteries should build model-option-map first.
- Attach extras 44/44; adapters signing 13/13 (grown from 9); bootstrap socket-listener
  4/4; shared attach contract + new quota schema 8/8 (root vitest).
- Fresh dist pair (25/25) + `build:attach`; bundle greps: `TranscriptMarkdown` ×6 and
  `quotaSnapshot` ×2 in tui-pi dist, `usage/codingPlanQuota` in `zcode.cjs` and
  `zcode-attach.cjs`, polish reducer + redaction in tui dist.
- `promote-piz.sh` from clean main (gate positive path).
- Installed-pair smoke (real `piz`, util-linux `script` pty, scratch git ws + isolated
  `ZCODE_DATA_BASE_DIR`): banner `piz v0.17.0`, footer pwd row `/tmp/piz-smoke-ws4 (main)`
  + `no-model • yolo` (incl. the `•` identity separator), and the quota cluster surfacing
  an honest diagnostic under no-credentials:
  `[tui-pi] quota refresh failed: no coding-plan provider with an API key in the registry`
  — no crash, cluster degrades, core exited with the client, no scratch leftovers.

NOT exercised live (unverified): a real GLM turn against the promoted pair, the quota
cluster rendering actual account values (needs the operator's provider config), and the
narrow-table/json-fence rendering against real model output in a live session. Full
acceptance gate (signing against the real provider request, allowance evidence, Ctrl-C
signal path, memory matrix) remains open and unchanged.

## 2026-10-28 — quota cluster account channel + failure-diagnostic dedupe (branch `patch/quota-account-channel`, `a306dd50`)

Problem observed live: with GLM Coding Plan via account login (the operator's
default model `GLM-5.3` on `account:zai-individual-coding-plan`), the footer
quota read threw `no coding-plan provider with an API key in the registry` on
every ~60s poll — the core resolver only accepted API keys held in provider
config and explicitly skipped zhipu-account access — and the tui-pi cluster
echoed each failure to stderr with no dedup or backoff: a permanent state as an
endless log wall. Design reference: pi provider-balance (same endpoint, same
credential as chat; no-credential is a silent state; failures back off 60s
machine-wide and report to a file, stderr only when headless).

Fix: core-side `resolveCodingPlanQuotaProvider` now also accepts entitled
`individual-coding-plan` account providers, resolving plan credentials through
`providerRuntimeHeadersPort.refreshBeforeModelRequest` (the same owner model
requests use; manual plan key or OAuth-derived project token), plumbed via
create-app → session-facade. Resolver absence/null/throw falls through to the
next candidate; team/start/off-peak plans stay out of this channel (desktop's
own usage services own those). Client-side `QuotaCluster` dedupes failure
diagnostics per message (one line per failure episode; new message or
successful landing re-arms) and idle ticks back off 60s after a failure while
turn-edge/startup/reset refreshes still attempt.

Checks run on the branch:

- Bootstrap `coding-plan-quota.test.ts` 14/14 (new: account resolver happy
  path with accountAccess shape asserted, null/throw fall-through to later
  API-key candidates, non-entitled/team/start account access skipped,
  fetch-level Bearer of the resolved plan key).
- tui-pi suite 244/244 (new: same-message failure diagnosed once; idle
  `refresh(true)` inside the 60s window skipped; authoritative turn-edge still
  fetches; backoff expiry resumes idle fetches; message change logs a new
  line; success re-arms diagnostics for the next episode).
- CLI `attach-adapter` + `tui-quota-query` 42/42; root typecheck (incl.
  desktop projects) and CLI typecheck clean; `architecture:check --changed`
  0 violations; bootstrap/tui-pi lint introduce no new findings (bootstrap
  lint exit-1 is the pre-existing `transcript-hydration.ts` max-lines error).
- **Live observation (real credentials, never printed):** a scratch probe ran
  the exact new path against the real credential store and endpoint —
  `resolver called for account:zai-individual-coding-plan model=GLM-5.3`,
  port resolved a credential (length 49), and
  `https://api.z.ai/api/monitor/usage/quota/limit` returned
  `level="pro"`, `CREDIT_LIMIT unit=3 number=5 percentage=14` (5h window,
  14% used) and `unit=6 number=1 percentage=91` (7d window) with
  `nextResetTime` values — the same wire pi's provider-balance consumes.
  The cluster will render these as `5h: 86% ↻… · 7d: 9% ↻…`.

Unrelated failures observed (pre-existing, reproduced identical at baseline):
bootstrap full-suite under load flakes in `session-persistence` (2),
`v4-gateway` oversize-projection, `v4-native-interaction-background` dwf
cancel, and intermittently `workflow-fault-matrix.retry` /
`protocol-unbound-resume` / `dynamic-workflow-run-service` /
`fault-matrix-harness` / `plugins` — all pass in isolation both on the branch
and at baseline; contention-related, not quota-related.

NOT exercised live (unverified): the promoted-pair smoke (this branch is not
promoted; `piz` still runs the 24866159 pair until merge + promotion), and the
rendered footer cluster in a real piz session against the account values.

## 2026-10-28 — promotion of 8fd13a43 (quota account-channel merge)

The 2026-10-28 verification above ran on `patch/quota-account-channel`; the
merge `8fd13a43` carried that tree to `main` unchanged (merge-commit only, no
conflict edits). Promotion path:

- `mise exec -- ../../node_modules/.bin/turbo run build --filter=@zcode/cli...`
  from `apps/zcode-cli` — 12/12, cache misses on `tui-pi`, `bootstrap`, `cli`
  (rebuilt with the fix); `tui` replayed from cache.
- Freshness spot-check on built output (the recurring stale-dist trap):
  `lastFailureMessage`/`FAILURE_BACKOFF` present in `tui-pi/dist/index.js` and
  the frozen `dist-runtime/node_modules/@zcode/tui-pi/dist/index.js`;
  `zhipu-account`/`individual-coding-plan`/`refreshBeforeModelRequest` present
  in `cli/dist/zcode.cjs`.
- `sh apps/zcode-cli/scripts/promote-piz.sh` from clean `main` — promoted
  `cli/dist` + tui-pi/tui snapshots to `dist-runtime/`.

NOT exercised live (unverified): a real `piz` session against the promoted
pair — the footer cluster rendering the account-channel values and the
stderr-quiet steady state still need one observed run. Expected: the quota
read resolves through `account:zai-individual-coding-plan` and renders
`5h: … ↻… · 7d: … ↻…`; if it still fails, the failure now costs exactly one
stderr line per episode instead of a wall.

## 2026-10-29 — attach footer session seeds (patch/attach-footer-seed)

Branch `patch/attach-footer-seed` (not merged, not promoted — `piz` still
runs the previous frozen pair). Checks actually run and observed:

- `pnpm --dir apps/zcode-cli typecheck` (turbo via PATH-injected
  `node_modules/.bin`): 34/34 tasks, 0 errors.
- CLI lint via `node ~/.local/share/pnpm/.tools/pnpm/10.33.2/node_modules/pnpm/bin/pnpm.cjs
  --dir apps/zcode-cli lint`: 0 errors, 71 warnings (all pre-existing
  upstream; the two `no-useless-fallback-in-spread` findings this branch
  introduced were fixed before commit). Running pnpm.cjs directly is an
  equivalent npm_execpath fix to the documented env route.
- tui-pi `status-line.test.ts` 31/31 (new: seed-lands-after-reset ordering,
  seed+live fold continuation, `model_complete` payload.contextWindow,
  model-catalog contextWindow fallback incl. provider-mismatch guard,
  accumulator↔`summarizeSessionUsageTotals` drift gate); `footer.test.ts` +
  `smoke.test.ts` 8/8.
- cli `attach-adapter.test.ts` 43/43 (new: durable sink migration on
  `/resume`, `/resume` result carries projection+usageTotals seeds,
  `sessionSnapshotSeed` runtime→projection fallback).
- contracts `session-usage-totals.test.ts` 4/4 (fold semantics:
  model_complete+failed-request set, latest-hit-rate ordering, sparse
  usage, event-free → undefined).
- bootstrap `zcode-protocol.test.ts` 128/128 (new: snapshot
  `runtime.usageTotals` folded from the session eventStore).
- `pnpm architecture:check --changed`: 0 violations. `attach-session.ts`
  breached the 800-line cap during the patch; transcript/seed projections
  were extracted to `attach-projection.ts` (real separation, back at 747).

NOT exercised live (unverified): a real `piz` session — the footer cluster
against an actual attached/resumed session still needs one observed run
after merge + promotion. The fold is runtime-ledger scoped: sessions
materialized after a core restart only fold events present in the
eventStore (same window as `runtime.contextUsage`), not full persisted
history.

## 2026-10-29 — two-row footer restore (same branch)

Same `patch/attach-footer-seed` branch, follow-up to the seed work above:

- tui-pi suite 250/250 (rewrote the row-count and quota-placement
  regressions for the two-row layout; new: meta-row composition cwd + usage
  + ctx | identity, activity-row quota right-zone with fit-or-drop).
- `pnpm --dir apps/zcode-cli lint`: 0 errors, 71 warnings (unchanged set).
- `pnpm architecture:check --changed`: 0 violations.

NOT exercised live (unverified): rendered two-row footer in a real `piz`
session — layout/widths verified against formatter + component tests only.

## 2026-11-01 — merge + promotion of 158a31d2 (patch/compact-context-window)

`main` merged `--no-ff` `158a31d2` from `patch/compact-context-window`
(2 commits, 24 files: additive `compactContextWindow` on `session/create`/
`session/resume` + `session/setCompactContextWindow`; core
`compact.contextWindowCap` = min(cap, model window), compaction-only; piz
attach sets 262_000 for `/^glm-/i` models, follows switches/resume; spec
compact/plan.md M2.1). No conflicts. Battery on merged main, all green:

- Root typecheck; root lint 0 errors / 96 warnings (baseline);
  `architecture:check --changed` 0 violations.
- CLI typecheck 34/34 (turbo, all cache hits — same tree verified on the
  branch); CLI lint via `run-cli-lint.mjs` 0 errors / 71 warnings /
  13 accepted (baseline).
- bootstrap `zcode-protocol.test.ts` 131/131 (new: compactContextWindow on
  create/resume ops + setCompactContextWindow dispatch incl. -32601 on old
  cores); core `compact-policy` + `runtime-compact-context-window-cap`
  33/33; cli `attach-adapter` + `attach-model-option` 67/67 under
  `env -u ZCODE_WORKSPACE_IDENTITY` (new: GLM predicate, 262000 sent on
  create/resume/setModel, null-clear on non-GLM, single-sync dedupe,
  mid-switch cap follow with silent -32601); shared `zcodeProtocol.test.ts`
  85/85 (root vitest; new field schema).
- Fresh dist pair: `turbo run build --filter=@zcode/cli...` 12/12 (cache)
  + `build:attach`; freshness greps — `compactContextWindow`×11,
  `setCompactContextWindow`×7, `contextWindowCap`×5 in `zcode.cjs`;
  `compactContextWindow`×6, `setCompactContextWindow`×1,
  `GLM_COMPACT_CONTEXT_WINDOW = 262e3` in `zcode-attach.cjs` (esbuild
  rewrites `262_000` as `262e3` — grep both spellings).
- `promote-piz.sh` from clean `main`; identical greps confirm frozen
  `dist-runtime` copies.

NOT exercised live (unverified): a real `piz` GLM session showing
auto-compact triggering at ~262K rather than the model's 1M window — needs
an observed long session; the cap wire path is test-verified end-to-end
(client → protocol → core policy) only. Old-core `-32601` fallback is
unit-tested, not observed live. Full acceptance gate (signing against the
real provider request, allowance evidence, Ctrl-C signal path, memory
matrix) remains open and unchanged.

## 2026-11-02 — merges + promotion of f1a0c45e (spill / aliases / footer gauge)

`main` merged `--no-ff` in stack order: `aaec6bcf`
(patch/shell-output-spill) → `22036063` (patch/shell-escape-aliases, with
both review fix-passes rebased) → `f1a0c45e` (patch/footer-compact-gauge,
likewise). Battery on merged main, all green:

- `architecture:check --changed` 0 violations.
- tui-pi 265/265 + typecheck + oxlint (spill semantics + char/line
  boundaries + control-char ordering, interactive `$SHELL +m -ic` alias
  resolution + head-limited noise strip + fallback chain hermeticity,
  `effectiveContextUsage` clamp + footer/panel gauge rendering).
- shared `zcodeProtocol.test.ts` 85/85 — root vitest is pre-existing-broken
  (`vitest.config.ts` references deleted `packages/zcode-cua/
  vitest.config.ts`); ran via a temp config inside `packages/shared`
  (removed after). Not caused by these merges; still open.
- cli attach 74/74 (attach-model-option/attach-adapter/attach-client) +
  CLI typecheck, under `env -u ZCODE_SERVER_BIN -u ZCODE_WORKSPACE_IDENTITY
  -u ZCODE_ATTACH_CORE -u ZCODE_RUNTIME_ENV -u ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  -u ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE
  -u ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` — ambient zcode-family session env
  otherwise leaks into the spawned-core path and dooms the fake core
  (pre-existing harness fragility, first hit while verifying this stack).
- `mise exec -- ../../node_modules/.bin/turbo run build --filter=@zcode/cli...`
  from `apps/zcode-cli` — 12/12 (10 cached) + `pnpm run build:attach` in
  `packages/cli`.
- Freshness greps on `cli/dist`, then identical greps on the frozen
  `dist-runtime` copies after `sh apps/zcode-cli/scripts/promote-piz.sh`
  from clean `main`: `"+m","-ic"`×1 and the job-control noise string ×1 in
  `tui-pi/dist/index.js`; `262e3`×1 and `GLM_COMPACT_CONTEXT_WINDOW`×2 in
  both `tui-pi/dist/index.js` and `zcode-attach.cjs`;
  `compactContextWindow`×6 in `zcode-attach.cjs`; `contextWindowCap`×5 in
  `zcode.cjs`.

NOT exercised live (unverified): a real `!gs` in a piz session, the footer
`%/262k (auto)` gauge in a live GLM session, auto-compact firing at ~262K
in a live session, and the old-core `-32601` fallback against a genuinely
old core — all are test-verified (client → protocol → core policy; runner →
spill/block/display) but not observed live. Live cores keep the previous
footer denominator and non-interactive `!` resolution until the next `piz`
launch against a restarted core; do not restart live cores. Full acceptance
gate (signing, allowance evidence, Ctrl-C, memory matrix) unchanged.

## 2026-11-02 — merges + promotion of 5f36e28b (exit-resume hint + auth-failure diagnostics)

`main` merged `--no-ff` `74883fe1` (patch/exit-resume-hint: attach
exit-resume hint, feature + review fix-pass + suite stability) and
`5f36e28b` (patch/auth-failure-diagnostics: 401/403 provider log payload,
built concurrently by a second agent and included on operator instruction).
Battery on final main, all green unless stated:

- Root typecheck; root lint 0 errors / 96 warnings (baseline);
  `architecture:check --changed` 0 violations; CLI workspace typecheck
  34/34 turbo tasks (6 rebuilt for the adapters change); CLI lint via
  `run-cli-lint.mjs`: 0 errors / 71 warnings / 13 accepted (baseline).
- CLI suite (package script) **620/620 pass, exit 0** + explicit
  `attach-resume-target.test.ts` 11/11, with the extended env-stripping
  list: `env -u ZCODE_SERVER_BIN -u ZCODE_WORKSPACE_IDENTITY
  -u ZCODE_ATTACH_CORE -u ZCODE_RUNTIME_ENV
  -u ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  -u ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE
  -u ZCODE_PERSONAL_PROVIDER_CONFIG_FILE -u HERDR_ENV -u HERDR_PANE_ID
  -u HERDR_BIN_PATH`. Strip the `HERDR_*` trio too when running attach
  tests inside zcode-family/herdr sessions (ambient `HERDR_*` activates
  the reporter path; the new exit-hint harness pins its own scrubbing).
- Suite-stability resolution: the "3 known pre-existing failures" set
  (build.test.mjs clientOnly deep-equal + 2 SEA asset tests) is fixed on
  main by `6e16e0ce` — assertion tracks the current `resolveBuildOptions`
  shape (incl. a new `--client-only` case); SEA tests pass in this
  checkout. Also fixed: opentui login-render test budget 5s→30s (3.5s
  idle / 5.0–6.4s under suite parallelism), headless 20ms-cleanup
  wall-clock bounds <200→<2000 (632ms observed under load), and
  `app-server-spawn` registration-file reads now poll for **non-empty**
  content (server writes `.pid/.info/.marker-env` after socket-listen by
  contract, and `writeFile` creates an empty file before writing — both
  races produced ENOENT and a spurious `'' !== '1'` under load).
- Adapters vitest (full suite, `pnpm exec vitest run tests`): 2275 passed,
  4 skipped, 16 failed across 8 files under the parallel-with-cli-suite
  worst case; the same 8 files re-run together → 4 failures; each failing
  file in true single-file isolation → 100% green (8/8, 6/6, 4/4, 46/46).
  Same documented load-flaky class as 2026-10-28 (real-process bash
  shutdown / SQLite concurrency / MCP OAuth cross-process); builder's
  independent report observed the identical set. `client-request-signing`
  passed inside the full run (mandatory signing gate covered).
- Fresh dist pair: `turbo run build --filter=@zcode/cli...` 12/12 +
  `build:attach`. Freshness greps before promote: `Resume this session
  with` ×1 and `formatExitResumeHint` ×2 in `dist/zcode-attach.cjs`;
  `providerErrorType|providerResponseBody` ×4 and
  `providerAuthFailureLogFields` ×3 in `dist/zcode.cjs`.
- `promote-piz.sh` from clean `main` (gate also fired correctly mid-cycle:
  refused with HEAD on `patch/auth-failure-diagnostics` + dirty tree before
  any swap; `dist-runtime` verified unchanged at that point). Identical
  greps on the frozen `dist-runtime` copies after promotion (hint ×1, auth
  fields ×4, `GLM_COMPACT_CONTEXT_WINDOW` ×2 carried from f1a0c45e).
- Installed-pair smoke (real `piz` wrapper, util-linux `script` pty,
  scratch workspace + isolated `ZCODE_DATA_BASE_DIR`, full env-stripping):
  boot → banner → double Ctrl-C → exit 0 with the hint printing
  `Resume this session with:` / `piz --resume sess_46a36f22-0932-4a9e-…`;
  the printed command then run verbatim under a pty → exit 0 and the same
  id re-hinted, proving the resume path bound the persisted session (an
  explicit-resume failure exits 1 with `Session not found` before any TUI).
  Scratch core killed via its own socket `.pid` file after a
  `/proc/<pid>/cwd` scratch-only check; no scratch processes remain;
  operator's live cores/clients untouched.

NOT exercised live (unverified): the hint after a real model turn; the
monolith `zcode attach` hint wording (unit-tested only); the auth-failure
payload against a real 401/403 (redaction/bounds/cause-chain are
test-verified only) — a live core keeps the previous logging until its
next start; do not restart live cores. Full acceptance gate (signing
against the real provider request, allowance evidence, Ctrl-C signal
path, memory matrix) remains open and unchanged.


## 2026-11-03 — SendMessage queue no longer drops messages (patch/subagent-sendmessage-queue)

Branch `patch/subagent-sendmessage-queue` from `main` `610d1fd3` (not merged,
not promoted — `piz` still runs the previous frozen pair; no core restarted).
Spec: [tool/07-subagent.md](../../apps/zcode-cli/docs/design/v2/tool/07-subagent.md)
"Rejected messages and terminal-state close-out (fork)".

Defect (from reading the code, not observed live): a SendMessage steer that the
winding-down child turn rejected (`turn_not_steerable` / `no_active_turn`) was
queued and reported `queued`; the queue was only flushed at sink registration
and stripped at terminal, so the message was lost. The no-sink case had the
same fate: the registration flush retries `no_active_turn` for about 200ms,
but the first turn does context init, SessionStart hooks and submission state
before `beginActiveTurn`. The 200ms figure comes from reading
`message-steering.ts`; startup latency was not measured.

Checks actually run and observed:

- New `core/tests/subagent-sendmessage-queue.test.ts`: 9/9 pass. All 9 fail
  with the `src` diff reverse-applied (queued text, 4× no redelivery timeout,
  2× missing not-delivered note, 2× steer-retry race returning `queued`).
- Core typecheck (`turbo run typecheck --filter=@zcode/core`, deps from
  turbo cache): clean.
- CLI lint (`npm_execpath=…/pnpm/10.33.2/…/pnpm.cjs mise exec -- node
  scripts/run-cli-lint.mjs` from the repo root; `pnpm --dir apps/zcode-cli
  lint` overrides `npm_execpath` back to the ELF and fails): 0 errors,
  71 warnings (same count as 2026-10-29), none in touched files.
- `pnpm architecture:check --changed` (after commit): OK, 0 violations.
- Core vitest full suite: 4177 passed, 22 skipped, 4 failed. All 4 failures
  were 5s timeouts under load:
  - `deferred-call-todo-runtime`: 2 tests. Re-run alone, `stream=on` still
    times out. With the fix reverse-applied it also times out: run 1 failed
    both modes, run 2 failed `stream=on`. So this failure predates the change
    and comes from load or timing.
  - `mcp-tool-bridge` (oversized image): 1 test, passes on rerun.
  - `tool-search-local-runtime` (`stream=off`): 1 test, passes on rerun.
- `git merge-tree` against `lead-sidekick`: the merge is clean after
  moving the `undeliveredMessages` option below the session callbacks.
  The merged tree was not typechecked. Sidekick queued messages carry no
  redelivery context, so terminal drain only logs them, which leaves
  sidekick behavior unchanged.

NOT exercised live (unverified): a real child turn rejecting a steer and
the background resume that follows; the model's reading of the new
`queued` text and notification notes; the startup window timing.

Open items:
- Rewind drops, conservatively, every message queued on an older branch
  generation.
- A not-delivered notice for a task whose own branch generation is stale is
  dropped by the existing per-taskId branch fence.
## 2026-11-02 — upstream sync battery (sync/2026-10-30-a60ba6a7, tree 1ce50ce3)

Full battery for the 3.17.1 sync; results summary in
[FORK.md](../../FORK.md) maintenance log. New invocation notes:

- Root vitest is now manifest-driven (`engineering-test-files.json`,
  upstream's app-test retirement). The fork's shared protocol/signing tests
  run via `mise exec -- pnpm exec vitest run --project engineering
  packages/shared` after adding the four entries to the manifest (the old
  `packages/*/test/**` discovery include is gone).
- tui-pi tests must run from a cwd shorter than the 80-col fixtures: 4
  footer/harness-flush tests fail when the cwd label alone crowds out the
  status text (this herdr worktree path is ~73 cols). Run
  `tsx --test <pkg>/tests/*.test.ts` from `/tmp`, plus
  `tests/terminal-drain.test.ts` from the package dir (its pty test needs
  the package cwd). 265/265 in that split; not a code regression.
- `architecture:check --changed` now admits fork files absent from
  upstream's refreshed snapshot; `status-line.test.ts` was trimmed 811→798
  lines (import compaction, same coverage) for the max-file-lines cap.
- `pnpm fmt:check` (oxfmt) reports ~1655 upstream files with format drift
  after the sync — upstream-wide, not gated for this fork's batteries, and
  deliberately not reformatted inside the sync merge.

## 2026-11-03 — merges + promotion of e37ed9d9 (session health + lean test gates)

`patch/session-startup-health` merged `--no-ff` as `9abdd086`
(draft-safe `session/subagents`, no-plugin discovery gating, numeric usage
log counters). During verification, `patch/lean-test-gates` was merged on
top as `a8254e2a`; promotion used current clean `main`. The full bootstrap
run exposed a new-test scope error (project config strips
`plugins.enabled`), fixed on main as `e37ed9d9` by moving the disabled
case to user config. Battery on final main, all green unless stated:

- Dependencies restored with `mise exec -- pnpm install --frozen-lockfile`
  (the post-sync checkout lacked new workspace links; no manifest/lockfile
  change). Root typecheck passed; CLI typecheck **36/36**; root lint
  **0 errors / 83 warnings**; CLI lint **0 errors / 74 warnings / 7
  accepted**; `architecture:check --changed --base a27f62f4` **0**
  violations (broad `zcode-cli` remains unmanaged).
- Full CLI-workspace tests completed in batches: adapters **2529**,
  bootstrap **3369** (0 new, 5 known, 21 stale known entries now passing),
  contracts **342**, core **4681**, dynamic-workflow **2034**,
  dynamic-workflow-runtime **100**, all other vitest packages 0 new
  failures (**13,420** vitest results total); node:test suites CLI
  **637/637 + 11/11**, tui **256/256**, tui-pi **265/265**,
  plugin-creator **8/8**. Signing and socket-listener always-run gates are
  included. One first-pass dynamic-workflow stack-trace failure passed its
  solo rerun; the post-fix bootstrap rerun had 0 new failures.
- Fresh pair: CLI graph **12/12** + `build:attach` + root
  `@zcode/model-option-map`. Freshness greps in `dist/zcode.cjs` and
  frozen `dist-runtime/zcode.cjs`: `isSessionPersisted` ×6, `noPlugins`
  ×16, `usageInputTokens` ×2, `NUMERIC_USAGE_FIELDS` ×3.
- `promote-piz.sh` from clean `main` at `e37ed9d9`.
- Installed-pair smoke (real `piz`, pty, scratch workspace + isolated
  `ZCODE_DATA_BASE_DIR`): boot → double Ctrl-C → exit 0 with hint
  `piz --resume sess_3e4ef4d4-8432-4d2e-a1c6-bf3d84446505`; printed command
  run verbatim → exit 0 and same id re-hinted. Scratch core stopped via
  its own pid file after `/proc/<pid>/cwd` + socket-info workspace checks;
  operator live cores/clients untouched.

NOT exercised live (unverified): a real model turn, live signing or
extra-usage allowance evidence, snapshot latency improvement, Ctrl-C
signal path, and the client-count memory matrix. Do not restart live cores;
core-side fixes apply at each core's next start.

## 2026-11-03 — re-port of patch/subagent-sendmessage-queue onto main 83fc4e65 (3.17.1 sync)

Merge commit `70fc5f3b` (`fork: merge main into patch/subagent-sendmessage-queue`,
parents `967a6b07` + `83fc4e65`; merge, no rebase, no history rewritten; not
merged into `main`, not pushed, not promoted, no core restarted). Four
conflicts, resolved semantically, not by taking a side wholesale:

- `packages/core/src/subagent/completion-notification.ts`: main's 3.17.1
  rewrite kept intact (`agentType` gone, `stopped` → `killed` + `stoppedBy`,
  `Agent "<description>" finished / failed: <reason> / was stopped…` summary,
  structured `localAgentSubagentResult`). The branch's `note` input is
  re-homed into `formatLocalAgentOutcome`: summary becomes
  `<outcome>. <note>` when a note is present; the note never enters the
  structured result. No-note notifications are byte-identical to main's.
- `packages/core/src/subagent/runner.ts`: branch drain/redelivery logic
  interleaved with main's shutdown tracking. `UndeliveredMessageContext`
  now carries the port's `track` (`TrackSubagentWork`); `handleRejectedRunningMessage`
  and `redeliverUndeliveredMessages` pass `context.track` into
  `resumeTerminalAgentInBackground`, and every fire-and-forget redelivery
  (`trackRedelivery`) is registered in the same tracking set, so `close()`
  cannot return before a terminal-drain resume is registered. Notifications
  are built as main's `LocalAgentTaskNotificationInput` objects (with `note`,
  and `stoppedBy: stopped.initiator` on the killed path) and enqueued through
  main's `enqueueBackgroundNotification`. The resume path keeps main's
  description fix (summary no longer becomes the task description).
  Invariants preserved: single owner `registry.pendingMessages`, synchronous
  drain at terminal settlement, stale-branch partition + log,
  restore-on-failed-resume notification (`restoreTaskAfterFailedResume`).
- `docs/design/v2/tool/07-subagent.md`: both sides kept — main's SendMessage
  schema bullet and the branch's never-silently-dropped bullet; the fork
  section now names post-merge APIs/statuses (`note` → summary via
  `formatLocalAgentOutcome`, distinct from the fixed `<note>` element;
  `failed / killed` with `stoppedBy` wording; `track` threading).
- This file: both sides' records kept (append-only).

Checks actually run on the combined tree (env stripped with
`env -u ZCODE_SERVER_BIN -u ZCODE_WORKSPACE_IDENTITY`, pinned mise tools):

- Focused `core/tests/subagent-sendmessage-queue.test.ts`: **9/9 pass**,
  assertions unchanged — `<status>failed</status>` survives main's format,
  and the stopped-child expectation now matches through the `killed`
  registry status (`describeTaskEnd` → "was stopped").
- First neighbouring run (`subagent-explore` + `background-task-control` +
  `subagent-background`) failed 49 tests with
  `TypeError: modelDescriptorOf is not a function`: this worktree's
  `packages/contracts/dist` predated the 3.17.1 sync (source has the export,
  dist did not). Diagnosed as a stale-dist precondition, not a code failure.
  After `turbo run build --filter=@zcode/core` (4 tasks), the four suites
  together pass **154/154** (queue 9, background-task-control 62,
  subagent-explore 54, subagent-background 29).
- Core typecheck (`turbo run typecheck --filter=@zcode/core`): clean.
- `pnpm architecture:check --changed`: OK, 0 violations (script reports its
  base as merge-base origin/main).
- `oxlint` on the three touched core source files: exit 0, no findings.
- Fork selected runner (`mise exec -- node apps/zcode-cli/scripts/fork-tests.mjs`,
  base `83fc4e656f`): core **3184 tests, 0 new / 0 known / 0 flaky**,
  bootstrap selected 8, adapters signing always-run 13, bootstrap
  socket-listener always-run 4, browser-use/node-repl/provider-regression 0
  selected. `@zcode/cli` was first NOT RUN (missing `dist/zcode.cjs`,
  exit 1 — reported as a precondition, not a pass). After building the CLI
  graph (26 turbo tasks) + `@zcode/model-option-map` + `tsc -b` for the root
  `packages/shared` / `packages/model-option-map` dists, a `--package
  @zcode/cli` rerun first showed 640/642 (2 `build-sea` failures, missing
  root `@zcode/shared` dist — same missing-dist class; `build-sea.test.mjs`
  then passed 42/42 standalone) and the final `--package @zcode/cli` run
  **passes** (642 package-script tests + 11 attach-resume-target tests).

NOT RUN / unverified: the full (non-selected) core suite; a live child turn
rejecting a steer and the background resume that follows; live signing /
extra-usage allowance evidence; promotion and installed-pair smoke (not
this branch's job). The branch-era claim "all 9 fail with the fix reverted"
was not re-run against the merged tree.

Open items (carried from the branch record, unchanged): rewind drops every
message queued on an older branch generation; a not-delivered notice for a
task whose own branch generation is stale is dropped by the existing
per-taskId branch fence.

## Promotion ffc79107 (2026-11-06)

`--promote-gate --base 315d9ff1 --max-workers 2` took the full tier: 13,260
vitest results, 0 new, 2 known, 4 flaky (passed on isolated rerun). `typecheck:piz`,
lint (0 errors, 83 warnings) and architecture checks passed. Pty smoke with an
isolated data dir on `dist` and on promoted `dist-runtime`: boot, double Ctrl-C,
exit 0 with a resume hint. Not observed: a live model turn, signing or allowance
behaviour, or a live core restart.

## Promotion a68e1a1d (2026-11-07)

`main` merged `--no-ff` `patch/short-model-aliases` (short `--model` names;
feature `7a31c5e5`, piz review `b95b575f`).

- `--promote-gate --max-workers 2` (base `ffc79107` from `PROMOTED_FROM`)
  took the full tier: 13,260 vitest results, 0 new, 2 known, 3 flaky (all
  green on the isolated rerun); cli/tui/tui-pi package scripts pass.
  `typecheck:piz` passed; root lint 0 errors / 83 warnings and CLI lint
  0 / 74 / 7 (both exact baselines); `architecture:check --changed` 0
  violations.
- **Shared-checkout contention:** an ACP worker committed `99e5646d`
  (`patch/acp-reasoning-effort`, cli `src/acp/*` only) into the same checkout
  mid-battery and left HEAD on its branch. Every gate package except
  `@zcode/cli` has identical sources on both trees, so those results stand.
  After the worker's session ended, the checkout went back to clean `main`,
  the cli graph + `build:attach` were rebuilt from the exact `a68e1a1d` tree,
  and the `@zcode/cli` suite re-ran green against that rebuild
  (682/682 + attach-resume-target 11/11). Promotion used that rebuild.
- Freshness greps, identical on `dist` and the frozen `dist-runtime`:
  `Select a supported reasoning effort for` ×1 and
  `prefer the session's current provider` ×1 in `zcode-attach.cjs`; ACP
  branch tokens (`acp reasoning effort changed`, `thoughtLevelOption`) ×0 in
  both bundles — main-only content promoted, per the promote-from-main
  policy. `PROMOTED_FROM` = `a68e1a1d` verified.
- Installed-pair smoke (real `piz`, scratch git ws, default data dir for the
  real catalog, session env stripped): `--model 'glm-5.3$bogus'` exits 1
  pre-TUI with `Select a supported reasoning effort for
  account:zai-individual-coding-plan/GLM-5.3: low, high, max`; pty boot of
  `piz --model glm-5.3` renders banner `models: GLM-5.3, GLM-5.3-Flash`
  (lowercase resolved to catalog spelling), footer `?/200k (auto)`, status
  `GLM-5.3 • …`, double Ctrl-C → exit 0 with the resume hint
  (`sess_e03779f9…`). Scratch core killed after `/proc/<pid>/cwd` +
  `.sock.info` workspaceIdentity checks; socket files removed; one deferred
  scratch session record remains in the operator's store (same class as the
  2026-10-24 model-flag smoke). Logs: `/tmp/piz-smoke-shortmodel.{a,b}.log`.

NOT exercised live (unverified): a real model turn on the resolved model
against the provider. Full acceptance gate (signing, allowance evidence,
Ctrl-C signal path, memory matrix) unchanged. `99e5646d` (ACP reasoning
effort) is merged nowhere and not promoted.

## 2026-11-08 — merge + promotion of 18b39eca (one shared core across all clients)

`main` merged `--no-ff` `fix/edit-from-here-last-message` as `18b39eca`
(`Closes #10`): the shared core is now ONE process per data root
(`<dataBaseDir>/.zcode/v2/sockets/core.sock`), started on Linux as a transient
`systemd --user` service `piz-core-<sha256(socket)[:16]>.service` via
`ensureServer` (no detached client-owned spawn; non-Linux Unix reuse-only with
explicit error; win32 unsupported). Workspace identity is session-scoped only.
Isolated source-integration verification (real service manager, ACP X/Y/Z +
terminal attach, original-scope retirement with unchanged MainPID/InvocationID,
adoption, list isolation, loopback-only core namespace):
`docs/fork/reports/2026-11-08-single-core-live-verification.md` (2/2 runs,
102 assertions each). Promotion battery on merged main:

- Build: CLI graph 12/12 + `build:attach` + root `@zcode/model-option-map`.
  Freshness greps ×1 each in `dist/zcode-attach.cjs`: `piz-core-`, `core.sock`,
  `expand-environment=no`, `UnsetEnvironment`, `service-type=exec`; ×6
  `scope: "user"` in `dist/zcode.cjs`.
- `fork-tests.mjs --promote-gate --max-workers 2` (base `4caa31d5` from
  PROMOTED_FROM): **13,350 vitest results, 0 new failures**, 2 known
  (v4-gateway oversize, telemetry-lifecycle), 5 flaky (all green isolated
  rerun — the documented load class). cli/tui/tui-pi package scripts pass.
- `typecheck:piz` passed; `architecture:check --changed` 1 violation =
  baseline, 0 new; root lint 0 errors / 84 warnings (baseline 83; the extra
  warning is not in any file this merge touched); CLI lint 0 errors /
  74 warnings / 7 accepted (exact baseline). Gate log:
  `/tmp/piz-promote-18b39eca/gate.log`, run dir `/tmp/piz-fork-tests-run-SP5JE0`.
- `promote-piz.sh` from clean `main` at `18b39eca`; identical greps on frozen
  `dist-runtime`; `PROMOTED_FROM=18b39eca`.
- Installed-pair smoke (real `piz`, pty, scratch git ws + isolated
  `ZCODE_DATA_BASE_DIR`): TUI boots (banner, footer pwd row + `quota !`
  degraded cluster, no credentials in the isolated env); the core came up as
  transient `piz-core-7abf2a3308b6c443.service` — `.info` = new schema
  `{"version":"0.17.2","scope":"user",socketPath,startedAt}`, `.pid` ==
  MainPID, `--cwd` = neutral data root — and SURVIVED the client's death
  (client killed externally; core still active 2+ min later, detached-session
  adoption window by design). Scratch service stopped after identity check
  (MainPID == `.pid`, cwd == scratch root); socket removed on close.
- Also observed post-promotion: a real client outside this session had
  already started the operator's real shared core
  (`piz-core-07359b7ae1597acd.service` on `~/.zcode/v2/sockets/core.sock`,
  dist-runtime pair) — the fix operating in production; not touched.

NOT exercised live (unverified): the TUI double-Ctrl-C/resume-hint exit path
in this smoke (the pty injection missed; unchanged by this merge and covered
by previous promotions), a real model turn, live signing/allowance evidence,
Ctrl-C signal path, memory matrix. Old per-workspace `core-<hash>.sock` cores
keep running until their clients drain them; do not restart live cores.
Full acceptance gate unchanged.
