# `piz acp` — ACP v1 frontend for the shared core

Status: implemented on `patch/acp-frontend` (2026-11-04). This document records the
shape, the ownership/event-order contract, the spike results that are actually
verified, and the ones still open.

## Shape

`piz acp` is a stdio adapter inside the thin client (`zcode-attach.cjs`). It speaks
ACP v1 NDJSON on stdin/stdout and talks to the shared core over the same Unix socket
the attach client uses. It adds no core protocol method, no bootstrap import, and no
Electron path.

```
ACP client (T3 Code)                    piz acp                         shared core
────────────────────                    ───────                         ───────────
initialize             ──►  capabilities: v1, resume{}, close{},       (no core call)
                            no loadSession, image support, no audio; HTTP/SSE MCP
session/new {cwd,
 mcpServers}           ──►  one lazy lane per cwd ─────────────────────► session/create
                            └─ subscribe, compact cap for GLM
session/prompt         ──►  v4 sendText ──────────────────────────────► turn
                            (/goal, /dwf routed locally: session/goal, dwf wire ops)
  ◄── session/update         raw SessionEvent → ACP update projection
  ◄── session/request_permission ◄──────────────────────────────────── permission
  ◄── elicitation/create     AskUserQuestion / ExitPlanMode ◄──────────── interaction/*
  ◄── {stopReason}           turn_complete / turn_error / cancel
session/cancel         ──►  v4 stop ──────────────────────────────────► runtime stop
session/resume         ──►  session/resume (no history replay) ───────► cold materialize
session/close          ──►  v4 stop + session/close ──────────────────► runtime released
```

`piz acp` reuses `AttachSessionHandle` for sessions, turns, mode/model mutation and
permission callbacks; it does not re-implement the share-core client. Client MCP
forwarding and lifecycle follow the approved extension below. This is a source
contract, not a claim that the installed matched pair has been updated.

Core ownership: since 2026-11-08 there is exactly one shared core per data root.
When the socket is absent the adapter asks `ensureServer` for it without a
workspace; on Linux `ensureServer` starts the core as a transient `systemd --user`
service (`piz-core-<sha256(socketPath)[:16]>`) so the core's lifetime is owned by
the user service manager, not by this adapter's process or any client scope (T3
runtime scope retirement cannot kill it). The launch requires systemd ≥ 254
(`--expand-environment=no`; local man systemd-run(1)). Platforms without a user
service manager fail explicitly — no detached-spawn fallback.

## Use with T3 Code

In T3 Code, open **Settings → Providers → Add provider → Show more → Local ACP
command** and select the environment where the installed CLI lives:

- Display name: `piz`.
- Executable: the absolute path to the installed `piz` wrapper.
- Arguments: one row containing `acp`.

Do not put `piz acp` in the executable field or use `~`/`$HOME`: T3 launches
the executable directly and does not expand shell expressions. The wrapper
selects the installed matched client/core pair; do not point at development
bundles or the old `zcode` command.

Select this provider for a new thread, choose a reported model, and send a
short prompt. T3 starts the adapter; no separate TUI is needed. Authentication
remains in the existing agent configuration, not an ACP sign-in flow.
These are setup instructions, not evidence that real T3 acceptance passed.

## Ownership and event order

Single owners, in order:

| Fact | Owner | Ordering contract |
| --- | --- | --- |
| ACP session id | core `session/create` | returned before any `session/update` for that id |
| Turn lifecycle | core runtime | `turn_started` (inputId = v4 commandId) → updates → `turn_complete` / `turn_error` |
| Tool calls | core event stream | `tool_call_scheduled` → `tool_call_started` → `tool_call_result` / `tool_call_error`; projector keys pending input by `toolCallId` |
| Permission / elicitation | core reverse request | one request per `requestId`; answer is the selected core option's `response` (attach mapping), or `answers` from the elicitation content |
| Mode | core `session/setMode` | `session_mode_changed` event drives `current_mode_update`, not local optimism |
| Model + compact cap | core `session/setModel` + `session/setCompactContextWindow` | `setModel` resolves the ref, then the GLM cap is re-synced from the new model id |
| Reasoning effort | core `session/setThoughtLevel` (single owner; the handle snapshot is its projection) | ACP request → boundary validation against the current model's advertised `reasoning.levels` → await `handle.setThoughtLevel` (merges the confirmed snapshot) → full `configOptions` in the response |
| Projection state | ACP connection | per-session projector (tool inputs, last plan); dies with the session |

