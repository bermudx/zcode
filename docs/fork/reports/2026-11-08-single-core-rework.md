# Single-core rework — lead findings applied

Date: 2026-11-08
Branch: `fix/edit-from-here-last-message` (base `cf61a95d`)
Issue: #10 — "Editing a message can terminate the shared core and lose replacement sessions"
Status: rework applied + re-verified; uncommitted pending lead review.
Historical handoff status: later committed as `99d0b843`; source review and
isolated live verification accepted in `2026-11-08-single-core-live-verification.md`.
Base: `docs/fork/reports/2026-11-08-single-core-implementation.md` (corrected in
place; its verification table remains the original run's record).
Artifacts: `/tmp/piz-single-core-rework/` (all logs + retained configs below).

## Lead findings → where they were fixed

1. **False delay tests.** `writeFakeServerScript` now sleeps **before**
   `server.listen()` (it previously listened, then slept — the socket was
   connectable throughout and both delay tests were vacuous). The fake core
   records `core-listening <ms>`; the fake runner records
   `manager-accepted <ms>` after registering the spawned child and before
   exiting 0 (both via `FAKE_EVENTS_FILE`). The delayed-start test asserts
   `manager-accepted < core-listening` with a real gap (600 ms configured,
   ≥300 ms required — scheduler margin). The contested-lock test now needs
   **separate** budgets: live-pid lock held 900 ms + true pre-bind delay
   1200 ms = 2100 ms > shared `waitForSocketMs` 2000 ms (a shared deadline
   provably kills this case; observed run took ~2190 ms), and asserts
   `acceptedAt >= lockReleasedAt` plus `listeningAt − acceptedAt ≥ 1000 ms`.
   Fixture-only label kept — no cgroup/lifetime claim.
2. **Stale `.pid` authority.** `readSelfRegisteredPid`, its poll constants and
   `EnsureAppServerResult.pid` are deleted; `ensureServer` returns exactly
   `{socketPath, started}` (tests assert the literal key set). No caller
   needed the pid. Test cleanup never touches `.pid`: the fixture runner
   appends `{pid, cwd}` of the fresh child to a private per-test JSONL
   registry before exiting; `afterEach` kills registry pids only after a
   `/proc/<pid>/cwd` identity check (unresolvable cwd → test fails, never a
   blind kill) and awaits real exit. `ensureTestServer` forces
   `dataBaseDir` + `FAKE_RUNNER_PID_FILE` into the test dir — no fixture
   core can get an operator-home cwd. New test: a live sentinel's pid is
   written to `${socket}.pid`, `ensureServer` runs, the sentinel survives,
   and the new bind's self-registration overwrites the stale file
   (waits for `.info` — never pre-seeded — before re-reading `.pid`).
3. **`scope:"user"` semantics.** Schema comment (`contract.ts`), `CONTRACT.md`,
   the bootstrap entrypoint comment and the contract test comment now say it
   records data/sharing scope only — any socket-mode bind (transient service
   or manual `zcode app-server --socket`) self-registers the same literal, so
   it cannot attest supervision; ownership proof is cgroup/`systemctl --user
   status`. No second owner flag added.
4. **Report/doc corrections.** Implementation report fixed in place: removed
   types were removed *by this change* (not "already absent"); the ready
   window starts at the runner's OS-level `'spawn'` event (before acceptance
   is known), not "after the request completes"; `{socketPath, started}`
   return documented; `version` removal recorded; a rework header note added.
   `version` deleted from `EnsureAppServerOptions` and
   `AcpCoreSessionsOptions` (`runAttachCommand`'s `version` stays — it feeds
   TuiOptions, not the launcher). `attach-command.ts` top comment now
   describes service-manager launch. Shared-core ASCII diagram corrected to
   one shared user core (was "one per workspace"). AGENTS.md product
   paragraph: candidate implemented on this branch, isolated live
   verification pending, nothing installed. systemd **>= 254**
   (`--expand-environment=no`, per local `man systemd-run` v262.1 — added in
   v254) now stated in `CONTRACT.md`, `tui-attach-shared-core.md`,
   `acp-frontend.md`, `tui-attach-client-build.md` and `FORK.md`. Local man
   also confirms `--setenv=NAME` resolves the value from systemd-run's own
   env.
5. **Source/schema execution gap (next handoff).** Workspace typechecks
   resolve `@zcode/shared` through the main checkout's *old* shared dist —
   they validate new CLI source against old schema types, not the new schema
   runtime. Only the root `contract.test.ts` vitest run executed new schema
   source. A real bootstrap run of the new metadata path needs source
   aliases (or a shared rebuild) before the metadata runtime can be called
   verified. Recorded in both reports.
6. **Reproducible test-file typecheck.** Throwaway config retained at
   `/tmp/piz-single-core-rework/tsconfig.spawn-test.json` (NodeNext, strict,
   `typeRoots` → worktree `node_modules/@types`, includes only
   `app-server-spawn.test.ts`). The 19 pre-existing
   `attach-adapter.test.ts` baseline errors are retained as reported by the
   prior run — this rework only re-verified the spawn file.

