# piz fork maintenance

## Identity and direction

- **Mode:** patch-carrying fork of [ZCode](https://github.com/zai-org/ZCode).
- **Purpose:** a low-overhead pi terminal client connected to a shared headless
  ZCode core. Preserve upstream runtime capabilities without paying for a full
  runtime and eager plugin/MCP processes in every terminal client.
- **Maintainer / decisions:** bermudi (personal tool; no public support SLA).
- **Focus:** piz. The standalone zcode-allowance build is parked pending a memory
  redesign. Preserve it for reference; do not make it our integration target.
  Request signing is already inherited by piz and is not retired by that decision.
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
| P001 | Request signing and auth/security error policy: adapters request-security-edition, root shared policy | `86ab5b13`, `df8bc4a7`; adapters `client-request-signing.test.ts`; [design](apps/zcode-cli/docs/design/v2/model/client-request-signing.md) | Upstream equivalent verified against our supported credential/request path, or explicit product decision to drop signing |
| P002 | Original TUI controls, paste routing and extracted frontend interfaces: CLI tui package | `090276d9`, `31a770cc`, `c0abfcb1`, `6ee50f58`; tui keymap/paste/exit tests | No remaining piz dependency, or upstream equivalent passes relevant regressions; no wholesale deletion without dependency audit |
| P003 | pi frontend: tui-pi, CLI selection/build wiring, architecture registration | `570ebd20` through `7e859585`; tui-pi tests incl. projection, composer, history, panels, terminal-drain, mentions, shell and wrapping; [design](apps/zcode-cli/docs/design/v2/tui-pi-frontend.md) | Upstream frontend meets our interaction and resource requirements |
| P004 | Shared core and thin attach client: bootstrap socket listener, CLI attach/spawn/build, root shared protocol | `32dc8799` through later attach fixes including `61abbc11`; CLI attach tests, bootstrap socket-listener, root shared attach contract; [design](apps/zcode-cli/docs/design/v2/tui-attach-shared-core.md) | Upstream shared-core mode covers no-plugin isolation, matched builds, sessions, reconnect and low per-client cost |
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

Current installed commands **still use the old trees**:

| Command | Installed source |
|---|---|
| `~/.local/bin/piz` | rapid-cloud worktree's `zcode-attach.cjs`, with core pinned to that worktree's `zcode.cjs` |
| `~/.local/bin/zcode` | reference clone's standalone allowance `zcode.cjs` |

This new checkout contains source only: dependencies and bundles have not been
installed or built. Existing builds/wrappers and live cores were not changed.
The external `zcode-allowance-update` script manages the parked standalone tree;
**do not use it to update piz**.

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
