# tui-attach shared core — slice B client build spec

Status: implementation in progress (this file = durable spec; keep it accurate as built).

## Goal

`zcode attach` / `zcode tui --tui-frontend=pi --shared-core` runs pi-tui as a thin
client against the shared headless core (`zcode app-server --socket --no-plugins`)
from slice A (`feat(app-server): unix socket mode, no-plugins runtime, attach spawn helper`).

## Already built (slice A + protocol additions, in tree)

- Spawn helper: `packages/cli/src/app-server-spawn.ts`
  `resolveSocketPath({workspacePath, workspaceIdentity?})`,
  `ensureServer({workspace, socketPath?, env?, version?, spawnSpec?})` → `{socketPath, reused}`.
- Socket listener (multi-client NDJSON): bootstrap `zcode-protocol/socket-listener.ts`.
- Wire: NDJSON `{id,method,params?,trace?}` / `{id,result|error}` / `{method,params}`;
  server may issue reverse requests `{id,method,params}` that client must answer.
  Message union: `zcodeProtocolMessageSchema`; version const `ZCODE_PROTOCOL_VERSION`.
- Protocol additions (this branch, uncommitted):
  - `zcodeSessionEventFormatSchema = "mapped"|"raw"`;
    `zcodeSessionRawEventSchema` = SessionEvent envelope
    `{id, sessionId, turnId?, type, timestamp(iso|num), traceId, sequenceNumber, payload?…}` loose.
  - `session/subscribe` + `eventFormat`; raw → `result.rawEvents`, `eventSeq` = last
    `SessionEvent.sequenceNumber`; live events arrive as notification `session/rawEvent`.
    `session/events` + `eventFormat:"raw"` → `rawEvents`.
  - `session/recallPreviousInput` `{sessionId, skip?}` → `{entry:{text}|null}`.
  - `session/recordInputHistory` `{sessionId, text, kind?}` → `{}`.
  - `zcodeProtocolNotifications.sessionRawEvent = "session/rawEvent"`.

## Flag decision (conflict)

`--attach <path>` already exists (multiple:string, prompt attachments). Resolution:
new boolean **`--shared-core`** scoped to `tui`, plus argv preprocessing making
`zcode attach` → `zcode tui --tui-frontend=pi --shared-core`. Bare `tui --attach`
is NOT remapped (ambiguous with the attachment flag).

## Files

| File | Contents |
|---|---|
| `cli/src/attach/attach-client.ts` | NDJSON socket client: connect/socketPath, request/notify, reverse-request handler, `closed` promise, `close()`. Line-buffer parse; safeParse `zcodeProtocolMessageSchema`; pending map; ids `attach-N`. Cross-platform (unix path or `\\.\pipe\`). |
| `cli/src/attach/attach-argv.ts` | `rewriteAttachArgv(argv)`: `attach` command → tui args; exported + unit tested. |
| `cli/src/attach/attach-session.ts` | `AttachSessionHandle`: per-session protocol-backed app surface (CommandCenterApp subset + TUI session ports). |
| `cli/src/attach/attach-tui-options.ts` | `AttachRuntime`/`buildAttachTuiOptions`: owns client+reconnect, event fan-out (subscribe raw, resubscribe afterSeq on reconnect), reverse-request routing, TuiOptions assembly (local ports stay local). |
| `cli/src/attach/attach-command.ts` | `runAttachCommand`: resolveSocketPath→ensureServer→connect→handshake (capabilities + session/create, answer `session/requestRuntimePreferences` with `{nativeSearchEnhancementsEnabled:false}`, check `snapshot.protocol.version === ZCODE_PROTOCOL_VERSION` else actionable error + nonzero) → build TuiOptions → `runTui` via existing `loadPiTuiRuntime()` → finally client.close() (never session/close — session survives). |
| wiring | `arguments.ts` (`shared-core` boolean, tui scope), `main.ts` argv rewrite for `attach`, `run.ts` tui-case dispatch, i18n en-US/zh-CN help, `architecture-policy.yaml` (extend `app-server-attach` roots, no new exception). |
| tests | `tests/attach-argv.test.ts`, `tests/attach-client.test.ts`, `tests/attach-adapter.test.ts` (fake net server; reconnect/resubscribe via injected connect fn). Add each to cli package.json test script. |

## Port mapping (TuiOptions types.ts:301 → protocol)

- `subscribeSessionEvents` → `session/subscribe {deliveryKind:"desktop-continuous", eventFormat:"raw", includeSnapshot:true}`; dispatch `session/rawEvent` per sessionId (revive timestamp→Date).
- `submitPrompt`/`sendInput` → `session/send {sessionId, content, inputId}`; turn
  completion via raw events (`turn_started`→turnId, `turn_completed`/`turn_error`).
  Steer via v4 command topic `v4/command` sendText (check desktop client for ACK shape:
  `packages/services/src/zcode-agent/zcodeProtocolClient.ts`).
- mode/model/thoughtLevel → snapshot + `session/setMode|setModel|setThoughtLevel`.
- goal ops → `session/goal` (show|set|replace|pause|resume|clear).
- checkpoints → snapshot field.
- `readSubagents` → `session/subagents`; `readSubagentTranscript` →
  `session/messages` + `session/events{raw}` on childSessionId.
- `recallPreviousInputHistory` → `session/recallPreviousInput`;
  deps.recordInputHistory → `session/recordInputHistory`.
- `cancelBackgroundTask` → `session/cancelBackgroundTask`;
  workflow runs → v4 conversation topics (if a topic is missing, port stays
  "unavailable" per TuiOptions contract — list unmapped ports honestly).
- `listMcpServers` → `{}` constant; connect/disconnectMcpServer → feature-unavailable.
- Reverse requests: `interaction/requestPermission` → TUI permission callback;
  `session/requestRuntimePreferences` → static `{nativeSearchEnhancementsEnabled:false}`;
  others → error -32601.
- Slash routing: reuse `createCommandCenter` (tui package) with protocol-backed
  `CommandCenterApp` + `CommandCenterDeps` (newApp/resumeApp/forkApp create new
  handles). Client holds no business state — projection/state from @zcode/tui
  internals fed by raw events.
- Local-only ports: clipboard (`createNodeClipboard*`), workspace path suggestions,
  stdin/stdout/stderr, noColor, theme, locale, version, workspaceDirectory,
  developerMode — copy the in-process `tui` case construction in run.ts.

## Reconnect

`closed` → emit synthetic SessionEvent the projection renders visibly (banner);
backoff 1s→2s→4s… cap 30s; on reconnect re-`session/subscribe` all active sessions
`{eventFormat:"raw", afterSeq:lastSeq}` and emit "reconnected" event. `close()`
stops retries + destroys socket.

## Gates

`pnpm --dir apps/zcode-cli typecheck` (rebuild changed workspace deps first on
missing-exports), scoped oxlint, `pnpm architecture:check --changed`, new tests
green, tui-pi tests still green. ONE commit:
`feat(tui-attach): pi-tui thin client over shared app-server core`. No push.