### Lifecycle and failure invariants

- `AttachRuntime.connect()` owns installation and closure of the lane transport.
  Each connector invocation opens a fresh socket; create/resume/close resolve the
  current runtime client rather than capturing the first transport.
- A bound session keeps its handle (and pending-turn waiter) on resume. A resume
  from another cwd is rejected. Successful close unregisters the handle from
  recovery; failed close retains the binding and propagates the error for retry.
- Outgoing session updates are admitted per ACP connection with a maximum of
  256 updates and 1 MiB of UTF-8 JSON, including the in-flight write. Only one
  update is submitted to the SDK at a time. Exceeding either limit or a failed
  write terminates the connection with a diagnostic and nonzero exit; updates
  are never silently dropped while reporting a successful turn.
- Question option values are the core's labels (not an invented `value` field).
  Live mode projection honors the independent `planEnabled` overlay. Plans come
  from successful live TodoWrite results, including an empty checklist, never
  from the stale initial snapshot after a turn.
- Node stdio read/write failures are recorded at the transport boundary:
  `connection.closed` resolution alone is not evidence of a clean exit.

Event order for one turn:

```
session/prompt
  → validate all content blocks (text/resources + images)
  → [images] existing v4 attachment begin → chunk* → commit
  → v4 sendText (commandId)
  → [core] turn_started(inputId)
  → session/update agent_message_chunk …      (model_streaming text_delta)
  → session/update tool_call → tool_call_update(…)
  → [core] session/request_permission  ⇄  client optionId  → core option.response
  → elicitation/create                ⇄  client content     → core answers/approve
  → [core] turn_complete | turn_error
  → session/prompt response {stopReason}
```

`session/cancel` sets the turn's cancelled flag and aborts the per-turn signal.
For ordinary prompts, `AttachSessionHandle` owns stop admission: before the
command is sent, cancellation only aborts the upload; after admission starts,
the handle issues v4 stop. The ACP adapter must not send an additional,
unscoped stop during an upload. Local goal commands still call
`stopActiveTurn()` because their continuation is started by a separate op.
A cancelled prompt resolves with `stopReason: "cancelled"`; cancellation never
turns into an error response.

### Image input — issue #79

`initialize.promptCapabilities.image` is true; audio stays false. The adapter
maps ACP image blocks to the existing `TuiPromptAttachment` data-URL shape and
calls `AttachSessionHandle.submitPrompt` once with text and all images. No
filesystem staging, remote URI fetching, new upload implementation, or model
provider import is introduced.

```text
ACP prompt blocks
  → synchronous validation + mapping (ACP adapter)
  → existing AttachSessionHandle (one in-flight prompt/abort signal)
  → existing v4 attachment transaction (core owns artifact bytes and refs)
  → one sendText with text + committed refs (core owns input admission)
  → normal model request / signing / turn events
```

- Accept inline PNG, JPEG, GIF and WebP with nonempty canonical padded base64.
  Each image must fit the shared `PROTOCOL_V4_LIMITS.attachmentMaxBytes` limit;
  check encoded length before decoding. MIME/encoding/size validation happens
  for the **whole prompt before any upload or command**. Actual image decoding
  and model compatibility remain core/provider responsibilities.
- Preserve text/resource flattening and image order. Images receive deterministic
  per-prompt display names; their storage identity remains the existing random
  upload transaction and core artifact reference. An image-only prompt has
  empty text and is valid; an empty prompt without images is not.
- An optional ACP image URI is not fetched or opened: inline `data` is the
  content authority. Audio, invalid images and images attached to commands
  answered locally return ACP invalid-params errors, never silent image loss.
  Skill invocations that produce a model prompt retain the images.
- Upload failure uses the existing abort cleanup, rejects the prompt, and
  never sends `sendText`. Cancellation during begin/chunk/commit must prevent
  subsequent uploads and command admission, return `cancelled`, and release
  the ACP in-flight slot. Resume does not replay uploads or resend a prompt.
- Diagnostics record only session/trace identifiers, attachment counts and
  stable failure descriptions, never base64 bytes, image URIs or prompt text.
  Shared-core ownership, permissions, no-plugins startup and signing are unchanged.

