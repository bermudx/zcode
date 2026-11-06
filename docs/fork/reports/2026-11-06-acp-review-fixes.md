# ACP review fixes — 2026-11-06

## Checklist

All eleven explicit findings are fixed. No P0 or P3 findings were supplied.

| Review item | Fix / regression |
| --- | --- |
| P1 #1: connect before bind | Lane creation calls `AttachRuntime.connect()` before subscribing. Real-socket new/resume tests use actual runtime and handle classes. Cleanup closes the installed socket. |
| P1 #2: actual question options | Uses the public core question schema and option labels, descriptions and previews. SDK-to-agent elicitation regression no longer invents `value` fields. Invalid input fails loudly. |
| P1 #3: fresh transport after disconnect | Runtime connector creates a new client on every invocation. Lifecycle requests and handles resolve the current runtime client. Socket reconnect regression exercises create/resume/mode/close after reconnection. |
| P1 #4: preserve active handle | Bound resume reuses the session/handle, rejects a different cwd, and does not add duplicate ACP sinks. Regression completes the original prompt and a follow-up after resume. |
| P1 #5: bounded output | Connection-owned queue admits at most 256 updates / 1 MiB UTF-8 JSON, including in-flight output. Exactly one update enters the SDK writer at a time. Overload closes the connection and signals the stdio boundary to exit nonzero. Prompt success waits for admitted updates. Blocked SDK writer and oversized-update tests enforce both limits. |
| P2 #6: close errors | Failed closure propagates through an ACP error response; the local binding remains available for retry. Socket and ACP-boundary tests inject failure. |
| P2 #7: unregister closed handles | Successful core close removes the runtime recovery registration before deleting the ACP binding. Disconnect regression confirms no subscribe/resume for a closed handle. |
| P2 #8: plan overlay | Live mode events honor `planEnabled: true`, independently of collaboration/permission mode. |
| P2 #9: live todos | Successful TodoWrite results are decoded and validated using the core output schema, projected immediately and deduplicated. Empty lists clear the plan. Agent regression deliberately leaves snapshot todos stale and verifies they are not re-emitted. |
| P2 #10: stdio failures | Entry boundary independently records stdin/stdout/decoder failures and explicit agent connection failures; SDK `closed` resolution alone cannot imply success. Real read/write OS failures, pending write callbacks, normal EOF and SDK parse-error responses are covered. |
| P2 #11: architecture registration | ACP belongs to the existing managed `app-server-attach` adapter module, with its command entrypoint and contract documented. Five baseline unmanaged-file violations become zero. |

## Error policy

- Update-write and event-projection catches are connection boundaries: an
  unrecoverable failure closes the connection with a contextual error/cause.
  A projection catch must not throw through the handle's sink and prevent its
  turn waiter from seeing completion.
- Close and prompt catches are ACP request boundaries: closure failures become
  explicit request errors, not success; cancellation alone maps to `cancelled`.
- Stdio write catches report contextual failure and rethrow to the SDK. The
  decoder catch reports failure and errors its readable stream. The entry catch
  writes a diagnostic and returns exit 1.
- Lane-creation rejection only evicts the rejected promise and rethrows; it does
  not turn a connection failure into a successful result. Cleanup attempts all
  lanes and propagates aggregate failure, while always disposing stdio listeners.
- Successful TodoWrite JSON/schema failures and unserializable display objects
  are not silently ignored. Malformed incoming ACP JSON receives the SDK's
  explicit JSON-RPC parse-error response; it is not fallback-parsed.

## Verification

Pinned mise Node 24.14.0 / pnpm 10.33.2; no dev build or promotion.

- ACP projector/agent/session/stdio plus attach-adapter tests: **106/106 pass**.
- CLI package `typecheck` (`tsc --noEmit`): **pass**.
- Targeted `oxlint --no-ignore -f json` from the CLI package, using absolute paths:
  **10 files, zero diagnostics**. Paths cover all ACP sources/tests and the changed
  attach runtime. Root ignores the CLI tree, so a zero-file lint is not evidence.
- `pnpm architecture:check --changed`: **pass**, zero violations (baseline: five).
- Selected `fork-tests.mjs`: **fails** on the existing
  `build-sea.test.mjs:733` bundled-official-plugin-assets assertion:
  **681/682 CLI tests pass**. Extra resume-target tests: **11/11 pass**.
  Always-run signing tests: **13/13 pass**; socket-listener tests: **4/4 pass**.
- Workspace-wide CLI `typecheck`: **blocked**, `turbo: command not found`.
- Workspace-wide CLI `lint`: **blocked**, its runner invokes the pinned native
  pnpm executable through Node, yielding `SyntaxError: Invalid or unexpected token`.
  These runner/environment failures were not changed as incidental scope.
- `git diff --check`: **pass**.

## Scope / remaining acceptance

- No explicit finding is deferred or skipped. Non-blocking dependency/auth
  callouts remain informational: no dependency update or permission redesign was
  added to this fix pass.
- The proposed ACP implementation was already dirty/untracked at handoff; it is
  preserved with the fixes. Existing SDK/lockfile changes were not replaced.
- Work remains on the operator's current `worktree/silver-river-2147` branch;
  no branch, wrapper, installation, running core, or promotion was changed.
- Socket tests use a protocol fixture, not a live model/core acceptance run.
  No live model turn, T3 client acceptance, resource measurement, or actual
  signing/allowance-metering acceptance was run. Passing signing unit tests
  does not establish account eligibility.
