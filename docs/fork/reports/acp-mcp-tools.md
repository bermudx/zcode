# ACP client MCP tools — implementation evidence (issue #31)

Status: implemented on `feat/acp-mcp-tools`. CMCP01–13 regression-tested through real
disposable seams (protocol socket app, ACP SDK client, real stdio/http/sse
fixtures). The CMCP13 logger leak found in rework 4 is repaired in rework 5 by
bounded structural connection diagnostics on the session-owned client path.
CMCP14 passed against real T3 on November 12, 2026, through an isolated
source-runtime lane with a scripted executor. The first run exposed missing
client declarations on internal cold recovery. Commit `943a9ff2` repairs that
gap; a fresh adapter then called the real read-only T3 capabilities tool
successfully before and after an isolated core restart, without another
client declaration. An independent reconnect re-check returned `PASS+NOTES`.
Nothing is installed, pushed, or promoted. This file records only observed
evidence.

Historical detail: `/home/daniel/.local/state/piz-acp-mcp-009cbbe5/rework5.md`
(rework-5 pass; supersedes rework4 and earlier notes, which record previous
passes and are not restated here),
`/home/daniel/.local/state/piz-acp-mcp-009cbbe5/cmcp14-reconnect-discovery.md`
and `/home/daniel/.local/state/piz-acp-mcp-009cbbe5/cmcp14-reconnect-repair.md`
(CMCP14 observation, seam analysis, and this repair round).

## CMCP regression matrix

| Case | Result | Evidence |
|------|--------|----------|
| CMCP01 ACP new forwards stdio/http/sse; tool executes | PASS | `cli/tests/acp-mcp-e2e.test.ts` "CMCP01+CMCP11 allow" — real `createAcpAgentApp` + ACP SDK client; all 3 transports declared; fake model calls tool, real fixture result in follow-up request. |
| CMCP02 empty create: no resources; inject allocates; clear releases; no bait config | PASS | `bootstrap/tests/acp-mcp-protocol-lifecycle.test.ts` CMCP02 — real socket protocol app; no pid before inject; live pid after; pid dead after clear. |
| CMCP03 two sessions, same cwd + identical config → independent PIDs | PASS | same file CMCP03 — independent live PIDs/echo; closing one leaves the other's call working. |
| CMCP04 bound resume: same handle/app across in-flight prompt + unchanged resume; changed entry reconnects only that server | PASS | cli e2e "CMCP04 bound resume" — same-owner bound resume over the ACP wire; session handle object identical before/after resume while a model-gated prompt waiter completes; answering-pid in `echo[v1@pid]` used as connection identity (pid file unreliable: adapter stdio probe rewrites it). |
| CMCP05 credential swap staged mid-turn: old connection serves the whole turn, queued turn uses new one; goal continuation too | PASS | lifecycle CMCP05 — real protocol `sessionSend`/`steer` admission + client-side queue flush after idle; turn 1's two tool results asserted individually (each carries `gen-v1@pidOld`, none carries gen-v2) — not a concatenated any-match. Continuation variant stages during an active turn and sees `mcp__s2__echo` next request. |
| CMCP06 explicit `[]` removes tools, no fallback | PASS | lifecycle CMCP06 — tools gone, pid dead, provenance stays explicit-empty. |
| CMCP07 empty create → resume inject → tool in real ModelRequest, executes | PASS | lifecycle CMCP07. |
| CMCP08 idle detach kills children + real owner transfer; active detach aborts a blocked MCP call without destroying the session | PASS | lifecycle CMCP08 (two cases) — per-socket servers; second socket adopts via `locateSessionOwner`, runs a turn without resupplying `mcpServers`; active variant awaits a `call.marker` file the fixture writes at `tools/call` receipt (before the holdCall gate) — real call-arrival proof, no timing guess; next owner adopts cleanly. |
| CMCP09 V4 forkAssistant inherits pending definition during active turn; child executes it via real protocol prompt | PASS | lifecycle CMCP09 — child `sessionResume`+`sessionSend` round produces `echo[v2@pid]`; legacy `sessionFork` stays guarded; parent usable after child close; credential sentinel never on disk. |
| CMCP10 blocked startup/apply/close + workflow-child borrow (direct + `runWorkflow` facade + staged-during-active-turn) | PASS | `core/tests/mcp-client-config.test.ts` (F1 op-set regressions); `adapters/tests/mcp-session-teardown.test.ts` (real PIDs); `bootstrap/tests/workflow-child-mcp-borrow.test.ts` (3 cases: generations, normal facade runner, active-parent staging where both child paths see the old applied face). |
| CMCP11 permission allow and reject over the real ACP wire | PASS | cli e2e: allow → real fixture call + result; reject → zero calls, `end_turn`, denied result persisted. Options picked by kind; nested ACP outcome shape. |
| CMCP12 malformed/duplicate input → sanitized errors at both boundaries | PASS | lifecycle CMCP12 (protocol) + cli e2e ACP-boundary test — duplicate case uses exactly two individually-valid same-name stdio configs (sentinel in env) so only the duplicate path can fire; malformed-shape cases kept separate; `INVALID_PARAMS`/`AcpMcpMapError`, no sentinel/credential echo in error messages. |
| CMCP13 client-supplied values never leak into product diagnostics | PASS | lifecycle CMCP13 multi-surface scan (logger, protocol notifications, `session/read`, persisted transcript, storage files) after `app.close` flushes late diagnostics — zero sentinel hits. Rework-5 repair: `CreateMcpAdapterOptions.connectionDiagnostics` (`"standard"` default / `"structural"`) in `adapters/src/mcp/index.ts`; `failConnection` structural mode emits fixed message + typed `failureKind` only (no raw `displayMessage`, `recentStderr`, or `serverRequestId`); `attachStdioLogging` structural mode emits per-chunk event + byteCount only. Wired only into the lazy session-owned noPlugins pool in `create-app.ts`. Focused regressions: `adapters/tests/mcp-connection-diagnostics.test.ts` (structural ENOENT, real stderr sentinel, standard-mode control). Adapter HTTP/SSE diagnostic tests still pass (8/8 file set). |
| CMCP14 real T3 key/restart behavior | PASS — exercised source-runtime route | After operator-confirmed credential rotation: T3 supplied one stdio server, and the real read-only `orchestrator_capabilities` call succeeded. After repair `943a9ff2`, the same adapter/session repeated that call successfully after the isolated worker changed from generation 2 to 3. T3 sent only another prompt, not `session/new`/`session/resume`/`session/load`; internal recovery replayed the memory-only declaration. ACP-process replacement and installed-pair behavior remain unverified. |

