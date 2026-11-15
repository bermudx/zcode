## Core Principles

- Before adding or changing behavior, update the corresponding spec first; create the directory on demand if it does not exist. Nail down product rules, state owners, interfaces, and acceptance scenarios before writing code.
- The currently checked-out source, `package.json`, and architecture policy are authoritative. Docs keep only the features, commands, and files the current repo provides; when a feature is removed, clean up references in instructions and skills in the same pass.
- When localizing a problem, if a code change was not explicitly requested, investigate the cause first. Combine source, logs, and runtime evidence, and separate confirmed causes from unverified hypotheses.
- Preserve local changes unrelated to the task; do not restore removed modules or internal dependencies on your own.

## Commands and Repository Structure

Before starting work, run `node scripts/check-workspace-freshness.mjs` to check the baseline. `mise.toml` is authoritative for the Node version.

Run the following commands from the repository root:

| Purpose             | Command                                                 |
| ---------------- | ---------------------------------------------------- |
| Typecheck         | `pnpm typecheck`                                     |
| Lint             | `pnpm lint` / `pnpm lint:fix`                        |
| Format check         | `pnpm fmt:check`                                     |
| Desktop development         | `pnpm dev:desktop`                                   |
| Web development         | `pnpm dev:web`                                       |
| Pre-push check       | `pnpm verify:pre-push` (lint, architecture checks, and affected unit tests) |
| Architecture check | `pnpm architecture:check --changed`                  |
| Module reading bundle       | `pnpm architecture:context <module-id>`              |
| Unused dependencies and exports | `pnpm knip`                                          |
| Export reference lookup     | `pnpm dep:refs --list-exports <file>`                |

affected uses Vitest's official selection and runs only the selected root unit tests; when the whole suite is selected, say so and skip the unit tests, exit successfully, and do not block the push for that reason; it does not replace CLI tests or desktop E2E. Full runs use `pnpm test` / `pnpm test:unit`, invoked only when the user explicitly asks. For the scope and output contract, see [the pre-push guide](docs/testing/pre-push-hook.md).

Test entry points follow the target package's current `package.json` and actual test files; do not assume a unified unit-test or E2E command exists.

- `packages/desktop`: Electron main, host, and renderer.
- `packages/web` and `packages/server`: web client and server.
- `packages/ui`: shared React components, hooks, and Zustand stores.
- `packages/services`: business services; `packages/rpc`: RPC framework.
- `packages/shared`: shared protocol and types; `packages/client`: agent client SDK.
- `apps/zcode-cli`: agent CLI and runtime.
- `CONTEXT.md`: plugin-store domain vocabulary; read before changing related UI.
- `DESIGN.md`: UI design spec; read before changing the UI.

## Implementation and Verification

- For code changes, use `.agents/skills/architecture-governance/SKILL.md`: run the architecture check first, then read the target module's controlled context.
- Avoid duplicated state and multiple write paths. Make the single owner, interface, dependency direction, event ordering, and idempotency boundaries explicit; do not use timeouts to mask synchronization problems.
- When behavior changes, add the matching tests first; interaction changes need E2E scenarios. Check that the tests and the implementation agree, and actually run the verification that is available. If it was not run or the environment limits it, say so honestly.
- When fixing a bug, explain the cause and the basis for the fix in Chinese comments. When a design flaw is found, align with the user first instead of endlessly adding fallback branches.
- PR descriptions must cover the background, design intent, and behavior before and after the change; for bugfixes, itemize the trigger scenario, root-cause evidence, fix mechanism, and regression verification, and link existing tickets where possible. Label unconfirmed root causes or introducing commits as such; do not attribute them by module or temporal proximity.
- For designs involving state, timing, remote, or async synchronization, use a diagram to show owners and event order.
- Always run `pnpm typecheck` and `pnpm lint`, report the real results, and never write up pre-existing failures as passes.
- Use async file and network IO; import across packages through public entry points and respect the existing path aliases.
- Forbidden: the UI calling Repo directly, Services referencing concrete Runtime implementations, cross-domain imports of implementation details, and circular dependencies.

## UI and Platform Boundaries

- Follow `DESIGN.md` and reuse existing components, covering layout, interaction, theming, and i18n for both desktop and mobile web.
- Components access services through `packages/ui/src/hooks/`; platform operations go through `IPlatformService` (`packages/shared/src/platform.ts`), never calling `window.zcode` directly.
- Handle Desktop, Web, local, and remote environment differences through dependency injection, covering Windows, macOS, and Linux.
- Zustand state lives in `packages/ui/src/store/`. Broadcast-synced fields such as theme and language need loop protection; UI-local state must not be mistaken for server-side truth.
- Files under hooks that contain JSX use `.tsx`.

