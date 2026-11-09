# Single shared core — live service-lifetime verification (issue #10)

Date: 2026-11-08 · Verifier: independent test sub-agent (fresh session) ·
Source under test: `99d0b8438704193236bea1287a5644a791453c4f` (`fix/edit-from-here-last-message`)
**Verdict: PASS (2/2 runs, 102 assertions each, zero failures, zero leftovers)**

## What was proven

On the REAL `systemd --user` manager (systemd 262), one transient
`piz-core-<sha256(socket)[:16]>.service` served every client type, and
survived the original client's scope retirement with its replacement
sessions fully usable:

- **One core, period** — ACP worker X (workspace A), ACP worker Y
  (workspaces A+B), a terminal attach client (workspaces A+B), and a third
  ACP client Z all converged on one socket
  `<data>/.zcode/v2/sockets/core.sock` and one service MainPID. No
  `core-<workspace-hash>.sock` files existed.
- **Independent supervision** — the core's cgroup was
  `…/app.slice/piz-core-<hash>.service`, sibling of — never inside — the
  `piz-single-core-test-*.scope` client scopes. `PrivateNetwork=yes` and
  `PrivateUsers=yes` held on the unit (test-only isolation added by the
  scoped `systemd-run` shim, appended args only); `/proc/<corepid>/ns/net`
  differed from the parent's and `/proc/<corepid>/net/dev` listed `lo`
  only — no external network was possible.
- **Survival across retirement** — `systemctl --user stop` on the
  original scope killed its worker (SIGTERM, exact T3 order: replacement
  spawned *before* retirement). Afterward the service showed the **same
  MainPID, same InvocationID, ActiveState=active, same cgroup** — no
  restart.
- **Replacement still usable** — real ACP `session/prompt` calls for
  `/goal` on workspace-A and workspace-B sessions each returned
  `end_turn` with an `agent_message_chunk` (`"No goal is set…"` — local
  command path, **no model call**). No `proto.sessionNotFound`, no
  "attach client disconnected", no stray stdout on the protocol channel.
- **Session/workspace binding** — terminal `session/create`
  (`persistence:"immediate"`) returned snapshots bound to the requested
  workspace path/key; `session/list` for workspace A returned exactly A's
  session and for B exactly B's (deferred ACP drafts correctly absent).
  After scope retirement, orphaned ACP sessions were adopted via
  `session/subscribe` and their snapshots proved the correct workspace
  binding for xA→A, yA→A, yB→B.
- **Metadata executed** — the core self-registered
  `core.sock.info` parsed by the NEW worktree schema
  (`{version:"source-single-core-test", scope:"user", socketPath,
  startedAt}`), `core.sock.pid` == systemd MainPID, service env had no
  `ZCODE_WORKSPACE_IDENTITY`/`HERDR_*`/`T3CODE_*`, cwd == neutral data
  root.
- **Exact cleanup** — all four recorded units reached `inactive`, the
  core process exited, `core.sock` disappeared, evidence left behind.
  `systemctl --user list-units 'piz-*'` is empty post-run; no wildcard
  kills were used.

## Operator re-run (seconds, self-cleaning)

From the repo root:

```
mise exec -- node --import tsx scripts/verify-single-core.mts
```

Exit 0 only when every assertion passes and cleanup succeeds. Evidence
is written to a private `/tmp/piz-single-core-live-*/` (mode 0700) and
kept: `result.json`, `logs/{driver,ensure-server,worker-*.stderr,
core-journal}.log`, `configs/{source-aliases,env-allowlist}.json`,
`shims/{core-shim,acp-worker}.mts`, `bin/{zcode,systemd-run}`,
`data/core-source-report.json`.

## Run evidence

| Run | Root | Service | Core PID / InvocationID | Result |
| --- | --- | --- | --- | --- |
| 1 | `/tmp/piz-single-core-live-KuUsk3` | `piz-core-09b35989c8c1b738.service` | 2587891 / `586df1c9…` | pass, 102 assertions |
| 2 | `/tmp/piz-single-core-live-6mRr5w` | `piz-core-890469cf93c88c5d.service` | 2589751 | pass |