Regression evidence belongs in the pure input mapper, the SDK client ↔ ACP
agent tests, and a disposable socket test using the real `AttachSessionHandle`
and upload implementation. Fixtures prove protocol forwarding, not image
understanding, real-model compatibility or allowance eligibility. A real
T3/model image turn remains unverified until observed on a verified built pair.

## Local slash commands (`/goal`, `/dwf`)

ACP clients have no command center: without interception, `/goal …` and
`/dwf …` typed in the client would reach the model as literal prompt text
(P005 forwarding) and never touch the goal state machine or the workflow
journal. The adapter therefore routes these two commands locally, the same
way the TUI command center does — through the same core ops, not a parallel
implementation:

| Input | Wire call | Response |
| --- | --- | --- |
| `/goal` / `/goal show`-less args | `session/goal` `action:"show"` | core `response` text |
| `/goal <objective>` | `session/goal` `action:"set"` + adapter-generated `inputId` | core `response`; then the continuation turn is awaited |
| `/goal replace <objective>` | `session/goal` `action:"replace"` | same as `set` |
| `/goal pause` / `resume` / `clear` | `session/goal` matching action | core `response` text |
| `/target …` | alias of `/goal` (same alias as the TUI) | — |
| `/dwf` / `/dwf list` | `v4/conversation/workflowRuns` (limit 20) | formatted run list (shared formatter with the TUI handler) |
| `/dwf cancel [runId]` | list + `session/cancelBackgroundTask` when exactly one run is in flight; otherwise candidate list | cancel result text |
| `/dwf resume <runId>` | `v4/command` `resumeWorkflowRun` (workId ≡ runId) | resume result text; `fault.command.workflowRunResumeRejected.<reason>` maps back to the structured reason |

Rules:

- Parsing mirrors the TUI: the prompt must start with the command word
  (case-insensitive); everything after the first whitespace is args. Only
  these two commands are intercepted — every other slash input keeps the
  P005 verbatim-forward behavior. `/model` over ACP is the config option,
  not text.
- The core is the single owner of goal state, response wording, the
  set-over-existing → replace collapse and the plan-mode continuation note;
  the adapter passes the parsed action through and renders the core's
  `response` verbatim as one `agent_message_chunk` (no model turn is
  involved). One ACP-lane exception: a successful `pause` returns an empty
  `response` by design (the protocol lane wants no bubble), but ACP clients
  have no goal panel — the adapter synthesizes `Goal paused.` so the
  command is not swallowed. A genuinely empty core response still emits no
  chunk.
- `session/goal` results are schema-validated (`zcodeSessionGoalResultSchema`)
  at the boundary; the returned snapshot merges into the handle like every
  other mutation.
- Goal `set`/`replace`/`resume` return `startedTurn: true` when the core
  launched the continuation turn. The adapter generated the `inputId` it
  passed to the op and subscribed a temporary sink **before** sending the
  op, so `turn_started(inputId)` cannot be missed. The ACP `session/prompt`
  request stays open until the **first** turn with that inputId settles
  (`turn_complete` / `turn_error`, both carry `inputId`); later goal-loop
  turns keep streaming as ordinary `session/update`s after the prompt
  returns. This is the ACP-lane boundary of the background continuation the
  TUI also does not block on. `startedTurn` is a pre-check, not a promise:
  the queued continuation can still come back empty-handed (deferred to a
  pending command, goal changed, prepare-boundary throw) **without emitting
  any turn event**, so the watch carries a no-turn-start backstop (default
  30 s, injectable for tests) that resolves the prompt as `end_turn` once
  no `turn_started(inputId)` has arrived; a started turn disarms the
  backstop (its `turn_complete`/`turn_error` is guaranteed, cancellation
  included). The deterministic alternative — routing the core's
  `state.updated` goal-continuation notifications through the attach client
  — stays a future option; the backstop deliberately avoids widening the
  attach sync surface for it.
- `session/cancel` goes through the existing v4-stop path (stop aborts the
  turn and pauses an active goal), after which the waiter resolves and the
  prompt returns `stopReason: "cancelled"`. It also covers goal-loop turns
  2..N: once the prompt has returned, the session is no longer in the
  in-flight table, so a cancel with no active turn falls back to a direct
  `stopActiveTurn()` (a core-side no-op when idle). This stop scoping is
  goal-lane only: cancelling a `/dwf` command (a pure op round-trip, no
  turn of ours in the core) never issues a v4 stop that could kill another
  client's turn.