## Source fixes

CMCP14 reconnect repair (current pass) — cold-core-restart resend, two
production files:

- `cli/src/acp/acp-sessions.ts` — internal `BoundAcpSession` extends
  `AcpSession` with `clientMcpServers?`: the ACP-side replay snapshot, an
  independent `structuredClone` taken before each create/resume request and
  stored only after the core acknowledges it. `resume` on a bound session
  replaces the snapshot only on a successful forwarded request; omitted and
  rejected resumes retain the prior declaration. `bindSession` accepts the
  snapshot as metadata; `createLane` supplies a synchronous
  `getSessionRecoveryMcpServers(sessionId)` hook that reads the live binding
  and returns a fresh clone (absent binding/declaration → `undefined`;
  explicit `[]` → `[]`). `closeSession`/`closeAll` discard the snapshot with
  the binding. The replay copy is not logged or persisted; serialization is
  limited to the existing protocol requests that carry it to the core.
- `cli/src/attach/attach-tui-options.ts` — new optional
  `AttachRuntimeOptions.getSessionRecoveryMcpServers`. `recoverSession`
  consults it only inside the existing `sessionUnavailable` cold-resume
  branch and spreads `mcpServers` into that `session/resume` when defined —
  preserving omit-vs-`[]` semantics. A successful warm `resubscribe` never
  reaches the hook and emits no extra resume. TUI/attach callers do not set
  the hook and behave identically.
- `docs/design/v2/acp-frontend.md` — the "no second accepted configuration"
  sentence now distinguishes the replay-only snapshot; adds the shared-core
  restart order to the contract diagram and the observed CMCP14 pre-repair
  baseline.
- `cli/tests/acp-sessions.test.ts` — fixture gains a `resident` record set
  (create/resume register, subscribe fails `sessionUnavailable` for unknown
  ids, `evictSessions` simulates core-restart record loss) plus
  `rejectResume`. Four new cases assert `session/resume.params` over the
  real socket: declaration replay on cold recovery with `[]`/omitted
  distinction and same-handle binding; zero extra resume on warm reconnect;
  bound-resume success replacing, omit/failure retaining; caller-mutation
  isolation, per-session isolation, closed-session exclusion.

Rework 5 (still in tree) — bounded privacy repair, two production files:

