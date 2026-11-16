# piz fork maintenance

## Identity and direction

- **Mode:** patch-carrying fork of [ZCode](https://github.com/zai-org/ZCode).
- **Purpose:** use ZCode's extra GLM Coding Plan usage allowance from a CLI,
  without having to use the Electron app or pay the memory cost of a separate
  heavy core for every CLI invocation/session. The operator prefers CLIs; the
  thin pi frontend and shared headless core are the means, not the reason.
- **Allowance context:** the operator reports that official binaries provide the
  extra usage. The supplied [announcement screenshot](docs/fork/evidence/zcode-150-percent-announcement.png)
  states: “ZCode users will continue to enjoy a 150% usage allowance on GLM Coding
  Plan.” This records the product motivation and announcement, not a fresh
  verification of our build's eligibility or actual account metering.
- **Maintainer / decisions:** bermudi (personal tool; no public support SLA).
- **Focus:** piz. The standalone zcode-allowance build is parked pending a memory
  redesign. Preserve it for reference; do not make it our integration target.
  Request signing is mandatory for the intended extra-usage path. It is already
  inherited by piz and is not retired by parking the standalone build.
- **Why a fork:** the current implementation crosses frontend, server startup,
  protocol and build boundaries; a wrapper alone does not contain these changes.
  Prefer upstream extension points and retire local patches where possible.
- **Lineage:** originally based on v3.15.1 (`aac4755666d09fdcd70272fcf063c077a639015f`);
  current fully integrated upstream base is recorded in [`UPSTREAM`](UPSTREAM).
- **Issues:** bring piz-specific failures to bermudi; no public fork tracker or
  hosting repository is configured. Do not send local-patch bugs to upstream
  without first reproducing on upstream.

## Repository roles

This is the maintained checkout, independent of the reference-library clone.
It starts at `1473554cf6fcbce50f3cff5aa562a6089898959c` from the old
`worktree/rapid-cloud-030e` branch. Existing history is preserved, not rewritten.

| Name | Role |
|---|---|
| `main` | Maintained piz product; no remote tracking branch yet |
| `upstream` / `upstream/main` | Public ZCode source / fetched mainline |
| `archive-source/*` | Imported reference branches from the old local clone |
| `feat/allowance-herdr` | Preserved standalone allowance branch; parked |
| `sync/<date>-<short-sha>` | Future upstream integration candidates |
| `patch/<topic>` | Future isolated product changes |
| `origin` | Configured 2026-11 (observed 2026-11-07, by or before the `c2d393f7` push) as `git@github.com:bermudi/piz.git`; repo transferred to `bermudx/zcode` 2026-11-08, local remote updated same day to `git@github.com:bermudx/zcode.git` (GitHub still redirects the old URL). Fetch and push both enabled; push policy below still applies |

`archive-source` points at the old local clone, not a hosted backup. Its refs
include old `main`, allowance, lucky-field and rapid-cloud tips. They are not
product branches or promises that every behavior will be carried forward.
This checkout has its own Git directory and copied objects, with no alternates
or hard-linked clone storage. It remains shallow: history before the original
boundary is unavailable. Deepen this writable repository when needed, never the
reference-library clone. Existing refs are preserved here; this is not yet an
off-machine backup.

Pushes are guarded locally: `push.default=nothing`, and `upstream`/`archive-source`
have `pushurl=DISABLED`. As of 2026-11-07 `origin` (bermudi/piz.git; renamed to
bermudx/zcode.git 2026-11-08) has push
**enabled** and `origin/main` sits behind local `main` at `c2d393f7` — this
differs from the guard state this file recorded before; pushes still require the
operator's explicit go-ahead.
Do not push to upstream, force-push, rename old branches, or delete old worktrees
as part of documentation maintenance. New carried-change commit subjects use
`fork:`. Merge upstream into candidate branches; do not rewrite existing history.
Repository-local rerere is enabled; review every replayed resolution.

## Compatibility and scope

- Source baseline: the exact SHA in UPSTREAM, not a README version label or an
  upstream desktop release. Track public `main`; available release tags lag it.
- Success requires both the intended extra-usage path and bounded incremental
  memory cost as CLI clients/sessions are added. A working terminal UI, a signed
  request, or a successful ordinary model turn alone does not prove the allowance.
  Signing is a hard product requirement, not an optional optimization. Preserve
  the signed provider-request path through the shared core; a candidate that
  drops or breaks signing cannot ship. Unsigned ordinary-quota operation does
  not satisfy this fork's goal. These are acceptance requirements, not a claim
  that runtime fallback behavior has already been changed. Verify
  actual eligibility/metering with observable service/account evidence when
  available, and label it unverified otherwise.
- One shared core process serves all workspaces, sessions and clients.
  The operator explicitly confirmed this requirement on 2026-11-08; it is not
  one core per workspace, provider or frontend. Workspace identity
  belongs to session routing and isolation inside the core, not to selecting
  a separate core process. Preserve workspace configuration, permission and
  session boundaries while sharing the process.
- Single-core transport/ownership (implemented on
  `fix/edit-from-here-last-message`, source review and isolated live verification
  accepted; not installed): the attach socket
  derives from the data root only (`<dataBaseDir>/.zcode/v2/sockets/core.sock`),
  never from workspace/provider/frontend. On Linux, clients auto-start the
  core as a transient `systemd --user` service
  (`piz-core-<sha256(socketPath)[:16]>`); requires systemd >= 254
  (`--expand-environment=no`). The user service manager owns its
  lifetime, so retiring any client scope (e.g. T3 ACP runtime) cannot kill it.
  Other Unix platforms reuse an already-listening socket but fail explicitly
  (no detached-spawn fallback) when the core is absent; win32 spawn stays
  unsupported. Session workspace refs, adoption/orphan/drain accounting and
  the no-plugins gate are unchanged.
- Client and shared core must be built and installed as a matched pair. No
  cross-version protocol compatibility promise exists yet.
- Preserve schema validation, workspace identity and path distinctions, session
  parentage/ownership, permission boundaries, event ordering and stale-run guards.
- Preserve default-new-session, explicit continue/resume, model catalog and
  attachments, queue/steer behavior, reconnect and actionable failures.
- Shared-core mode must retain the no-plugins entry gate. Do not silently add
  eager MCP children or move the monolith runtime into the thin client.
- Existing design documents describe intent, not proof of current behavior.
  Some contain stale implementation-status and runtime-preferences examples;
  consult current code and regression tests before using them as interface truth.
- No promise to maintain the original desktop/Web product or standalone TUI as
  user-facing fork products. Their shared contracts still require regression
  checks when touched. Unsupported attach ports remain explicitly unavailable.
- See [verification and acceptance](docs/fork/verification.md). Historical memory
  figures in archived notes are not a freshly measured baseline.

## Active patch inventory

Inventory groups describe carried behavior, not every historical commit. Upstream
submission/acceptance status is **unverified**; no fork PR links have been recorded.

| ID | Purpose / touched areas | Provenance and regression evidence (not rerun) | Removal condition |
|---|---|---|---|
| P001 | Extra-usage request path: signing and auth/security error policy in adapters request-security-edition and root shared policy; code presence does not prove allowance eligibility | `86ab5b13`, `df8bc4a7`; adapters `client-request-signing.test.ts`; [design](apps/zcode-cli/docs/design/v2/model/client-request-signing.md) | Only retire the local implementation when a verified replacement preserves mandatory signing and the supported extra-usage request path |
| P002 | Original TUI controls, paste routing, live transcript echo of drained queue inputs (`TurnSteerDrained.drainedInputs` → user rows in the shared reducer, idempotent by messageId with pendingInputId fallback, sensitive-prompt redaction on echo, visibility aligned with both resume authorities — no intent/text-based skip, `/compact` text not re-interpreted as visibility) and extracted frontend interfaces: CLI tui package | `090276d9`, `31a770cc`, `c0abfcb1`, `6ee50f58`, `c0527374` + `f4780a2b` review fixups; the 2026-10-27 merge into main supersedes the earlier id-less echo variant (`a40b6960`); tui keymap/paste/exit tests, `tui-events.test.ts` (drained row, duplicate delivery, pendingInputId fallback, compact intent renders like resume, `/compact`-looking text) | No remaining piz dependency, or upstream equivalent passes relevant regressions; no wholesale deletion without dependency audit |
| P003 | pi frontend: tui-pi, CLI selection/build wiring, architecture registration, clipboard image paste (`ctrl+v`/`alt+v`), `/skill` argument completion, kitty key-release filtering in chord dispatch, constant three-row footer (activity + pwd/branch row + two-zone stats row; 2026-10-27 verbatim pi parity: `↑↓R[W] CH% $cost ctx(auto)` segment gates + ctx threshold coloring + `•` identity separators + provider-prefix rule + provider-balance-style pwd-row quota slot), startup `PiBanner` (logo/version/hints/model scope), `userBg` user message block, `markdown*` terminal theme, transcript rendering polish (borderless volume-balanced markdown tables with fence-aware scanning + narrow-table width guard, `json`-fence pretty-printing for provider tool narration, thought/tool part-row restyle + inter-part rhythm; `TranscriptMarkdown` in tui-pi), `!` shell escape (interactive bash/zsh `$SHELL` `+m -ic` in an isolated session/process group so rc aliases/functions apply, non-bash/zsh, missing or non-executable `$SHELL` falls back to deterministic non-interactive `/bin/bash -c`; `!!` opt-out; output keeps the tail at 64k chars / 2000 lines and spills the full output to `<tmpdir>/piz-shell-<hex>.log` (0600) with a `[Output truncated. Full output: …]` notice in block, transcript row, status line and collapsed display — resolution history: interactive `80729ec8`/`f5241576` → deterministic `8888d7e9` (pi port) → interactive again `07e8b06a` on the hardened runner; `8888d7e9`'s head truncation superseded by `8fbbfba5`) | `570ebd20` through `7e859585` and later skills/image-paste commits plus `b0468c92`, `76335676`, `4422deb7`, `058685af`, `4163f747`, `63f379a2`, `f4780a2b`, `!` port `80729ec8`→`8888d7e9`→`8fbbfba5`, interactive resolution `4d0b7a5a`/`07e8b06a`; tui-pi tests incl. projection, composer, history (incl. kitty press/repeat/release), panels, terminal-drain, mentions, shell, wrapping, image-paste, banner, footer and transcript-markdown; [design](apps/zcode-cli/docs/design/v2/tui-pi-frontend.md) | Upstream frontend meets our interaction and resource requirements |
| P004 | Shared core and thin attach client: bootstrap socket listener, CLI attach/spawn/build, root shared protocol; attach `/skill` list + suggestions via `skills/referenceCatalog` additive fields; attach custom-command catalog via new `commands/referenceCatalog` (composer `/` panel + `/help`; expansion stays in the core input facade, local `listAttachCustomCommands` scan removed); coding-plan quota read via new `usage/codingPlanQuota` (account-level snapshot fetched core-side from the Registry's coding-plan provider — API-key access from provider config **or** zhipu-account individual-coding-plan entitlement via the account credential port `providerRuntimeHeadersPort` (2026-10-28; same owner as model-request auth, manual plan key or OAuth-derived project token), feeding the tui-pi footer quota cluster; readUsageQuota absent → cluster silent; tui-pi failure diagnostics deduped per message + 60s idle-tick backoff so permanent no-credential states log exactly once per episode); herdr pane lifecycle reporter for `zcode-attach` (bounded retry + 30s heartbeat re-assert + always-on throttled stderr diagnostics, since a single lost `working` report pins herdr idle/done for a whole turn) plus `ZCODE_ATTACH_CORE` spawn marker suppressing the shared core's zcode hook; attach bare `/resume` opens the commandCenter session picker (workspace-scoped `session/list`, full schema validation, current session excluded, updatedAt desc — no latest-session guessing) and `/resume <id|unique-prefix>` shares the entry resolver with workspace on `session/resume`; startup + `/new` `session/create` uses `persistence:"deferred"` so unsent drafts stay out of `session/list` until the first accepted send promotes them | `32dc8799` through later attach fixes including `61abbc11`, plus `887668fb`..`d68db6ab` and the 2026-10-24 reporter-durability commit; CLI attach tests, bootstrap socket-listener + skill-reference-catalog, root shared attach contract, `attach-herdr-reporter` (incl. retry/argv-reuse/heartbeat regressions) + `app-server-spawn` marker tests; `patch/resume-session-picker` attach-adapter picker/error regressions + deferred create assertions, bootstrap `session-selection-protocol` deferred→immediate admission; [design](apps/zcode-cli/docs/design/v2/tui-attach-shared-core.md) | Upstream shared-core mode covers no-plugin isolation, matched builds, sessions, reconnect and low per-client cost |
| P005 | Interactive unresolved slash input routed as a normal prompt | piz `2f55f457`; allowance has a different patch `c6b36ad5`; coverage (audited 2026-10-26): verbatim forward incl. attachments + default no-opt-in "Unknown command" + headless e2e `--prompt /nope` + attach e2e via real command center asserting exactly one `session/send` + custom-command expansion precedence + recognized builtins staying local (cli.unit / attach-adapter); TUI-lane wiring pinned by `ff7bf885` (2026-10-26); still open: attach unresolved-slash **with attachments** over a real socket | Upstream equivalent verified on piz, including recognized slash commands |
| P006 | `piz acp`: stable ACP v1 stdio adapter inside the thin client (`zcode-attach.cjs`), one lazy core lane per `cwd`; `session/new`/`session/resume`/`session/close`, `session/prompt`/`session/cancel`/`session/update`, `session/request_permission` answering with core's `option.response`, form elicitation for `AskUserQuestion` (string enum; multi-select as typed text) and explicit approve/reject for `ExitPlanMode`, plan/build modes, model config option plus the GLM compact cap, client MCP ignored and logged, auth outside ACP | `patch/acp-frontend`; CLI `tsc --noEmit`; `tests/acp-project.test.ts`, `tests/acp-agent.test.ts`, replaced `routes acp to the ACP stdio adapter`; built-binary stdio handshake (initialize) with pure JSON stdout; T3 0.1.6 acceptance (cancel vs rollback order, live-turn resume, form rendering, full GLM turn, RSS, signing) **not run** | Retire when ACP v1 is superseded or T3 drops the local ACP command |

**Session-health invariants (merged `9abdd086`, promoted in the `e37ed9d9` pair):**
draft-aware subagent reads preserve deferred persistence and real missing-parent
errors; trusted no-plugin command discovery must avoid bundled-plugin seed/hash
work without freezing workspace commands; numeric usage counters need an exact,
number-only redaction exception. Regression handles are
`session-lifecycle-logging`, the pre-first-prompt cases in `session-persistence`,
`logging`, `plugins`, `command-reference-catalog`, and the no-plugin snapshot
case in `zcode-protocol`. Retire these fixes when upstream covers those same
invariants; do not duplicate the upstream model-selection deferral fix.
See the [2026-11-03 verification record](docs/fork/reports/2026-11-03-session-health.md)
for the source checks and artifact limitations; it is not an installation record.

**Pending audit, not a carried-patch claim:** allowance-only `da309372` and
`bac3682c` provide queue/transcript behavior absent from piz's ancestry; compare
behavior before deciding whether to port. Do not blindly cherry-pick these or
the different slash-input fix. lucky-field is contained in allowance, not in piz.

**Later carried behavior (2026-10-26 inventory audit):** the rows above group
behavior by product area and predate several carried changes; these are the
verified in-main areas the 2026-10-26 review found missing from the P-rows.
Count these interfaces when budgeting syncs.

| Behavior | Provenance | Maps to |
|---|---|---|
| Shell aliases loaded into exec startup snapshots + eval-wrap for sourced commands | `3b2f3eb4` | adapters exec (bash-startup-script, shell-init-snapshot) |
| Session plan overlay projected into `settings.mode.current` | `508d1c77` | protocol/bootstrap |
| tui-pi `!` shell escape (interactive bash/zsh `$SHELL` `+m -ic` so rc aliases apply — resolution restored by `patch/shell-escape-aliases`, other/missing `$SHELL` falls back to deterministic `/bin/bash -c`; tree kill, `!!` opt-out; tail truncation + `<tmpdir>/piz-shell-*.log` spill, pi bash-executor parity) | `80729ec8`, `f5241576` → `8888d7e9` → `8fbbfba5` → `4d0b7a5a`, `07e8b06a` | P003 |
| ExitPlanMode plan rendered as readable markdown | `4f6d847b` | tui |
| Detach/adopt lifecycle: detach keeps sessions alive, adopt-on-resume, bounded orphan window, busy-fact reaper | `f95b9b29`, `3d6c2785`, `04a0c046`, `b9e4b0b8` | P004 (attach-core lifecycle) |
| Busy-quit choice (detach vs stop & quit) + ctrl-d decision fold | `68b5043b`, `87f433f8` | tui / tui-pi |
| Pi-style usage cluster + live subagent surface | `36076bf8`+ | tui-pi |
| Keymap additions (ctrl+x copy last reply, ctrl+n /new, ctrl+t thinking, ctrl+o info) | `0b7c1301` | tui-pi |
| Steer/queue parity (busy Enter steers, Ctrl+Q queues, Alt+Up restores) + drained inputs rendered as transcript user rows (2026-10-27 merge replaced the tui reducer with the transcript-polish variant: stable ids, redaction, resume-aligned visibility — see P002) | `fbe7dbee`, `a40b6960` (merges `4855b2b4`, `086f08c7`), superseded reducer from `c0527374`+`f4780a2b` | spans shared protocol schema, bootstrap server-ops, attach client, tui, tui-pi |
| App-server ready budget: 60s window starting at spawn completion | `6537f416` | P004 (app-server-spawn) |
| Attach resume: unique id-prefix expansion + surfaced resume failures | `9b46915f` | P004 (attach entry) |
| ACP reasoning effort: `session/set_config_option` `thought_level` (category `thought_level`) with choices from the current model's `reasoning.levels` (not the attach handle's unioned `thoughtLevel.available`), validated at the boundary, set through core `session/setThoughtLevel`; current falls back to the first level, never `""` | `99e5646d`, `366d2504` (merged `a2e129f4`; [report](docs/fork/reports/2026-11-07-acp-effort-discovery.md)) | P004 (ACP frontend) |
| ACP local commands `/goal` + `/target` and `/dwf`: intercepted in `session/prompt` before P005 forwarding, routed through the same core ops the TUI command center uses (`session/goal` with an adapter-generated inputId, `v4/conversation/workflowRuns`, `session/cancelBackgroundTask` with the strict `taskId` key, v4 `resumeWorkflowRun` with the shared rejection prefix); response rendered as one `agent_message_chunk`, goal set/replace/resume keeps the ACP prompt open until the first continuation turn settles (settlement sink armed before the op is sent — a fast-failing turn cannot strand the prompt; a no-turn-start backstop bounds the wait when the queued continuation never starts a turn), `session/cancel` returns `cancelled` and still reaches the core stop during later goal-loop turns (fallback when no in-flight entry; dwf commands never issue a stop); `available_commands_update` after session/new+resume advertises exactly the routed commands; `AttachSessionHandle` gained `goalCommand` + `listDynamicWorkflowRuns`/`resumeWorkflowRun` (wire body in `attach-goal-dwf-ops.ts`), which also unblocks `/dwf` on the attach TUI lane (previously "not available in this client"); dwf engine gate unchanged (core fail-closed) | `patch/acp-goal-dwf` | P006 (ACP frontend) + P004 attach surface |
| `--model` startup model selection (attach entry + banner); since `a68e1a1d` bare names are case-insensitive, prefer the session's current provider on ambiguity, and take a quoted `$effort` suffix validated against catalog levels (`--model glm-5.3`, `--model 'glm-5.3$high'`); other ambiguity still fails pre-TUI | `3db70344`, `7a31c5e5` (merged `a68e1a1d`, piz review `b95b575f`; [report](docs/fork/reports/2026-11-07-short-model-aliases.md)) | P004 (attach entry) |
| Per-session auto-compact window cap: additive `compactContextWindow` on `session/create`/`session/resume` + `session/setCompactContextWindow`, core `compact.contextWindowCap` = min(cap, model window), compaction-only (no provider limits, no protocol/snapshot denominators — 2026-11-02 revision: the footer ctx gauge clamps client-side via the same predicate, `patch/footer-compact-gauge`); cap constants/predicates live in `@zcode/shared` `compact-context-window.ts` (single source for wire + display); piz attach sets 262_000 for GLM (`/^glm-/i`) and follows model switches/resume — spec [compact/plan.md M2.1](apps/zcode-cli/docs/design/v2/compact/plan.md); v4 `createSession` deliberately untouched | `patch/compact-context-window`, merged `158a31d2`; display clamp `25bf5e32`/`9fd03361` (post-rebase SHAs) | P004 (shared protocol + attach client) + core compact |
| Attach exit-resume hint: after normal TUI exit (exit 0 + bound session id) the attach client prints `Resume this session with:` + `piz|zcode attach --resume <id>` to stdout once the terminal is restored; id follows /new /resume /fork via `getMainSessionId`; empty sessions print too (predictability over content-gating); signal exits and non-0 exits silent; opentui-frontend lane deviation recorded in spec | `patch/exit-resume-hint` `40e25506` + review fix-pass `c47d1e63`; suite-stability rides along in `6e16e0ce`; spec [tui-attach-shared-core.md](apps/zcode-cli/docs/design/v2/tui-attach-shared-core.md); 4 regressions `tests/attach-exit-resume-hint.test.ts` | P004 (attach client) |
| Provider auth-failure log payload: 401/403 model failures log `providerErrorType/Message/Code` + cause-chain-extracted (TerminalStreamChunkError), credential-shape-redacted, 1500-char-capped `providerResponseBody`, plus the previously dropped `errorCode/errorPhase/exceptionType/providerRequestId`; log-only — status events, session events, classification, retry policy unchanged | `patch/auth-failure-diagnostics` `3cf8e1ff` (builder: second agent, operator-authorized; 4 regressions `runner-status-fanout.test.ts`); spec [stream-error-retry.md](apps/zcode-cli/docs/design/v2/model/stream-error-retry.md) | P001 (adapters model runner diagnostics) |

At import, piz differed from the upstream base by 37 commits / 155 files /
15,878 insertions / 443 deletions, before these maintenance documents. This is
substantial core divergence; count touched interfaces and upstream churn, not
just commits, when budgeting syncs.

## Maintenance and security

- **Owner:** bermudi; agents investigate and prepare candidates, operator owns
  release and compatibility decisions. No unattended updater has been enabled.
- **Cadence:** proposed weekly public-main review, plus review before planned
  development; recurring scheduling is not configured or approved here.
- **Security:** review upstream advisories, mainline security fixes and dependency
  advisories for applicability to our changed runtime. Urgent applicable fixes
  take priority over ordinary syncs. No guaranteed response time or public SLA.
- **Supported line:** local piz product only; no historical backport commitment.
- **Sync procedure:** [upstream integration plan](docs/fork/upstream-sync.md).
- **Effort limit:** if a sync repeatedly conflicts at core seams, stop and report
  the seam and options rather than layering workarounds. No fixed time budget
  has been agreed.
- **Exit:** retire patches when verified upstream replacements exist. Reconsider
  scope if resource goals or maintainability cannot be met. Changing to an
  independent product, archiving or publishing remains an operator decision.

## Builds and installation

| Command | Installed source |
|---|---|
| `~/.local/bin/piz` | this checkout's `packages/cli/dist-runtime/` matched pair (written only by `scripts/promote-piz.sh`, which refuses to run from anything but a clean `main`); core pinned to the same dir's `zcode.cjs` via `ZCODE_SERVER_BIN`. Currently the `a971df4e` pair (ACP effort sync on top of `a2e129f4` ACP per-model reasoning effort), promoted 2026-11-07 from clean main after the recorded verification — see [verification](docs/fork/verification.md) |
| `~/.local/bin/zcode` | reference clone's standalone allowance `zcode.cjs` (unchanged; `PATH` `zcode` is not piz) |

The external `zcode-allowance-update` script manages the parked standalone tree;
**do not use it to update piz**.

**Promotion policy (2026-10-24):** promote only from a clean `main`, never
from patch branches — `promote-piz.sh` refuses otherwise. A branch-only
promotion regresses the next main-based promotion (this happened once with
the resume fix and is the reason the gate is mechanical).

**Promotion gate (2026-11-06):** test scope follows the change. Frontend-only and
docs-only promotions take the selected tier; everything else, plus sync, keeps full
coverage. A new test failure blocks promotion unless baseline evidence or an
explicit operator waiver is recorded. See
[Promotion gate](docs/fork/verification.md#promotion-gate).

Use pinned tools from `mise.toml`; see [build/check commands](docs/fork/verification.md).
The full core build and `build:attach` thin client must be paired. Next install
work must stage a versioned pair outside development worktrees, attach full Git
SHA/build identity, exercise it, and retain the previous pair for rollback.
Wrapper migration and core restart are separate from establishing this checkout.
A running core does not change when its bundle is rebuilt.

Upstream package/version identities remain unchanged. They do not identify our
build; a SemVer `+piz` suffix would not increase precedence. No fork package
versioning, updater, publishing, signing or public release process is configured.
Inherited release commands are not authorized release procedures. Preserve the
Apache-2.0 license and upstream attribution. Do not publish under upstream's
identity or enable inherited upload/update paths without a separate audit.

## Maintenance log

### 2026-10-22 — correct the reason for the fork

- Operator clarified the actual goal: obtain the official binaries' extra GLM
  Coding Plan usage through a preferred CLI, without Electron or a heavy core
  per invocation/session. Low-memory shared-core architecture serves that goal.
- Preserved the supplied 150% announcement screenshot and distinguished that
  announcement from unverified end-to-end allowance/metering for our build.
- Updated purpose, README notices, agent direction and verification requirements.
  Signing is explicitly mandatory: no sync may drop it or substitute unsigned
  ordinary-quota operation. Local code may retire only behind a verified signed
  replacement. Documentation only; no eligibility test, model call or runtime change.

### 2026-10-22 — establish maintained piz checkout; upstream check is a no-op

- Operator chose piz as future focus; standalone allowance needs a memory rethink.
- Public `main` / HEAD: `3c5b227649371507ddc4eb46ac5133afe6db1cab`, already fully
  integrated in piz. No incoming mainline commits; UPSTREAM is not advanced.
- GitHub releases endpoint returned v3.14.3; advertised tags were v3.14.3 and
  v3.15.1. Other branch `feat/ui-plugin` was observed, not reviewed or imported.
- Created independent local checkout from the old repo, checked out piz tip on
  new `main`, preserved reference branches/tags, fetched public upstream/main
  only into this new writable repo, and configured push guards.
- Added maintenance records and fork README notices. Preserved old piz agent
  notes and the original checkout's AGENTS snapshot including uncommitted notes under
  [docs/fork/archive](docs/fork/archive). Original dirty work remains untouched.
- No merge conflicts or patch retirement: no source integration performed.
- Checks: remote refs/API, base ancestry, clone/ref independence, document links,
  whitespace and baseline content; application checks not run. The inherited
  freshness script skips its checks without origin/main and is not a valid
  freshness gate for this remote mapping.
- Not built, installed, pushed or released. Follow-up: allowance-only behavior
  audit, dependency/bootstrap verification, tested build and installation plan.

### 2026-10-29 — attach footer session seeds (patch/attach-footer-seed)

- Restored the pi-style stats cluster on the attach lane (`↑in ↓out Rcache
  CH% $cost ctx/window`): the cluster counted live events only, so any
  attached/resumed session showed an empty left zone until the next turn.
- Protocol: additive `runtime.usageTotals` on the session snapshot
  (`packages/shared/zcode-protocol-legacy-types`), folded server-side from
  the session eventStore via new contracts `summarizeSessionUsageTotals`
  (same event set + field semantics as the TUI accumulator: `model_complete`
  + failed `model_request_failed` with usage; runtime memory-ledger scope).
- Client: `sessionSnapshotSeed` (new `attach-projection.ts`) projects
  `runtime.contextUsage`/`projection` + `usageTotals` into `initialResult`
  and `/new` `/resume` `/fork` swap results; `applyResult` now applies
  `resetSessionProjection` before merging seeds (previously erased them);
  `UsageTotalsAccumulator.seed()` folds totals + latest cache-hit rate;
  `applyModelCompleteEvent` now honors `payload.contextWindow`; stats line
  falls back to the current model's catalog `contextWindow` (pi parity,
  provider-matched).
- Fixed a quiet bug: `subscribeSessionEvents` bound the TUI's durable sink
  to the handle current at subscription time; `/new` `/resume` `/fork`
  swapped `current` but the sink stayed on the old handle. Sinks now
  migrate via `durableSinks` + `runtime.onSessionBound` (monolith
  `sessionEventRelay` semantics).
- Design docs updated: tui-pi-frontend.md (fold provenance, ctx-window
  chain), tui-attach-shared-core.md (seed path, sink migration).

### 2026-10-29 — restore two-row footer (patch/attach-footer-seed)

- Operator direction is two rows; the 3324315f-era three-row layout (activity
  + pwd + stats) is superseded by the restored double-row form: activity row
  (spinner + status + right-aligned quota cluster) + meta row (`~/cwd
  (branch)` + `↑↓ R CH $ ctx` left, identity right).
- Quota moved to the activity row's right edge via `appendFooterRightZone`
  (pi provider-balance alignment; drops the quota text rather than
  truncating status/spinner when <2 columns remain). `formatPwdRow` removed;
  `formatMetaLine` composes the meta row from `formatPwdLine` + the shared
  stats-left segments; `formatStatsLine` remains as the no-cwd form.

### 2026-10-29 — promotion of bf6d3a16 (attach footer seeds + two-row layout)

- Merge `bf6d3a16` carried `patch/attach-footer-seed` to `main` unchanged
  (merge-commit only, no conflict edits). Build:
  `turbo run build --filter=@zcode/cli...` from `apps/zcode-cli` — 12/12,
  cache misses on `tui`/`tui-pi`/`cli`.
- Freshness spot-check: `usageTotals`/`sessionSnapshotSeed`/
  `formatMetaLine`/`summarizeSessionUsageTotals` present in
  `cli/dist/zcode-attach.cjs`, `tui-pi/dist/index.js`,
  `tui/dist/index.js`, and in the frozen `dist-runtime` copies.
- `sh apps/zcode-cli/scripts/promote-piz.sh` from clean `main`.
- Live-core note: `runtime.usageTotals` is folded core-side; a core still
  running the previous build simply omits the additive field (clients
  degrade gracefully to live-only counting). Client-side fixes (two-row
  footer, sink migration, ctx-window plumbing) take effect on next `piz`
  launch; the session seed requires a core restart to be observable.

### 2026-11-01 — prune off-product inherited agent skills

- Removed upstream-inherited skills outside fork scope:
  `.agents/skills/{agent-browser,ai-elements,dogfood,e2e-case-lifecycle,electron}`
  and `apps/zcode-cli/.agents/skills/vercel-react-view-transitions`.
  agent-browser's worktree deletion predates this entry (uncommitted operator
  work); the rest target Electron/desktop-E2E/web-chat-UI workflows the fork
  does not ship. Kept: architecture-governance, session-management, dep-refs,
  feature-boundary-planner, react-best-practices (×2), session/attachment
  fixtures, opentui — all load-bearing per working rules or for tui-pi.
- Updated `third-party/copied-components.json` to match (ai-elements entry
  now covers only `packages/ui` components; agent-browser skills entry and
  its license snapshot removed) and dropped the stale
  `vercel-react-view-transitions` entry in `apps/zcode-cli/skills-lock.json`.
  `THIRD-PARTY-NOTICES.md` is generated — it refreshes on the next notices
  run, which also remains gated on other pre-existing drift (e.g.
  `third-party/README.md` prose still lists the deleted dirs).
- `feature-boundary-planner` still names `e2e-case-lifecycle` as a handoff
  target; the reference is now dangling (kept file untouched — it is
  upstream-owned content, and a dead pointer is cheaper than a permanent
  content-conflict surface).
- Added the [fork-deleted paths](docs/fork/upstream-sync.md#fork-deleted-paths)
  policy: modify/delete conflicts under those prefixes resolve to
  "stay deleted" mechanically during sync merges.

### 2026-11-01 — attach input submission migrated to v4 `v4/command`

- piz's send path no longer touches `session/send`/`session/stop` (both marked
  `@deprecated` upstream; host consumers already removed): idle submit and
  Ctrl+Q replay go through `v4/command` `sendText`, busy Enter through
  `requestedDelivery:"guide"`, stop (abort + stop&quit) through `v4/command`
  `stop`, attachments through `v4/attachment/begin→chunk→commit` refs with
  disk-path direct refs. Client queue ownership (Ctrl+Q local FIFO) unchanged;
  signing untouched (it lives core-side).
- New cli attach modules `attach-v4-command/attachments/input.ts`; legacy
  inline attachment mapper deleted. Envelope/ACK/upload schemas shared with
  `@zcode/shared/zcode-protocol-v4` (no private wire shapes). Design notes:
  [tui-attach-shared-core.md](apps/zcode-cli/docs/design/v2/tui-attach-shared-core.md)
  「输入提交迁移到 v4」.
- Verification (worktree, dev build only — installed `piz` pair NOT touched):
  `@zcode/cli` typecheck + oxlint clean; `architecture:check --changed` 0 new;
  attach-adapter suite 43/46 pass — 3 failures spawn a real app-server binary
  and fail identically on the unmodified baseline (10 more in the entry suites,
  same class); no live-core e2e was run. Remaining legacy protocol surface
  piz still needs is listed in the design doc section above.
- 2026-11-02 core fix (first live e2e): every attach submit failed with a
  `session_input → session(id)` FK error. Legacy `session/create` marks the
  record `persistence:"immediate"` while the runtime only writes the session
  row on first input; v4 admission trusted the record and wrote the ledger
  first. Admission now also runs first-persistence when
  `runtime.isSessionPersisted?.() === false` (absent method = no trigger).
  Spec bullet in 「输入提交迁移到 v4」 不变量; regression
  `bootstrap/tests/v4-legacy-create-admission.test.ts` (fails without the fix).
  Live e2e (dev build on sync+v4 combo, scratch workspace, GLM-5.3): idle
  submit, guide steer, Ctrl+Q queue/replay, double-Esc stop + new turn,
  clipboard image upload, exit resume hint + `--resume` replay all pass.
  Not verified live: signing/allowance on the v4 path. Pre-existing, seen on
  installed piz too: user abort is logged `model.network.failed` and the UI
  shows "Model request failed".
### 2026-11-01 — promotion of 158a31d2 (per-session compactContextWindow cap)

- Merge `158a31d2` carried `patch/compact-context-window` to `main` unchanged
  (merge-commit only, no conflict edits; spec compact/plan.md M2.1 had landed
  on the branch first). Build:
  `turbo run build --filter=@zcode/cli...` from `apps/zcode-cli` — 12/12,
  all cache hits (identical tree built on the branch); `build:attach` rerun.
- Freshness spot-check: `compactContextWindow`/`setCompactContextWindow`/
  `contextWindowCap` present in `cli/dist/zcode.cjs`; `compactContextWindow`,
  `setCompactContextWindow`, `GLM_COMPACT_CONTEXT_WINDOW = 262e3` (esbuild's
  spelling of 262_000) in `cli/dist/zcode-attach.cjs` and in the frozen
  `dist-runtime` copies.
- `sh apps/zcode-cli/scripts/promote-piz.sh` from clean `main`.
- Live-core note: `session/setCompactContextWindow` is a new additive op;
  a core still running the previous build answers `-32601` and clients treat
  that as silent no-op (covered by the mid-switch test). The cap takes effect
  on next `piz` launch against a restarted core.

### 2026-11-02 — `!` escape output spill (patch/shell-output-spill)

- Operator asked for pi's oversized-output behavior on `!cmd`; investigation
  showed no core patch is needed — the client runs the command, owns the
  filesystem and composes the `<shell-output>` block, so the spill is
  entirely tui-pi-side (`8888d7e9`'s "no append-local-message verb" blocker
  only ever applied to history placement, not to referencing a file path in
  the block text).
- Semantics ported from pi-mono bash-executor: tail truncation at 64k
  chars / 2000 lines (oversize sole line keeps its last 64k chars), full
  output streamed to `<tmpdir>/piz-shell-<hex>.log` (0600, `wx`, lazy open
  + backfill at the 64k threshold, finish-time fallback for lines-only
  overflow, 128k-char rolling buffer), `fullOutputPath` delivered only
  after the stream drains, failed spill degrades to a pathless notice +
  one stderr diagnostic. `truncated=true full_output="…"` block attributes
  + `[Output truncated. Full output: …]` in block, transcript row, status
  line and collapsed display notice; `!!` still excluded from context but
  spills for the operator. Divergence from pi kept at first: spill file held
  raw output (pi writes sanitized text core-side) — superseded by the review
  fix below, which sanitizes the whole stream like pi.
- Spec first (`b8868466` also corrected the design doc's stale
  interactive-`-ic` section), then implementation `8fbbfba5`, then the
  2026-11-02 subagent review fix: sanitize per chunk BEFORE accounting,
  rolling buffer and spill writes (one sanitized stream, exact pi
  semantics; the raw-file divergence is dropped — mixing a sanitized
  backfill with raw tail writes would corrupt the file), and deliver
  `fullOutputPath` whenever a spill exists so threshold-edge untruncated
  runs leave no unreferenced 0600 file. tui-pi: 259/259 tests (9 spill
  regressions incl. end-to-end block delivery, char/line boundary
  off-by-one pins, control-char-heavy output), typecheck + oxlint clean;
  `architecture:check --changed` green after recording pre-existing
  `status-line.test.ts` (812 lines per the tool's counting, since main
  `c7bb87c1`; invisible to main's empty-diff gate, surfaced by this
  branch's reverse-dependency closure) in `.architecture-baseline.json`.
  Not promoted; awaits merge + verification matrix.

### 2026-11-02 — `!` escape interactive `$SHELL` resolution (patch/shell-escape-aliases)

- Operator: `!cmd` ignored rc aliases — want `!gs` instead of `!git status`.
  Stacked on `patch/shell-escape-aliases` (branched from
  `patch/shell-output-spill`, same file).
- Re-flip of a recorded decision, with cause: `8888d7e9` replaced the
  `80729ec8`/`f5241576` interactive `$SHELL -ic` resolution as collateral
  of the pi-mono execution port (tree kill, idle-pipe grace, sanitize,
  `!!`) — not as a rejection of alias support. This restores the
  interactive resolution on top of the hardened runner: executable
  bash/zsh `$SHELL` → `+m -ic` (argv transport); other/missing
  `$SHELL` → the pi chain unchanged; Windows never interactive. The
  core-side shell-init-snapshot route (`3b2f3eb4`, model bash tool) was
  considered and rejected for the client: the thin client must not own
  core storage/snapshot lifecycle, and `-ic` is always-current where a
  snapshot can go stale.
- Startup noise: `zsh +m -ic` under setsid is silent (measured ~50ms with
  the full rc; operator's `gs` alias resolves); bash emits two known
  job-control/tty-pgrp stderr lines — stripped from the captured tail at
  finish, spill file keeps them (stays the sanitized full stream).
- Spec first (`4d0b7a5a`), then implementation + regressions (`07e8b06a`):
  resolution precedence (incl. `env:{}` pins against host `SHELL` leak,
  fish never interactive), real rc-alias runs for zsh+bash with seeded
  temp-HOME rc (+ZDOTDIR), noise strip under a real detached spawn,
  fallback keeps no-rc semantics. UI harness env omits SHELL so panel
  tests stay deterministic. tui-pi: 261/261 tests, typecheck + oxlint
  clean; `architecture:check --changed` 0 new violations. Not promoted;
  awaits merge + verification matrix.

### 2026-11-02 — footer ctx gauge follows the compact cap (patch/footer-compact-gauge)

- Operator: footer read `0.0%/1.0M` on GLM sessions whose auto-compact
  fires at ~228K — the gauge's 100% mark sat at ~4.4x the trigger; worse
  than useless, misleading. M2.1 had deliberately scoped the footer
  denominator out; operator overruled, spec amended (decision recorded in
  M2.1 and tui-pi-frontend.md). Stacked on `patch/shell-escape-aliases`.
- Design: display-side clamp only — protocol/core window semantics
  untouched. The GLM cap predicate moved to `@zcode/shared`
  (`compact-context-window.ts`; `attach-compact-cap.ts` re-exports) so the
  wire value attach sends and the footer denominator come from one source
  and cannot drift. `effectiveContextUsage()` (tui-pi status-line):
  payload window → catalog fallback → `min(cap, window)`, cap alone when
  no window is known (`?/262k`); `(auto)` renders while a cap is active
  (was a never-set dead flag); pi threshold coloring on the clamped
  percent puts the trigger (~87%) in the warning zone. SessionInfoPanel
  ctx row uses the same finalizer.
- architecture-policy.yaml: unmanaged-new-file exception for the shared
  append (shortcutCommands.ts precedent); status-line.test.ts stays at its
  accepted baseline — new tests live in footer.test.ts (800-line cap).
- Verification: tui-pi 264/264 + typecheck + oxlint; cli
  attach-model-option/attach-adapter/attach-client 74/74; shared module
  oxlint clean (4 pre-existing warnings elsewhere in the package);
  `architecture:check --changed` 0 new violations. Harness fragility
  found while verifying: running cli attach tests from inside a
  zcode-family agent session leaks ambient `ZCODE_SERVER_BIN` /
  `ZCODE_WORKSPACE_IDENTITY` env into the spawned-core path — the client
  resolves a different socket (identity hash), misses the fake core and
  spawns a doomed core. Pre-existing; tests pass with the vars stripped
  (`env -u ZCODE_SERVER_BIN -u ZCODE_WORKSPACE_IDENTITY …`). Not
  promoted; awaits merge + verification matrix.

### 2026-11-02 — review fix-pass on patch/shell-escape-aliases

Two independent subagent reviews (no blockers). Accepted + fixed:
- 噪声剔除改为**流首限位**（带 shell 名前缀的已知诊断行、至多 2 行）：
  旧的全文行过滤会把用户输出里长得像诊断的行无声吃掉（`!echo 'no job
  control in this shell'` 丢行、无 spill 时彻底丢失），与 spec「启动期
  诊断」承诺相悖。本地化措辞不匹配时漏删属外观问题，反向才是数据丢失。
- 直接调 runShellCommand 的 16 处用例统一 `CHAIN_ENV`（SHELL=""）：此前
  会随跑测试者的真实 rc 走交互分支，greenness 宿主相关。
- 补回归：空串 `$SHELL` 回退（旧变体覆盖、移植时丢失）、诊断长相行存活、
  spill 保留流首噪声、`!!cmd` 交互 alias + 不进上下文；PATH 测试更名
  （继承 PATH，非 profile）。
- Spec 措辞收敛：「rc 全量加载」→ 交互 rc（.zshrc/.bashrc，login rc 不读）；
  P003 行补「non-executable」回退条件。
Accepted as-is（记录在案）：噪声正则仅英文（本地化漏删为外观问题，限位
后不再可能误删）；`$SHELL` 相对路径/basename 子串匹配与旧变体逐字一致。
tui-pi 262/262，typecheck + oxlint 清洁。

### 2026-11-02 — review fix-pass on patch/footer-compact-gauge

Subagent review (no blockers; branch rebased onto the aliases fix-pass,
records SHAs repointed). Accepted + fixed:
- 第三份 spec（tui-attach-shared-core.md 的 GLM 压缩窗口上限节）仍写着
  「此上限不改页脚 ctx 分母」——与本 patch 直接矛盾，按 M2.1 修订口径
  改写（谓词唯一来源 @zcode/shared；页脚/信息面板客户端侧收紧）。
- compact/plan.md 里「attach-compact-cap.ts 唯一来源」的括注改指
  @zcode/shared（原文件是 re-export）。
- 「触发线落在 ~87% warning 区」加限定：已知窗口 ≥ cap 时成立；窗口
  未知 cap-only 分支里 core 对缺失窗口回退 200K 默认，比例更低且仅在
  首个 model_complete 前存在。
- 信息面板 ctx 行 used 未知渲染 `?/262000`（原 `0/262000` 伪造；与页脚
  `?/{win}` 同口径）+ 回归；无窗口 GLM 会话由此 cap-only 分母可见。
- 补 provider 前缀负例：`glm-labs/claude-x` 不 cap（谓词作用于剥前缀后
  bare modelId）；modelId 自身含斜杠的极端边界记录为已知限制。
Accepted as-is：tui-pi 首次值引入 @zcode/shared barrel（打包由 promotion
矩阵的 bundle/no-plugin startup 检查把关）；status-line.test.ts 811 vs
基线 812 的 off-by-one 为既有状态，非本 patch。
tui-pi 265/265，typecheck + oxlint 清洁，`architecture:check --changed`
0 新增违规。

### 2026-11-02 — merges + promotion of f1a0c45e (spill / aliases / footer gauge)

- Operator asked for merge + promotion; explicit permission for the merges
  to `main` (push not requested, none performed). Stack merged `--no-ff` in
  order: `aaec6bcf` (patch/shell-output-spill) → `22036063`
  (patch/shell-escape-aliases) → `f1a0c45e` (patch/footer-compact-gauge);
  the aliases/footer branches carried their review fix-passes rebased onto
  the previous merge. One conflict during the stack (both branches appended
  EOF sections to FORK.md) resolved keeping both sections; a stray `=======`
  marker from that resolution survived into main and is removed by this
  records commit.
- Verification battery on merged main, all green — details in
  [verification](docs/fork/verification.md): architecture 0 violations;
  tui-pi 265/265 + typecheck + oxlint; shared zcodeProtocol 85/85 (temp
  config — root vitest is pre-existing-broken, below); cli attach 74/74
  (env-stripped, below) + typecheck; turbo build 12/12 + `build:attach`;
  freshness greps on `dist` and frozen `dist-runtime`.
- `sh apps/zcode-cli/scripts/promote-piz.sh` from clean `main`.
- Unrelated pre-existing breakage surfaced while verifying, not introduced
  here: root `vitest.config.ts` references deleted
  `packages/zcode-cua/vitest.config.ts` (root vitest cannot run);
  zcode-family agent sessions leak ambient `ZCODE_*` env
  (`ZCODE_SERVER_BIN`, `ZCODE_WORKSPACE_IDENTITY`, …) into cli
  attach's spawned-core tests — pass with the vars stripped via `env -u`.
- Live-core notes: `session/setCompactContextWindow` is additive; a core
  still running the previous build answers `-32601` and the client treats
  it as a silent no-op (unit-tested). Live cores keep the old footer
  denominator + non-interactive `!` resolution until the next `piz` launch
  against a restarted core — do not restart live cores. Not exercised live
  (unverified): a real `!gs` in a piz session, the footer `%/262k (auto)`
  gauge in a live GLM session, auto-compact firing at ~262K; wire and
  display paths are test-verified end-to-end only.

### 2026-11-02 — merges + promotion of 5f36e28b (exit-resume hint + auth-failure diagnostics)

- Operator: "merge and promote", then "include it and promote" for a
  concurrently built `patch/auth-failure-diagnostics`. Both merged `--no-ff`
  into `main`: `74883fe1` (patch/exit-resume-hint: feature `40e25506`,
  review fix-pass `c47d1e63`, cli suite stability `6e16e0ce`) and
  `5f36e28b` (`3cf8e1ff`, builder report in operator message). No conflicts;
  the checkout was briefly occupied by the auth branch mid-battery — promote
  gate refused as designed, waited for the builder to commit, then proceeded.
- Review: two independent subagent reviews of the exit-resume hint (no
  blockers); accepted+fixed spec corrections and harness stdout sinks,
  accepted-as-is items recorded in the spec section.
- Battery on final main, all green — details in
  [verification](docs/fork/verification.md): architecture 0; root
  typecheck + lint (96 baseline); CLI turbo typecheck 34/34; CLI lint
  0/71/13; cli suite 620/620 + attach-resume-target 11/11 (extended
  env-stripping list); adapters vitest 2275 passed with 16 load-flaky
  failures → green in single-file isolation (documented class); fresh dist
  pair + `build:attach`; freshness greps on `dist` and frozen
  `dist-runtime` (hint string, auth fields, compact cap).
- Suite-stability note: the long-standing "3 known pre-existing failures"
  set (build.test.mjs clientOnly deep-equal + 2 SEA asset tests) is fixed
  by `6e16e0ce`; future batteries should expect a green cli suite instead.
- `sh apps/zcode-cli/scripts/promote-piz.sh` from clean `main`.
- Installed-pair smoke (real `piz`, util-linux `script` pty, scratch ws +
  isolated `ZCODE_DATA_BASE_DIR`): boot → double Ctrl-C → exit 0 with the
  hint printing `piz --resume sess_46a36f22…`; ran the printed command
  verbatim → exit 0, same id re-hinted (resume bound the persisted session);
  scratch core killed via its own pid file after `/proc/<pid>/cwd` check;
  operator's live cores/clients untouched.
- Live-core notes: the hint is client-side (attach-command) — effective on
  the next `piz` launch, no core restart needed; the auth-failure payload
  is core-side (model runner) — a live core keeps the previous logging
  until the next core start; do not restart live cores. Not exercised live
  (unverified): the hint after a real model turn, the monolith
  `zcode attach` hint wording (unit-tested only), and the auth payload
  against a real 401/403 (redaction test-verified only). Full acceptance
  gate (signing, allowance evidence, Ctrl-C signal path, memory matrix)
  unchanged.


### 2026-11-02 — upstream sync 3.17.1 (sync/2026-10-30-a60ba6a7)

- Base `3c5b2276` → `a60ba6a7` ("chore: sync ZCode source", 2026-10-30;
  desktop 3.17.1 / CLI 0.17.1; 5,231 files, +216k/−611k — ~1,990 deleted
  files are the upstream app-unit-test retirement; CLI/CUA suites keep
  theirs). Two merge commits on the branch: upstream merge `7d0aecb3`, then
  `1ce50ce3` reconciling parallel fork work that landed on `main`
  (`610d1fd3`: shell spill/aliases, footer compact gauge, exit-resume hint,
  auth-failure diagnostics) after the branch was cut.
- Upstream merge: 12 unmerged paths (11 content + 1 modify/delete). Fork
  rule handled `.agents/skills/e2e-case-lifecycle` (stay deleted);
  `packages/shared/test/zcodeProtocol.test.ts` kept fork-side (upstream
  retired it; it is P004's protocol-schema regression suite). Content
  resolutions of note:
  - `verification-policy.ts`: kept the real implementation, adopted
    upstream's two signature changes — `readValidatedRequestVerificationConfig`
    (delegates to our validating reader) and the 2-arg
    `requiresRequestVerification` (start-plan + config.enabled/skipModelRequest
    semantics, falls back to `requestVerificationInteractionAvailable=false`).
    The start-plan fail-closed stance moved into the Host flow
    (zcodeAgentService fails closed on invalid/missing config); signing doc
    updated. Upstream's kept `contract.test.ts` passes against our impl.
  - `zcode-protocol-entrypoint.ts`: official command endpoint, MCP node
    fallback and `sessionDataFiles` reintegrated into the per-connection
    lifecycle the auto-merge silently dropped; the endpoint's auth context
    follows `latestProtocolServer` (same owner as the MCP auth port);
    stateless `sessionDataFiles` shared across connection servers.
  - `server-types.ts` `requireSession`: sync claim (`claimDetachedSession`)
    runs BEFORE upstream's lifecycle readiness guard — the guard treats
    unclaimed/foreign sessions as `unloaded` and would reject reconnect
    resume-adoption.
  - `server-operations.ts`: upstream's register-before-subscribe +
    late-callback guard composed with the fork's `ownerContext` event
    fanout; `activateSessionForResume` gained a pre-lifecycle active-record
    fast path because lifecycle `initialize` short-circuits ready sessions
    and was silently dropping resume `compactContextWindow` on active
    records (caught by the compact-cap regression).
  - `browser-control-broker.ts`: upstream's `childSessionParents` value
    shape (`{parentSessionId}`) + fork's claimed-record lookup;
    `session-resident-pool.ts` keeps both new methods
    (`isDeactivationInFlight`, `operationCount`).
  - `AGENTS.md`/`00-tool-change-chain.md`/`architecture-policy.yaml`/
    `cli/package.json`: fork guide kept; both doc sections kept; both
    baseline-entry sets kept; test lists composed.
- Root vitest now uses the explicit `engineering-test-files.json` manifest
  (test retirement). Fork seam: added 4 entries (shared
  `zcodeProtocol.test.ts`, `usageCodingPlanQuotaSchema.test.ts`,
  `app-server-attach` + `request-security-edition` contract tests) so the
  protocol/signing regressions keep a `pnpm test` lane.
- Follow-ups fixed during verification: `tui-pi/tests/status-line.test.ts`
  import compaction (upstream's refreshed architecture checker counts it
  over the 800-line cap; 811→798, identical coverage);
  `attach-binary.smoke.test.ts` poll now requires the rendered mode token —
  the old workspace-substring condition matched `script`'s command echo and
  exited before the first frame (the 3.17.1 core boots to first frame later
  than its pid-file self-registration; manual pty boot verified the full
  banner/footer/quota-diagnostic render).
- Battery on the final combined tree, all green unless stated: root
  typecheck; CLI typecheck 36/36 (workspace grew 34→36); root lint 0
  errors/83 warnings; CLI lint 0/74/7; `architecture:check --changed` 0;
  adapters signing 13/13 + runner-status-fanout (auth payload) 9/9;
  bootstrap socket-listener+zcode-protocol 138/138, quota+cold-resume
  132/132, session-lifecycle/session-data 21/21; shared engineering set
  95/95 (incl. upstream's new verification contract test); tui-pi 265/265
  with a cwd caveat (4 footer/flush fixtures cannot fit this worktree's
  73-col path at width 80 — pass from a short cwd; the pty test needs the
  package cwd; sources unchanged by the sync); CLI suite **620/620 exit 0**
  (main's stability fixes now included). Fresh dist pair + `build:attach`;
  freshness greps: compactContextWindow ×11/×6, createOfficialCommandEndpoint
  ×2, exit-resume hint ×1, providerResponseBody ×2.
- Not exercised live (unverified): real model turn / signing against the
  live provider / allowance evidence / Ctrl-C signal path / memory matrix
  (full acceptance gate unchanged and still open); `piz` still runs the
  158a31d2-promoted pair — promotion from `main` is a separate operator
  decision after this branch merges.

### 2026-11-03 — selected test runs (patch/fork-test-runner)

- New fork-owned `apps/zcode-cli/scripts/fork-tests.mjs` (+ `fork-tests.test.mjs`).
  On patch branches it runs only the tests reachable from what changed. Turbo
  `...[merge-base]` picks the packages, and vitest `--changed` narrows to the
  test files that import changed code. Signing and socket-listener always run.
  `--full` is for sync branches and pre-promote. Upstream tests are selected,
  never skipped or deleted: that would add sync conflicts and blind sync gates.
- Each run strips the session env and puts TMPDIR on tmpfs (65k-row SQLite
  fixture: 23s vs 19 min idle on btrfs). Failing files get a solo rerun, and a
  pass on rerun is reported as FLAKY. Results are classified against
  [known-test-failures.txt](docs/fork/known-test-failures.txt), seeded with
  26 bootstrap failures that main already has (plugin/skill bundle class,
  cause not investigated). cli without a built `dist/` is reported NOT RUN,
  never pass. Root-workspace changes are reported NOT COVERED.
- Policy and measurements: [verification.md](docs/fork/verification.md)
  「Selected vs full runs」.

### 2026-11-03 — merges + promotion of e37ed9d9 (session health + lean test gates)

- Operator asked to merge and promote `patch/session-startup-health`.
  Merged `--no-ff` as `9abdd086`: draft-safe `session/subagents` reads,
  trusted no-plugin command-discovery gating before bundled asset work,
  and exact numeric usage counters in diagnostic logs. While verification
  ran, `patch/lean-test-gates` was merged on top as `a8254e2a` in the shared
  checkout; promotion therefore used current clean `main`, not a reset.
- A full-suite regression exposed a test-scope error in the new no-plugin
  case: project config intentionally strips `plugins.enabled`. Fixed on
  `main` as `e37ed9d9` by disabling plugins through user config; the trusted
  `noPlugins` override still wins over an enabled user config.
- Battery and installed-pair smoke are recorded in
  [verification](docs/fork/verification.md) and the
  [session-health report](docs/fork/reports/2026-11-03-session-health.md).
  `promote-piz.sh` ran from clean `main` at `e37ed9d9`; no push, wrapper
  change, live-core restart, model turn, signing/allowance proof, or
  latency measurement was performed.

### 2026-11-03 — worktree and branch cleanup (operator-requested)

- The canonical checkout went back to `main` (`81ac3ef8`, ahead 17 of
  `origin/main`); it had been sitting on the merged `patch/lean-test-gates`.
  The auxiliary clean-main checkout `/home/daniel/build/piz-promote-main` is
  gone, so `promote-piz.sh` now runs from this checkout — the gate only needs
  HEAD `main` plus a clean tracked tree, no fixed path.
- Removed worktrees, each clean with no untracked work (only regenerable
  `node_modules`/`dist`/`.turbo` ignored artifacts): `piz-promote-main`,
  `piz-session-health` (`patch/session-startup-health`),
  `sync-2026-10-30-a60ba6a7`, and the herdr worktrees
  `worktree-brave-cloud-bd48` / `worktree-lucky-valley-dbbc` — 17.4 GB of
  content per `du`. On btrfs the real gain is smaller (df: 368→366 GB used,
  ~2 GB) because worktree checkouts share extents.
- Kept `~/.herdr/worktrees/piz/worktree-lucky-harbor-d8a4`: a live agent
  session (`claude` plus running test processes) on the unmerged
  `lead-sidekick`. Its branch tip also moved during this cleanup
  (`39c2e2b2`→`44f8c013`) — another reason not to touch it.
- Deleted the 18 branches already merged into `main`. Their tips stay
  reachable from `main` and can be restored with `git branch <name> <sha>`:
  `patch/attach-v4-review-fixes` `386a28a2`, `patch/auth-failure-diagnostics`
  `3cf8e1ff`, `patch/compact-context-window` `bdb5e953`,
  `patch/exit-resume-hint` `6e16e0ce`, `patch/footer-compact-gauge`
  `7859ed1a`, `patch/footer-path-top-left` `c7bb87c1`,
  `patch/fork-test-runner` `4e36102f`, `patch/lean-test-gates` `bdf71561`,
  `patch/quota-footer-rightzone` `35a2fe58`, `patch/resume-session-picker`
  `5c93677f`, `patch/session-startup-health` `701aa0ef`,
  `patch/shell-escape-aliases` `b5c1a799`, `patch/shell-output-spill`
  `9ffe0ba5`, `patch/subagent-sendmessage-queue` `894c2b98`,
  `sync/2026-10-30-a60ba6a7` `74f14afb`, `worktree/brave-cloud-bd48`
  `8e044b18`, `worktree/lucky-harbor-d8a4` `9bce3ae5`,
  `worktree/lucky-valley-dbbc` `610d1fd3`.
- Retained because unmerged: `feat/allowance-herdr` (parked standalone
  allowance reference) and `lead-sidekick` / `patch/lead-sidekick-spec`.
  No force delete was used (`git branch -d` refuses unmerged refs), nothing was
  pushed, and no wrapper, live core or installed pair was touched. Branch names
  in this log and in `docs/fork/*` are now historical labels, not live refs.

### 2026-11-07 — merge + promotion of a68e1a1d (short --model names)

- Operator: "merge and promote". `patch/short-model-aliases` merged `--no-ff`
  as `a68e1a1d`: bare `--model` names are case-insensitive (`glm-5.3` → the
  catalog's `GLM-5.3`), prefer the session's current provider on ambiguity,
  and accept a quoted `$effort` suffix validated against catalog levels;
  full refs pass through, other ambiguity still fails before TUI startup.
  Builder + piz subagent review on the branch (`7a31c5e5`, `b95b575f`, no
  actionable findings); report
  [2026-11-07-short-model-aliases.md](docs/fork/reports/2026-11-07-short-model-aliases.md).
- Gate, installed-pair smoke and a shared-checkout contention note (an ACP
  worker landed `patch/acp-reasoning-effort` `99e5646d` in the same checkout
  mid-battery; promotion was rebuilt from clean `main` and grep-verified free
  of that branch's code) are recorded in
  [verification](docs/fork/verification.md) 「Promotion a68e1a1d」. That ACP
  branch is merged nowhere and not promoted — its merge is a separate
  operator decision.
- Environment lesson: T3 Code AppImage mounts (`/tmp/.mount_t3code*`) on PATH
  break `mise` 2026.11.0 (`t3code.AppImage is not a valid shim`); run
  build/test commands from T3 with those PATH entries stripped.

### 2026-11-07 — merge + promotion of a2e129f4 (ACP reasoning effort)

- Operator: review, then fix + merge + promote. Review in
  [report](docs/fork/reports/2026-11-07-acp-effort-discovery.md); finding 1
  (blank `currentValue`) fixed on the branch (`366d2504`); findings 2–3 open.
- `--promote-gate` exit 0: only the 2 known failures; cli 692/692 node tests,
  incl. the 10 new effort tests.
- First promote copied a stale 20:31 `dist/` without the change, stamped
  `a2e129f4`. Rebuilt (`pnpm --dir apps/zcode-cli build` + `build:attach`),
  promoted again; `dist-runtime/zcode{,-attach}.cjs` grep-verified to carry
  the effort option. Lesson recorded in AGENTS.md.
- Not done: live T3 check (option visible, set works, model-switch finding 2).
  No push, no core restart.

### 2026-11-07 — merge + promotion of a971df4e (ACP effort sync)

- Operator: fix review findings 2–3 with Sonnet. Builder: Claude Sonnet 5.5
  (`259cafd6`); lead review fix `c7cf871e`.
- Finding 2: not a bug (code trace, not live): `setModel` resolves the target
  model's default level (`command-center/handlers/model.ts`), core stores it,
  and `session-mapper.ts` drops unsupported `thoughtLevel.current`.
- Finding 3 fixed: attach `mergeSettings` emits `ModelSelected` on effort-only
  changes; ACP pushes `config_option_update` except during its own
  `set_config_option`. Lead review caught a TUI regression (event lacked
  `options.reasoningLevel` → terminal effort display reset); fixed with test.
- cli tsc + oxlint clean; promote gate exit 0 (2 known failures); built
  before promoting, dist-runtime grep-verified. No live T3 check yet.

### 2026-11-07 — upstream sync 3.17.2 (sync/2026-11-07-a9fe401e)

- Base `a60ba6a7` → `a9fe401e` ("chore: sync ZCode source v3.17.2",
  2026-11-03; desktop 3.17.2 / CLI 0.17.2; 203 files, +9,635/−1,472 — an
  order of magnitude smaller than the 3.17.1 dump). `upstream/main` was
  already fetched locally; zero network was used for the sync itself.
- Merge `0f56f297`: exactly one content conflict,
  `bootstrap/tests/protocol-slash-commands.test.ts` (import block) — fork's
  no-plugin discovery regression imports (`vi`, `plugins`,
  `listZCodeCustomCommands`) kept, upstream's dropped
  `ExecutionPort/ExecutionResult` import adopted (its only uses were the old
  shell-expansion test upstream replaced). No fork-deleted-path conflicts
  (rule not triggered). Nothing references the upstream-deleted
  `custom-command-shell-expansion.ts`.
- Seam review (auto-merge ≠ proof): manifests composed (engineering-test-files
  fork entries + upstream's desktop-prune entry; architecture-policy fork
  `compact-context-window-shared-append` exception + upstream additions);
  v4 gateway/bridge workspace threading composes with the fork's v4 send path
  and first-persistence admission; P001 signing untouched by this sync
  (no verification-policy/agent-service signing hunks);
  `compact-active.ts` reminder rework does not touch the cap predicate;
  `00-tool-change-chain.md` fork sections preserved (0 removals);
  noPlugins gating lives in untouched `custom-commands.ts`.
- **Gap found + fixed (`bcde55fd`):** upstream 3.17.2 validates
  restore-with-workspace session lineage even for ready runtimes inside
  lifecycle `initialize`/`ensureReady` (`validateSessionActivationWorkspace`,
  `sessionLifecycleWorkspace` capability). The fork's
  `activateSessionForResume` active-record fast path (3.17.1, kept so resume
  `compactContextWindow` is not dropped by the ready short-circuit) returned
  before `initialize` and bypassed the new check — a wrong-workspace
  `session/resume` could adopt another workspace's active record and write
  its cap. The fast path now validates first (mismatch →
  `project.session-lineage-invalid`, no cap write; workspace absent stays
  passthrough). Spec: tui-attach-shared-core.md 「GLM 压缩窗口上限」.
  Regression `bootstrap/tests/resume-active-lineage.test.ts` — mismatch
  cases verified red without the fix, green with it (4/4).
- Patch inventory: P001–P006 and the later carried behaviors all retained;
  no upstream retirement (signing, tui/tui-pi, attach client, ACP lane
  untouched by the diff). No new P-rows needed.
- Battery on the branch tip, all green unless stated: root typecheck; CLI
  turbo typecheck 36/36; `architecture:check --changed` — **caveat:** origin
  now exists and sits behind main (`c2d393f7`), so the checker's
  merge-base swept in older fork work: 1 violation,
  `cli/src/attach/attach-session.ts` 813/800 lines — pre-existing on main
  via `c7cf871e`, not from this branch; branch's own files add 0. Root lint
  0 errors/84 warnings (baseline 83; +1 from upstream's new files). CLI lint
  0/74/7 via the recorded `npm_execpath` workaround. `fork-tests.mjs --full`:
  13,521 vitest results, exit 0 — only the 2 known re-baselined failures
  (fail on main too), flaky set passed on solo rerun (22 rerun batches);
  cli node tests 695/695, tui-pi 270/270; seam files
  (resume-active-lineage, protocol-slash-commands, session-resident-pool,
  v4-cold-resume) ran in-suite and passed. Turbo build 26/26 +
  `build:attach`; freshness greps on fresh dist:
  `sessionLifecycleWorkspace` ×2/×1, `session-lineage-invalid` ×3 (core
  only, correct), `validateSessionActivationWorkspace` ×3,
  `compactContextWindow` ×11/×6.
- Contention: an ACP-session commit `c455443b` (FORK.md promotion record for
  `a971df4e`, Claude Opus 5.5) landed on this sync branch mid-flight between
  the merge and the fix — docs-only, correct content, rides the eventual
  merge; no history rewrite.
- UPSTREAM advanced to `a9fe401e`; origin row above corrected to reality
  (push enabled, origin/main behind). Not exercised live (unverified): real
  model turn, signing/allowance evidence, lineage rejection against a live
  core — full acceptance gate unchanged and still open. Not merged to main,
  not promoted; both are operator decisions.

### 2026-11-08 — subagent review of sync/2026-11-07-a9fe401e

Three independent read-only reviewers (no tests run): merge seams (19
both-sides-changed files), the bcde55fd lineage fix (all activation paths
mapped), fork-behavior preservation (10 must-keeps). Consensus:
**0 blockers, 0 fix-before-merge on the branch tip; fit to merge.**
- Merge review independently re-found the fast-path lineage bypass as the
  single semantic defect of merge commit 0f56f297 — already fixed by
  bcde55fd on-branch; every other seam composed as designed (incl.
  protocol-slash-commands resolution, server-operations adoption/fanout,
  v4-bridge admission, session-facade quota facade, manifests).
- Lineage-fix review: validate-before-mutation ordering, error shape, and
  legacy passthrough match upstream exactly; no explicit-workspace path
  bypasses validation; tests genuinely pin the seam.
- Preservation review: all 10 areas SURVIVED (signing byte-identical,
  v4 send, compact cap, attach surface, tui/tui-pi, ACP effort, no-plugin
  gate, P005, fork-deleted paths still gone).
- LATER (not filed anywhere yet, operator's call): op-level resume test
  through the real JSON-RPC wrapper; `remoteSessionId`-only mismatch
  case; 3.17.1-era notes — fast path ignores lifecycle state in the
  mid-stop window, adoption validates against persisted not live
  workspace facts, fast-path rejection records no lifecycle lastError;
  untracked `apps/zcode-cli/packages/adapters/backup/` should be trashed
  before promotion hygiene; pre-existing attach-session.ts 813/800
  architecture violation from `c7cf871e` lives on main.

Made by GLM-5.3 via ZCode; operator brief: review the 3.17.2 sync with subagents.

### 2026-11-08 — OSC 7501 程序状态上报（patch/osc7501-status）

- Operator brief: "piz reports status through OSC 7501"
  （[mitchellh.com/writing/program-status-osc7501](https://mitchellh.com/writing/program-status-osc7501)）。
  piz attach 客户端把生命周期经终端带内 `ESC ] 7501 ; … ESC \` 报告：
  idle（绑定/换绑/用户取消）、working（turn_started）、done（turn_complete
  success）、blocked（kind=permission/question，interaction 面板渲染期）、
  error（turn_error、`error_*` resultType、启动失败）；正常退出先发 idle 再打
  退出续接提示。spec 先行（tui-attach-shared-core.md「OSC 7501 程序状态
  上报」+ 根 GLOSSARY 词条）。
- 实现与 herdr reporter 同一裁决（状态所有权在会话事件流 + interaction
  路由，reporter 只翻译）：新 `osc-status-reporter.ts`（带内字节不丢不
  乱序→无重试/心跳，(state,kind,msg) 去重，msg 160 字符截断后 base64，
  写失败一次性禁用）；`AttachRuntime` 新增可选 `interactionStatus` 端口
  （routePermission/routeUserInput 围绕 serveInteraction——blocked 的真相
  在面板渲染，不在 permission_requested 事件，自动应答未渲染不计）；
  attach-command 仅 piz 入口 + `ctx.stdout.isTTY` 激活，monolith/管道零
  字节。herdr execFile 通道保留不动（herdr 当前只认那条路）。
- Verification：cli **709/709 + attach-resume-target 11/11**（fork-tests
  selected，全绿）；adapters signing 13/13；bootstrap socket-listener 4/4；
  cli `tsc --noEmit` 0 错、oxlint 0/0；`architecture:check --changed --base
  a971df4e` 0 违规。真实 pty 冒烟（util-linux `script` + 隔离
  ZCODE_DATA_BASE_DIR + 真实 core spawn）：绑定 idle 字节落在终端流、双
  Ctrl-C 干净退出 0 后退出 idle 先于续接提示（新回归
  `attach-binary.smoke.test.ts` 第二用例）。
- 新 worktree bootstrap 教训（本分支在全新 worktree 上完成）：只做 root
  `pnpm install --frozen-lockfile`（文档已写明 nested 安装必败）；中途失败
  的 `--dir apps/zcode-cli` 安装会**损坏包级链接**（contracts/node_modules
  丢 zod → tui-pi tsc 出 implicit-any 假错），frozen 重装即修复，root TS
  6.0.2 无需 5.9.3 遮蔽。SEA 资产测试还需 root `packages/shared`、
  `packages/model-option-map` dist 与 `@zcode/node-repl-host`、
  `@zcode/browser-use-plugin` 构建，全新 worktree 缺这些输出时 3 个 SEA
  测试红（clean main 同红，环境性）。`architecture:check` 默认 origin/main
  base 在本仓是分叉线，会把 attach-session.ts 813 行误报为新增——须显式
  `--base <分支点>`。
- Not exercised live（unverified）：真实 GLM 回合的 working/done、真实
  审批/AskUserQuestion 的 blocked（翻译层由单测 + 路由测试覆盖，idle 字节
  由 pty 冒烟覆盖）、Ghostty 端到端角标渲染。Not promoted；待 review +
  merge 决定。
- Review fix-pass（两个独立 subagent review，无 blocker；finding 均已
  在分支修复）：① `finish` 后 reporter 完全静默——原实现只退订事件
  sink，runtime.close() 窗口里迟到的 interaction settle/换绑仍可把
  exit idle 覆盖成 stale working（`finished` 门禁在 emit 层，端口、
  换绑、事件一律挡住）；② msg 单行化——换行折叠为空格、160 截断改按
  code point（不劈代理对），对齐协议与 spec 的「单行」承诺。补钉：
  catch 路径 `finish("error")` 的接线回归（--resume 未知会话驱动）、
  permission 侧无 handler 早退不触发端口、晚到 settle 守卫的 error
  半边、astral 截断/换行折叠字节回归、pty 冒烟 boot/exit 各自独享
  45s 预算。已知限制记入 spec（并发面板、grace 期 re-announce 闪烁）；
  spec 勘误：`script` 是 pty、照常发射，非「零字节」路径。

### 2026-11-08 — merge reviewed sync and OSC branches (no promotion)

- Operator authorized these two merges only; the ACP goal/dwf worktree had an
  active Herdr session and was left untouched.
- Merged `sync/2026-11-07-a9fe401e` at `5ae77e79` as `7d9fa0ca`, then
  `patch/osc7501-status` at `19ef618e` as `cfc84c03`, both `--no-ff`.
  The sole conflict was appended maintenance records in this file; kept both.
  Source changes needed no manual resolution.
- Combined-source checks: CLI 89/89, bootstrap lineage/socket 8/8, signing
  13/13; CLI typecheck passed; targeted lint 0 errors/7 warnings.
  Architecture still fails on unchanged `attach-session.ts` (814/800 by
  this invocation), also observed before merging; no baseline was widened.
- [Merge evidence and reproduction](docs/fork/reports/2026-11-08-sync-osc-merges.md).
  No build, promotion, network access, push, core restart or cleanup.
  Existing untracked adapters `backup/` left untouched.

### 2026-11-08 — /goal and /dwf over ACP (patch/acp-goal-dwf)

- Operator goal: "full support of `/goal` and `/dwf` over ACP". ACP clients have no
  command center, so these commands previously hit the model as literal text (P005)
  and never touched the goal state machine or the dwf journal.
- Spec first ([acp-frontend.md](docs/design/v2/acp-frontend.md) 「Local slash
  commands」), then implementation: `session/prompt` intercepts `/goal`/`/target`/`/dwf`
  (same word-boundary parse as the TUI) and routes through core ops; core stays the
  single owner of goal wording/state and of dwf facts. Response text is emitted as one
  `agent_message_chunk`; goal `set`/`replace`/`resume` keeps the prompt request open
  until the first continuation turn settles — the settlement sink is armed BEFORE the
  `session/goal` op is sent (a fast-failing continuation would otherwise strand the
  prompt), and later goal-loop turns keep streaming as ordinary updates. All commands
  share the normal in-flight guard and cancellation path.
- `AttachSessionHandle` surface: new `goalCommand` and CommandCenterApp optional
  `listDynamicWorkflowRuns`/`resumeWorkflowRun` (wire body extracted to
  `attach-goal-dwf-ops.ts`); the dwf pair also unblocks `/dwf list`/`resume` on the
  attach TUI lane, which previously reported "not available in this client". The dwf
  engine gate is unchanged: the shared core fails closed, so default piz sessions
  truthfully list no runs; enabling the engine is a separate operator decision.
- `command-center/handlers/dwf.ts`: cancel-target decision extracted to pure
  `resolveDwfCancelTarget` + formatting helpers exported (single copy shared by TUI
  handler and ACP router; no behavior change — dwf-command tests untouched and green).
- Baseline: `architecture:baseline:update` recorded `attach-session.ts` at 855 lines
  (file was already 813 on main, over the 800 cap but invisible to `--changed` without
  `origin/main`; this change adds the three delegating methods, +41 net). The script
  wiped the pre-existing status-line.test.ts entry; it was restored by hand — check
  the baseline diff whenever this script is used.
- Verification (worktree, dev build only — installed `piz` pair NOT touched):
  `@zcode/cli` typecheck + oxlint 0/0; full cli suite **719/719** (new tests:
  acp-commands 11, acp-agent +9, attach-adapter +4; the dwf-command suite is
  untouched and green); `architecture:check --changed` 0 new; fork-tests selected:
  adapters signing 13/13, bootstrap socket-listener 4/4; `build:attach` 2.2 MB
  carries the new command surface and the thin gate holds (only the inherited
  comment mentions bootstrap/src). The first fork-tests pass reported 3 build-sea
  failures — this fresh worktree lacked generated assets (root
  `@zcode/shared`/`@zcode/model-option-map` dist, the browser-use-plugin bundle);
  building them turned build-sea to 42/42. Not exercised (unverified): live T3/Zed
  rendering of the command responses, a real goal continuation turn over ACP, and
  `/dwf` against a core with the engine enabled. Merge + promotion are separate
  operator decisions.

### 2026-11-08 — review fix pass on patch/acp-goal-dwf

- Two independent subagent reviews of 7b56f45a (semantics lane + wire/records
  lane) returned 1 blocker + shared fix-before-merge findings; verified in-tree
  before fixing:
  - **Blocker (fixed)**: `cancelBackgroundTask` sent `backgroundTaskId`, but
    `zcodeSessionCancelBackgroundTaskParamsSchema` is strict over
    `{sessionId, taskId}` — core would `-32602` every `/dwf cancel`. Now sends
    `taskId` and parses the result with the shared result schema; wire test
    asserts the exact params object.
  - **F2M (fixed)**: the goal settlement wait had no fallback — `startedTurn`
    is only a pre-check, a queued continuation can end empty-handed with no
    turn event, hanging the prompt forever. `watchTurnSettlement` now carries
    a no-turn-start backstop (default 30 s, injectable; disarmed by
    `turn_started(inputId)`). The deterministic `state.updated`-based
    alternative stays documented as a future option.
  - **F2M (fixed)**: `session/cancel` was dead during goal-loop turns 2..N
    (prompt already returned, no in-flight entry). Cancel with no active turn
    now falls back to `stopActiveTurn()` directly (core-side no-op when
    idle). Scoping is goal-lane only: cancelling a `/dwf` command never
    issues a v4 stop (would kill another client's turn).
  - Pause feedback: core returns an empty response for a successful pause;
    ACP clients have no goal panel, so the router synthesizes `Goal paused.`
    (TUI-lane wording).
  - A cancel landing after a local command's op already returned (dwf has no
    watch to depend on) now closes the prompt as `cancelled` instead of
    `end_turn`, via the turn's cancelled flag.
  - `available_commands_update` timer now checks a connection-closed flag set
    by the abort listener (abort does not set `connectionFailure`), so it
    cannot notify into a dead connection.
  - Resume-rejection word list derived from a new shared
    `workflowRunResumeRejectionReasonSchema` (mirror of contracts
    `DynamicWorkflowRunResumeErrorReason`) instead of a hand-copied set;
    `packages/shared` dist rebuilt.
  - Spec (acp-frontend.md) extended: backstop rule + why, pause synthesis,
    cancel coverage/scoping, resource-blocks-baked-into-args, response-banner
    ordering after streamed output, and `turn_error` → `end_turn` (no notice)
    divergence.
  - Baseline correction: the fingerprint hashes rule+file+line-count, so the
    855-line entry no longer matched the file at 863. Regenerated with
    `architecture:baseline:update -- --changed` (scoped update keeps
    out-of-closure entries). It legitimately dropped the status-line.test.ts
    entry — fork commit c38a2e3f had already shrunk that file to 799 lines;
    the earlier hand-restore had resurrected a stale entry.
- Deferred items fixed (operator-approved follow-up): reviewer-B's test-fake
  casts are narrowed — `runGoalCommand`/`runDwfCommand` params now declare the
  members they consume (`Pick<AttachSessionHandle, …>`), the stale whole-result
  cast in `runDwfCancel` is gone (the parsed member type already carries those
  fields), and the test fakes/overrides are typed against those `Pick`s so
  member names and signatures are checked instead of silenced. Two documented
  foundry casts remain per file (snapshot stub, `asEvent`) plus the two
  SDK-boundary `as never`s (elicitation client stub, negative wire-validation
  payload — the invalid shape is the point). Bootstrap's resume-rejection doc
  comment now lists `superseded`; the word list itself was already complete.
  Discovery: `packages/cli` tsconfig includes only `src/**` — test files are
  never typechecked (tsx strips types at run time), so test-type changes were
  verified with a throwaway tsc project over the two test files; that run
  caught a branded-`SessionId` slip the runtime passes straight through.
- Verification: shared dist rebuilt (`tsc -b`); cli typecheck + oxlint clean;
  affected suites re-run once each (acp-commands 14/14, acp-agent 29/29,
  attach-adapter 72/72 — first acp-agent draft self-deadlocked two new tests,
  fixed by emit-before-await ordering and releasing the hanging op before
  awaiting the prompt); `architecture:check --changed` 0 new (1 baselined);
  `build:attach` 2.2 MB carries the fix surface (`acp-goal-`, `Goal paused.`,
  cancelBackgroundTask) and the thin gate holds — only the inherited comment
  mentions bootstrap/src.

### 2026-11-08 — ACP merged; combined promotion blocked

- Operator authorized merge and promotion. Merged reviewed ACP tip `ce6850cd`
  into main as `17dbfcce`, preserving the existing sync/OSC merges and unrelated
  docs checkpoint `106c5998`. Kept both maintenance histories and both added
  test entries in the two merge conflicts; no source conflict resolution.
- Rebuilt root shared dependencies, CLI graph 26/26, and attach bundle. Checked
  feature markers, staged a matched pair outside the checkout, and preserved
  the prior installed pair. Typecheck 36/36 plus root shared and explicit ACP
  test-file typecheck passed; lint had no errors; architecture had 0 new
  violations (the ACP branch carries its reviewed attach-session baseline).
- **Not promoted:** the full promotion run's CLI package had 744/745 pass;
  the real PTY OSC smoke exited 130 rather than the required clean exit 0
  after double Ctrl-C. This is not a known-failure waiver. The verifier then
  hit its 900-second inactivity watchdog during core tests, leaving the
  remaining gate incomplete. No whole-suite retry, skip or baseline widening.
- [Evidence, retained artifacts, and remaining work](docs/fork/reports/2026-11-08-acp-promotion-blocked.md).
  Installed artifacts and existing cores are unchanged. No push or model call.

### 2026-11-08 — combined promotion completed

- Operator authorized checking ready branches, merging and promotion. Merged
  `patch/osc7501-smoke-gate` as `4caa31d5`: corrected PTY readiness detection
  and restored cooked terminal mode on exit. Independent diff review found
  no blockers. Older ACP review branches were already incorporated; the
  separate lead/sidekick experiment was not included.
- Preserved completed gate results and finished the remaining ten packages:
  no new failures. Fresh PTY smoke 2/2, tui-pi 271/271, tui 267/267, shared
  engineering 101/101, typechecks and changed-file lint passed; architecture
  had 0 new violations. Independent real-artifact checks confirmed terminal
  restoration, ACP local commands and no-plugin core startup.
- Promoted from clean main at `4caa31d5` with the official script; compared
  installed bundles and frozen frontends against tested outputs. Retained
  the previous pair for rollback. No push or live-core restart.
- [Evidence, verifier-brief corrections and remaining acceptance limits](docs/fork/reports/2026-11-08-combined-promotion-complete.md).

### 2026-11-08 — live ACP verification of promoted 4caa31d5 pair

- Note: the 2026-11-07 "a971df4e promotion" entry above was written before the
  promotion actually ran (it was refused; the checkout had moved to a sync
  branch). The effort code shipped in the operator's 4caa31d5 promotion instead.
- dist-runtime `PROMOTED_FROM` 4caa31d5 contains a971df4e; zcode-attach.cjs
  carries the effort option, own-change tracking and the TUI event fix.
- Live `piz acp` stdio smoke (initialize → session/new → set_config_option →
  close; no prompt, no model request) against the shared core:
  GLM-5.3 effort `max of [low,high,max]`; set `low` confirmed; `bogus`
  rejected ("Unsupported reasoning effort for the current model"); switch to
  GLM-5.3-Flash resets effort to that model's default `max` (finding-2 trace
  confirmed); no duplicate `config_option_update` on own changes.
- Not verified live: another client's effort change reaching T3 (finding 3);
  T3 UI rendering itself.

### 2026-11-15 — upstream sync 3.18.2 (sync/2026-11-15-fec97590)

- Base `b66c16d0` → `fec97590` ("chore: sync ZCode source v3.18.2",
  2026-11-13). Primary driver is issue #64: desktop 3.18.2 stores
  `~/.zcode/v2/credentials.json` values as `enc:v2:` ciphertext with an
  OS-keyring key; the fork CLI read them raw and logged the user out.
  Upstream ships `packages/shared/src/credential-security/` (system
  credential cipher + bridge) and the CLI-side integration.
- The merge was handed off as a written working tree (no MERGE_HEAD).
  Verification found the merge-write was incomplete beyond the 28 marked
  conflict files: ~710 upstream-changed/upstream-added paths under
  `packages/ui`, `packages/web`, `packages/zcode-server-cli`, `apps/dev-docs`
  and others had been left at fork content, empty, or absent. All were
  restored to upstream content (verified file-by-file against the
  `fec97590` blobs); `packages/ui/src/App.tsx` had been left as a 0-byte
  file. 749 `D` entries audited — all upstream deletions of fork-untouched
  files, none unexplained. Fork-deletion policy applied to the two paths
  the merge-write resurrected: `.agents/skills/ai-elements` and
  `.agents/skills/e2e-case-lifecycle` are deleted again.
- 28 conflicted files resolved by hand, both-sides intent kept unless
  noted. Highlights:
  - `adapters`/`bootstrap` auth: upstream's credential cipher is threaded
    through `auth-login.ts`, `zcode-protocol-entrypoint.ts` (official-MCP
    cipher bridge now follows the owner-tracked `latestProtocolServer`
    auth context — same owner the fork already used) and
    `server-operations.ts`; `LoginZCodeCliOptions` carries
    `credentialStore` through `startCliOAuthLoginFlow` to
    `completeCliOAuthLoginFlow` (upstream's pre-init guard capture lives
    at flow start).
  - `workspace-model-runtime.ts`: both propagations kept — fork
    `noPlugins` and upstream `workspaceKey`.
  - `server-operations.ts`: upstream's `mapSnapshotMessages` kept (it
    wraps the fork's `mapMessageWithParts` #52 fix — a superset); cold
    forward-read fallback, visible-message filtering, cursor validation
    and head pagination retained.
  - `core/src/subagent/runner.ts`: fork `takeUndeliveredMessages`/
    redelivery kept inside upstream's claim/terminal-state registry flow;
    the fork's restore-on-finalize-failure was dropped — upstream's
    committed-killed semantics makes resurrection break the executionId
    guard; artifact-write failure handling and background-only
    abort/notification kept.
  - TUI permission lifecycle moved to upstream's mount-time
    `registerPermissionRequester`/persistent `permissionBroker` in
    `tui-prompt-handler.ts`, `app-submit-controller.ts`, `app-submit.ts`,
    `app.tsx`, `types.ts`; fork's in-process `delivery:"queue"` rejection
    and `steer`→`steer_active_turn` mapping kept. The attach path
    (P004-owned) needed the same wiring: `mountPromptRequestPermission`
    on the attach handle + `registerPermissionRequester` on its prompt
    handler, with per-submit fallback preserved; tui-pi `app.ts` now
    registers/unregisters the requester at construct/dispose instead of
    passing the now-deleted `requestPermission` submit option.
  - `cli/scripts/build.mjs`: `@zcode/tui-pi` external kept, upstream
    `@napi-rs/keyring` external added.
  - `plugins.ts`: upstream async `resolveZCodePlugins` kept inside the
    fork's `config.plugins.enabled` no-plugins gate.
  - `AGENTS.md`: fork (English) side kept per policy.
  - i18n `en-US`/`zh-CN`/`types`: fork `connection` cluster + upstream
    `approval` cluster merged (missing `},` fixed in all three).
  - `architecture-policy.yaml`, `package.json`, `cli/package.json`,
    test manifests: union merges.
- `pnpm-lock.yaml` rebuilt surgically: upstream v3.18.2 lockfile as base
  + fork-only importers (`apps/zcode-cli/packages/tui-pi`), fork deps
  (`@agentclientprotocol/sdk`, `@zcode/tui-pi`, `zod` devDep on
  `packages/cli`, `node-forge ^1.4.1` on `packages/{desktop,server,services}`),
  fork overrides pin (`zod@>=4 <5: 4.6.5`), and 123 fork-only
  `packages:`/`snapshots:` entries (Sentry, OpenTelemetry extras, pi-tui,
  playwright-core, vitest 4, vite 8, typescript 6.0.3, …). Post-merge
  validation: YAML parses, every importer version resolves to a snapshot
  key, every merged `package.json` specifier matches its lockfile importer
  (the 18 remaining diffs are pre-existing upstream quirks — React
  override specifiers and the `packages/ui` peer — identical in
  upstream's own lockfile). `packages/web` gained `core-js` and
  `packages/zcode-server-cli` `@napi-rs/keyring` per upstream manifests.
- Patch dispositions:
  - P001 (signing/extra-usage): retained — request-security-edition and
    adapters signing untouched by conflicts; credential-read path now
    decrypts via upstream cipher.
  - P002 (TUI projection/transcript): retained — tui merged with upstream
    permission-broker lifecycle, fork queue/steer semantics kept.
  - P003 (tui-pi/shell escape): retained — tui-pi seam adapted to the
    broker registration model.
  - P004 (shared core/attach/socket/no-plugins): retained — socket
    listener, attach option-builder broker wiring, no-plugin gate and
    `standalone` account source all preserved.
  - P005 (unresolved-slash forward): retained — prompt-handler prompt
    routing unchanged.
  - P006-adjacent (ACP frontend): retained — ACP command routing not
    touched by conflicts.
- Credential audit for #64: the only `credentials.json` file read in CLI
  code is `readRawCredentialRecord` inside
  `adapters/src/auth/shared-credentials.ts` — every value passes
  `cipher.decrypt` (`createSystemCredentialCipher`, `enc:v2:` handled
  upstream). All `oauth:zai:access_token` consumers go through
  `SharedZCodeCredentialStore` (`load`/`loadMany`) or the services-side
  `credentialService` (its own `createSystemCredentialCipher`). No raw
  bypass found.
- Open problems / unverified:
  - No local builds/typecheck/lint/tests run (repo rule: CI only; this
    sync ran on the sidekick lane without toolchain). The attach-side
    permission-broker addition and the tui-pi register/dispose lifecycle
    are type-correct on inspection but compiler-unverified — CI is the
    first gate.
  - `enc:v2:` decryption not exercised against a real keyring/desktop
    credential file; verified by code-path audit only.
  - `git merge-tree` self-check used for both-changed files; two files
    (`scripts/engineering-test-files.json`, `third-party/copied-components.json`,
    `pnpm-lock.yaml`) were union-merged manually — `merge-file` output
    was verified-equivalent or intentionally different.
  - `pnpm-lock.yaml` not verified against `pnpm install
    --frozen-lockfile` locally; the structural checks above are the
    pre-CI evidence.

### 2026-11-16 — Z.AI business token shared with Desktop (patch/zai-business-token)

- Issue #71: Z.AI OAuth login exchanges the raw OAuth token once, before
  credential persistence, and stores the returned business token under
  `oauth:zai:access_token`, matching Desktop 3.18.2. The project-token resolver
  now treats that stored value as the business token and sends it directly to
  downstream project-token requests; BigModel remains unchanged.
- There is no migration for older piz credentials that contain the raw OAuth
  token. Re-run `/login zai-coding-plan` if downstream authentication fails.
- Regression coverage: login with stub HTTP asserts the raw token is exchanged
  and only the business token is persisted; resolver coverage asserts no login
  exchange and verifies downstream Authorization uses the stored token;
  BigModel resolver coverage remains in place.
- Build, typecheck, lint, tests, push, draft PR and CI are pending; repository
  policy keeps those verification commands in CI.