- A second `session/prompt` while one is running (including local commands)
  is rejected by the existing in-flight guard — ACP clients serialize turns
  anyway, and the core-level guards (`Cannot manage goals while a prompt is
  running`) stay authoritative.
- Command or op failures surface as a `RequestError` with the core's
  message; they are never turned into a fake empty response.
- `session/new` and `session/resume` emit one `available_commands_update`
  advertising exactly the two locally routed commands (`goal`, `dwf`) so
  clients offer them in their input; commands the adapter does not route
  are deliberately not advertised.
- The dwf engine gate is unchanged: the shared core fails closed on dynamic
  workflows unless a host enables the policy, so `/dwf list` is a truthful
  empty list in default piz sessions. Full command semantics over ACP does
  not imply enabling the engine; that is a separate product decision.
- Resource blocks ride along as text: `promptBlocksToInput` flattens a
  prompt into one text string, so resource blocks typed around a local
  command end up **baked into its args** (a `/goal <objective>` objective
  or ignored as part of args), not attached as separate context. No local
  command reads ACP resource blocks; clients that need true attachments
  send a normal prompt.
- The response chunk for a local command is enqueued after whatever the
  core already streamed into the update queue (a goal continuation may have
  started streaming before the op response is emitted), so the banner can
  land after the first streamed chunks of the very turn it describes. This
  ordering is accepted: reordering the queue per command would be a second
  sequencing owner. Also, a settled `turn_error` for the awaited goal turn
  does **not** surface as an ACP `notice` or an error stop reason — the
  prompt returns `end_turn` and the error text reaches the client only
  through the ordinary projected `agent_message_chunk`s the core emits;
  ACP v1 has no per-prompt error channel short of failing the whole
  request, which would misreport a settled turn as a protocol failure.

`AttachSessionHandle` gains the wire surface behind this routing:
`goalCommand` (one `session/goal` call, schema-parsed result), and the
CommandCenterApp optional methods `listDynamicWorkflowRuns` /
`resumeWorkflowRun` (v4 query / v4 command) — the latter also unblocks
`/dwf` for the attach TUI lane, which previously reported "not available in
this client" because no CLI-side app implemented them. Boundary validation
shares the protocol's own schemas: `session/cancelBackgroundTask` sends the
strict `{sessionId, taskId}` params (taskId, never a `backgroundTaskId`
key) and parses the result with
`zcodeSessionCancelBackgroundTaskResultSchema`; the resume-rejection word
list is derived from the shared `workflowRunResumeRejectionReasonSchema`
enum (a mirror of the contracts `DynamicWorkflowRunResumeErrorReason`),
not hand-copied per call site.

## Mapping

