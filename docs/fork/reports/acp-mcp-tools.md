# ACP client MCP tools — implementation evidence (issue #31)

Status: implemented on `feat/acp-mcp-tools`. CMCP01–13 regression-tested through real
disposable seams (protocol socket app, ACP SDK client, real stdio/http/sse
fixtures). The CMCP13 logger leak found in rework 4 is repaired in rework 5 by
bounded structural connection diagnostics on the session-owned client path.
CMCP14 was exercised once on a real T3 isolated scripted lane and exposed a
real gap: the surviving ACP process resumed the session internally after an
isolated core restart but dropped `mcpServers`, so the post-restart prompt
had no client tools. A client-side replay-snapshot resend repair and its
regressions are now in tree; the post-repair live pass remains
operator-gated. This file records only observed evidence.

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
| CMCP14 real T3 key/restart behavior | OBSERVED GAP → REPAIRED, POST-FIX PASS PENDING | Pre-repair live check on the isolated scripted lane: first prompt used the injected stdio tool; after `ctl.mts restart` (gen1→gen2 core, same ACP process/adapterPid), the same T3 thread sent only a second `session/prompt` — no client `session/resume` — and the tool was absent ("Approved T3 tool not offered"). Root cause: the adapter's internal cold recovery (`AttachRuntime.recoverSession` → `session/resume`) never carried `mcpServers`; no client-side layer retained the declaration. Repair (below) replays the last acknowledged snapshot on internal cold resume, covered by 4 new `cli/tests/acp-sessions.test.ts` regressions over a real socket/AttachRuntime fixture. The post-repair live T3 pass is still operator-gated and not claimed here. |

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
  the binding. Nothing is logged, persisted, or serialized.
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

## Verify commands run (CMCP14 reconnect repair, uncommitted on 7ecd7c85)

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

- **Real T3 remains unverified (CMCP14).** Credential rotation and authorization
  are still required. An isolated matched candidate is sufficient for that
  check; installing over the operator's current pair is not a prerequisite.
  Do not restart a live core or promote this branch to obtain the evidence.
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

The verifier found no proved product defect. This accepts the disposable
verification stage with the stated limits, not the still-gated real T3 stage.
There is no repository `verify-*` skill; `/create-verification-skill` is an
optional follow-up, not part of this change.

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
- No live T3 behavior, no real credentials, no install/promotion/build of the
  application bundle, no full-suite `pnpm test` run (scope bounded to the
  packages listed above).
- Package-level lint green and a clean throwaway typecheck of the whole test
  helper tree are not claimed; baseline helper type errors pre-date this
  change.
- CMCP14's post-repair live pass is still operator-gated. The pre-repair
  observation (tool present then absent across an isolated core restart,
  no client `session/resume` on the ACP wire) and the regression-covered
  resend do not claim the tool survives a real restart until lead reruns
  the live check; whether T3 resends `mcpServers` on its own explicit
  `session/resume` after an ACP process restart is separately untested.
