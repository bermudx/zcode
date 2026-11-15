## Core principles

- Before adding or modifying behavior, update the corresponding spec first; create the directory on demand if it does not exist. Nail down product rules, state owners, interfaces and acceptance scenarios before writing code.
- Treat the currently checked-out source, `package.json` and architecture policy as authoritative. Documentation keeps only the features, commands and files this repo actually provides; when a feature is removed, clean up references in instructions and skills at the same time.
- When diagnosing, investigate the cause first unless a code change is explicitly requested. Combine source, logs and runtime evidence, and separate confirmed causes from unverified hypotheses.
- Preserve local changes unrelated to the task; do not restore removed modules or internal dependencies on your own.

## Commands and repo structure

Run `node scripts/check-workspace-freshness.mjs` before starting work to check the baseline. The Node version follows `mise.toml`.

Run the following commands from the repo root:

| Purpose | Command |
| ---------------- | ---------------------------------------------------- |
| Type check | `pnpm typecheck` |
| Lint             | `pnpm lint` / `pnpm lint:fix`                        |
| Format check | `pnpm fmt:check` |
| Desktop development | `pnpm dev:desktop` |
| Web development | `pnpm dev:web` |
| Pre-push verification | `pnpm verify:pre-push` (Lint, architecture checks and affected unit tests) |
| Architecture check | `pnpm architecture:check --changed` |
| Module reading pack | `pnpm architecture:context <module-id>` |
| Unused dependencies and exports | `pnpm knip` |
| Export reference lookup | `pnpm dep:refs --list-exports <file>` |

`affected` uses Vitest's official selection and runs only the selected root-level unit tests; when the whole suite is selected, say so and skip the unit tests, exit successfully, and do not block the push over it; it does not replace CLI tests or desktop E2E. Full runs use `pnpm test` / `pnpm test:unit` and are invoked only when the user explicitly asks. See [the pre-push guide](docs/testing/pre-push-hook.md) for the scope and output contract.

For test entry points, defer to the target package's current `package.json` and its actual test files; do not assume a unified unit-test or E2E command exists.

- `packages/desktop`: Electron main, host, renderer.
- `packages/web` and `packages/server`: web client and server.
- `packages/ui`: shared React components, hooks and the Zustand store.
- `packages/services`: business services; `packages/rpc`: RPC framework.
- `packages/shared`: shared protocols and types; `packages/client`: Agent client SDK.
- `apps/zcode-cli`: Agent CLI and runtime.
- `CONTEXT.md`: plugin-store domain vocabulary; read it before changing related UI.
- `DESIGN.md`: UI design spec; read it before changing UI.

## Implementation and verification

- For code changes use `.agents/skills/architecture-governance/SKILL.md`: run the architecture checks first, then read the target module's controlled context.
- Avoid duplicated state and multiple write paths. Make the single owner, interface, dependency direction, event order and idempotency boundaries explicit; never mask sync problems with timeouts.
- Add the matching tests when behavior changes; interaction changes need E2E scenarios. Check that tests and implementation agree, and actually run the verification that is available. If you could not run it or the environment limits you, say so honestly.
- When fixing bugs, write Chinese comments explaining the cause and the basis for the fix. When you find a design flaw, align with the user first instead of piling on fallback branches.
- PR descriptions must state the background, design intent and behavior before/after the change; for bugfixes, list per item the trigger scenario, root-cause evidence, fix mechanism and regression verification, and link existing tickets where possible. Mark unconfirmed root causes or introducing commits honestly; do not infer attribution from module proximity or timing.
- For designs involving state, timing, remote or async sync, use a diagram to show owners and event order.
- You must run `pnpm typecheck` and `pnpm lint`, report the real results, and never write up pre-existing failures as passes.
- Use async file and network IO; import across packages through public entry points and respect existing path aliases.
- No UI calling Repo directly, no Service referencing concrete Runtime implementations, no cross-domain imports of implementation details, and no circular dependencies.