| Area | v1 behavior |
| --- | --- |
| Sessions | `session/new`, `session/resume`, `session/close` (real stop); no `session/load`, so history is never replayed |
| Turns | `session/prompt` (text + resource blocks + inline images; audio rejected), `session/cancel`, `session/update` |
| Local commands | `/goal` (+`/target`) and `/dwf` intercepted in `session/prompt`, routed through core ops, response emitted as an `agent_message_chunk`; advertised via `available_commands_update` (see the section above) |
| Workspaces | one lazy `AttachRuntime` + socket client per `cwd`; sessions are per-cwd but share that lane. All lanes converge on the single shared core: the socket endpoint is derived from the data root only, never from `cwd`/workspace identity (2026-11-08 single-core consolidation); workspace refs still travel in every `session/create`/`session/resume`/`session/list` so per-session isolation is unchanged |
| Permissions | `session/request_permission`; `allow_once` / `allow_always` (only when core suggests permission updates) / `reject_once`; answer is the core option's `response` |
| `AskUserQuestion` | form elicitation: one string property per question, single-select as `enum`, multi-select as comma-separated text; answers are keyed by question text |
| `ExitPlanMode` | form elicitation with the complete `input.plan` in the decision field's description and an explicit `approve` / `reject` enum; Auto/Full cannot silently approve a plan because the client must return a decision |
| Modes | `plan` and `build`; any other core mode projects as `build` |
| Models | `session/set_config_option` with `configId: "model"`, values `provider/model`; `config_option_update` on model change |
| Reasoning effort | `session/set_config_option` with `configId: "thought_level"`, category `thought_level`; select choices come from the **current model's** `reasoning.levels` in `settings.model.available` (never the unioned `thoughtLevel.available`); `currentValue` falls back `thoughtLevel.current` → `thoughtLevel.defaultLevel` → model `reasoning.defaultLevel` → first level. The option is omitted when effort is disabled or the current model advertises no levels. The setter response returns the full `configOptions`; a model switch reprojects effort choices through the existing `config_option_update` lane. Effort changes made by other clients reach the handle through `state.updated` → `applyStatePatch`, which emits `model_selected` when the model selection **or** `thoughtLevel.current` changes; the agent then pushes `config_option_update` rebuilt from the live snapshot. Changes this connection made itself (in-flight `session/set_config_option`) are not pushed again: the response already carries the confirmed options. After a model switch the attach client sends the target model's `reasoning.defaultLevel`, and the core snapshot drops any `thoughtLevel.current` not listed for the current model, so no stale level is kept |
| Compact cap | applied on create/resume/model change via `syncCompactContextWindow` (GLM → 262K) |
| MCP from the ACP client | stdio/HTTP/SSE, forwarded to the core as a complete session override; see the client MCP extension below |
| Files/terminals | core executes them; `fs/*` and `terminal/*` are neither advertised nor used |
| Auth | outside ACP: existing `piz login`; no `authMethods` advertised |
| Disconnect | detach — core sessions survive; the ACP connection only unregisters its sinks |

### Reasoning effort before the first prompt

`session/new` and `session/resume` include the legacy ACP v1 `models` field
that T3 accepts for model discovery. It uses the same enabled models and
`provider/model` IDs as the standard `model` config option. Each model's
`_meta` advertises its own `reasoningEfforts` (`value` and `label`) and
`reasoningEffort` (the model default, when valid). A model with no levels
advertises `supportsReasoningEffort: false`.

This lets T3 list Flash's choices in a fresh catalog while GLM-5.3 is
active, without switching models or sending a prompt. The core snapshot is
the only source; the adapter adds no discovery requests or state. The
standard `model` and `thought_level` config options still own selection
and report the active values. T3 uses the active `thought_level` control as
the template for the advertised per-model choices; if the active model has
no such control, T3 may still need to observe a reasoning-capable session.

### Plan approval content

The core's `ExitPlanMode` input is the sole authority for the plan under review.
The ACP adapter validates it with `ExitPlanModeInputSchema` and preserves the full
plan string, including Markdown and whitespace, in the approval field's
`description`, before the approval instructions. Do not rely on the elicitation's
top-level `message`: the reported T3 approval panel shows the field description,
but not that message. The reason remains the form's top-level message; it is not
a substitute for the plan.

This is a pure projection of the existing reverse request, not a new transcript
message, saved plan, checklist update or approval state. Invalid/missing plans
fail before an approval form is sent. Approval, rejection, decline and cancellation
keep their existing response mapping. No core protocol, ownership or event-order
change is needed.

## Spike results (T3 Code 0.1.6)

Verified:

- T3 0.1.6 is installed locally; its docs describe `Settings → Providers → Add
  provider → Show more → Local ACP command` (executable + literal args), ACP v2
  preferred with v1 negotiation, and plan/build modes following T3's toggle.
- T3 appends its own `t3-code` MCP server to every agent session plus system-prompt
  instructions. It accepts agents that do not consume it; the original adapter
  ignored and logged `mcpServers`. Issue #31 replaces that behavior.
- T3 answers permission requests by thread mode: Supervised shows them, Auto-accept
  edits approves edits, Auto and Full access approve automatically. That is why plan
  approval is an elicitation form with an explicit answer rather than a permission
  request.
- Local stdio handshake of the built thin client: pure JSON stdout, `protocolVersion`
  1, `agentInfo {name: "piz"}`, `sessionCapabilities {resume, close}`, exit 0.

Not verified (no T3 provider instance / GLM credentials were configured here):

- Whether T3 cancels a turn before a checkpoint rollback or a stop.
- What T3 does when `session/resume` arrives during a live turn.
- How T3 renders string-`enum` elicitation forms and comma-separated multi-select.
- A full GLM turn, RSS per ACP client, plugin startup, and signing through attach.

