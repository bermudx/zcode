# ACP client MCP tools — implementation evidence (issue #31)

Status: implemented on `feat/acp-mcp-tools`. CMCP01–12 verified through real
disposable seams (protocol socket app, ACP SDK client, real stdio/http/sse
fixtures). **CMCP13 is a real privacy blocker**: a sentinel leak in the adapter
`mcp.server.failed` logger path was found by the multi-surface scan and is
documented below — fix deferred to lead decision. CMCP14 (real T3) remains
operator-gated — not exercised. This file records only observed evidence.

Historical detail: `/home/daniel/.local/state/piz-acp-mcp-009cbbe5/rework4.md`
(current round; supersedes rework3 and earlier notes, which record previous
passes and are not restated here).

## CMCP matrix (final)

| Case | Result | Evidence |
|------|--------|----------|
| CMCP01 ACP new forwards stdio/http/sse; tool executes | PASS | `cli/tests/acp-mcp-e2e.test.ts` "CMCP01+CMCP11 allow" — real `createAcpAgentApp` + ACP SDK client; all 3 transports declared; fake model calls tool, real fixture result in follow-up request. |
| CMCP02 empty create: no resources; inject allocates; clear releases; no bait config | PASS | `bootstrap/tests/acp-mcp-protocol-lifecycle.test.ts` CMCP02 — real socket protocol app; no pid before inject; live pid after; pid dead after clear. |
| CMCP03 two sessions, same cwd + identical config → independent PIDs | PASS | same file CMCP03 — independent live PIDs/echo; closing one leaves the other's call working. |
| CMCP04 bound resume: same handle/app across in-flight prompt + unchanged resume; changed entry reconnects only that server | PASS | cli e2e "CMCP04 bound resume" — real socket owner transfer; session handle object identical before/after resume while a model-gated prompt waiter completes; answering-pid in `echo[v1@pid]` used as connection identity (pid file unreliable: adapter stdio probe rewrites it). |
| CMCP05 credential swap staged mid-turn: old connection serves the whole turn, queued turn uses new one; goal continuation too | PASS | lifecycle CMCP05 — real protocol `sessionSend`/`steer` admission + client-side queue flush after idle; assertion on the turn's new tool result only (transcript legitimately carries v1 history). Continuation variant stages during an active turn and sees `mcp__s2__echo` next request. |
| CMCP06 explicit `[]` removes tools, no fallback | PASS | lifecycle CMCP06 — tools gone, pid dead, provenance stays explicit-empty. |
| CMCP07 empty create → resume inject → tool in real ModelRequest, executes | PASS | lifecycle CMCP07. |
| CMCP08 idle detach kills children + real owner transfer; active detach aborts a blocked MCP call without destroying the session | PASS | lifecycle CMCP08 (two cases) — per-socket servers; second socket adopts via `locateSessionOwner`, runs a turn without resupplying `mcpServers`; active variant aborts a `holdCall`-blocked `tools/call`, next owner adopts cleanly. |
| CMCP09 V4 forkAssistant inherits pending definition during active turn; child executes it via real protocol prompt | PASS | lifecycle CMCP09 — child `sessionResume`+`sessionSend` round produces `echo[v2@pid]`; legacy `sessionFork` stays guarded; parent usable after child close; credential sentinel never on disk. |
| CMCP10 blocked startup/apply/close + workflow-child borrow (direct + `runWorkflow` facade + staged-during-active-turn) | PASS | `core/tests/mcp-client-config.test.ts` (F1 op-set regressions); `adapters/tests/mcp-session-teardown.test.ts` (real PIDs); `bootstrap/tests/workflow-child-mcp-borrow.test.ts` (3 cases: generations, normal facade runner, active-parent staging where both child paths see the old applied face). |
| CMCP11 permission allow and reject over the real ACP wire | PASS | cli e2e: allow → real fixture call + result; reject → zero calls, `end_turn`, denied result persisted. Options picked by kind; nested ACP outcome shape. |
| CMCP12 malformed/duplicate input → sanitized errors at both boundaries | PASS | lifecycle CMCP12 (protocol) + cli e2e ACP-boundary test — `INVALID_PARAMS`/`AcpMcpMapError`, no sentinel/credential echo in error messages. |
| CMCP13 client-supplied values never leak into product diagnostics | **FAIL — real leak** | lifecycle CMCP13 multi-surface scan (logger, protocol notifications, `session/read`, persisted transcript, storage files): exactly one surface leaks — `logger:mcp.server.failed:warn`. Producer: `adapters/src/mcp/index.ts` `failConnection` logs `error: displayMessage` which carries raw `error.message`; spawn ENOENT echoes the client-supplied command path. Companion `stderr` field is already sanitized (`sanitizeMcpStdioStderr`); the `error` field is not. Test left failing as evidence; fix needs lead privacy-boundary decision. Adapter HTTP/SSE diagnostic tests still pass (5/5). |
| CMCP14 real T3 key/restart behavior | OPERATOR-GATED | Not exercised by automation; pending operator decision. |

