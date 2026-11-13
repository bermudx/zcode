# Single shared core — implementation report

Date: 2026-11-08
Branch: `fix/edit-from-here-last-message` (base `cf61a95d`)
Issue: #10 — “Editing a message can terminate the shared core and lose replacement sessions”
Status: implemented + hermetic-verified; uncommitted pending lead review.
Historical handoff status: later committed as `99d0b843`; source review and
isolated live verification accepted in `2026-11-08-single-core-live-verification.md`.
Rework 2026-11-08 applied lead findings in place (false delay tests, stale
`.pid` authority, `scope` semantics, dead `version` option, doc drift) —
see `docs/fork/reports/2026-11-08-single-core-rework.md`; verification rows
below are the original run's record.
Frozen incident evidence: `docs/fork/reports/2026-11-08-edit-from-here-session-loss.md`;
discovery: `docs/fork/reports/2026-11-08-single-core-discovery.md` (corrected in place).

## Goal

Operator directive: **one core, period** — across all workspaces, sessions,
terminal `piz`/`zcode attach` and `piz acp`. The core's lifetime cannot belong
to a T3 client scope. On Linux the core now runs as a transient
`systemd --user` service; there is no detached/double-fork fallback.

## Sequence (as specified and implemented)

client probes singleton socket → O_CREAT|O_EXCL startup lock picks one caller →
caller issues a `systemd-run --user` transient-service request → user service
manager owns the core outside any client cgroup → core binds the socket and
self-registers `.pid`/`.info` → per-session workspace refs flow in
`session/create|resume|list` → client scope retirement affects neither the
service nor the core → session adoption/orphan/drain accounting unchanged.

## Changes

### Production code

