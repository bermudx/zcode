# Edit from here loses the replacement ACP session

## Status

Diagnosis, not a fix. No installed command, running core, provider setting or
credential was changed. No model request, build, deployment or network fetch
was made during this investigation.

The earlier response stopped at the error code. That was insufficient:
the local incident records expose the session replacement and core shutdown.

## Observed incident

All times below are UTC on November 8, 2026 (the screenshot shows 3:07 PM
US Central, UTC−06:00).

| Time | Observation |
| --- | --- |
| 21:06:53.219 | The original ACP prompt succeeds. |
| 21:07:03.312 | T3 records `checkpoint.rollback-requested`. |
| 21:07:03.348–03.785 | A replacement ACP process initializes. |
| 21:07:03.786 | T3 starts `session/new`. |
| 21:07:03.808–03.837 | The core creates the replacement session and marks its runtime ready. |
| 21:07:03.852 | T3 receives a successful `session/new` response. |
| 21:07:03.885–03.886 | The workflow services for **both** the original and replacement sessions close. |
| 21:07:03.889 | The core logs `zcode_protocol.shutdown.completed`. |
| 21:07:06.155–06.420 | A replacement core starts. |
| 21:07:06.461 | The core logs `ZCode Protocol session runtime missing`. |
| 21:07:06.465 | The replacement session's lifecycle is `unloaded`. |
| 21:07:06.856–06.869 | The edited ACP prompt starts, then fails. |
| 21:07:06.897 | T3 records the reported `proto.sessionNotFound` error. |

The core shut down 37 ms after T3 received the replacement session ID,
and 52 ms after that session became ready. The replacement was still an
unsent deferred draft; a new core cannot cold-resume it from persistent history.

Evidence was read locally from:

- `~/.t3/userdata/logs/provider/events.ea9b35c4-e8a4-4f9c-8af3-25a8f28c72b8.log`
  (request method, status and timestamps only; request bodies are summarized
  by T3).
- `~/.t3/userdata/statev2.sqlite`, opened read-only: the incident thread's
  rollback event, native-session identity transitions and error event.
- `~/.zcode/cli/log/zcode-2026-11-08.jsonl`: selected lifecycle/startup/shutdown
  fields, without configuration or credentials.

## Ownership conflict

The relevant source paths are:

1. T3 `packages/provider-acp/src/server/adapter.ts`,
   `rollbackThread` / `startReplacementAcpRuntime`: start and commit a new ACP
   runtime, then close the previous runtime's scope.
2. T3 `packages/provider-acp/src/server/AcpSessionRuntime.ts`: ACP processes
   are wrapped in an agent scope where available; scope finalization calls
   `agentScope.stop`. It also has process-tree/cgroup termination paths.
   `detached: true` alone is not a lifetime contract with this supervisor.
3. piz `apps/zcode-cli/packages/cli/src/app-server-spawn.ts`: the first attach
   client starts a detached core; subsequent clients reuse its workspace socket.
4. piz `apps/zcode-cli/packages/cli/src/acp/acp-sessions.ts`: `open()` creates
   a deferred draft and binds its handle. `resume()` preserves an existing
   handle, not a durable copy of an unsent draft.
5. piz `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`:
   admission returns no revision for a session without a ready runtime.
   `command-inbox.ts` then rejects the command with `proto.sessionNotFound`.

The supported causal explanation is that retiring the original T3 ACP runtime
also retires its spawned core, even though the replacement ACP runtime has
already connected to that core. The observed ordering and T3's scope cleanup
support this explanation. A signal audit was not captured, so the exact
termination mechanism (agent scope versus another descendant-cleanup path)
is not independently proven.

```text
original ACP process → spawns workspace core
replacement ACP process → reuses core → creates deferred session
T3 retires original ACP scope → core exits → replacement session is lost
replacement ACP process → reconnects → edited prompt targets missing session
```

This is not evidence that T3 passed the wrong ID: its provider-thread events
retain the new session ID after rollback. Retrying `sendText`, swallowing the
rejection, or strengthening process detachment does not repair ownership.
Persisting drafts merely to survive this teardown would also change the
unsent-draft contract and would not protect other live sessions sharing the core.

## Decision needed before implementation

- **Preferred: a separately owned shared core.** A user service owns the core;
  ACP clients only attach to it. Closing one T3 process must not terminate the
  service or other clients' sessions. This preserves the shared-core product
  goal, but changes startup/service ownership and needs operator agreement.
- **Alternative: one core per ACP runtime.** Do not share a core between T3
  scopes. This fits T3's cleanup ownership, but gives up the intended resource
  sharing for ACP and can multiply core memory use.

Do not bypass T3's descendant cleanup as an incidental workaround.

## Checks and limits

- Architecture baseline: initially blocked by absent worktree dependencies.
  Reused local dependency directories via ignored symlinks; no install.
  Retried baseline: **0 violations / 0 new**.
- Loaded the `zcode-cli` architecture context. That inherited module is
  **unmanaged**; the architecture result does not verify its runtime ownership.
- No production source changed; no tests, typecheck or lint were run.
- No isolated live rollback reproduction or fixed-path acceptance has run.
  The timeline is evidence from the operator's real failure, not a synthetic
  passing test.
- No GitHub issue/comment was created and nothing was pushed.

A quick, read-only way to inspect the core side of the recorded incident:

```sh
jq -c 'select(.timestamp >= "2026-11-08T21:07:03" and .timestamp < "2026-11-08T21:07:08") | select(.event == "zcode_protocol.session.lifecycle_changed" or .event == "zcode_protocol.shutdown.completed" or .event == "zcode_protocol.startup.completed") | {timestamp,event,sessionId,state:.context.state}' ~/.zcode/cli/log/zcode-2026-11-08.jsonl
```

This inspects the failure; it is not a command for trying an implemented fix.
