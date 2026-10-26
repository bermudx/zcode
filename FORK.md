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
| P002 | Original TUI controls, paste routing and extracted frontend interfaces: CLI tui package | `090276d9`, `31a770cc`, `c0abfcb1`, `6ee50f58`; tui keymap/paste/exit tests | No remaining piz dependency, or upstream equivalent passes relevant regressions; no wholesale deletion without dependency audit |
| P003 | pi frontend: tui-pi, CLI selection/build wiring, architecture registration, clipboard image paste (`ctrl+v`/`alt+v`), `/skill` argument completion, kitty key-release filtering in chord dispatch, constant three-row footer (activity + pwd/branch row + two-zone stats row), startup `PiBanner` (logo/version/hints/model scope), `userBg` user message block, `markdown*` terminal theme | `570ebd20` through `7e859585` and later skills/image-paste commits plus `b0468c92`, `76335676`, `4422deb7`, `058685af`; tui-pi tests incl. projection, composer, history (incl. kitty press/repeat/release), panels, terminal-drain, mentions, shell, wrapping, image-paste, banner and footer; [design](apps/zcode-cli/docs/design/v2/tui-pi-frontend.md) | Upstream frontend meets our interaction and resource requirements |
| P004 | Shared core and thin attach client: bootstrap socket listener, CLI attach/spawn/build, root shared protocol; attach `/skill` list + suggestions via `skills/referenceCatalog` additive fields; attach custom-command catalog via new `commands/referenceCatalog` (composer `/` panel + `/help`; expansion stays in the core input facade, local `listAttachCustomCommands` scan removed); herdr pane lifecycle reporter for `zcode-attach` (bounded retry + 30s heartbeat re-assert + always-on throttled stderr diagnostics, since a single lost `working` report pins herdr idle/done for a whole turn) plus `ZCODE_ATTACH_CORE` spawn marker suppressing the shared core's zcode hook | `32dc8799` through later attach fixes including `61abbc11`, plus `887668fb`..`d68db6ab` and the 2026-10-24 reporter-durability commit; CLI attach tests, bootstrap socket-listener + skill-reference-catalog, root shared attach contract, `attach-herdr-reporter` (incl. retry/argv-reuse/heartbeat regressions) + `app-server-spawn` marker tests; [design](apps/zcode-cli/docs/design/v2/tui-attach-shared-core.md) | Upstream shared-core mode covers no-plugin isolation, matched builds, sessions, reconnect and low per-client cost |
| P005 | Interactive unresolved slash input routed as a normal prompt | piz `2f55f457`; allowance has a different patch `c6b36ad5`; coverage sufficiency not established | Upstream equivalent verified on piz, including recognized slash commands |

**Pending audit, not a carried-patch claim:** allowance-only `da309372` and
`bac3682c` provide queue/transcript behavior absent from piz's ancestry; compare
behavior before deciding whether to port. Do not blindly cherry-pick these or
the different slash-input fix. lucky-field is contained in allowance, not in piz.

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
| `~/.local/bin/piz` | this checkout's `packages/cli/dist-runtime/` matched pair (written only by `scripts/promote-piz.sh`, which refuses to run from anything but a clean `main`); core pinned to the same dir's `zcode.cjs` via `ZCODE_SERVER_BIN`. Currently the 086f08c7 pair (steer/queue parity + live fix: drained steer/queued inputs render as transcript user rows, Steering/Follow-up labels), promoted 2026-10-25 from main after the verification matrix incl. live steer — see [verification](docs/fork/verification.md) |
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
