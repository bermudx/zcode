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
| P003 | pi frontend: tui-pi, CLI selection/build wiring, architecture registration, clipboard image paste (`ctrl+v`/`alt+v`), `/skill` argument completion, kitty key-release filtering in chord dispatch, constant three-row footer (activity + pwd/branch row + two-zone stats row; 2026-10-27 verbatim pi parity: `↑↓R[W] CH% $cost ctx(auto)` segment gates + ctx threshold coloring + `•` identity separators + provider-prefix rule + provider-balance-style pwd-row quota slot), startup `PiBanner` (logo/version/hints/model scope), `userBg` user message block, `markdown*` terminal theme, transcript rendering polish (borderless volume-balanced markdown tables with fence-aware scanning + narrow-table width guard, `json`-fence pretty-printing for provider tool narration, thought/tool part-row restyle + inter-part rhythm; `TranscriptMarkdown` in tui-pi), `!` shell escape (interactive bash/zsh `$SHELL` `+m -ic` in an isolated session/process group so rc aliases/functions apply, non-bash/zsh or missing `$SHELL` falls back to deterministic non-interactive `/bin/bash -c`; `!!` opt-out; output keeps the tail at 64k chars / 2000 lines and spills the full output to `<tmpdir>/piz-shell-<hex>.log` (0600) with a `[Output truncated. Full output: …]` notice in block, transcript row, status line and collapsed display — resolution history: interactive `80729ec8`/`f5241576` → deterministic `8888d7e9` (pi port) → interactive again `07e8b06a` on the hardened runner; `8888d7e9`'s head truncation superseded by `8fbbfba5`) | `570ebd20` through `7e859585` and later skills/image-paste commits plus `b0468c92`, `76335676`, `4422deb7`, `058685af`, `4163f747`, `63f379a2`, `f4780a2b`, `!` port `80729ec8`→`8888d7e9`→`8fbbfba5`, interactive resolution `4d0b7a5a`/`07e8b06a`; tui-pi tests incl. projection, composer, history (incl. kitty press/repeat/release), panels, terminal-drain, mentions, shell, wrapping, image-paste, banner, footer and transcript-markdown; [design](apps/zcode-cli/docs/design/v2/tui-pi-frontend.md) | Upstream frontend meets our interaction and resource requirements |
| P004 | Shared core and thin attach client: bootstrap socket listener, CLI attach/spawn/build, root shared protocol; attach `/skill` list + suggestions via `skills/referenceCatalog` additive fields; attach custom-command catalog via new `commands/referenceCatalog` (composer `/` panel + `/help`; expansion stays in the core input facade, local `listAttachCustomCommands` scan removed); coding-plan quota read via new `usage/codingPlanQuota` (account-level snapshot fetched core-side from the Registry's coding-plan provider — API-key access from provider config **or** zhipu-account individual-coding-plan entitlement via the account credential port `providerRuntimeHeadersPort` (2026-10-28; same owner as model-request auth, manual plan key or OAuth-derived project token), feeding the tui-pi footer quota cluster; readUsageQuota absent → cluster silent; tui-pi failure diagnostics deduped per message + 60s idle-tick backoff so permanent no-credential states log exactly once per episode); herdr pane lifecycle reporter for `zcode-attach` (bounded retry + 30s heartbeat re-assert + always-on throttled stderr diagnostics, since a single lost `working` report pins herdr idle/done for a whole turn) plus `ZCODE_ATTACH_CORE` spawn marker suppressing the shared core's zcode hook | `32dc8799` through later attach fixes including `61abbc11`, plus `887668fb`..`d68db6ab` and the 2026-10-24 reporter-durability commit; CLI attach tests, bootstrap socket-listener + skill-reference-catalog, root shared attach contract, `attach-herdr-reporter` (incl. retry/argv-reuse/heartbeat regressions) + `app-server-spawn` marker tests; [design](apps/zcode-cli/docs/design/v2/tui-attach-shared-core.md) | Upstream shared-core mode covers no-plugin isolation, matched builds, sessions, reconnect and low per-client cost |
| P005 | Interactive unresolved slash input routed as a normal prompt | piz `2f55f457`; allowance has a different patch `c6b36ad5`; coverage (audited 2026-10-26): verbatim forward incl. attachments + default no-opt-in "Unknown command" + headless e2e `--prompt /nope` + attach e2e via real command center asserting exactly one `session/send` + custom-command expansion precedence + recognized builtins staying local (cli.unit / attach-adapter); TUI-lane wiring pinned by `ff7bf885` (2026-10-26); still open: attach unresolved-slash **with attachments** over a real socket | Upstream equivalent verified on piz, including recognized slash commands |

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
| Per-session auto-compact window cap: additive `compactContextWindow` on `session/create`/`session/resume` + `session/setCompactContextWindow`, core `compact.contextWindowCap` = min(cap, model window), compaction-only (no provider limits, no usage/ctx denominators); piz attach sets 262_000 for GLM (`/^glm-/i`) and follows model switches/resume — spec [compact/plan.md M2.1](apps/zcode-cli/docs/design/v2/compact/plan.md); v4 `createSession` deliberately untouched | `patch/compact-context-window`, merged `158a31d2` | P004 (shared protocol + attach client) + core compact |

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
| `~/.local/bin/piz` | this checkout's `packages/cli/dist-runtime/` matched pair (written only by `scripts/promote-piz.sh`, which refuses to run from anything but a clean `main`); core pinned to the same dir's `zcode.cjs` via `ZCODE_SERVER_BIN`. Currently the `158a31d2` pair (bf6d3a16 contents + per-session compactContextWindow cap: piz attach caps GLM sessions at 262K; core `compact.contextWindowCap` = min(cap, model window)), promoted 2026-11-01 from main after the recorded verification — see [verification](docs/fork/verification.md) |
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