## UI and platform boundaries

- Follow `DESIGN.md`, reuse existing components, and cover layout, interaction, theming and internationalization for both desktop and mobile web.
- Components access services through `packages/ui/src/hooks/`; platform operations go through `IPlatformService` (`packages/shared/src/platform.ts`), never direct `window.zcode` calls.
- Handle Desktop, Web, local and remote environment differences through dependency injection, and cover Windows, macOS and Linux.
- Zustand state lives in `packages/ui/src/store/`. Broadcast-synced fields such as theme and language need loop protection; UI-local state must not be mistaken for server truth.
- Files under hooks that contain JSX use the `.tsx` extension.

## Processes, protocol and remote control

- The desktop app talks to the Agent over stdio. Protocol changes update `packages/shared/src/zcode-protocol/index.ts` in the same change, with strict types and runtime validation.
- Main handles windows, native operations, process scheduling and message forwarding; it carries no task/session business state.
- Each window uses one window-scoped Local Host; local workspaces share that Host. Remote workspaces are managed by the connection registry inside the window; no separate Desktop Remote Host is created.
- Phone remote control attaches to the desktop's existing Host attachment and reuses the session runtime; do not start a separate Agent, Local Host or remote session for the phone.
- The desktop's `desktop-continuous` live path and the phone's `web-remote-replayable` recovery path must stay clearly separated. When changing stream, snapshot, queue or reconnect behavior, verify both semantics at the same time.
- The external relay and Main only handle auth, pairing, heartbeats, forwarding and attachment scheduling; they store no business state such as task queues or snapshots.
- Accepted busy/running input is admitted serially by the CLI/runtime `CommandInbox`; the Renderer keeps only uncommitted drafts and pending optimistic overlays, and Host owner/lease handles routing.
- Keep owner/lease, cross-Host routing and stale-run guards; do not remove a boundary check based on a single path alone.

## Workspace Identity

- `workspaceIdentity` is for identity isolation; `workspacePath` is for file operations, command cwd, Git and path display.
- The identity key is uniformly `workspaceIdentity?.trim() || workspacePath`, used for dedup, binding, caching, queues, persistence and request correlation.
- Remote paths must thread `workspaceIdentity` and `remoteSessionId` through end to end; never match by path alone.
- New interfaces keep the local-path fallback; remote identity reuses the existing build and parse utilities — no hand-written formats in business code.

## Logging

- The UI uses `packages/ui/src/logger.ts`, not `console.log` or `window.zcode?.log` directly.
- Service logs related to Agent/session/runtime use `createServiceLogger(scope)` (`packages/services/src/logger/serviceLogger.ts`).
- `debug` is for high-frequency diagnostics such as raw protocol data, streaming chunks and per-tool updates; it is not persisted to disk in production.
- `info` is for production-relevant events such as process and session lifecycle, permission outcomes and one-time initialization.
- `warn` is for recoverable problems; `error` is for unrecoverable errors such as crashes, handshake failures and lost authentication.
- Never write credentials, real user data or internal service addresses into logs, examples or commits.

## Local ZCode artifact identity (four names)

Four ZCode artifacts coexist on this machine; use the following names consistently when communicating, debugging and installing:

| Name | Source | Entry point / location |
| ---- | ---- | ----------- |
| **zcode-allowance** | This repo's `feat/allowance-herdr` build (request signing, 150% coding-plan allowance) | `~/.local/bin/zcode` (wrapper → this repo's `apps/zcode-cli/packages/cli/dist/zcode.cjs`) |
| **zcode-oss** | This repo's upstream-vanilla build (no signing patch; comparison baseline) | Not installed separately; if coexistence is needed, install it as a separate entry point without overwriting `zcode` |
| **zcode-cli** | Official CLI (the 3.14.5 home written by the official install/upgrade flow) | `~/.local/share/zcode-cli-3.14.5/zcode.cjs`; official entry point backed up at `~/.local/bin/zcode.official-wrapper` |
| **Zcode AppImage** | Official desktop app | `~/Applications/zcode.AppImage`; desktop entry `~/.local/share/applications/zcode.desktop` |