- `adapters/src/mcp/index.ts` — new optional
  `CreateMcpAdapterOptions.connectionDiagnostics?: "standard" | "structural"`
  (default `"standard"`), readonly `NodeMcpAdapter` field. In `failConnection`,
  structural mode emits a fixed `MCP server connection failed` message plus the
  existing typed `failureKind` on both `status.error` and the
  `mcp.server.failed` warn context (failureKind now logged explicitly); raw
  `displayMessage`, `recentStderr`, and external `serverRequestId` never reach
  status/log. In `attachStdioLogging`, structural mode never retains or emits
  child text — per-chunk `{event, byteCount}` only; the recent-stderr callback
  returns `undefined`. Standard mode behavior unchanged. Tool results/content
  untouched (not configuration diagnostics).
- `bootstrap/src/app/create-app.ts` — the lazy session-owned **noPlugins**
  pool's `createMcpAdapter` gets `connectionDiagnostics: "structural"` only;
  file/plugin adapter + `mcpPortFactory` paths unchanged.
- `docs/design/v2/mcp.md` — one line documenting the structural-diagnostics
  boundary for client-supplied connections.
- `adapters/tests/fixtures/mcp-echo-server.mjs` — new env hooks:
  `MCP_FIXTURE_CALL_MARKER_FILE` (pid written at `tools/call` receipt, before
  the holdCall gate), `MCP_FIXTURE_FAIL_INITIALIZE`, `MCP_FIXTURE_STDERR_TEXT`.
- `adapters/tests/mcp-connection-diagnostics.test.ts` (new) — structural
  ENOENT (sentinel in command path + env), real stdio server emitting an
  unlabeled stderr sentinel then failing initialize, and a default-standard
  control proving ordinary missing-command diagnostics still show a harmless
  marker.
- `bootstrap/tests/acp-mcp-protocol-lifecycle.test.ts` — CMCP08 marker-file
  call-arrival barrier (replaces 300ms sleep; also fixed a missing `usage`
  field in the turn's tool-calls model result that had silently prevented the
  call from dispatching at all — the sleep had masked it); CMCP05 turn-1
  per-result assertions; CMCP13 close/flush ordering (`session/read` before
  `app.close`, log+storage scan after).
- `cli/tests/acp-mcp-e2e.test.ts` — ACP duplicate case uses exactly two
  individually-valid same-name stdio configs (sentinel in env); temp state
  under `fixture.rootDir`.

Rework 4 (still in tree) changed test and fixture files only; earlier source
fixes (still in tree from prior rounds):

- F1: runtime-owned `Set<McpConnectOperation>` (immutable desired snapshot +
  controller + attach-epoch/config generation) replaces scalar in-flight state;
  per-op registration/removal; detach and `beginShutdown` abort all live
  records; `initializeMcp` fenced after all awaits so stale startup results
  cannot overwrite a newer apply; revoked ops cannot start new connects.
- F2: inline owned-port close closure restored in `getOrCreateSessionMcpPort`;
  `wrapOwnedSessionMcpPort` export deleted; ownership now proven through a real
  `createRegistryBackedTestApp` noPlugins app.
- Earlier rework (still in tree): attach-epoch fencing, apply below admission
  freeze, configured-vs-effective MCP distinction, dynamic getters for late
  inject/clear, per-server reuse on resume, session-owned pool `idleGraceMs:0`
  for noPlugins sessions, workflow children borrow effective config
  (`servers: {}` — discovery only, no ownership).

PR #34 review 3 (R1/R2/R3, still in tree, uncommitted) — three review findings
from checklist comment `6842002612`, fixed together:

- R1 attachment signal (`server.ts`, `server-types.ts`,
  `server-operations.ts`, `types.ts` app options, `create-app.ts`,
  `agent-runtime.ts`, `internal.ts`, `internal-methods.ts`): a server-owned
  `AbortController` tracks the current client attachment, aborted synchronously
  in `markClientDetached`/`disconnectClient`; `context.getClientDetachSignal` /
  `context.isClientAttached` expose it. `createRecord` captures the signal
  before the async app factory when `params.mcpServers !== undefined` and
  passes it through `ZCodeAppOptions` into `AgentRuntimeDeps
  .mcpClientDetachSignal`. The runtime constructor drops admission
  synchronously (`mcpClientAttached=false`, `mcpReconnectNeeded=true`) when the
  signal is already aborted, otherwise subscribes once into
  `setMcpClientAttached(false)`; `beginShutdown` unsubscribes. After the late
  `context.sessions.set`, the record reconciles via `isClientAttached` so a
  detached materialization never resurrects. Adoption (`claimDetachedSession`
  inside `requireSession`) keeps the existing attach-at-boundary reconnect.
