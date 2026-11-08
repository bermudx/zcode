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
                            no loadSession, no image/audio, no MCP
session/new {cwd}      ──►  one lazy lane per cwd ─────────────────────► session/create
                            └─ subscribe, compact cap for GLM
session/prompt         ──►  v4 sendText ──────────────────────────────► turn
  ◄── session/update         raw SessionEvent → ACP update projection
  ◄── session/request_permission ◄──────────────────────────────────── permission
  ◄── elicitation/create     AskUserQuestion / ExitPlanMode ◄──────────── interaction/*
  ◄── {stopReason}           turn_complete / turn_error / cancel
session/cancel         ──►  v4 stop ──────────────────────────────────► runtime stop
session/resume         ──►  session/resume (no history replay) ───────► cold materialize
session/close          ──►  v4 stop + session/close ──────────────────► runtime released
```

`piz acp` reuses `AttachSessionHandle` for sessions, turns, mode/model mutation and
permission callbacks; it does not re-implement the share-core client. `session/new`
ignores `mcpServers` and logs the count — core owns its MCP configuration.

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
  → v4 sendText (commandId)
  → [core] turn_started(inputId)
  → session/update agent_message_chunk …      (model_streaming text_delta)
  → session/update tool_call → tool_call_update(…)
  → [core] session/request_permission  ⇄  client optionId  → core option.response
  → elicitation/create                ⇄  client content     → core answers/approve
  → [core] turn_complete | turn_error
  → session/prompt response {stopReason}
```

`session/cancel` sets the turn's cancelled flag, aborts the per-turn signal (which
issues the v4 stop in `AttachSessionHandle`) and calls `stopActiveTurn()`. A cancelled
prompt resolves with `stopReason: "cancelled"`; cancellation never turns into an
error response.

## Mapping

| Area | v1 behavior |
| --- | --- |
| Sessions | `session/new`, `session/resume`, `session/close` (real stop); no `session/load`, so history is never replayed |
| Turns | `session/prompt` (text + resource blocks only; images/audio rejected with a message), `session/cancel`, `session/update` |
| Workspaces | one lazy `AttachRuntime` + socket client per `cwd`; sessions are per-cwd but share that lane |
| Permissions | `session/request_permission`; `allow_once` / `allow_always` (only when core suggests permission updates) / `reject_once`; answer is the core option's `response` |
| `AskUserQuestion` | form elicitation: one string property per question, single-select as `enum`, multi-select as comma-separated text; answers are keyed by question text |
| `ExitPlanMode` | form elicitation with an explicit `approve` / `reject` enum; Auto/Full cannot silently approve a plan because the client must return a decision |
| Modes | `plan` and `build`; any other core mode projects as `build` |
| Models | `session/set_config_option` with `configId: "model"`, values `provider/model`; `config_option_update` on model change |
| Reasoning effort | `session/set_config_option` with `configId: "thought_level"`, category `thought_level`; select choices come from the **current model's** `reasoning.levels` in `settings.model.available` (never the unioned `thoughtLevel.available`); `currentValue` falls back `thoughtLevel.current` → `thoughtLevel.defaultLevel` → model `reasoning.defaultLevel` → first level. The option is omitted when effort is disabled or the current model advertises no levels. The setter response returns the full `configOptions`; a model switch reprojects effort choices through the existing `config_option_update` lane. Effort-only changes from other clients are not newly subscribed by this fix |
| Compact cap | applied on create/resume/model change via `syncCompactContextWindow` (GLM → 262K) |
| MCP from the ACP client | ignored and logged; core keeps its own MCP configuration |
| Files/terminals | core executes them; `fs/*` and `terminal/*` are neither advertised nor used |
| Auth | outside ACP: existing `piz login`; no `authMethods` advertised |
| Disconnect | detach — core sessions survive; the ACP connection only unregisters its sinks |

## Spike results (T3 Code 0.1.6)

Verified:

- T3 0.1.6 is installed locally; its docs describe `Settings → Providers → Add
  provider → Show more → Local ACP command` (executable + literal args), ACP v2
  preferred with v1 negotiation, and plan/build modes following T3's toggle.
- T3 appends its own `t3-code` MCP server to every agent session plus system-prompt
  instructions. It accepts agents that do not consume it; this adapter ignores and
  logs `mcpServers` instead of forwarding them.
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
