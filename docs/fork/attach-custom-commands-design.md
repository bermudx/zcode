# Attach-mode custom commands (/commands) — design decisions

Date: 2026-10-24 · Branch: `patch/attach-custom-commands` · Owning design doc:
[tui-attach-shared-core.md](../../../apps/zcode-cli/docs/design/v2/tui-attach-shared-core.md) (P004)

## Problem

The thin client (`zcode-attach.cjs` / `piz`) lacks the UX for user-level (`~/.zcode/commands`) and
workspace-level (`<cwd>/.zcode/commands`) custom markdown commands:

1. The composer `/` panel does not list custom commands. The thin client bundle
   has no bootstrap (`build.mjs`: `无 bootstrap/core/adapters`; verified in
   dist/zcode-attach.cjs that `listZCodeCustomCommands` appears 0 times), and
   `attach-main.ts` does not inject `listAttachCustomCommands` either;
   `loadStartupOptions`'s `.catch(() => undefined)` silently swallows this path.
2. `/help` does not list custom commands: the attach commandCenter has no `listCustomCommands` dep.

## Key facts (measured/traced on this branch, not inferred)

**The core already expands custom commands on the server side.** `session/send` →
`record.app.sendInput` → input facade `prepareRuntimePrompt` →
`customCommandPromptResolver` (create-app.ts:912, with `workingDirectory`) →
`resolveZCodeCustomCommandPrompt`. After the attach client forwards unknown `/...`
as an ordinary prompt (P005 `forwardUnknownSlashAsPrompt`), the core expands it:

- Measured probe (tsx directly calling bootstrap `resolveZCodeCustomCommandPrompt`):
  workspace `.zcode/commands/marker-probe.md` expands to
  `Run custom command /marker-probe.\nCommand source: project/zcode.…`;
  a non-existent command returns `undefined` (the original text is passed through to the model).
- monolith headless (`prompt-command.ts` `routesToPromptCommandCenter`) likewise
  routes resolvable custom commands to the facade for expansion — facade-side
  expansion is the codebase's own new convention, not this fork's invention.
- The core-side expander is **more capable**: via `executionPort` it supports `` !`cmd` `` dynamic shell
  expansion; the monolith TUI's client-side expander (`expandCliCustomCommandPrompt`) throws
  "unsupported shell expansion" on the same syntax. If the thin client expanded locally instead,
  it would cut off the dynamic commands currently available through the shared core.

## Decision

**(a) Minimal version: add only one protocol method, `commands/referenceCatalog` (the catalog); expansion stays in
the core's input facade; no `commands/load`; no client-side
`loadCustomCommand`.**

- New method: workspace-level, sessionless, freshly scanned on every call (following `skills/referenceCatalog`'s
  workspace-authority precedent). Returns the full metadata projection of custom commands
  (name/description/scope/source/path/argumentHint/model/allowedTools/
  skills/rootPath/frontmatterKeys/disableNonInteractive + totalDiscovered),
  for the `/` panel suggestions and `/help`.
- **No sessionId / authority fields**: the skills session authority comes from the skill directory frozen at
  runtime context initialization; custom commands have no corresponding session-frozen state (the facade re-scans
  on every send), so a pseudo session authority is false precision. Leave additive room.
- **Expansion does not move to the client**: the thin client keeps forwarding verbatim `/name args` via session/send
  (existing behavior); the core expands it and records the original text as `displayInput`. Rationale above: capability
  parity with the headless convention, preserved dynamic shell expansion, single source of truth (P004's "no local
  re-scan in the thin client; session authority" argument — the thin client should not hold a second copy of command truth).
- **Reserved-name filtering**: the catalog drops entries hit by `isReservedZCodeSlashCommandName`
  (following the `listProtocolSlashCommands` precedent). Slight divergence from the monolith local panel (local scan,
  no filtering): reserved-name commands cannot truly be invoked from any panel (the facade rejects reserved names),
  so listing them would be a lie; the protocol catalog does not lie. `disableNonInteractive` is not filtered,
  only passed through — the attach TUI is an interactive client, so interactive-only commands should be shown.
- **Remove the `listAttachCustomCommands` dep** (run.ts/cli-types.ts): the monolith attach path switches to the same
  protocol catalog, eliminating the dual source of truth of "client local re-scan vs core live scan".

## Alternatives and rejection reasons

- **(b) Client-side local scan** (`listCustomCommandsForTui` used directly): the thin client bundle has no bootstrap;
  either bundle `createConfig`+`resolveZCodePlugins`+commands adapter into the thin client (breaking the P004
  thin-client boundary), or write a second scanner that drifts from the core (plugin command roots,
  commandOverrides disable paths, and workspace identity semantics would all diverge). Rejected.
- **Reuse the session snapshot's `slashCommands` array**: only name/description/inputHint/source; missing the
  scope/path needed for the `/` panel usage hints and `/help`; and it only refreshes on session create/resume,
  so commands created mid-session are invisible; the skills precedent (a dedicated catalog method) already
  offers the better shape. Rejected.
- **Client-side expansion (commands/load + loadCustomCommand dep)**: cuts dynamic shell expansion, duplicates
  expansion logic, doubles the protocol surface. Rejected (see decision item 2).

## 2026-11-03: trusted `--no-plugins` discovery boundary

- `noPlugins` comes only from the process entrypoint / server dependencies; it does not accept client
  workspace, session, or runtimeConfig parameter overrides. The entrypoint holds the same policy: runtime startup,
  session snapshot, `commands/referenceCatalog`, workspace presentation, V4
  workspace config, and input facade command expansion all pass through that gate.
- Every command discovery still uses the shared `createConfig`; the trusted gate is applied as the existing CLI
  override, preserving normal user/workspace commands and commandOverrides; no caching, no truncating the catalog,
  no adding a cross-workspace config root. Both the catalog and expansion are scoped to the workspace of the current call.
- With `plugins.enabled=false` in effect, custom command discovery does not call the plugin resolver; startup and
  the generic plugin resolver must check the switch before calling `resolveOfficialPluginRoots`, so builtin
  plugin assets are not seeded/hashed before the empty result. The normal enabled path is unchanged.
- Order: trusted entrypoint → server deps / app options → config resolution for this call →
  plugin gate → normal command scan → snapshot/catalog/expansion. The config file remains the sole authority for
  command metadata; there is no second catalog state or session-frozen cache.
- Regression coverage: disabled config does not parse/seed plugins; the no-plugin snapshot keeps builtin and
  workspace commands; catalog freshness across calls and workspaces, and input expansion. This fix only proves
  the forbidden discovery IO was removed; the historical 1383/1161ms snapshot figures have no controlled attribution and are not claimed as a performance gain.

## Known limits (recorded, not fixed)

- The catalog is fetched once at attach startup (`loadStartupOptions`); commands added/removed mid-session only
  appear in the panel at the next startup — the same staleness as the monolith TUI (local scan at startup).
- Input history records `/review` as a prompt rather than slash_command (the monolith local-expansion path records
  slash_command); under the displayInput semantics the two display equivalently.
- When `/review` does not exist, the original text is really sent to the model (forwardUnknownSlashAsPrompt's
  existing trade-off: pasted absolute paths also start with `/`, so it cannot blanket-report Unknown command). The monolith
  interactive path behaves the same way.