## Verification (this rework, run once after edits)

Environment: worktree root, `mise exec` (pinned node 24.14.0 / pnpm
10.33.2), `PATH` rebuilt without `/tmp/.mount_*` entries — same as prior
report. Every exit status is the checked command's own (no `tee`).

| Check | Result | Exit | Log |
|---|---|---|---|
| `node --import tsx --test apps/zcode-cli/packages/cli/tests/app-server-spawn.test.ts` | 19/19 pass (~6.4 s) | 0 | `/tmp/piz-single-core-rework/spawn.log` |
| `pnpm --dir apps/zcode-cli/packages/cli typecheck` | clean | 0 | `/tmp/piz-single-core-rework/cli-typecheck.log` |
| `node_modules/.bin/tsc -p /tmp/piz-single-core-rework/tsconfig.spawn-test.json` | clean, 0 errors | 0 | `/tmp/piz-single-core-rework/spawn-test-typecheck.log` |
| `oxlint -c /tmp/piz-single-core-rework/oxlintrc.json <6 changed cli/test files>` | 1 warning, 0 errors | 0 | `/tmp/piz-single-core-rework/oxlint-cli.log` |
| same, `bootstrap/src/zcode-protocol-entrypoint.ts` | 2 warnings, 0 errors | 0 | `/tmp/piz-single-core-rework/oxlint-bootstrap.log` |
| same, `shared/src/app-server-attach/{contract,contract.test}.ts` | 0/0 | 0 | `/tmp/piz-single-core-rework/oxlint-shared.log` |
| `pnpm architecture:check --changed` | OK — violations 1 / baseline 1 / new 0 | 0 | `/tmp/piz-single-core-rework/architecture-check.log` |

oxlint note: root `.oxlintrc.json` `ignorePatterns` exclude `apps/zcode-cli`
(package `lint` scripts lint 0 files), so a retained ad-hoc config enables
`correctness`+`suspicious` (119 rules). Remaining warnings are all
pre-existing and outside rework edit sites: `preserve-caught-error`
(`attach-command.ts:249`, untouched upstream code) and `no-shadow` ×2
(`zcode-protocol-entrypoint.ts:273`, upstream code). `.sort()` → `.toSorted()`
applied to the three assertions this rework added plus the two identical
calls the original implementation left in `app-server-spawn.ts` — the only
warnings ever inside the changed surface; suite + typecheck re-run after.

Spawn-suite highlights vs the findings: the contested-lock case took
~2190 ms > 2000 ms shared budget; the delayed-start case took ~670 ms with
markers proving `manager-accepted` strictly preceded `core-listening`; the
stale-`.pid` case ends with the sentinel still alive and `.pid` rewritten
to the real listener.

## Not run (per brief — prior evidence stands)

- ACP sessions (5/5), attach-adapter affected (3/3), attach misc (44/44),
  contract (3/3), bootstrap typecheck — unchanged by this rework.
- Frozen broken-bin ACP reproduction — not repeated.
- Real `systemd-run --user` / cgroup-survival run — not authorized here;
  stays on the promote-gate/`attach-binary.smoke.test.ts` real-build path.

## Housekeeping / no-live-processes statement

- Orphan found and reaped: pid 2528510
  (`fake-app-server.mjs --socket /tmp/zcode-app-server-spawn-qyh2Rk/…`,
  elapsed ~27 min, `/proc` cwd = `/home/daniel`). The `/home/daniel` cwd
  proves pre-rework provenance — `ensureTestServer` cannot produce it (it
  forces `dataBaseDir` into the test dir, so `--cwd` is always the tmp dir).
  Killed after `/proc` identity check; its tmp dir was already gone. This
  orphan is the exact hazard finding 2 fixes (old cleanup trusted `.pid`).
- `ps` sweep for `fake*`/`zcode-app-server*` after the final run: none.
  `/tmp/zcode-app-server-spawn-*`: none. Only intentional artifacts remain
  under `/tmp/piz-single-core-rework/`.

## Remaining risks / next-handoff work

- **Real cgroup/lifetime verification still pending** — the main acceptance
  gap. Needs the real build + `attach-binary.smoke.test.ts` path (real
  `systemd-run --user`, service survival across client scope retirement,
  `systemctl --user status` ownership proof). Fixture tests explicitly do
  not claim this.
- `--setenv=NAME` value lookup is man-page + fixture verified; live
  confirmation rides the same real-build run.
- Source-alias requirement for a real bootstrap run of the new
  `appServerInfoSchema` metadata (§5).
- Manager-side `HERDR_*`/`T3CODE_*` names absent from the caller env cannot
  be enumerated for `UnsetEnvironment=` — documented limit, unchanged.
- Stale `.pid`/`.info` persist after a killed core until the next bind
  overwrites them; clients intentionally ignore them (diagnostic only).
- `resolveSocketPath` win32 named-pipe arm: compile-time only on Linux.
- Baselines unchanged: 1 pre-existing architecture violation; 19
  pre-existing `attach-adapter.test.ts` typecheck errors (prior run's
  33-error HEAD baseline comparison retained).
- Edits left uncommitted for lead review, per handoff.
