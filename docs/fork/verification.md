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