## Source fixes

Rework 4 (current pass) changed **test and fixture files only** — five files,
no production source:

- `bootstrap/tests/helpers/acp-mcp-core-fixture.ts` — per-socket
  `ZCodeProtocolAgentServer` instances (matching the production entrypoint),
  cross-server `locateSessionOwner` adoption, `loggerFactory` plumbing.
- `bootstrap/tests/acp-mcp-protocol-lifecycle.test.ts` — 12 lifecycle tests
  (see matrix); CMCP13 collects hits across all surfaces before asserting.
- `bootstrap/tests/workflow-child-mcp-borrow.test.ts` — adds real
  `app.runWorkflow` facade coverage and a staged-during-active-parent-turn
  case; isolation hardened (temp storage, `skipUserConfig`, `noPlugins`).
- `cli/tests/acp-mcp-e2e.test.ts` — bound-resume handle-object identity +
  in-flight waiter, ACP-boundary malformed/duplicate cases, nested permission
  outcome shape.
- `adapters/tests/fixtures/mcp-echo-server.mjs` — `holdCall` `tools/call`
  barrier for blocked-turn/detach tests.

Earlier source fixes (still in tree from prior rounds):

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

## Verify commands run (rework 4)

From `apps/zcode-cli` (vitest via `../../node_modules/.bin/vitest`):

- bootstrap: `vitest run tests/acp-mcp-protocol-lifecycle.test.ts
  tests/workflow-child-mcp-borrow.test.ts` → **14 pass / 1 fail** — the one
  failure is the intended CMCP13 leak evidence (see matrix).
- adapters: `vitest run tests/mcp-http-sse-fixture.test.ts
  tests/mcp-session-teardown.test.ts` → 5/5 pass.
- cli: `node --disable-warning=DEP0205 --import tsx --test
  tests/acp-mcp-e2e.test.ts tests/acp-mcp.test.ts` → 10/10 pass.
- test-file typecheck: throwaway `tsc -p tsconfig-acp-tests.json --noEmit`
  (extends cli tsconfig, includes the 5 changed test files — the repo
  `tsconfig.json` excludes `tests/`) → **0 errors in changed files**; 13
  errors remain, all in untouched baseline helpers
  (`test-agent-runtime.ts`, `registry-backed-test-app.ts`,
  `provider-config-fixtures.ts`) — pre-existing, not introduced here.
- `node scripts/architecture/architecture-check.mjs check --changed`
  → OK, 0 new violations (1 baseline).
- `git diff --check` → clean; `oxlint` over the 5 changed files
  → 0 warnings / 0 errors.
- Logs + sha256 of the changed files:
  `/home/daniel/.local/state/piz-acp-mcp-009cbbe5/rework4-*.{log,txt}`.

## Disposable exercise

```bash
cd apps/zcode-cli/packages/cli && node --disable-warning=DEP0205 --import tsx \
  --test --test-name-pattern "CMCP01" tests/acp-mcp-e2e.test.ts
```

Real ACP app + protocol socket + disposable stdio/http/sse fixtures; performs a
tool call through permission allow and observes the real result, then cleans up.

## Not claimed

- **CMCP13 is not clean**: the adapter `mcp.server.failed` logger warn path
  echoes client-supplied values (`failConnection`, `adapters/src/mcp/index.ts`).
  The evidence test is intentionally left failing until the lead decides the
  privacy boundary for raw `error.message` fields.
- No live T3 behavior, no real credentials, no install/promotion/build of the
  application bundle, no full-suite `pnpm test` run (scope bounded to the
  packages listed above).
- Package-level lint green and a clean throwaway typecheck of the whole test
  helper tree are not claimed; 13 baseline helper type errors pre-date this
  change.
- CMCP14 is explicitly operator-gated; nothing here asserts T3 resend or
  restart behavior.
