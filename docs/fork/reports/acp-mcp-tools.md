# ACP client MCP tools — implementation evidence (issue #31)

Status: implemented on `feat/acp-mcp-tools`. CMCP01–13 verified through real
disposable seams (protocol socket app, ACP SDK client, real stdio/http/sse
fixtures). CMCP14 (real T3) remains operator-gated — not exercised. This file
records only observed evidence.

Historical detail: `/home/daniel/.local/state/piz-acp-mcp-009cbbe5/rework3.md`
(supersedes rework1/rework2 notes; those files record earlier passes and are
not restated here).

## CMCP matrix (final)

| Case | Result | Evidence |
|------|--------|----------|
| CMCP01 ACP new forwards stdio/http/sse; tool executes | PASS | `cli/tests/acp-mcp-e2e.test.ts` "CMCP01+CMCP11 allow" — real `createAcpAgentApp` + ACP SDK client; all 3 transports declared; fake model calls tool, real fixture result in follow-up request. |
| CMCP02 empty create: no resources; inject allocates; clear releases; no bait config | PASS | `bootstrap/tests/acp-mcp-protocol-lifecycle.test.ts` CMCP02 — real socket protocol app; no pid before inject; live pid after; pid dead after clear. |
| CMCP03 two sessions, same cwd + identical config → independent PIDs | PASS | same file CMCP03 — independent live PIDs/echo; closing one leaves the other's call working. |
| CMCP04 reorder keeps PID; changed env reconnects only that server | PASS | same file CMCP04 + cli e2e "CMCP04 bound resume". |
| CMCP05 mid-turn freeze + goal continuation gets new toolset | PASS | same file CMCP05 (real `continueActiveTargetIfIdle` + persisted target → continuation request sees `mcp__s2__echo`); `core/tests/prompt-admission.test.ts` S5 (frozen provider/outputStyle/tools mid-turn; new facts next turn). |
| CMCP06 explicit `[]` removes tools, no fallback | PASS | lifecycle CMCP06 — tools gone, pid dead, provenance stays explicit-empty. |
| CMCP07 empty create → resume inject → tool in real ModelRequest, executes | PASS | lifecycle CMCP07. |
| CMCP08 detach kills children; adopted resume reconnects same session/history | PASS | lifecycle CMCP08 — pid exits on detach; adopt without `mcpServers` reuses same app instance. |
| CMCP09 V4 forkAssistant inherits pending definition during active turn | PASS | lifecycle CMCP09 — child `echo[v2@pid]`; legacy `sessionFork` stays guarded; parent usable after child close; credential sentinel never on disk. |
| CMCP10 blocked startup/apply/close + workflow-child borrow | PASS | `core/tests/mcp-client-config.test.ts` (F1 op-set regressions, deterministic barriers); `adapters/tests/mcp-session-teardown.test.ts` (real PIDs); `bootstrap/tests/workflow-child-mcp-borrow.test.ts` (real `createScriptWorkflowAgentRuntime`, empty→inject→clear→reinject; child never owns parent connection). |
| CMCP11 permission allow and reject | PASS | cli e2e: allow → real fixture call + result; reject → zero calls, `end_turn`, denied result persisted. Options picked by kind. |
| CMCP12 malformed boundary input → sanitized errors | PASS | lifecycle CMCP12 — missing command/env-shape/null-headers rejected without `TypeError`. |
| CMCP13 authenticated HTTP/SSE discover+call, secret-safe diagnostics | PASS | `adapters/tests/mcp-http-sse-fixture.test.ts` (3) — loopback auth'd StreamableHTTP + SSE; wrong-token per-server failure; no token/URL leak in diagnostics. |
| CMCP14 real T3 key/restart behavior | OPERATOR-GATED | Not exercised by automation; pending operator decision. |

## Source fixes (this pass)

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

## Verify commands run

From `apps/zcode-cli` (vitest via `../../node_modules/.bin/vitest`):

- bootstrap: `vitest run tests/acp-mcp-protocol-lifecycle.test.ts
  tests/workflow-child-mcp-borrow.test.ts tests/session-facade.test.ts`
  → 18/18 pass.
- core: `vitest run tests/mcp-client-config.test.ts tests/prompt-admission.test.ts`
  → 18/18 pass.
- adapters: `vitest run tests/mcp-http-sse-fixture.test.ts
  tests/mcp-session-teardown.test.ts` → 5/5 pass.
- cli: `node --disable-warning=DEP0205 --import tsx --test
  tests/acp-mcp-e2e.test.ts` → 3/3 pass.
- typecheck: `mise exec -- ../../node_modules/.bin/turbo run typecheck
  --filter=@zcode/bootstrap --filter=@zcode/core --filter=@zcode/adapters
  --filter=@zcode/cli` → 15/15 tasks, exit 0.
- lint: package lint is red on pre-existing baseline errors only
  (`bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts` 968 lines,
  `cold-event-merge.ts` 808, `adapters/src/fs/index.ts` 1644, plus legacy
  warnings — none in files this change touched); targeted oxlint over all
  changed/new files: 0 warnings, 0 errors.

## Disposable exercise

```bash
cd apps/zcode-cli/packages/cli && node --disable-warning=DEP0205 --import tsx \
  --test --test-name-pattern "CMCP01" tests/acp-mcp-e2e.test.ts
```

Real ACP app + protocol socket + disposable stdio/http/sse fixtures; performs a
tool call through permission allow and observes the real result, then cleans up.

## Not claimed

- No live T3 behavior, no real credentials, no install/promotion/build of the
  application bundle, no full-suite `pnpm test` run (scope bounded to the
  packages listed above).
- Package-level lint green is not claimed; baseline errors listed above are
  pre-existing and unrelated to this change.
- CMCP14 is explicitly operator-gated; nothing here asserts T3 resend or
  restart behavior.