## Processes, Protocol, and Remote Control

- The desktop app talks to the agent over stdio. When the protocol changes, update `packages/shared/src/zcode-protocol/index.ts` in the same change, providing strict types and runtime validation.
- Main handles windows, native operations, process scheduling, and message forwarding; it carries no task/session business state.
- Each window uses one window-scoped Local Host; local workspaces share that Host. Remote workspaces are managed by the connection registry inside the window; do not create a separate Desktop Remote Host.
- Phone remote control connects to the desktop's existing Host attachment and reuses the session runtime; do not start another agent, Local Host, or remote session for the phone.
- The desktop's `desktop-continuous` live path and the phone's `web-remote-replayable` recovery path must stay clearly distinct. When changing stream, snapshot, queue, or reconnection, verify both semantics.
- The external relay and Main only handle authentication, pairing, heartbeats, forwarding, and attachment scheduling; they store no business state such as task queues or snapshots.
- Accepted busy/running input goes through serial admission by the CLI/runtime `CommandInbox`; the Renderer keeps only unsubmitted drafts and pending optimistic overlays, and Host owner/lease handles routing.
- Keep owner/lease, cross-Host routing, and stale-run guards; boundary checks must not be removed based on a single path alone.

## Workspace Identity

- `workspaceIdentity` is for identity isolation; `workspacePath` is for file operations, command cwd, Git, and path display.
- The identity key is uniformly `workspaceIdentity?.trim() || workspacePath`, applied to deduplication, binding, caching, queues, persistence, and request correlation.
- The remote path passes `workspaceIdentity` and `remoteSessionId` through end to end; matching by path alone is not allowed.
- New interfaces keep the local-path fallback; remote identities reuse the existing construction and parsing utilities instead of hand-writing formats in business code.

## Logging

- The UI uses `packages/ui/src/logger.ts`; do not use `console.log` or `window.zcode?.log` directly.
- Service logs for agent/session/runtime use `createServiceLogger(scope)` (`packages/services/src/logger/serviceLogger.ts`).
- `debug` is for high-frequency diagnostics such as raw protocol data, streaming chunks, and per-tool updates; it is not persisted to disk in production.
- `info` is for production-relevant events such as process and session lifecycles, permission results, and one-time initialization.
- `warn` is for recoverable anomalies; `error` is for unrecoverable errors such as crashes, handshake failures, and lost authentication.
- Never write credentials, real user data, or internal service addresses into logs, examples, or commits.

## Local ZCode Artifact Identity (Four Names)

Four ZCode artifacts coexist on this machine; use the following names consistently when communicating, debugging, and installing:

| Name | Source | Entry point / location |
| ---- | ---- | ----------- |
| **zcode-allowance** | This repo's `feat/allowance-herdr` build (request signing, 150% coding-plan quota) | `~/.local/bin/zcode` (wrapper → this repo's `apps/zcode-cli/packages/cli/dist/zcode.cjs`) |
| **zcode-oss** | This repo's build of stock upstream (no signing patch, comparison baseline) | Not installed separately; if coexistence is needed, install it as a separate entry point that does not overwrite `zcode` |
| **zcode-cli** | Official CLI (the 3.14.5 home written by the official install/upgrade flow) | `~/.local/share/zcode-cli-3.14.5/zcode.cjs`; official entry point backed up as `~/.local/bin/zcode.official-wrapper` |
| **Zcode AppImage** | Official desktop app | `~/Applications/zcode.AppImage`; desktop entry `~/.local/share/applications/zcode.desktop` |

- The current `zcode` command = zcode-allowance (a deliberate replacement of the official entry point); behavior changes take effect only after re-producing this repo's `dist/zcode.cjs`.
- Distinguishing limits (verified): `--version` currently prints `0.17.0` for zcode-allowance (the zcode-cli official 3.14.5 home prints `0.16.9`; both drift with upstream syncs); the CLI process name is rewritten to `zcode-cli` (`apps/zcode-cli/packages/cli/src/process-name.ts`), so `ps`/`pgrep` cannot see the entry path. The only distinguishing signal is the launch entry: the path the wrapper points to, or the AppImage runtime (its subprocesses carry `APPIMAGE`/`APPDIR` per AppImage convention — not verified on this machine). A running CLI currently has no intrinsic identity marker.

## This Branch (feat/allowance-herdr)

