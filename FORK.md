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
| `origin` | Not configured: no fork hosting destination has been selected |

`archive-source` points at the old local clone, not a hosted backup. Its refs
include old `main`, allowance, lucky-field and rapid-cloud tips. They are not
product branches or promises that every behavior will be carried forward.
This checkout has its own Git directory and copied objects, with no alternates
or hard-linked clone storage. It remains shallow: history before the original
boundary is unavailable. Deepen this writable repository when needed, never the
reference-library clone. Existing refs are preserved here; this is not yet an
off-machine backup.

Pushes are guarded locally: `push.default=nothing`, and both current remotes have
`pushurl=DISABLED`. Choose a hosted fork explicitly before changing that setup.
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
- Reuse shared cores across CLI invocations/sessions rather than creating a
  heavy runtime for each client. Sharing does not remove session/workspace
  isolation requirements or imply one global core across all workspaces.
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
| `--model` startup model selection (attach entry + banner) | `3db70344` | P004 (attach entry) |
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
| `~/.local/bin/piz` | this checkout's `packages/cli/dist-runtime/` matched pair (written only by `scripts/promote-piz.sh`, which refuses to run from anything but a clean `main`); core pinned to the same dir's `zcode.cjs` via `ZCODE_SERVER_BIN`. Currently the `e37ed9d9` pair (session-health merge `9abdd086` + lean test-gates merge `a8254e2a` + no-plugin regression config-scope fix), promoted 2026-11-03 from clean main after the recorded verification — see [verification](docs/fork/verification.md) |
| `~/.local/bin/zcode` | reference clone's standalone allowance `zcode.cjs` (unchanged; `PATH` `zcode` is not piz) |

The external `zcode-allowance-update` script manages the parked standalone tree;
**do not use it to update piz**.

**Promotion policy (2026-10-24):** promote only from a clean `main`, never
from patch branches — `promote-piz.sh` refuses otherwise. A branch-only
promotion regresses the next main-based promotion (this happened once with
the resume fix and is the reason the gate is mechanical).

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
