# Edit from here loses the replacement ACP session

## Status

Reproduced, not fixed. No installed command, operator-owned running core,
provider setting or credential was changed. No model request, build,
deployment or network fetch was made during this investigation. The reproduction
starts and stops only its own isolated test processes.

The earlier response stopped at the error code. That was insufficient:
the local incident records expose the session replacement and core shutdown.

## What was already documented

The audit was correct about the underlying persistence limit:

- `apps/zcode-cli/docs/design/v2/tui-attach-shared-core.md`, "已知遗留
  (deferred)": ephemeral/zero-turn sessions cannot resume after a core restart
  because they have not entered the store.
- That document also notes that a detached server remains in the spawning
  client's process tree until the client exits.

That is not the same as accepting this rollback failure:

- `docs/design/v2/acp-frontend.md`, behavior table: disconnect detaches and core
  sessions survive.
- Its "Not verified" section explicitly leaves T3 checkpoint rollback/cancel
  ordering unverified. `FORK.md` P006 also marks T3 rollback acceptance not run.

The original diagnosis should have distinguished the documented persistence
limit from the unverified integration boundary. It was premature to recommend
a service before reproducing the shutdown mechanism.

## Isolated reproduction

Added `scripts/repro-acp-core-lifetime.mts`. It copies the installed client/core
bundles into a private temporary directory, creates private HOME/data/workspace
directories, passes an allowlist environment, and starts each ACP client in an
empty Linux network namespace. No operator credentials or model endpoint are
used. There is no fake core or fake ACP agent.

Runtime snapshot: installed promotion
`4caa31d5f1d5efee9931b5bbc9a10838b491df72`; Node 24.14.0.

Observed:

- **Plain EOF control:** two real ACP clients share the same core. Closing the
  original client's stdin leaves the core alive; the replacement completes
  `/goal` with `stopReason: "end_turn"` and no model turn.
- **Scope retirement:** the core's `/proc/<pid>/cgroup` names the original
  client's test scope, not the replacement client's scope. Stopping only the
  original scope kills that shared core. The replacement reconnects to a new
  core but cannot restore its deferred draft.
- After the real reconnect/resubscribe failure, the replacement's actual ACP
  `session/prompt` returns **`v4 command rejected: proto.sessionNotFound`**.
- A signal trace from a scope-retirement attempt captured
  `SIGTERM {si_code=SI_USER, si_pid=808, si_uid=1000}`. `/proc/808/comm` is
  `systemd`. Tracer and tracee share the stopped scope, so signal capture is
  racy; the final exact-error run had an empty signal trace.
- An earlier timing probe sent during reconnect returned **`attach client is
  not connected`**. The final test waits for the existing resubscribe-failure
  diagnostic, rather than adding a fixed delay, to test the post-reconnect case.

This uses the same `systemctl --user stop <scope>` primitive as T3's
`AgentScope.stop`; it does **not** drive the T3 UI or invoke its complete
rollback runtime. Combined with the original incident's T3/core logs, it
establishes the process-lifetime failure mechanism without a provider call.

Evidence:

- Control and first signal capture: `/tmp/piz-acp-lifetime-wmEv78/`.
- Early-reconnect error and another signal capture:
  `/tmp/piz-acp-lifetime-oiOSMI/`.
- Final exact ACP error, exit 0:
  `/tmp/piz-acp-lifetime-4Bp9Sx/result.json`.
- One intermediate signal-capture assertion stopped before the prompt:
  `/tmp/piz-acp-lifetime-eExWgk/`.

Harness corrections are not passing product checks: the first launch failed on
a Node strip-only unsupported parameter property before starting processes;
the first scope attempt later timed out on an unnecessary numeric-ID core
probe; another stopped at the racy trace assertion. The control completed once
and was not repeated. The final scope run completed after correcting those
probe problems and adding the observed reconnect boundary.

Cleanup initially missed the plain control's core because `process.title`
rewrote argv. That isolated core and its tracer were stopped explicitly after
verifying their private test cwd. The script now uses registered PIDs plus
private cwd, tracks the tracer, and waits for exit. This cleanup-only adjustment
was typechecked/linted, not followed by another full reproduction.

Run the reproduction (Linux, user systemd, `unshare` and `strace`; roughly 10 s):

```sh
mise exec -- node scripts/repro-acp-core-lifetime.mts --runtime /home/daniel/build/piz/apps/zcode-cli/packages/cli/dist-runtime
```

It stops its own transient scopes/cores and retains its temporary evidence.
No service is installed or enabled. `--case scope-cleanup` runs just the failure
case; `--case plain-eof` runs just the control.

### Earlier real occurrence confirmed

The existing records also show the same pattern at **1:57 PM US Central** on
November 8, before the screenshot's **3:07 PM** failure:

- `19:57:10.352Z`: T3 records rollback.
- `19:57:10.776Z`: the replacement core session becomes ready.
- `19:57:10.821Z`: core shutdown completes.
- `19:57:13.273Z`: a new core starts; the draft is unloaded.
- `19:57:16.490Z`: the thread records `proto.sessionNotFound`.

The user systemd journal records the original ACP scope ending at
`19:57:10.859Z` and, for the screenshot incident, `21:07:03.928Z`.
This confirms that the screenshot is not the only recorded occurrence; it
does not count every historical failure.

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

The initially inferred, now reproduced failure mechanism is that retiring the original T3 ACP runtime
also retires its spawned core, even though the replacement ACP runtime has
already connected to that core. The observed ordering and T3's scope cleanup
support this explanation. The reproduction captures the scope inheritance and
systemd-originated SIGTERM. No signal audit exists for the original incidents
themselves; their original scope-finalization records are present in the journal.

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

## Ownership options considered, not an approved implementation

- **A separately owned shared core.** A user service owns the core;
  ACP clients only attach to it. Closing one T3 process must not terminate the
  service or other clients' sessions. This preserves the shared-core product
  goal, but changes startup/service ownership and needs operator agreement.
- **Rejected: one core per ACP runtime.** This would fit T3's cleanup ownership,
  but violates the product's single-core requirement and multiplies core memory.

Do not bypass T3's descendant cleanup as an incidental workaround.

## Initial investigation checks and limits

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

## Reproduction checks

- Explicit strict TypeScript check of the `.mts` script: passed.
- Oxlint on the script: 0 errors / 0 warnings.
- Architecture check: 0 violations / 0 new. The inherited CLI module is still
  unmanaged; this does not verify its lifetime semantics.
- No product source changed. No full suite, build, model call, deployment,
  service installation, GitHub write or push.

## Follow-up: issue filing and fix recommendation

The operator subsequently authorized filing the audit's other gaps.
Checked all existing issue titles for duplicates, rechecked the relevant source,
and created these issues in `bermudi/piz`:

| Issue | Problem | Type / priority / area |
| --- | --- | --- |
| #6 | Screenshots cannot be submitted through ACP | enhancement / P2 / attach |
| #7 | Additional input is rejected while an ACP turn is running | enhancement / P2 / attach |
| #8 | Background work and compaction are not visible through ACP | enhancement / P2 / attach |
| #9 | Manual skill invocation is not expanded through ACP | enhancement / P3 / attach |
| #10 | Editing a message can terminate the shared core and lose replacement sessions | bug / P1 / attach |

Reused existing labels; none were created. Issue bodies distinguish source
inspection from live verification and contain no private incident logs,
credentials or machine paths. #8 separates projection from workflow enablement,
already tracked by #5. #7 explicitly acknowledges that rejecting a concurrent
prompt is the currently documented behavior, not a regression.

**Audit correction:** did not file the proposed attach goal-continuation bug.
`AttachSessionHandle.setTarget` and `updateTargetStatus` already call
`session/goal`. The core's `goalSession` routes set/resume to
`continueGoalAfterChange`, which starts `runGoalContinuationInBackground` when
mode/admission permit. The missing optional client method therefore does not
establish that continuation fails to start. Whether every TUI progress/waiter
detail is correct remains unverified; do not replace the false claim with
another untested one.

No fork/rewind, locale, overload or doc-drift issue was added in this filing.

**Earlier recommendation, superseded by the operator clarification below:**
make the shared core a workspace-level resource. This was an incorrect
interpretation of the product goal, not an approved architecture. The independent
lifetime requirement remains: keep each ACP process's cleanup intact; retiring
it releases its connection, not a core another client is using.

T3 already uses a separately owned shared-server pattern for OpenCode
(`packages/provider-opencode/src/server/OpenCodeRuntime.ts`), while ACP runtime
startup/finalization owns one scope per runtime. Investigate reuse of that
shared-resource lifecycle before introducing another permanent service.
Setting `shared: true` alone is not a fix: the ACP scope still has a stop
finalizer. This direction needs coordinated T3/piz ownership work, not an
unannounced escape from T3's process containment.

**Operator clarification: one core, period.** A single shared core process must
serve every workspace, session and client. My earlier "one core per workspace"
answer was wrong. I had treated the existing workspace-keyed launcher as a
product requirement; the operator explicitly rejected that interpretation.
The operator cites Electron's single-core approach as the intended model.
This report does not independently audit Electron's process architecture.

Do not add a T3-specific, provider-specific or workspace-specific core.
Workspace identity still scopes session/configuration/permission routing inside
the one core. Global process discovery and ownership must not erase those
boundaries. An ownership fix that merely moves each existing workspace core
to a separate service still fails this requirement. The OpenCode example is
only an ownership-pattern reference, not an approved implementation. No
replacement lifetime/launcher mechanism has been selected.

No production code, installed command, T3 checkout or running core was changed
in this follow-up. No tests/build were rerun for this documentation/issue filing.