These are acceptance items, not claims. The adapter fails closed where it can: an
unknown session, an in-flight second prompt, or an unrenderable interaction returns an
explicit error/decline instead of a silent success.

## Client MCP extension — issue #31

Status: implemented; disposable and isolated real-T3 source-runtime evidence
recorded in [the fork report](../../fork/reports/acp-mcp-tools.md). Not installed.
`additionalDirectories` forwarding is not part of this extension.

Upstream v4.0.0 moved MCP connection ownership into `McpSession`, and the fork
was ported onto that model (see "Configuration source" below). The fork report
and the November 12 real-T3 pass describe the implementation before that port:
they are history, not acceptance of the ported code. Real-T3 acceptance of the
ported implementation is not recorded yet. Terms: [GLOSSARY.md](../../../GLOSSARY.md).

### Admission and ownership

- `initialize` advertises HTTP and SSE MCP support; stdio is ACP's baseline.
  The thin adapter translates ACP server descriptions using shared protocol
  schemas, never an MCP SDK or a bootstrap/core runtime import.
- `session/new.mcpServers` is a complete session override. `[]` means no
  servers, not fallback to workspace/user/plugin configuration. Omission on
  resume retains the in-memory override, if one exists. When the ACP adapter
  survives a shared-core restart, its internal cold recovery resends the
  session's last acknowledged declaration from memory; if the ACP process
  itself is lost, credentials are unrecoverable unless the client supplies
  them again.
- ACP servers use explicit session isolation and the session's execution cwd
  for stdio. Client-provided servers are trusted configuration from the owning
  protocol client, not repository declarations. They cannot acquire builtin
  plugin provenance or bypass normal MCP tool-call permissions.
- The protocol record retains the accepted client declaration only in memory,
  for resume comparison and fork inheritance. The runtime owns effective
  configuration, pending replacement, transport state, and turn ordering.
  The adapter does not keep a second accepted configuration or update queue.
  Its only client-MCP state is a replay snapshot — an independent copy of the
  last declaration acknowledged by the core, updated only on successful
  create/resume replies — used solely to populate `session/resume` when the
  adapter's own transport reconnect finds the session record gone (shared
  core restart, idle eviction). A successful warm resubscribe sends no
  extra resume; a failed bound resume keeps the older snapshot.
- No credentials, commands, environment values, header values, or full
  configuration are written to logs, events, session history, or disk caches.
  Diagnostics use session/trace identifiers, counts, and stable error kinds.

### Configuration source

Upstream v4 gives each session one owner of MCP connections: `McpSession`
(`core/src/mcp/runtime/session.ts`). It reads a configuration source, and each
new snapshot makes it connect, replace, or remove servers and withdraw or
publish tools. The fork adds no second owner. It wraps the upstream source in
an [override source](../../../GLOSSARY.md)
(`core/src/runtime/mcp-client-session.ts`) and hands `McpSession` a view of it.

- Snapshot order: a detached session publishes `{ enabled: false, servers: {} }`.
  Otherwise the snapshot is the client declaration, if there is one; else the
  upstream base source (disk and plugin configuration); else the configuration
  the session was created with. A client declaration is a complete override and
  is never merged with the base.
- A missing server map means the session has no configuration to apply. An
  injected port keeps its existing directory, and children can borrow that
  directory. An explicit empty map instead asks the session to remove all
  connections.
- Applying, suspending, and closing run on one serialized queue, the
  [apply tail](../../../GLOSSARY.md). A counter that increments on every attach
  and detach lets the runtime discard a result that completes after the
  attachment changed.
- A [turn boundary](../../../GLOSSARY.md) with nothing staged and no
  [reconnect debt](../../../GLOSSARY.md) does not touch the session and does
  not wait for connections. Upstream's background startup policy stays in
  effect.
- The runtime reconnects without a configuration change only when reconnect
  debt exists: after [adoption](../../../GLOSSARY.md), or when an identical
  declaration arrives and the port reports a desired server as failed,
  disconnected, or missing. It then asks the port to revalidate the applied
  servers once. A session declared at `session/create` has no staged
  declaration, so it retries from its applied configuration.