- Purpose: add coding-plan request signing to the OSS code and produce zcode-allowance (see the table above). Local branch, **not pushed** (origin is upstream `zai-org/ZCode` with no write access; pushing requires creating a fork remote first, and a push from a shallow clone is rejected with `shallow update not allowed` — run `git fetch --unshallow` first). Rebased onto `3c5b2276` on 2026-10-20 (`chore: sync ZCode source`, v0.17.0, including the session-store soft-delete rework and the tui.tsx startup-screen Ctrl+C leak fix); originally based on `aac47556` (`feat: update to v3.15.1`).
- Signing commits (post-rebase hashes): `7d7e5304` protocol research and acceptance docs → `df8bc4a7` shared signing-failure / verification-code policy → `86ab5b13` CLI request-signing implementation (with telemetry, spec, and test cases).
- Local TUI commits: `090276d9` (exit on Ctrl-D with an empty draft), `43549d6b` (Ctrl-X prefix; its Y copy-last-reply was later superseded by Ctrl+Y), `31a770cc` (selection panel bracketed-paste fix: `app-selection-paste.ts` + regression test `tests/tui-selection-paste.test.ts`), `c0abfcb1` (keymap consolidation: composer key handling split into `app-composer-keyboard.ts`, finalizing Ctrl+P/Ctrl+L/Ctrl+Y/double-Esc, plus an oxlint max-lines fix).
- TUI keybindings (current behavior): `Ctrl+P` cycles the model, `Ctrl+L` opens the model selector, `Ctrl+Y` copies the last reply, double-tapping `Esc` (within 2s) pauses output; `Ctrl+C` no longer copies selected text, and `Ctrl+U` / `Ctrl+R` / `Ctrl+X Y` were dropped. Implementation in `app-composer-keyboard.ts` and `app-keyboard.ts`; tests in `tests/tui-keymap.test.ts`.
- Key paths: implementation `apps/zcode-cli/packages/adapters/src/model/request-security-edition/`; design spec `apps/zcode-cli/docs/design/v2/model/client-request-signing.md`; tests `apps/zcode-cli/packages/adapters/tests/client-request-signing.test.ts` (9 cases); protocol and acceptance record `docs/coding-plan/client-request-signing-and-usage-allowance.md`.
- Build artifact = the zcode-allowance in the table above (`packages/cli/dist/zcode.cjs`). herdr integration is not on this branch: the hook bridge is the local `~/.zcode/herdr-hook.sh`, and the agent manifest lives in the herdr fork (`master` `838cb593`).
- Update flow: `~/.local/bin/zcode-allowance-update` (script and docs in `~/build/testing/subagents/zcode-allowance-build/`). Default mode = fetch + rebase + gates (typecheck, the 9 signing tests) + rebuild + smoke test; `--check` probes whether upstream has moved ahead, `--auto` is for scheduled jobs, and `--build-only` rebuilds after conflicts are resolved by hand. Rollback: tags `allowance/backup-*`; last-built baseline: tag `allowance/last-built`. The wrapper needs no changes, and running sessions require a restart to pick it up. Pitfall (verified 2026-10-20): the gate typecheck runs **before** dependent packages are rebuilt, so when an upstream sync touches contracts/adapters source, stale dist can cause false failures like `no exported member 'ToolSearchMode'` — first rebuild the changed packages using the same logic as the script (derive the packages that have a build script from `git diff --name-only allowance/last-built HEAD -- apps/zcode-cli/packages`), then rerun `--build-only` and it goes green.
- Auth status (verified 2026-10-19): the OAuth access token expires within hours (the z.ai business exchange returns `project_token_login_failed`; the CLI never writes or reads `oauth:zai:refresh_token`, so there is no refresh), so restarts repeatedly demand login; the durable path = a manual coding-plan API key (type `/login zai-coding-plan-api-key <KEY>` as a single composer line, or paste it into the login panel's input line). The signing credential accepts only a JWT (`token_use: project_access`) or `<id>.<secret>` (exactly one dot); a parse failure → `unsigned_sent reason="invalid_credential"` → server 401 `身份验证失败`. Identity hash = `key-${sha256(去空白).slice(0,24)}`, cross-check against `~/.zcode/v2/credentials.json` (structure only, never values). Diagnostic entry point: `~/.zcode/cli/log/zcode-*.jsonl`.
- Known baseline issues (not introduced by these changes): the tui tests have 3 mode-related failures (`Shift+Tab` two cases + `mode composer popup`) that also fail on pristine upstream `aac47556` (upstream test drift). CLI-level `pnpm --dir apps/zcode-cli lint` cannot find turbo when run directly; after injecting `PATH="$PWD/node_modules/.bin:$PATH"` it runs, but `@zcode/cli`, `@zcode/contracts`, and `debug` still have pre-existing max-lines errors (unrelated to the TUI). `apps/zcode-cli/packages/tui`'s `oxlint src` was fixed by splitting the hooks of `app-composer-keyboard.ts`, `app-copy.ts`, and `app-permission.ts`.

## tui-attach Shared Core (piz) — This Worktree's Everyday Entry Point

- Entry point `~/.local/bin/piz` → `dist/zcode-attach.cjs`; the core is pinned via `ZCODE_SERVER_BIN` to this worktree's `dist/zcode.cjs`. **tui-pi changes have no effect until rebuilt**: run `pnpm --dir apps/zcode-cli/packages/tui-pi build` (tsc + esbuild → `dist/index.js`, dynamically imported at runtime), then `pnpm --dir apps/zcode-cli/packages/cli build:attach` (≈0.5s). The core is a long-lived process; only protocol/server changes require rebuilding `zcode.cjs` and `kill $(cat <sock>.pid)`.
- Protocol facts (verified 2026-10-22, do not go on intuition): `session/create`'s `settings.model.available` is the **complete catalog**; the `available` in mutation replies such as `session/subscribe` and `session/setModel` and in `state.updated` patches is a `modelAvailability:"current"` **filtered projection (only the current item is left)**. Any "replace the snapshot wholesale" implementation shrinks the Ctrl+P/Ctrl+L choices down to 1 item — `/new` (newApp → toHandle → subscribe includeSnapshot) is exactly that path; the symptom is the first Ctrl+P reporting `Model is not available`, then `Only one model available` (the failure reply writes the 1-item list back into the TUI store). Fix: `attach-catalog.ts` merges add-only (never removes entries), and `adoptSnapshot()`/`mergeSettings()` both route through it.
- The attachment protocol shape for `session/send` is `{kind, localPath | dataBase64 | textContent, filename}` (the server's `mapProtocolPromptAttachment` only accepts these keys); the TUI's `{type, path, content}` must be converted through `attach-attachments.ts`, otherwise it is **silently dropped** — the submit succeeds and the model receives nothing.
- Reconnects swap the client: session-scoped requests inside attach must always go through `runtime.currentClient()`; capturing the constructor-time client sends `/new`, `/resume`, and `/fork` at a dead socket.
- When reading core session history for verification, `session/messages` often reports `Session is not active`: idle sessions are evicted from the active registry (session residency). Run `session/resume {sessionId, workspace}` before reading.
- pi-tui rendering invariant: **if any line exceeds the terminal width, `TuiMainScreen.doRender` throws and kills the process** (crash signature `Rendered line N exceeds terminal width (X > Y)`, log `/tmp/pi-tui-crash.log`). Every component that consumes external text (user input/paste, system notices, `!` output, tool output) must run `wrapTextWithAnsi` to fold to `width` before coloring; `MessageRow.render` also has a `truncateToWidth` backstop at the end. Verified: pasting a 212-column line into a 211-column terminal crashes it.
- Composer capabilities: `@path` completion needs `fd`/`fdfind` on PATH (pi-tui's `CombinedAutocompleteProvider` returns [] from `getFuzzyFileSuggestions` without fd, so the popup never appears); on submit, `mentions.ts` resolves `@token` (including `@"带空格 的路径"`) into a file attachment. `!cmd` runs in the **client** workspace (`shell.ts`, 120s, truncated output), prints `!cmd` plus the output lines, and prepends the output to the next prompt as a `<shell-output …>` block — the core has no "append local message" protocol surface, so context handoff can only happen at submit time; slash commands do not consume the buffer. In the transcript the block collapses to one line `⤷ shell output: …`.
- Architecture gate: `pnpm architecture:check --changed` enforces an 800-line-per-file cap; `tui-pi/src/app.ts` is already at 797, so the next code addition must split it further (existing splits: `model-chords.ts` for Ctrl+P/Ctrl+L, `shell-prompt.ts` for the `!` handoff, `rows.ts` for rendering, `mentions.ts`).
- Verification recipe (only meaningful in a real terminal; a scripted fake pty can only test the process): `tmux new-session -d -s probe -x 120 -y 40 'cd <ws> && piz'` → `capture-pane -p` to inspect the rendering → `send-keys` to verify the `@` popup, Ctrl+P after `/new`, `!cmd`, and long pastes (`load-buffer` + `paste-buffer -p`). Scripts like models-probe live in `/tmp/zcode-probe/` (they spawn their own core and answer `session/requestRuntimePreferences` themselves; otherwise there is no provider).
