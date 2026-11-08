# Diagnosis: attach-binary OSC 7501 smoke exit 130 — 2026-11-08

## Root cause — test gate, not product code

`tests/attach-binary.smoke.test.ts` polls the `script(1)` typescript for
"bound OSC idle + collaboration-mode token" before driving double Ctrl-C.
util-linux `script` writes a header line into the log:

```
Script started on <date> [COMMAND="cd '<workspace>' && '<node>' '<attach.cjs>'" ...]
```

The header contains the literal `cd '<workspace>'` and the full binary
path. On this checkout (`/home/daniel/build/piz`), both gate terms match
the header before the TUI renders:

- `logText.includes(workspace)` matches `cd '<workspace>'`.
- `/\b(build|yolo|plan)\b/` matches the `build` segment of
  `/home/daniel/build/…`.

The first test already knew the `cd` hazard (comment at old line ~122)
and added the mode token as the "first frame" signal — but the token is
itself satisfiable by the header path.

Sequence of the failure (instrumented repro, timings from this machine):

| t | event |
|---|---|
| ~2.0–2.3s | `oscReporter.bind` emits `7501;state=idle` (at `registerSession`, **before** `runTui`) |
| same poll | gate sees OSC idle + header `build` → trips early |
| +0ms | test writes `\u0003`; pty still canonical (raw mode only turns on inside `runPiTui` → startup query) |
| +25ms | `^C` echoed; line discipline converts to SIGINT; no handler installed yet → node dies |
| — | `script -e` reports `COMMAND_EXIT_CODE="130"` → `exited === 130` |

Deterministic on any checkout under a `build/` (or `plan/`, `yolo/`)
directory whenever a poll lands between OSC-idle emission and the first
frame. The branch's recorded green was path/timing luck, not a stable
baseline. No product regression: the merged sync/OSC/ACP code is not
involved.

## Fix — `patch/osc7501-smoke-gate` (`47c8ab51`)

- `ptyBody()` strips the `script` header line before any content check.
- The OSC gate additionally requires `\x1b[?2004h` — the bracketed-paste
  enable written by `ProcessTerminal.start()` only after
  `setRawMode(true)`, i.e. proof that raw mode and the SIGINT guard are
  installed before input is driven. The header cannot contain ESC bytes.
- The boot smoke keeps `workspace`+`modeToken` but on the stripped body,
  closing the same false-positive path (it could previously pass before
  the TUI rendered).

## Verification

- `mise exec -- node --test apps/zcode-cli/packages/cli/tests/attach-binary.smoke.test.ts`
  on this checkout: **before fix 130 !== 0 (deterministic), after fix
  2/2 pass** (~4s for the OSC test; gate now waits for the real frame).
- Instrumented repro (`NOSEND`): real boot order confirmed — OSC idle →
  startup color query → `?2004h` → kitty/DA negotiation → first frame
  with `no-model • build`.
- Throwaway `tsc --noEmit` over the test file: clean (cli tsconfig does
  not cover `tests/`).
- Lint: cli package lint scope is `src` only — tests not linted by
  design. Architecture: 0 new / 1 baselined.
- Test file run once post-fix per single-run policy.

## Secondary findings (not fixed — decisions for the operator)

1. **Fork-side raw-mode leak.** `tui-pi/src/terminal-startup.ts`
   (fork commit `ad6882b5`, absent from `upstream/main`) sets
   `stdin.setRawMode(true)` for the startup color query and never
   restores it. `ProcessTerminal.start()` then captures `wasRaw = true`,
   so `tui.stop()` "restores" raw mode — leaving the real tty in raw
   mode after `piz` exits. Interactive shells self-heal at the next
   prompt (readline re-sets termios); non-shell consumers see a raw
   tty. Code-read evidence, not live-verified.
2. **Pre-TUI canonical window.** All of attach boot (`ensureServer`,
   handshake, `sessionCreate`, `registerSession`) runs with a cooked pty
   and no SIGINT handler; a real Ctrl-C there kills the client (exit
   130, core unaffected). This matches ordinary CLI semantics — herdr
   panes that deliver Ctrl-C as SIGINT would see a kill rather than the
   double-press guard. Worth deciding whether the guard should be
   installed earlier; out of scope for the gate fix.

## Effect on the blocked promotion

The only gate failure is explained and fixed on the patch branch.
Remaining per the blocked report: merge this fix to main (needs operator
green light), resume the interrupted promote-gate coverage (core and
later packages were never run), complete the staged ACP smoke, then
promote from clean main.