- Closing the session releases only the view. The runtime owns the base source
  and closes it at shutdown.

### Lazy resources and the no-plugins boundary

`--no-plugins` continues to prohibit automatic plugin, builtin MCP, and
workspace/user-file MCP loading. The sole exception is an explicit session
override. An empty session must not create an MCP pool, adapter, settings lease,
broker, telemetry timer, connection, or child process. The explicit session
creates its owned MCP adapter/lease lazily, including when servers are first
provided on warm resume. This does not start another core or change the socket
identity. Closing or removing the final client server releases its resources.

### Replacement, detach, and fork order

```text
validated ACP declaration
  → session/create or session/resume
  → protocol record accepts an in-memory, independent declaration
  → runtime stages the latest replacement
  → current turn finishes
  → next turn boundary applies transports and invalidates MCP tool registration
  → next turn discovers the confirmed tool set

transport detach
  → synchronously suspend client MCP admission and fence late connection work,
    including sessions whose app factory is still materializing (attachment
    signal is captured before the factory await, not found by a later scan)
  → cancel the old attachment's connect wait without cancelling its turn;
    this frees the trust guard's queue to apply the empty configuration
  → disconnect and await session-owned stdio teardown
  → retain runtime/history and in-memory declaration for adoption
  → resume/adoption schedules suspended connections at the next turn boundary

shared-core restart while this adapter lives
  → resubscribe fails (no resident record)
  → internal cold session/resume carries the adapter's replay snapshot
  → resubscribe → session resumes with the same handle and client MCP
```

- An idle runtime may apply immediately. Queued inputs, goal continuations, and
  other runtime turn entry points must cross the same boundary. A model-request
  boundary inside a running turn is not sufficient.
- Semantically equal declarations, including credentials, are a no-op on live
  or still-connecting connections. Server/object ordering alone does not force
  a reconnect. Declaration equality is not connection health: an identical
  create/resume declaration still retries desired servers whose live status is
  failed, disconnected, or missing — one bounded retry per explicit
  configure/resume, never a per-turn retry loop. Servers mid-handshake or
  explicitly disabled/untrusted are left alone; live entries keep the same
  connections and PIDs. Removed or changed servers retire their old session
  connections; unaffected servers keep theirs.
- Applying, suspending, and closing are serialized and fenced against stale
  asynchronous completion. Close is terminal. Detach cannot be undone by a
  late connect result or an old owner's callback after adoption.
- Detach terminates session stdio children promptly, not after the pool's
  workspace idle-grace period. An in-flight MCP call may fail when its child
  exits; this must not abort the whole turn or destroy the runtime. File/plugin
  MCP in other app-server modes keeps its existing lifecycle.
- Warm/adopted resume must not replace the ACP handle or its in-flight waiter.
  Identical live settings remain connected; changed settings wait for the
  current turn to finish. No restart or cancellation is used for refresh.
- Workflow children borrow the parent's MCP surface, not a constructor-time
  snapshot. A child waits for the parent's [apply tail](../../../GLOSSARY.md)
  to settle and for scoped servers that are still connecting, then takes the
  parent session's view in one synchronous read. Status and tools come from
  that single read, so a borrower never receives a mixed-generation view. When
  the parent detached or was replaced during the wait, the child sees the
  current state: no MCP for a detached parent. Borrowers never own, connect,
  disconnect, or cancel the parent's transports, and never apply the parent's
  pending staged configuration during an active parent turn.
- Fork copies the most recently accepted client declaration, including a
  pending replacement, in memory. The child gets independent session-owned
  connections; closing/detaching either session cannot kill the other's tools.
  Fork persistence does not copy credentials.
- MCP tools retain the existing registry, ToolSearch, permission, result,
  cancellation, and trace paths. Re-registration is explicitly invalidated on
  replacement; it must not depend on adapter revision sums being distinct.

### Acceptance cases