- `apps/zcode-cli/packages/cli/src/app-server-spawn.ts`
  - `resolveSocketPath({dataBaseDir?, env?, platform?})` now returns the fixed
    `<dataBaseDir>/.zcode/v2/sockets/core.sock`. Workspace argument removed;
    data root must be non-blank and (on Unix) absolute. win32 keeps a named
    pipe hashed from the data root (`\\.\pipe\zcode-core-<hash>`), still
    unsupported for spawn.
  - `ensureServer` no longer takes `workspace`. Lock/probe/stale-reclaim
    logic unchanged.
  - Linux launch = `spawn("systemd-run", …)` (unit
    `piz-core-<sha256(socketPath)[:16]>.service`, derived from the socket
    path only — never cwd/provider/version/frontend):
    `--user --quiet --collect --service-type=exec --expand-environment=no
    --property=WorkingDirectory=<data root> --property=StandardInput=null
    --property=StandardOutput=null --property=StandardError=journal`, then
    `-- /usr/bin/env -- <core> app-server --socket <path> --no-plugins
    --cwd <data root>`.
  - Env: `ZCODE_WORKSPACE_IDENTITY`, `HERDR_*`, `T3CODE_*` and all
    service-instance names (`INVOCATION_ID`, `JOURNAL_STREAM`, `LISTEN_*`,
    `NOTIFY_SOCKET`, `WATCHDOG_*`) are excluded from forwarding and from the
    service env. `--setenv=NAME` passes names only — values resolve inside
    `systemd-run`'s own env, so no secret values enter argv or logs.
    `UnsetEnvironment=` always lists `ZCODE_WORKSPACE_IDENTITY` + all
    service-instance names, plus caller-present `HERDR_*`/`T3CODE_*` names
    (manager-side env cannot be enumerated — documented limit).
    `ZCODE_ATTACH_CORE=1`, `ZCODE_DATA_BASE_DIR=<data root>` and
    `PWD=<data root>` are forced into the service env.
  - Readiness: `systemd-run` exit 0 = acceptance only; the client keeps
    probing the socket. The readiness window (60 s) starts after the
    runner process's **OS-level spawn** (the child `'spawn'` event —
    before manager acceptance/exit is known), so lock-wait no longer
    eats the core-start budget. Nonzero runner exit re-probes once
    (race tolerance) then reports the unit name + bounded sanitized
    stderr. Timeout errors name the unit for `systemctl --user status`.
    Failure paths never kill a shared service; only the (ephemeral)
    runner child is SIGTERMed.
  - Non-Linux Unix: an already-listening socket is reused; an absent core
    fails with an explicit “start it under an independent supervisor” error
    naming the `zcode app-server` command. win32 spawn still throws.
  - Return shape is exactly `{socketPath, started}` (rework 2026-11-08:
    the earlier revision returned `pid` read from `<socket>.pid`, but a
    pre-existing stale `.pid` could hand back an unrelated live pid —
    registration files are operator-only metadata, possibly
    transient/stale, never launcher authority; no caller needs the pid).
  - `spawnSpec.serviceRunner` is a test seam replacing `systemd-run`
    (fixture-only, documented as such); `ZCODE_SERVER_BIN` still selects the
    core executable.
  - Diagnostic `log?: (line) => void` added; attach/ACP wire it to
    stderr/logger respectively.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts`
  - Self-registration is unconditional after bind (no longer gated on
    `ZCODE_WORKSPACE_IDENTITY` in env) — any socket-mode bind registers,
    including manual `zcode app-server --socket` starts — and writes the
    new shape `{version, scope:"user", socketPath, startedAt}` via
    `appServerInfoSchema`. `.pid`/`.info` ownership stays with the listener;
    cleanup semantics unchanged (stale files are overwritten by the next bind).
- `apps/zcode-cli/packages/cli/src/attach/attach-command.ts`
  - Both `ensureServer` calls drop `workspace`; startup/reuse lines go to
    stderr. `workspaceRef` (`workspaceKey`) still feeds session params and
    reconnect `ensureConnected` reuses the same path.
- `apps/zcode-cli/packages/cli/src/acp/acp-sessions.ts`
  - Lane `ensureServer` call drops the workspace arg. Per-cwd lanes remain —
    they are session-level workspace routing over connections to the same
    core. Class doc updated.
- `apps/zcode-cli/packages/cli/src/attach/attach-main.ts`
  - `ZCODE_SERVER_BIN` help text updated (service-manager launch).

### Contract (root `packages/shared`)

- `app-server-attach/contract.ts`: `appServerInfoSchema` is now
  `{version, scope: z.literal("user"), socketPath: nonblank, startedAt: iso}`.
  The old `workspaceIdentity` field and the `appServerAttachWorkspaceSchema`/
  `AppServerAttachWorkspace` type were **removed by this change**;
  `resolveWorkspaceKey` lives in `task-realtime-core.ts` and stays
  session-level. `scope:"user"` records the registration's data/sharing
  scope only — it does not attest supervision (any socket-mode bind,
  including a manual `zcode app-server --socket`, self-registers the same
  value; lifetime ownership is provable only via cgroup/service manager).
- `contract.example.ts`, `contract.test.ts`, `CONTRACT.md` updated to the
  singleton user-scope metadata.

### Specs/docs

- `docs/design/v2/tui-attach-shared-core.md` — product target (“one core,
  period”), `core.sock` derivation, systemd user-service lifecycle,
  platform matrix, `.info` shape, env filtering, reconnect wording.
- `docs/design/v2/acp-frontend.md` — ACP lanes converge on one core;
  ownership section.
- `apps/zcode-cli/docs/design/v2/tui-attach-client-build.md` — new
  launcher API sketch.
- `FORK.md` — one-core requirement + implementation status.
- `docs/fork/verification.md` — `ZCODE_WORKSPACE_IDENTITY` no longer
  redirects the socket but still affects session refs; keep stripping it
  (also excluded from the service env).
- `docs/fork/reports/2026-11-08-single-core-discovery.md` — four corrections
  applied (no `cwd` spawn option; `session/resume` not `session/load`; drain
  timing is sweep+reap-gated, not last-disconnect; `AcpSessionRuntime` lives
  in its own file) plus a dated note that finding (a) is now implemented.

## Tests

Rewrote `apps/zcode-cli/packages/cli/tests/app-server-spawn.test.ts` (19
tests after rework) around a fixture-only fake service runner (labeled
“not cgroup/lifetime evidence”) that emulates accept→exec semantics: writes
argv, applies `--setenv=NAME` lookup from its own env, honors
`UnsetEnvironment=`, injects stale manager-side pollution,
`detached`-spawns the `--` command, registers the fresh child `{pid,cwd}`
in a private per-test JSONL registry before exiting 0 like `systemd-run`,
and records `manager-accepted`/`core-listening` markers via
`FAKE_EVENTS_FILE`. The fake core's `FAKE_CORE_LISTEN_DELAY_MS` is a true
pre-bind delay (rework 2026-11-08: the earlier script called `listen`
*before* sleeping, so the socket was connectable immediately and the
delay tests were vacuous). Test cleanup kills only registry pids after a
`/proc/<pid>/cwd` identity check and waits for actual exit — it never
consumes `.pid`. The test helper defaults `dataBaseDir` into the test dir
so no fixture core ever gets an operator-home cwd. Covers:

- fixed `core.sock` derivation (workspace-independent) + env/option precedence;
- one service request under 6 concurrent callers, all on the same socket;
- argv: `--user`/`--service-type=exec`/no `--scope`, neutral `WorkingDirectory`,
  unit name, `--setenv` names only (no values/secrets), `UnsetEnvironment`
  coverage, `/usr/bin/env --` command tail, `--no-plugins`;
- service env snapshot: ownership/service-instance/workspace names absent even
  against stale manager values, secret forwarded via env, `PWD`/data root set;
- launcher exit 0 with true pre-bind delay → success, asserting
  `manager-accepted` strictly precedes `core-listening` (probe loop spans
  the accepted-but-not-ready gap);
- runner nonzero → explicit error naming the unit + bounded stderr, no kills,
  lock released;
- accepted-but-never-listening → timeout naming the unit;
- live socket reused even with a missing runner binary;
- missing runner → explicit error, no detached fallback;
- darwin: reuse allowed, spawn fails explicitly;
- stale-lock reclaim, live-lock wait, contested-lock ready window with
  lock-wait + real bind delay > `waitForSocketMs` (separate lock/ready
  budgets proven by markers);
- stale pre-existing `.pid` (live sentinel): `ensureServer` neither
  returns it nor acts on it — sentinel stays alive, real bind overwrites
  the stale file (registration metadata is never launcher authority).

`tests/acp-sessions.test.ts`: new test asserts two cwd lanes produce two
connections on the **same** socket while `session/create` keeps per-cwd
workspace refs; fixture now records `ensureConnected` refs.
Four attach test files migrated to the new `resolveSocketPath` signature.

## Verification evidence (`/tmp/piz-single-core-implementation/`)

Environment: pinned tools via `mise exec`, `PATH` stripped of `/tmp/.mount_*`.
Two `node_modules` symlinks were created inside the worktree (ignored):
`packages/shared/node_modules` and
`apps/zcode-cli/packages/bootstrap/node_modules` → main checkout equivalents,
matching the existing root/CLI symlink convention (workspace package
resolution for `@zcode/model-option-map` etc.).

| Check | Result | Log |
|---|---|---|
| `pnpm architecture:check --changed` (baseline) | OK, 1 violation = baseline | `architecture-baseline.txt` |
| same, post-edit | OK, violations 1 / baseline 1 / new 0 | `architecture-check.log` |
| context-package `app-server-attach` | generated | `context-app-server-attach.log` |
| context-package `zcode-cli` | generated | `context-zcode-cli.log` |
| `node --import tsx --test tests/app-server-spawn.test.ts` | 18/18 pass | `app-server-spawn.test.log` |
| `node --import tsx --test tests/acp-sessions.test.ts` | 5/5 pass | `acp-sessions.test.log` |
| attach-adapter affected tests (`--test-name-pattern`) | 3/3 pass | `attach-adapter-affected.log` |
| attach-resume-fallback + model-option + exit-resume-hint | 44/44 pass | `attach-misc.test.log` |
| vitest `--project engineering` contract.test.ts | 3/3 pass | `contract.test.log` |
| `pnpm --dir apps/zcode-cli/packages/cli typecheck` | clean | `cli-typecheck.log` |
| `pnpm --dir apps/zcode-cli/packages/bootstrap typecheck` | clean | `bootstrap-typecheck.log` |
| `tsc -p packages/shared/tsconfig.json --noEmit` | clean | `shared-typecheck.log` |
| throwaway `tsconfig` over 6 changed test files | 19 errors, all pre-existing | `tests-typecheck.log` |
| same config over HEAD baseline of those files | 33 errors (22 attach-adapter + 11 spawn old-API) | `tests-typecheck-baseline.log` |
| oxlint changed `.ts` (CLI scoped) | 0 warnings/errors | `oxlint-cli.log`, `oxlint-bootstrap.log`, `oxlint.log` |

Test-file typecheck detail: the repo never typechecks `tests/` (tsconfig
covers `src/**`). The throwaway config (since deleted) ran the six changed
test files under the package's NodeNext settings. Current: 19 errors, all in
`attach-adapter.test.ts`, all present in the HEAD baseline of the same files
(baseline 22; my edits removed the 3 signature-mismatch errors at the changed
call sites; the new spawn/ACP test files are error-free). None of the 19 are
at or near this change's edit sites.

## Boundaries honored

- No installs, no builds, no dist artifacts, no wrapper/live-core/promotion
  changes, no commits (lead review pending), no pushes.
- No new source files under `apps/`/`packages/` (test file rewrite in place;
  manifest `module.ts` unchanged — all touched files already registered).
- `--no-plugins` gate unchanged; signing path untouched; session-level
  workspace refs, adoption/orphan/drain and `latestProtocolServer` behavior
  untouched (documented disabled-plugin boundary: under `--no-plugins` there
  is no MCP surface for cross-client auth routing to matter — if a future
  no-plugin path needs it, that is a separate design).
- Fixture runner tests are labeled fixture-only; they do not prove
  cgroup/lifetime behavior.
- No live processes left: fixture pids recorded in the private per-test
  registry are SIGKILLed in `afterEach` only after a `/proc/<pid>/cwd`
  identity check, then awaited for real exit; temp dirs removed.

## Known limits / next-handoff work

- **Real cgroup integration unverified by this handoff** (per brief): prove on
  real binaries that the `piz-core-<hash>` unit survives T3 scope retirement —
  i.e. repeat the frozen edit-from-here scenario against a built pair and show
  the replacement keeps the same core and session.
- `systemd-run --setenv=NAME` resolves values from `systemd-run`'s own env
  (documented behavior; exercised via fixture, confirm once live).
- Manager-side `HERDR_*`/`T3CODE_*` names not present in the caller env cannot
  be preemptively unset (manager env is unenumerable) — residual cosmetic risk
  only, they never reach the service env via forwarding.
- Stale `.pid`/`.info` after a killed core persist until the next bind rewrites
  them — same as before; clients probe the socket, not the pid file.
- `attach-binary.smoke.test.ts` now exercises real `systemd-run --user` when
  run (promote-gate path): it requires a user manager and cleans up via the
  self-registered `.pid`. Re-verify under the next real-build run.
- `resolveSocketPath`'s win32 named-pipe arm is compile-time only.
- `version` was removed from `EnsureAppServerOptions` (rework
  2026-11-08): it was never consumed — the server writes its own real
  version into `.info`. `AcpCoreSessionsOptions.version` went with it;
  `runAttachCommand`'s `version` parameter stays (TuiOptions consumer).
- **Source/schema execution gap for the next handoff:** the workspace
  typechecks above resolve `@zcode/shared` through the main checkout's
  *old* shared dist (they validate the new CLI source against the old
  schema types, not the new schema runtime). Only the root
  `contract.test.ts` vitest run executed the new schema source. A real
  bootstrap run of the new metadata path needs source aliases (or a
  shared rebuild) so `zcode-protocol-entrypoint` resolves the new
  `appServerInfoSchema` — required before calling the metadata runtime
  verified.