Driver stdout was also tee'd to `/tmp/piz-scv-run1.out` /
`/tmp/piz-scv-run2.out`. Journal for run 1 shows
`/usr/bin/env -- …/bin/zcode app-server --socket …/core.sock
--no-plugins --cwd …/data`, exit status 143 on the final `systemctl
stop`, ~6.8 s CPU / 622 MB peak (tsx source-mode overhead; not a product
figure).

## Commands and exit statuses

| Command | Exit | Log |
| --- | --- | --- |
| `mise exec -- node --import tsx scripts/verify-single-core.mts` (run 1) | 0 | `/tmp/piz-scv-run1.out`, `…KuUsk3/result.json` |
| same (run 2) | 0 | `/tmp/piz-scv-run2.out`, `…6mRr5w/result.json` |
| `mise exec -- pnpm --dir apps/zcode-cli exec vitest run packages/adapters/tests/client-request-signing.test.ts` | 0 (13/13 tests) | `/tmp/piz-single-core-live-evidence/client-request-signing.log` |
| `mise exec -- pnpm --dir apps/zcode-cli exec vitest run packages/bootstrap/tests/socket-listener.test.ts` | 0 (4/4 tests) | `/tmp/piz-single-core-live-evidence/socket-listener.log` |
| Author checks: `tsc --noEmit --strict … scripts/verify-single-core.mts`, `oxlint scripts/verify-single-core.mts` | 0 / 0 warnings | — |

## How the test is wired (no production changes)

- `scripts/verify-single-core.mts` generates a private `bin/zcode`
  executable shim (selected via `ZCODE_SERVER_BIN` — a production
  injection point) that execs pinned `node --import tsx --import
  <alias-register> <core-shim.mts> app-server …`. `core-shim.mts` only
  wires the production launch chain — console boundary, env
  sanitization, `prepareCliProviderRuntimeEnv`, protocol lifecycle,
  `runZCodeProtocolAgent` — to the worktree's changed sources; it
  contains no business logic.
- A private `bin/systemd-run` executable (earlier in `PATH` for the
  launched processes only) passes `--scope` launches through untouched
  and appends `--property=PrivateNetwork=yes --property=PrivateUsers=yes`
  to transient services, so the spawned core has no network even by
  accident. All production launcher args are untouched.
- ACP workers run the real `runAcpStdio` inside uniquely named
  `systemd-run --user --scope` units, mirroring T3's client scopes;
  the driver speaks raw ACP JSON-RPC (`initialize`, `session/new`,
  `session/prompt`) on their stdio pipes.