- The current `zcode` command = zcode-allowance (a deliberate replacement of the official entry point); behavior changes only take effect after this repo's `dist/zcode.cjs` is rebuilt.
- Distinguishing limits (measured): `--version` currently prints `0.17.0` for zcode-allowance (the official zcode-cli 3.14.5 home prints `0.16.9`; both drift independently with upstream syncs); the CLI process name is rewritten to `zcode-cli` (`apps/zcode-cli/packages/cli/src/process-name.ts`), so `ps`/`pgrep` never show the entry path. The only way to distinguish them is the launch entry: the path the wrapper points to, or the AppImage runtime (its children carry `APPIMAGE`/`APPDIR` per AppImage convention — not verified on this machine). A running CLI currently has no built-in identity marker.

## TUI idle CPU (root-caused 2026-10-21, unfixed)

- Symptom: an idle zcode-cli (sitting on the empty-transcript startup screen) continuously burns ~20-25% of a core per instance (measured: PID 30698 accumulated 251 CPU minutes over 17¾h).
- Root cause: `useShimmerFrame` in `packages/tui/src/app-motion.tsx` is driven permanently by an 80ms `setInterval`; `app-view.tsx:184` defaults `animateEmptyLogo: !options.noColor`; every frame `ShimmerText` re-renders the whole logo tree (6 lines ≈ 250 per-char `<text>` nodes + per-character hex color blending) through react-reconciler → opentui `setStyledText`/WASM text shaping in full. An empty session parked in a herdr background pane burns the same.
- Amplifier: at runtime `require("react")` resolves to `react.development.js` (root node_modules) when NODE_ENV is not set to production, multiplying reconciler cost by another 2-4×.
- Fix directions (not implemented): pause the animation for unfocused/background panes; or settle to a static logo after a few seconds; drive the shimmer through opentui native coloring instead of React state; force production React in builds; replace per-char nodes with styled segments per line.
- RAM (measured 2026-10-21, after forcing GC on a ~15min fresh session): RSS ~0.8-1GB per instance, and the bulk is not business data: ~100MB opentui WASM linear memory (83MB WebAssembly.Memory + 16MB cell buffers) + ~62MB of monolith bundle source string retained by V8 (zcode.cjs is 30MB → 57MB as UTF-16, held by V8 as script source) + ~40MB compiled code/closure + ~95MB glibc malloc arena + ~60MB Node baseline; real application state (transcript/React tree/store) is only ~50-60MB. Before GC, heapTotal grew to ~360MB (high-frequency shimmer garbage); forced GC returned 237MB. Each session also carries a ~200MB zcode-node-repl-mcp child process. Multiple instances = full price per instance, no Electron-style amortization.
- The per-session child processes are the biggest chunk (same-day measurement, herdr multi-session environment): each zcode-cli session eagerly spawns 4×~180MB office plugin MCP servers (presentations/documents/pdf/spreadsheets, identifiable by ZCODE_PLUGIN_ID in their env) + 1×~190MB zcode-node-repl-mcp (browser-use/cua host) ≈ 930MB per session; main process + children total ~1.8-2.2GB per session. In a fresh /tmp directory there was a lot of plugin-resolution history (8×zcode-cli + 2×mcp children) — the plugin set is resolved per workspace, multiplying the fixed cost directly. Office plugin children idle at ≈0 CPU; pure memory cost.
- tui-pi frontend measured (worktree rapid-cloud-030e, `tui --tui-frontend=pi`, under a script pseudo-terminal): main process stable at 468-483MB with 0.0% idle CPU (vs the opentui frontend at ~830-950MB + 20-25% CPU). tui-pi is an esbuild external (build.mjs resolveBuildExternal includes @zcode/tui-pi), dynamically imported at runtime, not bundled into the monolith; @earendil-works/pi-tui is 3.3MB with no WASM and only get-east-asian-width+marked as deps. Note: the script fake terminal answers no queries, so the TUI may not have finished drawing its first frame — the process-cost data is valid, rendering behavior needs separate verification. MCP children are frontend-independent (the pi frontend spawns them too).
- Measurement scripts: /tmp/zcode-probe/probe.sh (frontend A/B idle cost), /tmp/zcode-probe/kids.sh (child-process identification, env list + cwd). Pitfall: pgrep -f also matches your own shell's cmdline when it contains the same pattern — keep the pattern in script files only, never in inline commands.