- R2 identical-declaration retry (`methods/mcp.ts`): `configureMcpServers`
  compares the incoming declaration against the *effective* declaration
  (`mcpDesiredServers ?? config.mcp.servers`) so the create-with-mcp case
  reaches the retry probe. When unchanged and no reconnect already pending,
  `detectMcpRetryNeeded` reads `port.status()` and requests
  `mcpReconnectNeeded=true` only for desired-enabled names that are
  `failed`/`disconnected`/missing and not already in `mcpInFlightConnects`;
  connecting/live/disabled entries are never disturbed. `performMcpApply`
  passes `revalidate: true` to `connectConfiguredServers` when the reconnect
  flag caused the apply, so cached failed pool entries reconnect while live
  entries are ping-reused (same PID); the flag clears only after a
  current-epoch successful apply. The status probe captures the desired
  version/object identity plus attach epoch before the async read and
  discards its result when desired changed during the probe — a stale probe
  can neither set `mcpReconnectNeeded` nor trigger an apply over a newer
  declaration. No per-turn polling or reconnect loops.
- R3 borrowed access (`runtime/types.ts` `BorrowedMcpAccess`,
  `borrowMcpAccess` dep, `methods/mcp.ts` `prepareBorrowedMcp`, child
  `startMcpStartup`/`initializeMcp`, `script-workflow-child-runtime.ts`,
  `workflow-facade.ts`): both workflow child constructors now pass
  `borrowMcpAccess: (input) => parent.prepareBorrowedMcp(input)` instead of
  freezing the parent's port/config at construction. `prepareBorrowedMcp`
  waits the parent's already-scheduled `mcpApplyTail` and `mcpStartupPromise`
  (rereading identities until stable; never waits the parent turn, never
  applies staged desired during an active turn), then reads the full
  discovery snapshot (`status()` + `listTools()`) inside the same generation
  fence: after the reads it rechecks attach epoch, apply-tail/startup
  identities, port and applied-config references and retries the whole
  discovery on any change, so a queued apply or detach+adopt during the
  final read can never produce a mixed-generation snapshot. It returns
  `{port, config, snapshot}` with `config.servers:{}` applied by the child.
  Child startup awaits it under the child's own shutdown signal — child
  cancellation never aborts the parent handshake — and fences
  closed/detach/epoch before assignment. `initializeMcp` now reads the real
  `mcpPort` after the startup await (previously captured before). The
  `borrowedMcpConfig` export is removed; tests call `prepareBorrowedMcp`.
- Specs: `docs/design/v2/acp-frontend.md` (detached admission pre-registry,
  live-vs-failed retry, borrower awaits applied discovery);
  `docs/design/v2/mcp.md` (same three semantics).
