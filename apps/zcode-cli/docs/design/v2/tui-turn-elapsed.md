# TUI Turn Elapsed Indicator

## Goal

The interactive TUI shows how long the current top-level turn has been
running. The indicator appears on the right side of the live status line
while a turn is active and updates live so long-running work has an
immediate time signal.

## Scope

- Track the active turn start timestamp in the shared session projection
  state (`activeTurnStartedAtMs`): React state in the OpenTUI frontend,
  `AppStore.state` in the pi frontend. Both are fed by the same
  `applySessionEventToState` handler (`setActiveTurnStartedAtMs`).
- Render a right-aligned elapsed indicator on the activity/status row only
  while a turn is active.
- Clear the indicator when the active turn completes or fails.
- Keep the feature local to the TUI presentation surface; do not add a
  `ZCODE_` environment variable or alter provider/runtime contracts.

## Anchor Contract

`activeTurnStartedAtMs` has the same lifecycle as `activeTurnId`:

- `turn_started` sets it to the payload's `executionStartedAt` — the core's
  execution-entry epoch ms. For attach (pi) clients this is the honest
  anchor for remotely started turns, including turns already running when
  the client subscribes. When the payload lacks the field the client falls
  back to receive time.
- `turn_complete`, `turn_error`/`model_error` (non-compact path), and the
  settle-result guard that clears `activeTurnId` clear it.
- Starting an idle turn clears any leftover anchor before the busy gate
  opens (`submitIdleTurn`, shared by both frontends). A turn whose settle
  event never reaches the client (e.g. `submitPrompt` rejects on a
  transport failure) therefore cannot resurface its elapsed count during
  the next turn's acceptance gap.
- The settle-result guard compares the settled turn id against a ref
  mirror of `activeTurnId` and clears both fields outside any React state
  updater — updaters stay pure, so the clear cannot be decoupled from the
  `activeTurnId` change by a discarded or double-invoked render pass.
- The anchor is written before `activeTurnId` in the `turn_started` case so
  per-key-notify stores (pi `AppStore`) present `active` and the anchor in
  the same frame.

Between prompt acceptance and `turn_started` the model is not executing
yet, so the activity row can show the spinner without an elapsed label for
that short gap. Chained turns (steer/follow-up) re-anchor per turn — the
indicator measures the current turn, not a continuous busy stretch.

## Rendering Contract

The row keeps the live status text on the left; the elapsed indicator is
right-aligned in the same row.

- OpenTUI (`InputActiveStatus`): the right cluster composes
  `[elapsed, contextMeter]` — turn-scoped elapsed first, session-scoped
  context meter last at the row tail. When width is scarce the elapsed
  label yields first; the existing context meter is never displaced by the
  new segment.
- pi (`ActivityLine`): the right zone composes `[elapsed, quotaCluster]` —
  elapsed first, account-level quota last at the row tail. Both render
  `theme.dim`; when space is short the whole right zone drops before the
  status text is truncated (`appendFooterRightZone`).

Refresh rides the existing animation ticks — the OpenTUI spinner/shimmer
frame interval and pi-tui `Loader` interval both re-render ~80 ms while
active. No dedicated elapsed timer exists: idle rows carry no interval
(the pi idle indicator has a single frame), and the indicator never owns
session state, calls providers, reads storage, or performs external I/O.

Elapsed formatting uses larger units for longer turns: milliseconds below
a second (`Nms`), seconds below a minute (`Ns`), `Xm YYs` below an hour,
`Xh YYm ZZs` at or above an hour (`formatElapsedMs` in
`packages/tui/src/state.ts`, shared via `@zcode/tui/internals`).

## Cross-Platform Behavior

Elapsed time is computed with Node's standard timers and wall-clock
milliseconds. The implementation must not depend on shell commands, POSIX
signals, terminal escape parsing outside the existing renderers, or
platform-specific time formatting.

## Failure Behavior

If the turn aborts or the TUI closes, the same paths that clear
`activeTurnId`/`busy` clear the anchor and the indicator disappears. If the
clock moves backward relative to the recorded anchor, the display clamps
elapsed time to `0ms` rather than showing a negative duration. A stale
anchor (e.g. a turn ended without its settle events) does not resurface:
the busy row is the render gate, so it is cleared when the next idle turn
starts — before `busy` flips — and overwritten by the next `turn_started`.
Sub-second values truncate (`999.6ms` renders `999ms`, never `1000ms`).

## Tests

- The elapsed label appears right-aligned on the activity row while a turn
  is running, driven by `activeTurnStartedAtMs`.
- `turn_started` anchors to `executionStartedAt`; `turn_complete` clears.
- The row disappears/clears after the turn settles.
- Starting an idle turn clears a stale anchor before `busy` is set, even
  when the new submission then rejects without any settle event.
- The settle guard clears the matching active turn (and only that turn)
  without side effects inside a state updater.
- Duration formatting converts minute- and hour-long turns into larger
  units, clamps negative input, and truncates fractional sub-second values
  so it never renders `1000ms`.
