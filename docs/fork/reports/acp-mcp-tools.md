# ACP client MCP tools — implementation evidence (issue #31)

Status: implemented on `feat/acp-mcp-tools`. CMCP01–13 verified through real
disposable seams (protocol socket app, ACP SDK client, real stdio/http/sse
fixtures). The CMCP13 logger leak found in rework 4 is repaired in rework 5 by
bounded structural connection diagnostics on the session-owned client path.
CMCP14 (real T3) remains operator-gated — not exercised. This file records
only observed evidence.

Historical detail: `/home/daniel/.local/state/piz-acp-mcp-009cbbe5/rework5.md`
(current round; supersedes rework4 and earlier notes, which record previous
passes and are not restated here).

## CMCP matrix (final)

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
| CMCP14 real T3 key/restart behavior | OPERATOR-GATED | Not exercised by automation; pending operator decision. |

## Source fixes

Rework 5 (current pass) — bounded privacy repair, two production files:

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

## Disposable exercise

```bash
cd apps/zcode-cli/packages/cli && node --disable-warning=DEP0205 --import tsx \
  --test --test-name-pattern "CMCP01" tests/acp-mcp-e2e.test.ts
```

Real ACP app + protocol socket + disposable stdio/http/sse fixtures; performs a
tool call through permission allow and observes the real result, then cleans up.

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
- CMCP14 is explicitly operator-gated; nothing here asserts T3 resend or
  restart behavior.