- New regressions: `acp-mcp-protocol-lifecycle.test.ts` CMCP-R1a (detach
  before construction: no stdio admitted across materialization, late
  registration stays detached, second-owner `sessionSend` adopts via
  `claimDetachedSession` and the turn calls the real tool — a zero-turn
  session has no persisted row, so `session/resume` lineage validation
  correctly rejects it and the request-level adoption path is used instead),
  CMCP-R1b (detach after real app built but before factory return:
  blocked-initialize child dies before release, no resurrection), CMCP-R2
  (HTTP endpoint behind a bounded TCP-blackhole attempt counter → failed
  status; identical resume while down issues a bounded retry (≤4 attempts)
  and stays failed; a normal turn while still down issues zero new
  connection attempts; same endpoint healthy + identical resume reconnects
  and the next real protocol turn calls `mcp__h1__echo` end to end; live
  stdio sibling keeps its PID and its connected entry is never
  reinitialized), CMCP-R2b (identical resume during held handshake does not
  respawn or disturb the pending connect);
  `client-mcp-lifecycle.test.ts` three new borrowed-discovery fence cases
  (queued apply during the gated final `status()` read returns the NEW
  applied face, not a stale mix; detach+adopt during the read re-reads
  instead of returning the stale snapshot; a stale identical-resume health
  probe cannot trigger a second apply over a newer desired);
  `workflow-child-mcp-borrow.test.ts` three
  new cases (late port apply while script child waits → first ModelRequest
  carries the inherited tool + real echo; `runWorkflow` facade child during
  held handshake likewise; child cancellation while waiting settles promptly
  without aborting the parent's handshake). Fixture additions:
  `MCP_FIXTURE_INITIALIZE_RELEASE_FILE` (deterministic handshake gate),
  HTTP/SSE fixture fixed-port + `initializeRequests()` counters;
  `acp-mcp-core-fixture.ts` gains `appFactoryHooks` barriers.

## Verify commands run (review 3)

All via `mise exec --` unless noted; logs and exit codes under
`/home/daniel/.local/state/piz-acp-mcp-009cbbe5/review3-*.log`.

Evidence correction recorded in rework 1: `review3-cli-tests.log` and
`review3-typecheck.log` captured only a `cd` failure from a wrong relative
path (`EXIT:1`), not the actual runs — the interactive runs themselves did
pass, but those two log files are not proof. The exact intended checks were
re-run with absolute cwd and fresh logs under `rework1-*` (see the rework-1
section below), which is the authoritative artifact for cli 13/13 and
typecheck 15/15.

- `apps/zcode-cli`: `turbo run build --filter=@zcode/bootstrap...
  --filter=@zcode/contracts...` → exit 0 (library builds only, needed so
  bootstrap tests see the changed `@zcode/core`/`@zcode/adapters` `dist/`).
- `packages/bootstrap`: `vitest run
  tests/acp-mcp-protocol-lifecycle.test.ts
  tests/workflow-child-mcp-borrow.test.ts
  tests/script-workflow-child-runtime.test.ts` → 49/49 pass, exit 0
  (`review3-bootstrap-tests.log`).
- `packages/core`: `vitest run tests/mcp-client-config.test.ts` → 10/10,
  exit 0 (`review3-core-tests.log`).
- `packages/cli`: `node --disable-warning=DEP0205 --import tsx --test
  tests/acp-mcp-e2e.test.ts tests/acp-sessions.test.ts` → 13/13, exit 0
  (re-run logged at `rework1-cli-tests.log`; the review-3 log file is a
  broken-cwd artifact — see correction note above).
- `apps/zcode-cli`: `turbo run typecheck --filter=@zcode/bootstrap
  --filter=@zcode/core --filter=@zcode/adapters --filter=@zcode/cli` → 15/15
  tasks, exit 0 (re-run logged at `rework1-typecheck.log`; turbo resolved
  via the repo-root binary — no local `.bin/turbo` in the nested workspace).
- Throwaway `tsc --noEmit` over the four changed bootstrap test/helper files:
  0 errors in changed files; remaining diagnostics are pre-existing baseline
  helpers (`registry-backed-test-app.ts`, `test-agent-runtime.ts`,
  `provider-config-fixtures.ts`, one unchanged `generateText` stub missing
  `usage` in `client-mcp-lifecycle.test.ts:186`) — same class as rework-5.
  (Re-run logged at `rework1-test-tsc.log`.)
- Repo root: `pnpm architecture:check --changed` → OK, 0 violations
  (`review3-arch.log`; note `bootstrap/src/app`, `core/src/runtime`,
  `adapters/src/mcp` are not managed roots — no controlled context exists for
  them); `git diff --check` → clean; changed-file `oxlint` → 0 errors,
  4 warnings, all pre-existing baseline lines untouched by the diff
  (`review3-diffcheck-oxlint.log`).
- `pnpm --dir apps/zcode-cli lint` is environment-blocked at baseline:
  `run-cli-lint.mjs` execs `npm_execpath` as a node script, but the installed
  pnpm 10.33.2 is a standalone ELF (`@pnpm/exe`), so `node <elf>` fails with
  `SyntaxError` before any package runs — identical failure without this
  delta. The underlying per-package `oxlint src --no-ignore` was run directly
  instead (core 0 errors, adapters 0 errors, bootstrap only registered
  max-lines errors on `create-app.ts`/`server.ts` plus baseline warnings on
  unchanged lines).
- Red reproductions (temporary local reversals, all restored and re-verified
  green): R1 — cutting `mcpClientDetachSignal` in `server-operations.ts`
  makes CMCP-R1a/R1b fail with an admitted/leaked stdio child; R2 — forcing
  `retryRequested=false` in built `core/dist` makes CMCP-R2 fail (`h1` never
  reconnects); R3 — skipping the readiness wait in built `prepareBorrowedMcp`
  makes the late-apply/facade/cancellation cases fail (model request before
  handshake release). Rebuilt/restore-verified; no `TEMP-RED-REPRO` markers
  remain in src or dist. (Re-run with saved logs under `rework1-red-*`.)
- No disposable fixture processes left running after the pass.

## Verify commands run (review 3, rework 1)

All via `mise exec --` with absolute cwd recorded inside each log; logs and
exit codes under `/home/daniel/.local/state/piz-acp-mcp-009cbbe5/rework1-*`.

- `apps/zcode-cli`: `turbo run build --filter=@zcode/bootstrap...
  --filter=@zcode/contracts...` → 9/9 tasks, exit 0
  (`rework1-build.log`; prerequisite so bootstrap tests see the changed
  `@zcode/core` `dist/`).
- `packages/bootstrap`: `vitest run
  tests/acp-mcp-protocol-lifecycle.test.ts
  tests/workflow-child-mcp-borrow.test.ts
  tests/script-workflow-child-runtime.test.ts
  tests/client-mcp-lifecycle.test.ts` → 57/57 pass, exit 0
  (`rework1-bootstrap-tests.log`; adds the three borrowed-discovery fence
  cases and the strengthened CMCP-R2).
- `packages/core`: `vitest run tests/mcp-client-config.test.ts` → 10/10,
  exit 0 (`rework1-core-tests.log`).
- `packages/cli`: `node --disable-warning=DEP0205 --import tsx --test
  tests/acp-mcp-e2e.test.ts tests/acp-sessions.test.ts` → 13/13, exit 0
  (`rework1-cli-tests.log`; absolute cwd — replaces the broken review-3 log).
- `apps/zcode-cli`: `turbo run typecheck --filter=@zcode/bootstrap
  --filter=@zcode/core --filter=@zcode/adapters --filter=@zcode/cli` → 15/15
  tasks, exit 0 (`rework1-typecheck.log`; absolute cwd).
- Throwaway `tsc --noEmit` over the changed bootstrap test/helper files via
  a temporary `tsconfig.rework1-check.json` (deleted after the run): 20
  diagnostics, all pre-existing baseline helper/fixture stubs in untouched
  files (`test-agent-runtime.ts`, `registry-backed-test-app.ts`,
  `provider-config-fixtures.ts`, `../core/tests/test-runtime-model.ts`) plus
  one baseline `generateText` stub in `client-mcp-lifecycle.test.ts`
  (byte-identical to the baseline line; the file was never in a package
  tsconfig). 0 errors in any line this delta added
  (`rework1-test-tsc.log`).
- Red reproductions re-run with saved logs (temporary local reversals, all
  restored and re-verified green): `rework1-red-r1.log` (cut
  `mcpClientDetachSignal` → CMCP-R1a/R1b fail), `rework1-red-r2.log`
  (`retryRequested=false` → identical resume after endpoint recovery never
  reconnects `h1`), `rework1-red-r3fence.log` (pre-fence `prepareBorrowedMcp`
  → mixed stale snapshot returned; 2 fence tests fail),
  `rework1-red-desired-fence.log` (desired-generation recheck removed →
  stale health probe triggers a second apply: `connectCalls() === 2`).
- `git diff --check` → clean; no `TEMP-RED-REPRO` markers in src or dist;
  no disposable fixture processes left running.

## Verify commands run (rework 5)

All via `mise exec --` from the stated directories; full output and exit codes
in `/home/daniel/.local/state/piz-acp-mcp-009cbbe5/rework5-*`.

- `apps/zcode-cli`: `turbo run build --filter=@zcode/bootstrap...
  --filter=@zcode/contracts...` → 9/9 tasks, exit 0 (library/declaration
  builds only; required — bootstrap tests resolve `@zcode/adapters` from
  `dist/`, so the src change is invisible to them until built).
- `packages/bootstrap`: `vitest run tests/acp-mcp-protocol-lifecycle.test.ts
  tests/workflow-child-mcp-borrow.test.ts tests/client-mcp-lifecycle.test.ts`
  → 20/20 pass (12 lifecycle + 3 workflow + 5 client-mcp-lifecycle), exit 0.
- `packages/cli`: `node --disable-warning=DEP0205 --import tsx --test
  tests/acp-mcp-e2e.test.ts tests/acp-mcp.test.ts` → 10/10, exit 0.
- `packages/adapters`: `vitest run tests/mcp-http-sse-fixture.test.ts
  tests/mcp-session-teardown.test.ts tests/mcp-connection-diagnostics.test.ts`
  → 8/8, exit 0.
- `apps/zcode-cli`: `turbo run typecheck --filter=@zcode/bootstrap
  --filter=@zcode/adapters --filter=@zcode/cli` → 14/14 tasks, exit 0.
- Throwaway `tsc --noEmit` over changed test files, one config per owning
  package (`tsconfig-rework5-{adapters,bootstrap,cli}.json`, each extends that
  package's own tsconfig): adapters exit 0; bootstrap exit 2 and cli exit 2 —
  all 13/7 errors are in pre-existing baseline helpers pulled in transitively
  (`registry-backed-test-app.ts`, `test-agent-runtime.ts`,
  `provider-config-fixtures.ts`); **0 errors in any changed file**. No
  clean-whole-tree claim.
- Repo root: `pnpm architecture:check --changed` → OK, 0 new violations
  (1 baseline); `git diff --check` → clean; `oxlint` over the 6 changed
  source/test files → 0 errors, 4 warnings, all pre-existing/registered
  (`mcp/index.ts` max-lines is a registered exception; the two
  `no-useless-fallback-in-spread` warnings pre-date this change).

## Verify commands run (CMCP14 reconnect repair, committed as 943a9ff2)

All via `mise exec --`; logs and exit codes under
`/home/daniel/.local/state/piz-acp-mcp-009cbbe5/cmcp14-repair-*.log`.

- `apps/zcode-cli/packages/cli`: `node --disable-warning=DEP0205 --import tsx
  --test tests/acp-sessions.test.ts tests/attach-adapter.test.ts
  tests/acp-mcp-e2e.test.ts` → 86/86 pass, exit 0.
- `pnpm exec tsc --noEmit` (cli package) → exit 0; throwaway `tsc -p` over the
  touched test file (`tsconfig` per `tsconfig-rework5-cli.json` shape,
  include `tests/acp-sessions.test.ts`) → exit 0, zero inherited helper errors.
- `pnpm exec oxlint` on the 3 changed source/test files → 0 errors, 0 warnings.
- Repo root: `pnpm architecture:check --changed` → OK, 0 new violations
  (1 baseline); `git diff --check` → clean.

## Disposable exercise

```bash
cd apps/zcode-cli/packages/cli && mise exec -- node --disable-warning=DEP0205 --import tsx \
  --test --test-name-pattern "CMCP01" tests/acp-mcp-e2e.test.ts
```

Real ACP app + protocol socket + disposable stdio/http/sse fixtures; performs a
tool call through permission allow and observes the real result, then cleans up.

## Independent verification and lead disposition

Verifier verdict, verbatim:

```text
PASS+NOTES
```

Accepted source commit: `8be867d705f9d6158a4ffe05da2751bf7a87dce6`.
The fresh piz / GLM-5.3 verification report is
`/home/daniel/.local/state/piz-acp-mcp-009cbbe5/verification2.md`.
Its final driver log (`verify2-driver.log`, run `v2-mwcmmqkb`) records
93 checks and zero failed checks. The driver exercises the production
`runAcpCommand` from source in separate processes, a disposable socket core,
SQLite storage, and real stdio/HTTP/SSE servers. No installed command changed.
The first verifier attempt failed before verification with a DNS error; it
provides no feature verdict.

Lead disposition of the notes:

- **The original CMCP14 note is superseded by the real-T3 check below.**
  The operator confirmed credential rotation and authorized the isolated
  scripted lane. No installed pair or normal live core was changed.
- **Model and signing limits accepted.** The driver uses a scripted executor.
  Neither its tool calls nor these tests prove real model behavior, signing,
  extra-usage eligibility, or account metering.
- **Wire constraints accepted.** The SDK requires an array on `session/new`;
  omitted declarations were exercised on resume. Legacy `session/fork`
  ownership/active-turn/checkpoint restrictions remain unchanged; the separate
  V4 active-turn fork regression is listed above.
- **Idle replacement behavior accepted.** Replacing an idle connection can
  leave no serving connection until its new handshake finishes. This does not
  relax the whole-turn deferral requirement for an active turn.
- **Deferred-session limit retained.** A never-prompted draft is not evidence
  of persistent cross-connection lineage. Adoption tests use persisted history.
- **Driver errors are not product findings.** The driver recorded pipe-close
  `ECONNRESET` rejections during deliberate adapter termination. Its recorded
  check results, rather than exit code alone, are the evidence: the driver
  exits zero even if its check list contains failures.
- **Independent coverage is narrower than the regression matrix.** This
  driver exercised permission allow, not reject, and a subsequent prompt,
  not a separately queued/goal-continuation turn. Those additional paths have
  the regression evidence above, not independent live verification. Its fork
  calls also use the MCP port directly after ACP resume; the regression suite
  separately drives a forked child's tool through a protocol prompt.
- **CI unavailable.** This is a local, unpushed branch. No PR verdict comment,
  push, merge, install, or promotion has been performed.

The original verifier found no proved product defect. Its disposable
verification stage remains accepted with the stated limits. Real T3 and the
new reconnect delta have the separate evidence below.
There is no repository `verify-*` skill; `/create-verification-skill` is an
optional follow-up, not part of this change.

## Real T3 check and independent reconnect re-check — November 12, 2026

The operator created a temporary local ACP provider using the prepared
`acp-launch.sh`. It runs production `runAcpCommand` from source against an
isolated protocol/app assembly, SQLite store, and scripted model executor.
The executor requests only the uniquely offered read-only
`orchestrator_capabilities` tool with `{}`. No real model request or account
credential-store access was needed for this transport check.

The lead observed the following after repair `943a9ff2`:

- A fresh adapter received `session/new` with one stdio MCP server.
- Its first real T3 tool call succeeded in worker generation 2.
- The owned controller stopped that worker (expected exit 0) and started
  generation 3 with a different PID.
- The same T3 thread and adapter process received only another
  `session/prompt`, without new declarations or an ACP resume/load request.
- The second real T3 tool call succeeded in generation 3. The surviving
  adapter restored the declaration through its internal cold recovery.

Evidence collection retained only method/presence/count/transport, numeric
process facts, byte counts, and tool-success booleans. No raw MCP declaration,
authorization value, environment dump, tool-response content, or persisted
transcript was inspected. The adapter's recorded generation is its startup
snapshot; the worker's actual PID transition and executor generation establish
the restart.

Lead-run evidence:
`/home/daniel/.local/state/piz-acp-mcp-009cbbe5/cmcp14-real-t3-result.md`,
with stream paths and exact timestamps. This is not an independent verdict.

Fresh independent verifier verdict for the reconnect delta, verbatim:

```text
PASS+NOTES
```

Report:
`/home/daniel/.local/state/piz-acp-mcp-009cbbe5/verification-reconnect.md`.
Its final structured results and driver log record 20 checks, zero failed,
over the production ACP adapter and disposable fake MCP. It independently
observed a successful tool call after a core restart using only a prompt on
the original session/process, an unchanged warm resume retaining the same
MCP child, and explicit `[]` remaining empty after another core restart.

Lead disposition of every note:

- **Reconnect interval:** the empty-session scenario sent prompts before
  transport recovery finished; two returned `attach client is not connected`.
  The next prompt was correct without redeclaring servers. This accepts
  eventual tool restoration, not seamless prompt admission during a socket
  outage. The main tool-restoration scenario succeeded on its first attempt.
- **CI unavailable:** no push or CI run was authorized. A draft PR/verdict
  comment and CI remain pending; no merge, install, or promotion is authorized.
- **Fixture limits:** the independent re-check used fake MCP, not real T3.
  Real T3 has the separate lead-run evidence above. Neither check proves
  installed-pair, real-model, signing, or allowance behavior.
- **Driver development errors:** malformed fake input and an incorrect
  update-field assertion were driver mistakes, not product findings. Final
  acceptance uses the recorded 20 successful checks, not earlier iterations.
- **Scope and cleanup:** unchanged CMCP01–13 suites were not rerun. The
  verifier stopped its own clients/children, preserved the checkout and
  existing test clients, and left the isolated controller ready.

## Not claimed

- CMCP13 structural mode covers the `failConnection` + `attachStdioLogging`
  producers only. Other secondary raw-`error.message` log sites in
  `adapters/src/mcp/index.ts` (tool-list refresh, resource subscribe replay,
  OAuth orchestration, close-path debugs) are unchanged by design — if a real
  scenario drives client-controlled text through one of them, that producer
  needs its own decision.
- A source-only audit of *default* (non-noPlugins) app storage exposure for
  client-supplied MCP config was not performed in rework 4 or 5 — that surface
  is unexamined, not verified clean.
- No installed-pair verification, real model request, account credential-store
  access, install/promotion/build of the application bundle, or full-suite
  `pnpm test` run (scope bounded to the packages listed above). Real T3 tool
  access was exercised only through the isolated source-runtime route above.
- Package-level lint green and a clean throwaway typecheck of the whole test
  helper tree are not claimed; baseline helper type errors pre-date this
  change.
- Whether T3 resends `mcpServers` after the ACP process itself is replaced is
  separately untested. The exercised restart kept that process alive; its
  memory-only replay declaration cannot survive loss of both client and core.
