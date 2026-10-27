# Carried-patch review — 2026-10-26

Fresh-context review of the piz fork's carried changes on `main` (HEAD `bebeb309`).
Findings only — no fixes applied, no commits, no builds; `promote-piz.sh` and
`dist-runtime/` untouched. Targeted existing tests were run as evidence (below).

## Scope derivation

Commands and results (run from repo root, branch `main`):

- `cat UPSTREAM` → `ref: refs/heads/main`, `commit: 3c5b227649371507ddc4eb46ac5133afe6db1cab` — re-derived base, matches the brief's SHA.
- `git log --oneline 3c5b227649371507ddc4eb46ac5133afe6db1cab..HEAD` → **104 commits**: 67 `fork:`-subject + 37 imported pre-fork lineage (the 37 match FORK.md's "at import … 37 commits" note). P001–P005's provenance SHAs all sit in the 37 imported commits, so "carried patches" = the **full base..HEAD diff**, not literally only `fork:` subjects (assumption A1/A2 below).
- `git diff --stat 3c5b2276..HEAD` → **231 files, +27,551 / −641** (136 added, 95 modified); ≈126 production TS files + ≈70 test files after excluding docs/archive.
- `git branch --no-merged main` → `feat/allowance-herdr`, `patch/transcript-polish` (both out of scope, see "Not reviewed").

## Method

Four subagents (workspace hard cap = 4), one per area; every finding below was
re-verified in the main session by reading the cited lines before entering this
report, except where explicitly marked. Verified-OK notes are kept separate from
findings.

## Coverage table

| Area | Files actually read | Findings (severity) | Reviewed by |
|---|---|---|---|
| P001 signing/auth policy | All 11 `adapters/src/model/request-security-edition/*` (9 signing-* added, index.ts, recovery.ts); `telemetry/src/request-security-edition/index.ts` (diff); `packages/shared/src/request-security-edition/{policy,verification-policy}.ts` (diff); `tests/client-request-signing.test.ts`; wiring reads: `request-security.ts`, `model-execution.ts` (excerpts), `runner.ts`/`runner-stream.ts` (excerpts), `account-request-retry.ts`, `provider-endpoint-routing-fetch.ts`, `bootstrap/src/model-factory.ts`, design doc | 5: 1 high, 1 medium, 3 low | Subagent A + main-session re-verification |
| P004 shared core + attach client | Full: `bootstrap/src/zcode-protocol/{socket-listener,command-reference-catalog}.ts`; all 15 `cli/src/attach/*`; `cli/src/app-server-spawn.ts`; `packages/shared/src/app-server-attach/{contract,index,module}.ts`; `scripts/promote-piz.sh`, `scripts/measure-attach.sh` (headers); root `vitest.config.ts`. Diff-only: `packages/shared/src/zcode-protocol/index.ts`; 12 modified `bootstrap/src/zcode-protocol/*`; `bootstrap/src/app/{app-config-options,runtime-config,types}.ts`; `cli/src/{run,main,arguments,cli-types,protocol-lifecycle,skill-suggestions}.ts`; `cli/scripts/build.mjs`, `cli/package.json`. Supporting excerpts: `prompt-command.ts`, `sessions.ts`, `tui/app-submit.ts`, `tui-pi/app.ts` | 6: 2 high, 2 medium, 2 low | Subagent B + main-session re-verification |
| P003 tui-pi + P002 tui controls | All 34 `tui-pi/src/*` in full (incl. CONTRACT.md, contract.example.ts); `tui/src` added files in full (`internals.ts`, `app-composer-keyboard.ts`, `app-selection-paste.ts`, `app-session-event-handler.ts`, `app-events.ts`, `app-terminal-width.ts`) + 14 modified `tui/src` files (diff); `cli/src/tui-pi-runtime-loader.ts` (full), `tui-command.ts`/`tui-command-state.ts`/`tui-prompt-handler.ts` (diff); i18n locale diffs; `architecture-policy.yaml` diff; `tui-pi` package/build/tsconfig; selective tests (`harness.ts`, shell/history/rows-wrap/status-line); pi-tui dist `tui-main-screen.js` (throw verification) | 6 (+1 P002): 1 high, 2 medium, 4 low | Subagent C + main-session re-verification |
| P005 + remainder + cross-cutting | `command-center/{create,types,slash-commands}.ts` (full); `tui-prompt-handler.ts`; `attach/{attach-tui-options,attach-main}.ts`; `tui-command.ts`; `adapters/src/exec/{bash-startup-script,shell-init-snapshot}.ts` + caller `node-execution-adapter-process.ts`; `tui-pi/src/app.ts` submit path; `tui/src/app-submit{,-controller}.ts`; diffs of i18n, `cli/package.json`, `cli/scripts/build.mjs`, `tui-pi` build files, `.gitignore`, `architecture-policy.yaml`, `UPSTREAM`; greps over all 126 changed production files (any / sync-IO / stdout) | 5 (+1 inventory): 1 medium, 1 medium, 3 low, inventory medium | Subagent D + main-session re-verification |

## Hard-gate audit on carried code

| Gate | Verdict | Evidence |
|---|---|---|
| Signing path (P001) intact and wired | **PASS with one gap** | Wired: `model-factory.ts:25,33` builds the security state; `model-execution.ts:296` wraps the transport before use; consumers at `account-request-retry.ts:24,64`, `runner-stream.ts:507+`. Every unsigned fallback is *observed* (`unsigned_sent` + logger + telemetry): `signing-signer.ts:97,99,102,125` all route through `sendUnsigned` with a reason. The one silent exception is finding **P001-F2** (missing baseURL). Fail-open-on-signing-failure is by design and labeled; whether labeled-unsigned operation satisfies "signing mandatory" remains the owner's policy call (eligibility/metering still unverified, per FORK.md). |
| No-plugin startup gate | PASS | Spawn hardcodes `--no-plugins` (`app-server-spawn.ts:150-158`); entrypoint applies `NO_PLUGINS_CONFIG_OVERRIDES` at highest priority (`zcode-protocol-entrypoint.ts:178-183`); `runtime-config.ts:94-101,160-168` blocks re-enabling; per-session app inherits (`entrypoint:457`). Manual `--socket` without `--no-plugins` remains possible but is operator action, not an attach-spawn bypass. |
| Client/core protocol schemas in sync | PASS | skills/commands referenceCatalog, `delivery:"steer"`, `steerQueued`, recall/record/discard, `rawEvents` all defined once in `packages/shared/src/zcode-protocol/index.ts`, consumed with strict parse, implemented in `server-operations.ts:2024-2290`; `command-reference-catalog.ts` matches contract field-for-field incl. enums. No drift found. |
| Thin client imports no full runtime | PASS | `attach/**` imports only node builtins + `@zcode/{shared,contracts,tui,tui-pi-via-loader,i18n,shared-types}`; bootstrap references are `import type` (erased); `build.mjs` bundles `attach-main.ts` with tui/tui-pi/playwright-core/koffi external; `zcode-attach.cjs` contains only 2 loader-string references vs 19 in the snapshot bundle. |
| No TS `any` | PASS | Zero `any` occurrences on added lines across all 126 changed production files (subagent-D grep, `: any`/`as any`/`<any>`/`any[]`); subagent A/C per-area greps agree; tui-pi typecheck+lint clean. |
| No sync network/FS IO in production paths | PASS with notes | Only 3 clusters: `cli/src/cwd.ts:22` and `cli/src/env.ts:58` (startup-only), `tui-pi/src/shell.ts:203` `spawnSync("which")` per user-triggered `!` escape (blocks the render loop for one `which`; acceptable, noted). Heavy sync IO in `bash-startup-script.ts:88-102` is inherited upstream code, not fork-added. |
| Errors via project loggers, never protocol stdout | PASS with gaps | Nothing added writes to protocol stdout (`attach-main.ts:40,44` are `--help/--version` before protocol; diagnostics consistently stderr). Gaps are *silenced* signals, not stdout pollution: **P004-F4**, **P003-F4**, **REM-F3**, **P001-F3**. |
| workspaceIdentity/path, permission parentage, event ordering, stale-run guards | PASS | Detach/adoption lifecycle double-scans the adopt-window race (`zcode-protocol-entrypoint.ts:388-395`); 10-min adopt window + four busy facts in `isReapable` (`server.ts:169-172,1394-1416`); 30s sweep + `exitWhenDrained` (`entrypoint:404-417,625-653`); server self-registers `.pid/.info` as bind owner (`:613-621`). Ready budget: window starts after spawn completes, separate from lock-wait deadline (`app-server-spawn.ts:199` vs `:108,118-137`); contested-lock regression test passes. |

## Findings

Severity = impact × confidence. All citations verified in the main session
unless noted. "Verified by subagent only" items were read by the subagent with
exact quotes; I verified the surrounding mechanism.

### P001 — signing/auth (area reviewer: subagent A)

**P001-F2 · HIGH · bug · confidence high**
`apps/zcode-cli/packages/adapters/src/model/request-security-edition/index.ts:47-48` —
`requiresClientRequestSigning(providerConfig)` true but `!providerConfig.baseURL`
→ `return transport` with **no observation and no log** (verified: lines 47-48;
everything else records `unsigned_sent`). Failure mode: a coding-plan provider
with missing/empty baseURL silently sends unsigned, unattributed traffic — the
only truly silent unsigned path in the fork. Direction: record an
`unsigned_sent` observation (reason `missing_baseurl`) or fail with
`invalid-config`.

**P001-F1 · MEDIUM · bug · confidence medium** (mechanism verified; runtime
frequency inferred, not observed)
`signing-manager.ts:89-97` rebuilds+disposes the signer whenever
`current.transport !== transport` (verified), and `model-execution.ts:289-295`
builds a **new** `createProviderEndpointRoutingFetch` closure per factory
creation, which the request path re-enters per snapshot/request
(`runner.ts:258-279`, verified by subagent). Failure mode: after two verify
rejections the signer sets `#bypassSigning` (`signing-signer.ts:123-125`,
verified) to stop handshake thrash — but the next request gets a new transport
identity → new signer generation → bypass forgotten while the shared key was
invalidated (`:253-258`), so every subsequent request repeats handshake + 2
signed attempts + unsigned fallback (~4 round trips) against a rejecting
gateway. The documented BYPASS goal ("后续请求不再尝试签名", design doc) is
defeated in the wired path. Direction: compare reuse on stable inputs
(apiKey/baseURL/clientVersion) or cache the routing-fetch closure; or hoist
bypass state into the shared `ClientSigningKeyState`.

**P001-F3 · LOW · code-smell · confidence high**
`signing-signer.ts:171-173` (verified) — observer exceptions vanish in
`catch { /* 观测失败不能影响请求主路径 */ }` with no stderr/diagnostic
fallback. Failure mode: broken telemetry disappears silently while requests
continue. Direction: route the swallowed error to a debug-level log.

**P001-F4 · LOW · code-smell · confidence high**
`signing-handshake.ts:43` (verified) — 10s handshake `setTimeout` is cleared in
`finally` but not `unref()`'d; an abandoned handshake can hold a CLI process's
event loop up to 10s. Direction: `timeout.unref?.()`.

**P001-F5 · LOW · code-smell · confidence high**
`signing-key-state.ts:18-34` (verified by subagent) — process-lifetime
`Map<apiKey, Map<origin, {privateKey}>>` with no eviction; disposed signers
deliberately keep cached keys. Deliberate single-user design; matters only for
long-lived cores with many rotated accounts. Direction: none needed now;
evict-by-window if account rotation ever becomes real.

### P004 — shared core + attach (area reviewer: subagent B)

**P004-F1 · HIGH · bug · confidence high**
`apps/zcode-cli/packages/cli/src/attach/attach-session.ts:323` (verified) —
`if (options?.onEvent) this.sinks.add((event) => void options.onEvent?.(event));`
added on **every** `submitPrompt` and never removed (the only `sinks.delete` is
the discarded `addSink` unsubscribe at `:180`; grep-verified). The TUI passes
`onEvent` on every submit (`tui/src/app-submit.ts:165,280`); the monolith
removes its per-turn onEvent in `submitPrompt`'s finally (`prompt-command.ts:319-320`).
Failure mode: sinks Set grows one closure per turn for the handle's lifetime;
every later event fans out to every stale onEvent (O(turns) per event, O(N²)
cumulative) until `/new`//`resume` swaps handles. Rendering stays correct only
because pi-tui dedupes via `appliedEventIds` (`tui-pi/src/app.ts:367-368`) — so
the symptom is silent memory/CPU growth in long sessions, on piz's core product
path. Direction: keep the unsubscribe and invoke it in the turn-promise
finally, mirroring monolith semantics.

**P004-F2 · HIGH · bug · confidence high**
`apps/zcode-cli/packages/cli/src/attach/attach-tui-options.ts:400` (verified) —
in-TUI bare `/resume` does `listed.sessions?.at(-1)`. The entry path fixed by
9b46915f sorts by `updatedAt ?? createdAt` precisely because "server 的
session/list 返回顺序不保证（实测创建序/任意序混排）" — that comment is at
`attach-command.ts:62-63` (verified), and `.at(-1)` reintroduces the exact
failure it documents: silently resuming a stale session instead of the most
recent one. Direction: reuse `resolveAttachResumeTarget`'s `-c` branch
(recency sort + explicit error) here.

**P004-F3 · MEDIUM · bug · confidence high**
`attach-tui-options.ts:239,287,291` (verified, quoted verbatim) — user-facing
connection-status strings hardcoded in **French** regardless of locale:
"Connexion au core perdue — reconnexion…", "Reconnecté au core",
"Reconnecté au core — session indisponible, nouvelle tentative…". Related:
French comments at `attach-command.ts:175,374`, `attach-tui-options.ts:98`
violate the fork's Chinese-comment rule for carried changes. Direction: route
status text through the locale layer (`resolveLocale`/`--locale` already
exists); translate comments.

**P004-F4 · MEDIUM · implementation-gap · confidence high**
`attach-tui-options.ts:130` (verified) — the default
`(this.options.connect ?? ((path) => connectAttachClient(path)))` never passes a
logger, and `attach-command.ts:183-191` (verified) constructs `AttachRuntime`
without `logger`. All built-in transport diagnostics (dropped malformed line
`attach-client.ts:97`, invalid protocol message `:104`, socket error `:178`)
are optional-chained into no-ops in production. Failure mode: a corrupt stream
silently degrades — "if it runs, it emits signals" is violated on the primary
transport boundary. Direction: wire a throttled/verbose-gated stderr logger
into `connectAttachClient` from `runAttachCommand` (ctx.stderr is in scope).

**P004-F5 · LOW · code-smell · confidence high**
`attach-entry-args.ts:31-32` (verified) — `--resume` with no value silently
sets `resumeSessionId = undefined` → degrades to new-session, the silent
fallback 9b46915f removed elsewhere; `--model` two lines later errors properly
(`:33-37`). Direction: mirror the `--model` validation.

**P004-F6 · LOW · code-smell · confidence high**
`attach-client.ts:61,167-176` (verified by subagent) — inbound NDJSON `buffer`
grows without a cap if the peer never sends `\n`; a wedged core could balloon
the thin client's RSS. Same-trust boundary (client spawns the core), so limited
impact. Direction: cap line length and fail the connection.

### P003 / P002 — frontends (area reviewer: subagent C)

**P003-F1 · HIGH · bug (test infrastructure) · confidence high — observed**
`apps/zcode-cli/packages/tui-pi/tests/harness.ts:113-117` (verified) —
`flush` is a fixed 40ms sleep. The shell test spawns a real child
(`shell.ts:473`); under full-suite load the spawn can exceed 40ms → transcript
row absent → `assert.ok(shellRow)` fails. Observed by the area reviewer: 1
failure in 3 full-suite runs (`tests/shell.test.ts:212` "shell output must
appear in the transcript", actual undefined), 17/17 isolated ×3; my own
main-session run passed 186/186 (7.2s) — intermittent, mechanism confirmed.
Failure mode: the suite's green/red signal is unreliable under load, which
erodes the fork's verification discipline (verification.md already records two
prior flakes of this class). Direction: poll/await a condition with a deadline
instead of a fixed sleep for tests that cross a process boundary.

**P003-F2 · MEDIUM · bug · confidence medium** (mechanism verified from code;
not reproduced live — narrow-terminal repro pending, labeled)
`tui-pi/src/workflow.ts:99` (verified) —
`parts.join(...).slice(0, Math.max(width, 40))`: (a) `Math.max(width, 40)`
deliberately keeps up to 40 units when `width < 40`; in noColor mode (identity
styles, zero ANSI) the run line can be 40 cells on a <40-col terminal; (b) the
slice and `truncate(label, 40)` (`:92`, `.length`-based, same at
`info-panel.ts:17`) count UTF-16 units, not display width — a 40-CJK-char label
is 80 cells, and slicing can cut mid-ANSI-escape. pi-tui **throws** on
over-width lines ("Rendered line N exceeds terminal width",
`node_modules/@earendil-works/pi-tui/dist/tui-main-screen.js:486` — verified),
killing the client; WorkflowCard renders outside MessageRow's `clampLines`
safety net (`app.ts:222`). Failure mode: narrow terminal + workflow run →
client crash. Direction: use the codebase's own width-aware helpers
(`visibleWidth`/`truncateToWidth` from rows.ts) and clamp to the actual width.

**P003-F3 · MEDIUM · implementation-gap · confidence medium (runtime default
labeled ASSUMPTION)**
`cli/src/tui-prompt-handler.ts:352-360` (verified) — in-process hosts
deliberately do not map `delivery:"queue"`; the comment states queued inputs
"会随回合静默丢失" (the auto-drain elevator only exists with the v4 bridge).
But Ctrl+Q while busy sends `delivery:"queue"` (`tui-pi/src/chords.ts:118-123`)
and the UI shows "Input queued (N pending)" + a queue row
(`tui/src/app-submit.ts:172-186`). Failure mode: in `zcode tui`/in-process mode
the user is told the follow-up is queued, then it silently vanishes at turn
settle. **piz attach mode is unaffected** (full queue semantics live there,
turn-steering.md). What the runtime does with the unmapped delivery is
ASSUMPTION (unverified). Direction: in-process hosts either reject the queue
lane with an explicit status or wire a local replay lane.

**P003-F4 · LOW · code-smell · confidence medium**
`tui-pi/src/app.ts:301-336` (verified) — `seedWorkflowRuns` swallows replay
(`:312-314`) and list (`:320-322`) failures with no stderr/status signal
("回放失败不该让 TUI 起不来"). Failure mode: user silently loses workflow
state with zero diagnostics. Direction: one-line `options.stderr.write`
diagnostic, keeping startup resilient.

**P003-F6 · LOW · code-smell · confidence low**
Residual usage-gating edges (documented tradeoffs, not regressions):
`tui/src/app-session-event-handler.ts:41` — before `getMainSessionId` resolves
in early attach, subagent ModelComplete events could fold into main totals
(short window); `:109` — a doubly-delivered id-less event double-counts tokens.
Direction: none required; note for future gate work.

**P002-F5 · LOW · refactor-or-deepen · confidence high**
`tui/src/internals.ts` closure pulls **react** at runtime via 3 modules
(`app-session-event-handler.ts:3`, `app-permission.ts:8`,
`app-workflow-seed.ts` — hook wrappers); tui-pi uses only their pure parts.
Verified there is no opentui leakage (all 35 re-exported modules are
opentui-free at runtime; keys/composer are `import type`). Benefit of moving
pure functions out of the React modules: drops the React edge from tui-pi
entirely. Low priority; respects the internals contract either way.

### P005 + remainder + cross-cutting (area reviewer: subagent D)

**P005-F1 · MEDIUM · implementation-gap · confidence high**
`cli/src/tui-prompt-handler.ts:271` — the opentui-TUI wiring
(`forwardUnknownSlashAsPrompt: true`) has no direct test; only the attach wiring
(`attach-tui-options.ts:428`) is exercised end-to-end. Failure mode: a refactor
of `createTuiSubmitPrompt` deps could silently drop the flag on the TUI lane
with no failing test. Direction: one assertion that the tui handler's command
center forwards unresolved `/...` (or a wiring-shape test).

**REM-F3 · MEDIUM · code-smell · confidence medium**
`adapters/src/exec/shell-init-snapshot.ts:117,153` (verified) — snapshot
creation `this.create(request).catch(() => undefined)` swallows failures (incl.
1MB `maxBuffer` overflow from chatty interactive rc) with **no logging**;
execution silently falls back to a login shell without aliases. Failure mode:
"aliases work for most users, silently don't for chatty-rc users". Direction:
log the failure at debug level to stderr, keep the fallback.

**INV-1 · MEDIUM · docs-staleness (FORK.md inventory) · confidence high**
The FORK.md "Active patch inventory" is stale relative to the 104-commit diff.
Verified in-main but absent from any P-row: `3b2f3eb4` shell-alias/eval-wrap,
`508d1c77` plan overlay into settings.mode.current, `80729ec8`/`f5241576`/`8888d7e9`
tui-pi `!` shell port (P003's feature list doesn't mention it, and its
narrative ends at the intermediate "interactive shell" state — HEAD runs
deterministic non-interactive `/bin/bash`), `4f6d847b` ExitPlanMode plan
rendering, `f95b9b29`/`3d6c2785`/`04a0c046`/`b9e4b0b8` detach/adopt lifecycle,
`68b5043b`/`87f433f8` busy-quit choice, `36076bf8`+ usage cluster,
`0b7c1301` keymap additions, `fbe7dbee`/`a40b6960` steer-queue,
`6537f416` ready budget, `9b46915f` resume prefix expansion, `3db70344`
`--model` flag. Some plausibly fit P003/P004's open wording, but the table's
stated role as the sync-budgeting map ("count touched interfaces, not just
commits") suffers when whole behavior areas are uncited. Direction: refresh the
inventory rows (or add a "later carried behavior" appendix), including the
P003 `!`-semantics correction.

**P005-F2 · LOW · docs-staleness · confidence high**
FORK.md:106 "coverage sufficiency not established" is stale. Verified coverage
now includes: unresolved-slash verbatim forward with attachments
(`cli.unit.test.ts` ~:947), default no-opt-in "Unknown command", headless
end-to-end `--prompt /nope` (`cli.unit:1384`), attach end-to-end through a real
command center + fake-core socket asserting exactly one `session/send`
(`attach-adapter:583`), custom-command expansion precedence (`cli.unit:902`),
recognized builtins staying local (`/help`, `/skill`, `/model`). Still uncovered:
attach unresolved-slash **with attachments** over a real socket, and the TUI
wiring lane (P005-F1). Direction: update the cell to this real coverage
statement.

**REM-F1 · LOW · refactor-risk · confidence high**
`cli/scripts/build.mjs` (tail, verified by subagent) — default `build` now
always runs `buildAttach` after `buildCli`, so an attach-bundle failure breaks
the normal CLI build; `--desktop-agent`'s `minify` also propagates into the
attach bundle (harmless coupling). Acceptable for a fork that always ships the
pair; note for build-breakage triage.

**REM-F4 · LOW · behavior-note · confidence high**
`shell-init-snapshot.ts` cache key is `rootDir:dialect:shellPath` per manager
instance — a long-lived core serves aliases captured at first snapshot until
restart (that is the patch's point; informational).

### Verified-correct notes (not findings)

- **P005 core semantics**: only three `createCommandCenter` consumers exist;
  headless defaults to "Unknown command" (pinned by `cli.unit:1384`), both
  interactive wirings opt in; attachments ordering in `create.ts:61-99` never
  silently drops attachments; forwarded text is the original input. tui-pi does
  **not** diverge: idle submits delegate through `submitIdleTurn` → the same
  flagged handlers (`tui-pi/src/app.ts:452-465`, `tui-command.ts:57`,
  `attach-command.ts:275`). Known boundary (consistent across clients): P005's
  forward applies to idle submits only; a busy-turn `/...` goes raw as
  steer/queue input.
- **REM-F2 eval-wrap**: `bash-startup-script.ts:125` single-quote escaping is
  the standard safe pattern; pinned by real zsh/bash subprocess tests (9/9).
- **Steer/queue rendering (a40b6960)**: drained rows are payload-sourced, not
  memory-queue-sourced; optimistic user rows only on `started_turn`;
  `appliedEventIds` dedup across sinks prevents double-append — verified with
  line cites by the area reviewer.
- **Kitty release filtering, terminal query drain, `!` shell isolation
  (setsid + group SIGKILL + reaping), usage double-gating, timer cleanup**:
  all PASS with evidence (see gate table and area reports); residuals only in
  P003-F6.

## Inventory vs reality (per-row verdict)

- P001: accurate (commits in-main, artifacts exist, caveat framing correct).
  Soft mismatch only: design doc's post-BYPASS claim is defeated by P001-F1.
- P002: accurate (commits + claimed tests exist; 44 targeted tui tests pass).
- P003: cited SHAs accurate; feature list incomplete/stale (see INV-1 — `!`
  shell port, ExitPlanMode rendering, usage cluster, keymap, steer-queue not
  enumerated; `!` narrative describes an intermediate state).
- P004: accurate — cited SHAs in-main; open-ended "later attach fixes" wording
  carries the newer behavior, at the cost of INV-1's map quality.
- P005: provenance accurate; coverage cell stale (P005-F2). `c6b36ad5` correctly
  labeled as the allowance-tree variant, not in main (intentional).

## Tests run (evidence)

| Command (all with `mise exec`, pinned tools) | Outcome |
|---|---|
| `env -u ZCODE_WORKSPACE_IDENTITY … --filter @zcode/adapters exec vitest run tests/client-request-signing.test.ts` | 9/9 pass |
| `env -u ZCODE_WORKSPACE_IDENTITY … --filter @zcode/bootstrap exec vitest run tests/socket-listener.test.ts tests/protocol-steer-queue.test.ts tests/command-reference-catalog.test.ts` | 13/13 pass (4+5+4) |
| `env -u ZCODE_WORKSPACE_IDENTITY … --filter @zcode/cli exec node --disable-warning=DEP0205 --import tsx --test tests/app-server-spawn.test.ts tests/attach-client.test.ts` | 16/16 pass (incl. contested-lock ready-window regression) |
| `mise exec -- pnpm exec vitest run packages/shared/src/app-server-attach/contract.test.ts` (repo root) | 4/4 pass |
| `mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/tui-pi test` | area reviewer: run1 185/186 (shell flake → P003-F1), runs 2-3 186/186; **main session re-run: 186/186 pass (7.15s)** |
| `mise exec -- pnpm exec tsx --test tests/shell.test.ts` (tui-pi, isolated) | 17/17 ×3 pass |
| `… --test tests/{tui-keymap,tui-selection-paste,ctrl-d-exit,ctrl-c-exit-guard,tui-events}.test.ts` (tui) | 44/44 pass |
| `env -u ZCODE_WORKSPACE_IDENTITY … --filter @zcode/cli exec node … --test tests/cli.unit.test.ts tests/attach-adapter.test.ts` | 226/226 pass (~29s) |
| `… --filter @zcode/adapters exec vitest run tests/bash-startup-script.test.ts` | 9/9 pass |
| tui-pi `typecheck` + `lint` | clean (0 errors/warnings, 33 files) |

Not run: full CLI suite (607+), root/CLI turbo typecheck+lint battery, any
build, any live model turn — latest full-battery evidence remains
`docs/fork/verification.md` 2026-10-25; this review ran targeted sets only.
No stray processes left behind (checked after attach/bootstrap runs).

## Not reviewed (with reasons)

- `patch/transcript-polish` — unmerged branch (`git branch --no-merged main`),
  explicitly out of scope per brief. Listed as skipped.
- `feat/allowance-herdr` + `archive-source/*` — parked/reference lines, out of
  scope per brief and FORK.md.
- Docs-only commits (FORK.md, verification logs, design docs, READMEs,
  `docs/fork/archive`) — treated as intent/claims, never as proof of behavior;
  reviewed only where inventory claims were audited against code.
- Unmodified upstream code — read only in excerpts needed for wiring
  verification (model-execution, runner, prompt-command, sessions,
  pi-tui dist); not itself under review.
- Live/runtime behavior — model turns, real herdr pane cycles, narrow-terminal
  crash repro, memory measurements: not exercised here; relevant findings are
  labeled accordingly (P001-F1 frequency, P003-F2 repro, P003-F3 runtime
  default = ASSUMPTION/unverified).

## Assumptions

- **A1** (brief-labeled): carried-on-main is the intended review target.
- **A2**: "our patches" = full `3c5b2276..HEAD` divergence including the 37
  imported pre-fork commits, because P001–P005 provenance SHAs sit in them;
  literally filtering to `fork:`-subject commits would have excluded P001/P002
  entirely.
- **A3**: subagent-run test outcomes are reported as their recorded results
  (commands + outcomes above); headline code findings were independently
  re-read in the main session, and the tui-pi suite was additionally re-run by
  me (186/186).
- **A4**: P001-F1's per-request frequency is inferred from the
  factory/snapshot chain, not observed on a live gateway; the
  transport-identity→signer-rebuild mechanism is verified.
- **A5**: P003-F2's crash is mechanism-verified (including pi-tui's throw) but
  not reproduced on a real narrow terminal.
- **A6**: P003-F3's description of what the in-process runtime does with an
  unmapped `delivery:"queue"` is ASSUMPTION (the code comment's claim was not
  traced into the runtime).

## Dispositions (fix pass 2026-10-26)

Fix pass on `main`: review recorded at `df2f5840`; area branches
`patch/p001-signing-remediation` (merge `bcd8054f`),
`patch/p004-attach-remediation` (merge `cdb9f4de`),
`patch/p003-frontend-remediation` (merge `9697a8d5`),
`patch/p005-remainder-remediation` (merge `43092fe1`); docs `d273d6ed`.
Every fix landed test-first (each test observed failing for the right reason
before its fix); P004-F1 additionally spot-checked in the main session by
reverting the production fix (2/2 tests fail) and restoring (2/2 pass).
Final-main battery observed by the verifier: adapters signing+bash+shell-init
36/36, bootstrap 13/13, spawn+attach-client 18/18,
cli.unit+attach-adapter+resume-target+model-option 263/263, shared attach
contract 4/4, tui-pi 194/194, touched tui set 44/44; root typecheck, CLI
typecheck 34/34, root lint 0 errors/96 upstream warnings, CLI lint
0 errors/71 warnings/13 accepted (baseline match), architecture:check 0.

- **P001-F2** — fixed `5b68acae`: fail-loud `invalid-config` chosen (sibling
  `resolveHandshakeUrl` already throws `invalid-config`; baseURL never injected
  later; empty baseURL would misroute credentials). Test: `fails closed with
  invalid-config when a signing-required provider has no baseURL`
  (client-request-signing).
- **P001-F1** — fixed `2b6a81ae`: smallest-direction choice = hoist bypass into
  shared `ClientSigningKeyState` (option c); a reused signer would wrap a stale
  transport (a is wrong) and closure caching (b) widens the blast radius into
  model-execution wiring. Test: `keeps bypass engaged across signer rebuilds
  caused by a new transport identity`.
- **P001-F3** — fixed `340a5346`: observer errors routed to `logger.debug`
  (`model.client_signing.observation_failed`), request path still guarded.
  Test: `reports observer failures to the debug log without breaking the
  request`.
- **P001-F4** — fixed `c60b9c16`: `timeout.unref?.()` in the handshake. Test:
  `unrefs the abandoned handshake timeout handle`.
- **P001-F5** — no-fix per review direction (deliberate single-user cache;
  revisit only if account rotation becomes real).
- **P004-F1** — fixed `8e1626f6`: per-turn onEvent sink unsubscribed in the
  send-failure catch and the turn-promise finally (monolith-mirror). Tests:
  `submitPrompt 的 per-turn onEvent 回合结束即摘除：不随回合累积、无陈旧回调`,
  `submitPrompt 发送失败后 per-turn onEvent 即摘除` (attach-adapter).
- **P004-F2** — fixed `441ffb3b`: bare in-TUI `/resume` now uses the shared
  recency ruling (`pickMostRecentResumeSessionId`, moved with
  `resolveAttachResumeTarget` into attach-tui-options to avoid an import
  cycle; attach-command re-exports). Tests: `TUI 裸 /resume 按 updatedAt 取最
  近会话，而不是列表末位`, `TUI 裸 /resume 空列表显式报错`.
- **P004-F3** — fixed `032b9605` (+doc `e18bc56b`): three status strings now
  `tui.connection.{lost,reconnected,reconnectedSessionUnavailable}` via
  `getZCodeCopy`; en-US/zh-CN catalogs; French comments translated to Chinese.
  Tests: `断线状态文案三键在 en-US/zh-CN 目录齐全且按 locale 区分`,
  `AttachRuntime 断线状态行按 locale 走 i18n 目录`.
- **P004-F4** — fixed `152e82a9`: `createAttachTransportLogger` (≥60s-throttled
  stderr) wired into `connectAttachClient` and `AttachRuntime` from
  `runAttachCommand`. Tests: `runAttachCommand 给传输接 stderr 诊断：畸形行
  有日志、连接继续`, `malformed line 产生 logger.warn 诊断且连接继续`.
- **P004-F5** — fixed `39b8292e`: `--resume` without a value errors, mirroring
  `--model`. Test: `zcode-attach --resume 缺值报错，不静默降级为新会话`.
- **P004-F6** — fixed `92dcd8d8`: 4MB named line cap; oversized/growing buffer
  fails the connection (pending rejected, socket destroyed, warn logged).
  Test: `超长无换行流触发行上限显式失败`.
- **P003-F1** — fixed `e7172220`: harness `flush` is now poll+deadline (5ms
  interval, 5s deadline, fail-loud timeout); the shell-test path contains no
  fixed sleep (mechanism check). Tests: `tests/harness-flush.test.ts` (3
  cases) + full shell suite green.
- **P003-F2** — fixed `b3171184`: pi-tui `truncateToWidth`/`visibleWidth`
  replace UTF-16 slicing in workflow.ts and info-panel.ts; run lines clamp to
  real width minus indent plus a final clamp pass. Tests: `run line never
  exceeds a narrow terminal with a long CJK label (noColor)`, `run line with
  ANSI styles truncates to width without cutting mid-escape` (+ info-panel CJK
  in panels.test.ts). Live narrow-terminal repro remains a labeled CI gap;
  unit tests pin the same invariant pi-tui's `doRender` enforces.
- **P003-F3** — fixed `047abbbc` (+spec `0e87b4d8`): A6 trace resolved (see
  below) — the core parks the input on its queue lane with no in-process
  consumer; explicit reject chosen (local replay fails the triviality bar: no
  settle signal in-process without a new state machine). In-process handler
  returns `queue_unavailable`; shared app-submit surfaces "Follow-up queuing
  is unavailable…" and keeps the draft. Tests: `in-process TUI sendInput
  rejects queue delivery without touching the runtime` (cli.unit),
  `queue_unavailable surfaces a status and restores the draft, never a queue
  row` (tui-pi submit).
- **P003-F4** — fixed `f53126ce` (+refactor `ef948dc2` to stay under the
  800-line gate): single-line stderr diagnostic per replay/list failure,
  startup resilient. Test: `workflow seed failures surface a stderr diagnostic
  and keep the TUI alive`.
- **P003-F6** — no-fix per review direction (documented tradeoffs).
- **P002-F5** — no-fix per review direction (respects the internals contract;
  React-edge removal is optional future work).
- **P005-F1** — fixed `ff7bf885` (test-only; production wiring was present):
  `TUI submit prompt handler forwards an unresolvable slash input to the app
  verbatim` (cli.unit) — verified to fail when the flag is dropped.
- **P005-F2** — fixed (docs) `d273d6ed`: FORK.md P005 coverage cell now states
  the real coverage incl. the new TUI-lane pin; remaining gap (attach
  unresolved-slash with attachments over a real socket) named.
- **REM-F1** — no-fix per review direction (fork always ships the pair; noted
  for build-breakage triage).
- **REM-F3** — fixed `fc7cde07` (+doc `9e91afdc`): injected-`Logger` debug
  diagnostic (`exec.shell_init_snapshot_failed`) on snapshot-creation failure;
  login-shell fallback unchanged; wired at all three construction sites.
  Tests: `diagnoses failed snapshot creation via the injected logger while
  keeping the fallback` (shell-init-snapshot), `diagnoses shell init snapshot
  failure and falls back to a login shell` (exec).
- **REM-F4** — no-fix per review direction (informational; the cache lifetime
  is the patch's point).
- **INV-1** — fixed (docs) `d273d6ed`: FORK.md inventory refreshed — P003 row
  gains the `!` shell escape with corrected HEAD semantics (deterministic
  non-interactive `/bin/bash -c`, superseding the interactive-shell variant),
  plus a "Later carried behavior" appendix covering all twelve uncited areas
  with SHAs.

### A6 resolution (P003-F3 trace, 2026-10-26)

Traced end-to-end and re-verified in the main session by reading each cited
line: the in-process handler strips `delivery`; input-facade defaults to
`"auto"` (`bootstrap/src/app/input-facade.ts:197`); the busy steerable branch
admits it via `steerTurn` with no delivery field
(`core/src/runtime/methods/prompt-admission.ts:52-84`); the item lands on the
core queue lane (`pendingInputDelivery` undefined → "queue",
`core/src/runtime/methods/steering.ts:472-475`) which inline drain never
consumes (guide lane only, `:1199-1207` comment "普通 queue 只能由 bootstrap
在 session-ready + goal gate 后提升"); the only promoter (`sendQueuedNow`
auto-drain) is constructed solely by the v4 bridge
(`bootstrap/src/zcode-protocol-v4/`), never in-process. At settle the UI
clears the queue area and the input is silently lost — the review's claim
holds, mechanism now pinned. Explicit reject implemented (above).

### Assumption outcomes after the fix pass

- A1/A2 (scope) — untouched; the fix pass targeted the same base..HEAD set.
- A3 (subagent evidence) — superseded for fixes: the verifier re-ran every
  cited suite itself on each branch and on final main (counts above).
- A4 (P001-F1 frequency inferred) — mechanism now pinned by a regression test
  through the real execution/key-cache path; live-gateway frequency still
  unobserved, by design (no model calls in this pass).
- A5 (P003-F2 crash not reproduced live) — unchanged; unit tests pin the
  invariant, live narrow-terminal repro remains a labeled gap.
- A6 — resolved, see above.