## tui-attach shared-core mode (implemented 2026-10-21, worktree rapid-cloud-030e, not pushed)

- Location: branch `worktree/rapid-cloud-030e`, commits `32dc8799..3b9462af` (spec → server → client → e2e). Design docs `apps/zcode-cli/docs/design/v2/tui-attach-shared-core.md` + `tui-attach-client-build.md`. Implementation in `packages/cli/src/attach/` (client/session/tui-options/command/argv) + bootstrap socket listener + `packages/shared/src/app-server-attach/`.
- Usage: `zcode tui --tui-frontend=pi --shared-core` (the first client automatically spawns `app-server --socket <~/.zcode/v2/sockets/core-<hash>.sock> --no-plugins` detached; an atomic lock prevents a double start; stop = `kill $(cat <sock>.pid)`). Note that in the CLI `--attach` is the prompt-attachment flag — do not confuse the two.
- This mode: zero plugins / zero MCP / zero child processes (noPlugins is an entry-level hard gate; even session/create parameters cannot reopen it); server-side sessions survive client exit; on disconnect, a status-line notice + exponential-backoff reconnect (30s cap) + session/resume cold recovery; ephemeral zero-turn sessions cannot be recovered after a core restart (the UI says so honestly).
- Measured memory (`apps/zcode-cli/scripts/measure-attach.sh`, thin client `zcode-attach`, N=5): 160-166MB per client (<200 target met), 420MB server, 1237MB total (5 sessions vs the current ~9-11GB, ≈87% reduction). Intermediate state: monolith-path clients at 418-435MB (missed <200) → slice D closed it out with a separate 1.5MB client-only bundle (`attach-main.ts` → `dist/zcode-attach.cjs`, DI injection stripping the bootstrap/adapters dependency chain). The client's ~160MB ≈ the V8+TUI baseline; going lower means shrinking the TUI surface (out of scope). The core spawn can be overridden with ZCODE_SERVER_BIN.
- Daily entry point: `~/.local/bin/piz` (thin-client wrapper; ZCODE_SERVER_BIN is pinned to this worktree's zcode.cjs — the PATH zcode is the allowance build, which has no --socket. The core spawn can be overridden via env). In a pane, cd to a workspace and run `piz` directly; a second pane with the same workspace shares the same core. Stop the core: `kill $(cat ~/.zcode/v2/sockets/core-*.pid)` (after SIGTERM the .sock is cleaned up; leftover .pid/.info is by design and reclaimed atomically by the next ensureServer).
- Pitfalls (two live encounters on 2026-10-21): ① the session model catalog is materialized from the **response** of `session/requestRuntimePreferences` (scope: runtime-materialization) — a response that fails the schema (missing required booleans like nativeSearchEnhancementsEnabled) = a bare runtime with no providers = "No selectable models". The desktop app is the reference implementation. ② the core is a long-lived process: after a dist rebuild a **running core does not update itself**; you must TERM the old core (its .pid file) so the next piz pulls the new build — after upgrading, remember to clear the core.
- Verification discipline (live lessons from 2026-10-21, bitten twice): a script fake pty can only verify processes/memory, not rendering or terminal interaction — a real terminal answers OSC 10/11/4 + DA queries, and response leaks / first-frame drawing / input paths only surface in a responding terminal. Before claiming "it works", you must: `tmux new-session -d ... 'piz'` → `capture-pane` to check for leaked sequences and rendering → `send-keys` with real input to verify composer echo + `ss -xp` to confirm ESTABLISHED. The repo already has a responding-pty regression test (tui-pi tests/terminal-drain.test.ts) backing CI; the manual tmux check remains the shipping gate. Pitfalls: shell-variable splicing like `${f%.pid}.sock` produces a false `.sock.sock` positive on `x.sock.pid` filenames; pgrep -f always matches your own shell's cmdline (third time burned by this today: use a `[b]e` character class to dodge the pattern).
- Daily entry point: `~/.local/bin/piz` (thin-client wrapper; ZCODE_SERVER_BIN is pinned to this worktree's zcode.cjs — the PATH zcode is the allowance build, which has no --socket. The core spawn can be overridden via env). In a pane, cd to a workspace and run `piz` directly; a second pane with the same workspace shares the same core. Stop the core: `kill $(cat ~/.zcode/v2/sockets/core-*.pid)` (after SIGTERM the .sock is cleaned up; leftover .pid/.info is by design and reclaimed atomically by the next ensureServer).
- Known deferred: dwf list/replay/resume, expert workflows and listPlugins are not wired up (they use the optional-port "unavailable" semantics); the full-width disconnect banner awaits TUI-side design.
- Diagnostics: for a running node process, `kill -USR1 <pid>` opens the inspector → `ss -tlnp` (no K!) to find the port → `curl /json` for the ws URL → `node /tmp/cpuprof.mjs <ws-url> out.cpuprofile 5000` for CDP `Profiler` sampling analysis (usable when yama=1 blocks ptrace/eu-stack); for memory, `/tmp/cdpmem.mjs` (memoryUsage before/after GC), `/tmp/cdpsnap.mjs` + `/tmp/snapanalyze.mjs` (heap snapshot aggregation), `/tmp/snapretainers2.mjs` (retainer chains). An inspector opened with SIGUSR1 cannot be closed from inside the process; it disappears only when the session restarts.

## This branch (feat/allowance-herdr)

- Purpose: add coding-plan request signing to the OSS code and produce zcode-allowance (see the table above). Local branch, **not pushed** (origin is upstream `zai-org/ZCode` with no write access; pushing requires creating a fork remote first, and a shallow-clone push is rejected with `shallow update not allowed` — run `git fetch --unshallow` first). Rebased on 2026-10-20 onto `3c5b2276` (`chore: sync ZCode source`, v0.17.0, which includes the session-store soft-delete refactor and the tui.tsx startup-screen Ctrl+C leak fix); originally based on `aac47556` (`feat: update to v3.15.1`).
- Signing commits (post-rebase hashes): `7d7e5304` protocol research and acceptance docs → `df8bc4a7` shared signing-failure / verification-code policy → `86ab5b13` CLI request-signing implementation (with telemetry, spec and tests).
- attach branch (worktree-rapid-cloud-030e, not pushed locally): `32dc8799` spec → `e1b11b32` server entry → `214ec873` thin client → `3b9462af` e2e → `ab49b084` standalone attach artifact → `fix(tui-pi)` terminal-response leak fix → `ba027b0d` line-width truncation → `c3159c08` daily-driver hardening (model rotation/queue/reconnect/self-registration) → `aae1783b` session-selection semantics + Ctrl-C byte/signal equivalence.
- attach live lessons (2026-10-22 gauntlet, all located by real measurement): ① the legacy `session/setModel` reply is the snapshot itself (no `{snapshot}` wrapper) and `available` is filtered by `modelAvailability:"current"` down to only the current model — the client must recognize both the direct-return shape and the filtered shape to preserve the old catalog; ② that path only sends a `state.updated` patch, not a raw `ModelSelected`, so the client must merge and then emit a synthetic event itself; ③ `session/list` gives no ordering guarantee, so "most recent session" must explicitly take the max by `updatedAt` — `at(-1)` restored a stale session; ④ `.pid/.info` may only be written by the server that successfully binds, after listen — writing them from the client registers a dead process under double-spawn races (`probeSocket` only proves "someone is listening", not "my child is listening"); ⑤ when reporting acceptance criteria to Devin, demand a "real model turn", not a status line — the model LIST renders locally; only a turn exercises the auth/materialization path; ⑥ fuser output mixes path digits in, so parse the pid with `tr -cd '0-9\n' | tail -1`.
- attach session selection and Ctrl-C (user-reported from real use on 2026-10-22; root causes fixed):
  - **Default must not resume**: the attach entry used to unconditionally resume the most recent session of this workspace → piz always landed in the old conversation and could not start a new session. The main CLI semantic is "new session by default, `-c` to continue"; attach now matches: default `session/create`, `-c/--continue` the most recent session, `--resume <id>` a specific session. The thin client `zcode-attach` ships its own parseArgs, so `-c/--continue/--resume` must be added there in sync (the piz wrapper passes `"$@"` through, so the flags do get through).
  - **Ctrl-C has two delivery paths**: bytes (0x03 in raw mode) and signal (SIGINT). A herdr pane delivers Ctrl-C as a **signal**; without a SIGINT handler Node terminates outright by default (exit 130) → dead on the first press. The double-press confirmation on the byte path was always correct; the pitfall was only on the signal path. `tui-pi/src/ctrl-c-intent.ts` is now the single owner: both paths share one guard/state, `run-tui` installs a SIGINT handler that forwards to the same intent, and **on exit you must `process.off`** (a signal handler is a ref handle; leaving it attached keeps the process hanging after the TUI has exited).
  - Lesson: **whether the terminal delivers bytes or a signal depends on the deployment environment** — tmux sends bytes, herdr sends a signal; testing only in tmux misses the signal path. Same class of lesson: fork/upstream-sync changes must be verified in **both** environments.
  - Diagnostics: `stty -a -F <tty>` to check for `-isig` (raw mode) and confirm the byte path; `kill -INT <pid>` and see whether the process survives to tell whether the signal path has a handler.
- Local TUI commits: `090276d9` (Ctrl-D exits on an empty draft), `43549d6b` (Ctrl-X prefix; its Y copy-last-reply was later superseded by Ctrl+Y), `31a770cc` (selection-panel bracketed-paste fix: `app-selection-paste.ts` + regression test `tests/tui-selection-paste.test.ts`), `c0abfcb1` (keymap consolidation: composer key handling split into `app-composer-keyboard.ts`, finalizing Ctrl+P/Ctrl+L/Ctrl+Y/double Esc, fixing the oxlint max-lines error), `da309372` (busy-submit local queue + settle flush + Enter steer on empty input; `-c`/`--resume` first-screen transcript replay).
- TUI busy-submit semantics (verified by measurement 2026-10-21): busy submits go into the TUI's local pending-send queue (not the runtime queue lane — on the plain app that lane has no promoter, so input would be lost when the turn ends); after the turn settles (complete/error/cancel), entries are flushed one by one as new turns; pressing Enter while the composer is empty and the queue is non-empty = steer everything into the current turn with `queueDelivery: "guide"` (drained at tool/text boundaries). The local queue is volatile and is not persisted. Implementation in `app-submit.ts` / `app-submit-controller.ts` / `app.tsx` (flush effect + `steerQueuedInputs`), test `tests/tui-queue-steer.test.ts`. Testing pitfall: putting typeText and pressEnter in the same act in testRender batches the draft updates into one commit, and opentui's content-change echo glues the old buffer's contents onto the next input — split into separate acts and leave 2-3 frames after submitting.
- `-c` / `--resume` first screen: `loadResumedTranscript` (`tui-prompt-handler-queries.ts`) reads the store through `loadSessionTranscript` and injects it into the TUI first screen through `initialResult.restoredMessages` (103 messages rendered in a real test); if the transcript read fails it silently falls back to an empty first screen. Runtime hydration still waits for the first submit.
- TUI keymap (current behavior): `Ctrl+P` rotates the model, `Ctrl+L` opens the model selector, `Ctrl+Y` copies the last reply, `Esc` pressed twice (within 2s) pauses output; `Ctrl+C` no longer copies selected text, and `Ctrl+U` / `Ctrl+R` / `Ctrl+X Y` are removed. Implementation in `app-composer-keyboard.ts` and `app-keyboard.ts`, test `tests/tui-keymap.test.ts`.
- Key paths: implementation `apps/zcode-cli/packages/adapters/src/model/request-security-edition/`; design spec `apps/zcode-cli/docs/design/v2/model/client-request-signing.md`; tests `apps/zcode-cli/packages/adapters/tests/client-request-signing.test.ts` (9 cases); protocol and acceptance record `docs/coding-plan/client-request-signing-and-usage-allowance.md`.
- Build artifact = the zcode-allowance in the table above (`packages/cli/dist/zcode.cjs`). herdr integration is not on this branch: the hook bridge is the local `~/.zcode/herdr-hook.sh`, and the agent manifest lives in the herdr fork (`master` `838cb593`).
- Update flow: `~/.local/bin/zcode-allowance-update` (script and docs in `~/build/testing/subagents/zcode-allowance-build/`). Default mode = fetch + rebase + gates (typecheck, the 9 signing tests) + rebuild + smoke; `--check` probes whether upstream has moved forward, `--auto` is for scheduled jobs, `--build-only` rebuilds after conflicts are resolved by hand. Rollback: tags `allowance/backup-*`; last-built baseline: tag `allowance/last-built`. The wrapper needs no changes; running sessions must be restarted to pick up the change. Pitfall (measured 2026-10-20): the gate typecheck runs **before** dependency packages are rebuilt, so when an upstream sync changes contracts/adapters source, the stale dist causes fake failures like `no exported member 'ToolSearchMode'` — first rebuild the changed packages using the same logic as the script (derive the packages with build scripts via `git diff --name-only allowance/last-built HEAD -- apps/zcode-cli/packages`), then run `--build-only` and it goes green.
- Auth status (measured 2026-10-19): the OAuth access token expires within hours (the z.ai business exchange returns `project_token_login_failed`; the CLI never writes/reads `oauth:zai:refresh_token`, so there is no refresh), which is why restarts keep demanding login; the durable path = a manual coding-plan API key (type `/login zai-coding-plan-api-key <KEY>` as a single line in the composer, or paste it into the login panel's input line). Signing credentials accept only a JWT (`token_use: project_access`) or `<id>.<secret>` (exactly one dot); a parse failure → `unsigned_sent reason="invalid_credential"` → server 401 `身份验证失败`. Identity hash = `key-${sha256(whitespace-stripped).slice(0,24)}`, cross-checked against `~/.zcode/v2/credentials.json` (structure only, never values). Diagnostics entry point: `~/.zcode/cli/log/zcode-*.jsonl`.
- Known baseline issues (not introduced by these changes): the tui tests have 3 mode-related failures (`Shift+Tab` two items + `mode composer popup`), which also fail on pristine upstream `aac47556` (upstream test drift). CLI-level `pnpm --dir apps/zcode-cli lint` cannot find turbo when run directly; with `PATH="$PWD/node_modules/.bin:$PATH"` injected it runs, but `@zcode/cli`, `@zcode/contracts` and `debug` still have pre-existing max-lines errors (unrelated to the TUI). The `oxlint src` of `apps/zcode-cli/packages/tui` was fixed by splitting the hooks in `app-composer-keyboard.ts`, `app-copy.ts` and `app-permission.ts`.