- A module-alias config (kept in `configs/source-aliases.json`, built
  mechanically from `packages/shared`'s own exports map) resolves
  `@zcode/shared` specifiers to worktree source in driver, workers and
  core. This is required because the worktree's `node_modules` links
  resolve `@zcode/shared` to the **main checkout** (stale schema).
- Environment: workers/core get an explicit allowlist (`PATH`,
  `XDG_RUNTIME_DIR`, private `HOME`/XDG dirs, `ZCODE_DATA_BASE_DIR`,
  `ZCODE_SERVER_BIN`, `PIZ_SCV_ROOT`, `CI`). No user credentials, no
  `DBUS_SESSION_BUS_ADDRESS`, no whole-env forwarding.

## Environment repairs (test-only, documented separately)

- `apps/zcode-cli/packages/adapters/node_modules` was absent in this
  worktree (other packages link per-package `node_modules` to
  `/home/daniel/build/piz/…`). Repaired identically:
  `ln -s /home/daniel/build/piz/apps/zcode-cli/packages/adapters/node_modules apps/zcode-cli/packages/adapters/node_modules`.
  Without it the signing test cannot resolve `@zcode/shared`; this is a
  worktree linkage gap, not a product defect. `git status` stays clean
  (`node_modules` is ignored).

## Limits

- **SOURCE integration, not a built-candidate verification.** The
  changed launcher, bootstrap entrypoint, and shared schema ran from
  worktree source under `tsx`; unchanged `@zcode/*` deps resolved via the
  existing `node_modules` links (partly to the main checkout's artifacts).
  The two vitest gates resolved `@zcode/shared` to the main checkout's
  source — identical resolution to every other test run in this
  worktree, and schema-independent for signing/listener semantics.
- **No real T3 UI edit was driven** — this is the isolated exact
  process-order reproduction (replacement before retirement) specified
  by the brief.
- **No model endpoint exercised**: `/goal` is a local command path; the
  core additionally ran in a loopback-only namespace. Nothing about
  request signing, metering, or extra GLM Coding Plan allowance is
  claimed — the signing test is a regression gate only.
- Full suites, real-binary builds, and promotion remain unverified and
  were out of scope.

## Lead review

Accepted the source implementation and the live evidence after reading the
complete driver, both result ledgers and signing/socket test logs. This proves
the isolated process-order scenario, not a real T3 UI edit or a built release.

One driver-only review correction narrows cleanup success to `inactive`,
`failed` or `unknown` (collected units); transitional states, empty replies
and unrecognized states cannot count as stopped. Fallback service cleanup
also requires the exact private shim path and private data-root cwd, not
just a matching filename. The recorded runs already ended with `inactive`
units, exited core PIDs and removed sockets; those observations remain valid.
The live scenario was not repeated for this driver-only correction.

Focused lead checks live in `/tmp/piz-single-core-lead-review/`: a source-extracted
cleanup predicate check covers three stopped and seven non-stopped states,
including transitional and empty replies, and checks both final cleanup
assertions use that predicate. Driver typecheck and lint are recorded there.
The first stricter driver typecheck exposed a missing optional access after
the cleanup guard changed; that driver-only error was corrected before the
final check. No unchanged signing, socket or live scenario checks were repeated.

Final driver checks: strict `tsc --noEmit` exit 0, oxlint exit 0 with no
warnings/errors, and `git diff --check` clean. The two earlier live runs and
their original driver remain the historical evidence; only the driver cleanup
predicate and fallback identity check changed in lead review.

No CI workflow is configured in this checkout. The separate infrastructure gap
is filed as bermudi/piz #11 (`enhancement`, `P2`); a `ci` area label was created
for automated branch validation. This does not hold up #10's source fix and
does not authorize a push, build, merge, promotion or live-core restart.
Full-suite and matched-binary verification remain gates for the operator's
next merge/promotion decision.

## Static-review follow-up — two P3 findings

Both findings are fixed before merge; production code is unchanged.

- Awaited the four floating `assert.rejects()` calls in
  `app-server-spawn.test.ts`, so residual-artifact failures remain inside their
  test bodies.
- Built the ACP scope argv once in `spawnAcpScope` and used that array for both
  `CommandRecord.argv` and `spawn`. New ledgers include the actual
  `--quiet --collect` flags and the actual suffix-free `--unit` argument.
  The earlier retained ledgers are historical: their scope-launch argv omitted
  those two flags and included the `.scope` suffix. They have not been rewritten.
  Their process/cgroup observations and acceptance results remain unchanged.

Focused checks ran once, with logs and command exit statuses under
`/tmp/piz-single-core-p3-review/`:

- The three affected launcher tests pass (concurrency, rejected service start,
  accepted-but-never-listening timeout).
- A fixture-only source-extracted `spawnAcpScope` check captures the actual
  `spawn` arguments and compares them exactly with the ledger; it confirms both
  flags and the suffix-free unit argument. This is evidence-recording coverage,
  not an additional live cgroup run.
- An AST check confirms all 12 `assert.rejects()` calls in the spawn tests are
  awaited.
- Strict explicit typecheck of both changed files passes.
- Lint exits 0 with one pre-existing `no-array-sort` warning at the untouched
  environment-name listing in the driver; no lint errors.
- Architecture before/after: one accepted baseline violation, zero new.
  `git diff --check` is clean.

No live service scenario, signing gate, unrelated suite, build or installation
was repeated for these test/evidence-only changes. Permission/auth and platform
compatibility callouts remain documented limits; this follow-up does not change
their behavior.
