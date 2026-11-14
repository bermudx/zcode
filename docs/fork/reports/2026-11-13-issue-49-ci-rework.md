# Issue #49 PR #57 CI rework — root causes and fixes

PR: https://github.com/bermudx/zcode/pull/57 (`patch/thin-client-login`)
Failing run: https://github.com/bermudx/zcode/actions/runs/43552924450 (head `7b28278b`)
Fix head: `3bd6368d`
Verification run: https://github.com/bermudx/zcode/actions/runs/43554285015 — **success**;
"Fork tests (selected)": 0 NEW FAILURES, 0 FLAKY, 1 KNOWN
(`zcode-protocol-telemetry-lifecycle`, pre-existing).

## Verdict: both NEW FAILURES were pre-existing on main, not caused by this PR

Every main `ci` run containing `84739b4b` (merged via #34) fails these tests:

| run | head | result for the two tests |
|---|---|---|
| 43378042131 | `a5967c90` | `injects protocol MCP` NEW; lifecycle tests FLAKY |
| 43546476610 | `64ea7f89` | all 3 lifecycle tests + `injects protocol MCP` NEW |
| 43546498020 | `40eb3309` (= PR merge-base) | `detach kills`, `close during blocked`, `injects protocol MCP` NEW; `blocked initial startup` FLAKY |

The PR changed none of the involved files (`server-operations.ts`, the fake
app fixture, the MCP fixture, pool, runtime). They only surfaced because
`--changed` selection picked the bootstrap package via `packages/shared`.

## Failure 1 — `zcode-protocol.test.ts › injects protocol MCP servers into session runtime config`

Deterministic. Protocol `session/create` returned -32603:

```
TypeError: record.app.runtime.setMcpClientAttached is not a function
    at createRecord (server-operations.ts:4023)
    at materializeCreatedSession (server-operations.ts:1374)
    at SessionLifecycleController.activate
```

`84739b4b` added a post-registration reconcile in `createRecord`: when a
session is materialized with injected `mcpServers` and the owner context has
`isClientAttached`, it calls `record.app.runtime.setMcpClientAttached(...)`
synchronously. `setMcpClientAttached` was added to the real `AgentRuntime`
interface in the same commit, but the test fixture
`tests/helpers/fake-zcode-app.ts` was never updated — its `runtime` stub
lacks the method, so the call threw before the record returned.

Fix (commit `3bd6368d`): added `setMcpClientAttached: async () => {}` to the
fake stub, matching the real interface.

## Failure 2 — `client-mcp-lifecycle.test.ts › detach kills …` (and 2 siblings)

Flaky. `expect(processAlive(pidB)).toBe(true)` failed ~100 ms after the pid
file appeared — the child was dead before `setMcpClientAttached(false)` was
even called. Same signature in all three tests.

Root cause is a fixture race, not production code:

- `@modelcontextprotocol/client` 2.0.0 in `auto`/`pin` negotiation mode runs
  `negotiateStdioViaSibling`: it clones the transport's spawn params (same
  env) into a **disposable sibling probe** that sends only `server/discover`,
  then reaps it via `_dispose`/`terminateMcpStdioProcessTree`. Only then does
  the real session transport spawn.
- `mcp-echo-server.mjs` wrote `MCP_FIXTURE_PID_FILE` at process startup, so
  the sibling wrote the pid file first; the session child overwrote it later.
  `waitForFile` + `processAlive` could observe the already-reaped sibling
  pid → `false`. Whether the test read sibling or session pid was pure
  timing — hence flaky, worse under CI load.
- Tests pinning `protocolVersion: "legacy"` (e.g.
  `workflow-child-mcp-borrow.test.ts`) skip the probe entirely — which is why
  only the auto-mode lifecycle tests flaked.

Fix (commit `462422e8`): the fixture now records its pid only when it
receives `initialize` (`recordPid()`). `initialize` is sent exclusively on
the session transport — the probe only sends `server/discover` — so the pid
file deterministically names the session child. This also removes the same
latent race in `mcp-session-teardown.test.ts` and the `MCP_FIXTURE_PID_DIR`
consumers (siblings no longer leave pid records at all).

## Files changed

- `apps/zcode-cli/packages/adapters/tests/fixtures/mcp-echo-server.mjs` —
  pid records gated on `initialize` receipt.
- `apps/zcode-cli/packages/bootstrap/tests/helpers/fake-zcode-app.ts` —
  `setMcpClientAttached` stub added.

No production code changed; the detach/suspend behavior the tests assert is
unchanged. Both fixes address main-side bugs tracked by the CI gate; they
are unrelated to the auth/* protocol feature itself.