| Case | Required observation |
| --- | --- |
| CMCP01 | New ACP sessions forward stdio/HTTP/SSE definitions correctly; protocol stdout stays JSON-only |
| CMCP02 | Empty/omitted no-plugins sessions allocate no MCP resources and cannot load file/plugin servers |
| CMCP03 | Concurrent sessions, including the same cwd/server name, cannot see or close each other's tools |
| CMCP04 | Unchanged/reordered resume settings preserve connection identity and stdio PID |
| CMCP05 | Changed credentials during a running multi-step turn take effect only after that turn; the next queued/goal turn uses the new tools |
| CMCP06 | Explicit `[]` removes client servers and tools without falling back to file config |
| CMCP07 | Late first injection after an empty session discovers and registers tools correctly |
| CMCP08 | Close and idle/active detach terminate real disposable stdio children; adoption reconnects without replacing the session |
| CMCP09 | Fork inherits client tools, including pending settings, with independent connections and credential-free persistence |
| CMCP10 | Close/detach during a pending connect cannot leak or resurrect children; detach/adoption ordering is fenced |
| CMCP11 | MCP allow/reject follows the existing ACP permission callback and tool-result path |
| CMCP12 | Invalid/duplicate server definitions fail at the boundary without echoing sensitive fields |
| CMCP13 | Disposable HTTP/SSE tool discovery and execution use fake authorization only; diagnostics/persistence contain no fake secret sentinel |
| CMCP14 | A real T3 check, after credential rotation, establishes whether resume resends `mcpServers`, including after an isolated core restart |

CMCP14 cannot be proved by fixtures. Do not inspect environment values or print
request payloads to perform it; record presence/count/transport and tool success
only. Installed binaries, live-core restarts, promotion, and key rotation remain
separate operator-controlled actions. Unreached live acceptance is reported as
unverified, never inferred from source or disposable-server checks.

Observed CMCP14 baseline (pre-repair, real T3 on an isolated scripted lane):
the same ACP process survived an isolated core restart and sent only a second
`session/prompt` — no client `session/resume`. The first prompt used the
injected tool; the post-restart prompt had no client MCP tools because the
adapter's internal cold recovery resumed without `mcpServers`. That gap
motivates the replay-snapshot resend above; a post-repair live pass is
reported separately and never inferred from this observation.

On November 12, 2026, the post-repair real-T3 check passed: the same adapter
called the read-only capabilities tool before and after an isolated core
restart. T3 sent only another prompt; the adapter restored MCP through its
internal cold recovery. An independent reconnect re-check returned
`PASS+NOTES`, including unchanged warm connection identity and explicit-empty
replay. This uses a source-runtime assembly and scripted executor, not an
installed pair or real model. ACP-process replacement is separately untested.

## Bundle cost

Measured with the same esbuild entry (`src/attach/attach-main.ts`) and metafile:
the ACP SDK is **178,557 input bytes** and the ACP modules **44,385 input bytes**, out
of 4,207,360 total input bytes (4.3%). The unminified attach bundle is 2,294,963 bytes
(2.2 MB) — the same order as before the adapter, and the thin gate still holds (no
bootstrap/core runtime code in the bundle).

## Verification

- `tsc --noEmit` on `@zcode/cli`.
- `tests/acp-project.test.ts` (pure mapping), `tests/acp-agent.test.ts` (in-process
  ACP client ↔ agent, fake core port), and the replaced `routes acp to the ACP stdio
  adapter` test in `cli.unit.test.ts`.
- Built `dist/zcode-attach.cjs` handshake over real stdio (initialize only; no core).
- Thin gate: the bundle contains no bootstrap/core runtime code; the only
  `bootstrap/src` hit is an inherited comment.
- Selected fork runner (`mise exec -- node apps/zcode-cli/scripts/fork-tests.mjs`,
  base `c2d393f797`): adapters 13, bootstrap 4 and the ACP/cli tests pass. The
  `@zcode/cli` package script still exits 1 on one asset test,
  `build-sea.test.mjs` "includes bundled official plugin assets": this checkout has
  no generated `browser-use-plugin/scripts/browser-client.mjs`, and building that
  plugin fails on unbuilt `@zcode/core` / `@zcode/node-repl-host` type output. The
  other two `build-sea` asset tests pass after `tsc -b packages/shared`. This is a
  pre-existing plugin-asset build gap, not an ACP failure.

## Known limits

- `session/update` tool output is text-only; ACP diff/terminal content is not emitted.
- Model options come from the session snapshot; a model the account cannot use stays
  visible only if core lists it as enabled.
- History is not replayed by design; a client that drops its own transcript cannot
  rebuild the conversation through ACP.
- `session/close` releases the core runtime but keeps the stored session, so resume
  works afterwards.
