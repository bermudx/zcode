# Single-core discovery — evidence report

Date: 2026-11-08. Scope: bermudi/piz issue #10, discovery only. No implementation,
no design decision, no test execution. Product requirement (operator, frozen):
**one core process for all workspaces, sessions and frontends** (terminal `piz`
attach and `piz acp`), workspace identity/config/permission/session/signing and
no-plugin isolation preserved inside it. Frozen prior evidence:
`docs/fork/reports/2026-11-08-edit-from-here-session-loss.md` (scope-retirement
kills a reused spawned core; `proto.sessionNotFound` after reconnect; `detached:
true` does not escape T3 scope; control survived plain EOF).

Paths below are relative to repo root unless absolute. Line numbers verified
this session.

---

## 1. Client spawn side — `app-server-spawn.ts` and callers

File: `apps/zcode-cli/packages/cli/src/app-server-spawn.ts`

- `resolveSocketPath(workspace, options)` (L67–84): socket name is
  `core-<sha256(resolveWorkspaceKey(workspace))[:16]>.sock` under
  `<dataBaseDir>/.zcode/v2/sockets/`; win32 → `\\.\pipe\zcode-core-<hash>`.
  `dataBaseDir` = option ?? `ZCODE_DATA_BASE_DIR` ?? `homedir()`.
  `resolveWorkspaceKey` = `workspaceIdentity?.trim() || workspacePath`
  (`packages/shared/src/task-realtime-core.ts` L84–89). **This is the point that
  makes cores per-workspace: socket selection is workspace-keyed.**
- `ensureServer` (L91–232): probe socket → `O_EXCL` lock `<socket>.lock` (pid
  payload) → `spawn(<zcode|ZCODE_SERVER_BIN>, ["app-server", "--socket", path,
  "--no-plugins", "--cwd", workspace.workspacePath], {detached: true,
  stdio: "ignore", env})` (L145–181), `child.unref()`. **Correction
  (2026-11-08): the spawn options carry NO `cwd` — the workspace reaches the
  child only via the `--cwd` argv flag; an earlier version of this report
  wrongly listed `cwd: workspace.workspacePath` in the spawn options.**
  Spawned env adds `ZCODE_WORKSPACE_IDENTITY =
  resolveWorkspaceKey(workspace)` (L162–163) and `ZCODE_ATTACH_CORE=1` (L168).
  Waits ≤60 s probing the socket (L19). `.pid`/`.info` are written by the
  *server* after bind, not by the launcher (L195–196 comment;
  `zcode-protocol-entrypoint.ts` L654–679).
- Stale-lock reclaim: atomic rename + inode check (L265–319); lock released only
  by owning pid (L321–332).
- Schemas: `appServerInfoSchema` = `{version, workspaceIdentity, startedAt}`
  (`packages/shared/src/app-server-attach/contract.ts` L13–19);
  `appServerAttachWorkspaceSchema` = `{workspacePath(nonblank),
  workspaceIdentity?}` (L23–27). **No production client reads `.info`/`.pid`
  for trust** — only `tests/app-server-spawn.test.ts` parses `.info`, and the
  version-mismatch hint suggests `kill $(cat '<socket>.pid')`
  (`attach/attach-command.ts` L218). `.info.workspaceIdentity` currently stores
  the workspace key — semantics change if the core is no longer workspace-bound.

Callers of `ensureServer`:

- `attach/attach-command.ts` `runAttachCommand` (L87–): builds workspace from
  `deps.cwd()` + `env[ZCODE_WORKSPACE_IDENTITY]` (L104–109), workspaceRef with
  `workspaceKey` (L112–116), `ensureServer({env, version, workspace})` (L142);
  `AttachRuntime.ensureConnected` re-runs `ensureServer` on every reconnect
  (L152–154). `session/create` and `session/resume` carry `workspace:
  workspaceRef` (L194–208). Workspace needed for **both** transport selection
  and session params.
- `acp/acp-sessions.ts` `AcpCoreSessions` (L60–195): `lanes` Map keyed by **cwd
  string** (L62) — one `AttachRuntime` per cwd, i.e. per-workspace socket per
  cwd. `createLane` (L163–182) reads identity from `options.env
  [ZCODE_WORKSPACE_IDENTITY]` (L164) — **the same client env value is applied to
  every cwd lane**; `workspaceKey = resolveWorkspaceKey({identity, cwd})`
  (L167); `ensureConnected` → `ensureServer({env, version, workspace:
  {identity, cwd}})` (L184–194). `open(cwd)` / `resume({cwd, sessionId})` are
  per-session calls over the lane.
- `acp/acp-agent.ts` ≈L253–279: ACP `session/new` `params.cwd` →
  `sessions.open(cwd)`; **`session/resume`** → `sessions.resume({cwd,
  sessionId})`. **Correction (2026-11-08): the method is `session/resume`,
  not `session/load` — `session/load` is deliberately unimplemented
  (`loadSession: false` advertised at initialize).**
- Entry wiring: `zcode attach` → argv-rewrite to `tui --tui-frontend=pi
  --shared-core` (`attach/attach-argv.ts` L5–7, `main.ts` L19–21);
  `run.ts` L35–36 imports `runAttachCommand`/`runAcpCommand`; `attach-main.ts`
  is the `zcode-attach`/`piz` binary; `piz acp` → `runAcpCommand` →
  `acp/acp-main.ts` `runAcpStdio` L141 (`new AcpCoreSessions({env, version})`).

Minimal public types that encode per-workspace core:

| Type/artifact | What it encodes | Needed for |
|---|---|---|
| `AppServerAttachWorkspace` (`contract.ts`) | spawn input = workspace | transport discovery (socket hash) |
| `appServerInfoSchema.workspaceIdentity` | info file records workspace key | operator metadata only |
| socket name `core-<workspaceKeyHash>.sock` | one socket per workspaceKey | transport selection |
| `zcodeWorkspaceRefSchema` (`packages/shared/src/zcode-protocol-legacy-types.ts` L36–43) | `{workspacePath, workspaceIdentity?, remoteSessionId?, workspaceKey}` | **session** params (`session/create`, `session/resume`, `session/list`, runtime-preferences routing) — independent of transport |

Session vs transport: `AttachRuntime.connect()` only needs `socketPath`
(`attach-tui-options.ts` L248–266); workspace is consumed by `session/create`,
`session/resume` (incl. cold-recovery in `recoverSession`, L453–480) and
`session/list` for `-c`/`--resume` (L119–192). ACP lanes need the workspace ref
only inside per-session requests. **Nothing in the protocol requires the socket
choice to be workspace-derived.**

---

## 2. Process-wide resources in `zcode-protocol-entrypoint.ts`

`runZCodeProtocolAgent(options)` — `apps/zcode-cli/packages/bootstrap/src/
zcode-protocol-entrypoint.ts`. All resources below are created **once per
process** before accepting connections.

| Resource | Derived from | Per-session/workspace hook today | Singleton leak evidence |
|---|---|---|---|
| Config `configResult` | `createConfig({env: options.env, cliOverrides: NO_PLUGINS_CONFIG_OVERRIDES?})` L189–192 — **no `workingDirectory` passed**, so project-config discovery is skipped at entry (`adapters/config/config-factory.ts` L153–162 discovery is cwd-based). User config + env + CLI overrides only. | Per-session app config comes via `createZCodeApp` deps + `runtimeConfig` from `createRecord` (server-operations.ts L3843–3950). | Workspace A's user/env config is global anyway; **project-level config is NOT loaded process-wide** — each app's `createConfig` resolves `workingDirectory` per workspace. Gap to verify: whether any entry-level config value (e.g. `sessionDbPath`) still resolves relative paths against the inherited spawn cwd (`resolvePath` in file-config adapter). |
| `sessionStore` | `openProtocolStartupStorage({dbPath: getSessionDbPath(configResult)})` L193–207 → `app/session-store.ts` L139–145 → default `~/.zcode/cli/db/db.sqlite` (absolute). | Store is shared by all servers/sessions already. | A *relative* configured `sessionDbPath` would resolve against the spawner's cwd — singleton must not inherit it. Default absolute path is already workspace-independent. |
| Provider registry runtime | `startProcessProviderRegistryRuntime(runtimeEnv, {standalone:{}})` L214–224; credential/provider paths from `resolveNodeProviderRuntimePaths(env)` + `ZCODE_BUILTIN_*` env prepared by `prepareCliProviderRuntimeEnv` (`cli/src/provider-runtime-env.ts` L53–103, `dataBaseDir` = `ZCODE_DATA_BASE_DIR` ?? homedir). | Process-wide registry; per-request model selection flows via `runtimeConfig.modelSelection` (createRecord L3850). | Provider catalog, default model, credentials are machine-global — already correct for a singleton. |
| Auth/signing port | Standalone: `createStandaloneProviderRuntimeHeadersPort(credentialStore, env)` inside process-provider-registry-runtime.ts L142–144; socket mode uses this since no Host answers reverse requests. | Priority in `createWorkspaceZCodeApp` (`workspace-model-runtime.ts` L80–83): `options.port` > `context.deps.providerRuntimeHeadersPort` > `createProviderRuntimeHeadersPort(context, workspace)` — the last is per-workspace and reverse-requests `interactionRequestProviderRuntimeHeaders` carrying workspace/sessionId/turnId/account scope (`zcode-protocol/provider-runtime-headers.ts` L20–107). | Signing is credential-scoped, not workspace-scoped; preserved under a singleton. `standalone-account-provider-runtime.ts` revalidates identity/OAuth/project-token scope per request — no workspace leakage found. |
| Official MCP auth headers | `createOfficialMcpAuthHeadersPort` L266–300: `resolveContext` → `latestProtocolServer` (most recent connection); `resolveWorkspace` falls back to **`options.cwd`** (L281–289) and process `workspaceIdentity` from `ZCODE_WORKSPACE_IDENTITY` env (L273, L293). | Per-request `request.workspaceIdentity/workspacePath` overrides the fallback (`official-mcp-auth-port.ts` L51–54). | **First-spawner cwd/identity becomes the process-global fallback** for MCPs that don't pass a workspace — must not be inherited by the singleton. |
| `officialCommandEndpoint` | `createOfficialCommandEndpoint` L304–315; auth header port resolves context via `latestProtocolServer`; `envForSession(sessionId, workspace)` is per-session (used L496–497). | `createOfficialCommandAuthHeadersPort` builds the workspace ref from the *requesting session's* workspace (official-mcp-auth-port.ts L87–135). | Context routing = latest connection; a request from workspace A's session could ride workspace B's connection — already the existing cross-connection seam (see §3). |
| MCP/plugin policy | `NO_PLUGINS_CONFIG_OVERRIDES` = `{features:{mcp:false}, plugins:{enabled:false}}` (`app/app-config-options.ts`); applied via `createConfigCliOverrides` when `options.noPlugins`; attach/ACP always spawn `--no-plugins`. `mcpConnectionPool` created L319–349 with **`workingDirectory: options.cwd`** and `officialMcpAuth` — skipped when `features.mcp===false` (L319–322). | Pool lease per server: `mcpConnectionPool.acquireLease({leaseId:"protocol-settings"})` L350; per-app lease inside `createZCodeApp` dep L485–489. | Under `--no-plugins` the pool never materializes — safe today. A plugin-enabled singleton would bind the pool to the first spawner's cwd and its auth to `latestProtocolServer`. |
| Logging/telemetry | `telemetryEnv` + `ZCODE_TELEMETRY_DEVICE_MID` folded into every app env L479–483; `mcpTelemetrySink`/`mcpResourceSink` broadcast to **all** `attachedConnections` L599–616. | Per-session `traceContext` created in `createRecord` L3821. | Telemetry env is machine-global; broadcast fans events to every attached client (workspace-agnostic by design). |
| Spawn env → app env | `createRecord` passes `env: context.deps.env` = spawn-time `options.env` (server-operations L3844; entrypoint L461–483 merges telemetry). | None observed — env flows verbatim to every workspace's app. | **`ZCODE_WORKSPACE_IDENTITY` in the spawned env reaches every app's env.** Any downstream env reader sees the first workspace's identity. Known downstream consumer: `.info` self-registration (below). Whether `createZCodeApp`'s config layer re-reads `ZCODE_WORKSPACE_IDENTITY` from env was not traced — gap. |
| `.pid`/`.info` self-registration | L654–679: only when `process.env[ZCODE_WORKSPACE_IDENTITY]?.trim()` — uses **process.env**, writes `<socket>.pid` and `<socket>.info` `{version, workspaceIdentity: identity, startedAt}`. | — | Identity recorded is the workspace key; under a singleton this either disappears (env stripped) or records the first spawner — matches §1 finding that nothing consumes it. |
| Spawn `cwd` | `options.cwd` → `context.deps.cwd` per server (L502). | Fallback only: `buildWorkspaceRef({workspacePath: context.deps.cwd ?? process.cwd()})` in `materializeSessionRecord` (server-operations L3787, L3803) and `createRecord` L3816–3819 — **used only when the client sends no `workspace` param**. | Any client that omits `workspace` gets the first spawner's cwd — protocol clients today always send it (attach L194–208; ACP lanes L167). |
| `latestProtocolServer` | Set to most-recently-attached server L529; re-pointed on detach/disconnect L371–372, L562–563. | Process-global callback target for MCP elicitation/notifications L324–333 and official-MCP auth L266–268. | Cross-connection attribution is "whoever connected last" — pre-existing seam that becomes load-bearing (and more visible) under one core. |
| Idle shutdown | `exitWhenDrained` L439–444: `lifecycle.requestShutdown()` when `attachInFlight==0 && attached+detached == 0`, evaluated by the 30 s sweep **after** reaping. | — | **Correction (2026-11-08): last client disconnect does NOT exit the core immediately.** Detach moves the connection to `detachedConnections`; the sweep only reaps `isReapable` entries (no pending reverse requests, no active work, adoption window expired) — a detached owner with resident sessions survives up to the 10 min adopt window, and busy work blocks reaping entirely. `exitWhenDrained` fires only once both pools are empty *and* in-flight attaches drained. Still the only "unused" exit path besides signals — needs an owner decision (evidence only). |

Env identity that must not be inherited by the singleton: `ZCODE_WORKSPACE_IDENTITY`
is today (i) the client-side socket-hash input, (ii) injected into spawn env
(app-server-spawn L162), (iii) the process-global official-MCP-auth identity
(entrypoint L273/293), (iv) the `.info` trigger+value (L657), (v) applied by ACP
lanes to *every* cwd (acp-sessions L164). `ZCODE_ATTACH_CORE=1` (L168) is a
herdr-ownership marker — orthogonal. `ZCODE_SERVER_BIN` selects the binary.
`fork-tests.mjs` STRIPPED_ENV already strips `ZCODE_WORKSPACE_IDENTITY`,
`ZCODE_ATTACH_CORE`, `ZCODE_SERVER_BIN` to keep fake-core tests honest.

---

## 3. Multi-workspace/multi-client session handling (exists today)

`zcode-protocol/server.ts` + `server-operations.ts` + `v4-bridge.ts`:

- One `ZCodeProtocolAgentServer` **per accepted socket connection**
  (entrypoint `attachConnection` L456–597). Each has its own `context.sessions`
  Map, `claimedSessionRecords`, `sessionResidentPool`, `v4Gateway`,
  `inputPrediction`, pending + parked reverse-request maps. **Sessions of two
  workspaces connected through one client live in one context; sessions of two
  *clients* live in two contexts on shared process resources** — both shapes
  already coexist.
- `record.workspace: ZCodeWorkspaceRef` per session (server-types L147);
  `workspaceKey` is the isolation unit: `listSessions` filters live records by
  `workspace.workspaceKey` (server-operations L1884–1898) and store queries by
  `directory` (L1845–1849); v4 sessions-index `getSessionWorkspaceId` →
  `record.workspace.workspaceKey`, `listWorkspaceSessionIds` same filter
  (v4-bridge L1791–1813); `resolveWorkspaceRefFromId` handles local path vs
  `remote:ssh/wsl/docker:…:<path>` identities (L1266–1278).
- Per-session workspace binding in `createRecord` (L3816–3970):
  `runtimeConfig.workingDirectory = workspace.workspacePath` (L3891),
  `workspaceIdentity` (L3894), per-session `permissionBroker`,
  `automationPort`, `workspaceHookReviewHost` labeled by workspace (L3938–3944).
- Ownership/adoption — **one owner, no second registry needed**:
  `findDetachedSessionOwner` dep → entrypoint L420–427 scans detached *and*
  still-draining attached entries for `isDetached() && hasResidentSession`;
  `adoptDetachedSession`/`tryAdoptDetachedSession` (server.ts L1452–1464);
  `claimSessionRecord` migrates the record plus parked reverse requests
  (`sessionOwnerRedirects` L325–328); event fan-out follows `record.ownerContext`
  (createRecord L3981–3989 comment).
- Attached/detached/orphan accounting:
  - `markClientDetached` (server.ts L477–505): connection → `detachedConnections`;
    session-scoped pending reverse requests parked with
    `DETACHED_CLIENT_REQUEST_TIMEOUT_MS` = 10 min (L181); non-session requests
    failed.
  - `DETACHED_SESSION_ADOPT_WINDOW_MS` = 10 min (L189).
  - `isReapable` (L1495–1517): detached, no pending requests, no active
    abort/turn/finalization/foreground execution, no residency-blocking work,
    and records empty or adoption window expired.
  - Sweep: `reapDetachedConnections` every 30 s (`DETACHED_SERVER_SWEEP_INTERVAL_MS`
    entrypoint L101, timer L693–694, reap L446–452 then `exitWhenDrained`).
  - `disconnectClient` = hard terminate, stops foreground work; `shutdown()`
    closes runtimes/resources without product `session/close`.
- `attachInFlight` counter guards the accept→attach gap (L430–444, L622–639).
- Cross-connection notifications: `mcpTelemetrySink`/`mcpResourceSink` iterate
  **all** `attachedConnections` (L599–616); `latestProtocolServer` re-point
  logic L371–372/562–563.
- `sessionWorkspaceRoutingEnabled` — set when the Host advertises the
  capability (server.ts L1007–1008); gates `workspace` on
  `sessionRequestRuntimePreferences` (L3660) and `subagentsReadRuntimeConfig`
  (L3917). **Attach/ACP thin clients do not advertise it** — `AttachRuntime`
  answers `sessionRequestRuntimePreferences` locally
  (attach-tui-options.ts L294–296) and ignores workspace. Relevant if the
  singleton needs workspace routing on thin-client reverse requests.
- Reconnect/cold-resume exists client-side: `AttachRuntime.recoverSession`
  re-subscribes, on `sessionUnavailable` issues `session/resume` with the
  workspace ref then resubscribes (attach-tui-options.ts L452–480).
- Session-not-found boundary: `proto.sessionNotFound` from CommandInbox when the
  revision/session is unknown (`command-inbox.ts` L325–337 area,
  `host.sessionExists` gate) — the observed post-kill error.

---

## 4. Process-owner / lifecycle mechanisms

piz (supported mechanisms today):

- `ensureServer` detached spawn: `detached:true, stdio:"ignore", unref()`
  (app-server-spawn L145–181) — survives parent exit *vis-à-vis signals/stdio*,
  but **inherits the spawner's cgroup/scope** (frozen reproduction: systemd
  scope SIGTERM killed the reused core).
- `createProtocolProcessLifecycle` — signal-driven shutdown; socket mode sets
  `closeOnInputEnd:false` (`main.ts` L30–35) so the core does not die on stdin
  EOF (matches frozen control result).
- `.pid` self-registration for operator inspection only.
- Core idle exit = `exitWhenDrained` (§2). No service/supervisor mode exists in
  piz today — the spawning client is the de-facto owner; that is the incident.

T3 seams (bounded reads, `/home/daniel/build/t3code`):

- `packages/shared/src/AgentScope.ts` — `wrap({command,args,name,threadId,env,
  survivesRestart,shared})` → `systemd-run --user --scope`; `stop(unit)`,
  `kill(threadId)` (skips `shared` ≈L347), `clear(threadId)`, `oomKilled`.
- `apps/server/src/process/agentScope.ts` — Linux-only (default elsewhere
  ≈L102); scopes under `app-t3code-agents.slice` / owned slice; `shared:true` +
  OOM support → `OOMPolicy=continue` + `--collect` and untracked kill
  (≈L402–421); `survivesRestart` selects the slice; `stop` guards `t3code-*`
  name + active + not-oom (≈L319–343); `stopLeftoverAgents` at server start
  (≈L130–155). **`shared` affects OOM/tracking, not membership — descendants
  still die with the scope.**
- `packages/provider-acp/src/server/AcpSessionRuntime.ts` — **Correction
  (2026-11-08): `AcpSessionRuntime` lives in its own file, separate from
  `adapter.ts`.** It wraps the ACP process in `agentScope.wrap({name:"acp",
  threadId})` (≈L1418–1428) with a `stopScope` finalizer (≈L1431–1435,
  L1475–1480). In `adapter.ts`: `startReplacementAcpRuntime`
  (≈L6922–7092) starts the replacement scope and only then
  `Scope.close(previousScope)` (≈L7065–7073) — **new client reuses the old
  core's socket, then old-scope retirement kills the shared core** (frozen
  incident mechanism). `rollbackThread` ≈L9296–9350.
- `packages/provider-opencode/src/server/OpenCodeRuntime.ts` —
  `startServerAttempt` (≈L494–704): `agentScope.wrap({name:"opencode",
  shared:true})` (≈L514–520) for the *provider* process; the spawned shared
  server is tracked in `OpenCodeServerLedger` (≈L528–575) and its scope
  finalizer kills the child process group (≈L558–573).
- `packages/provider-opencode/src/server/OpenCodeServerLedger.ts` — JSON
  entries `<stateDir>/opencode-servers/<pgid>.json` `{pgid, pid, startTime,
  command, port, stateDir, owner:{pid,startTime}}`; `reapOrphans` kills groups
  whose **owner** (T3 server pid+startTime) is dead, after validating process
  identity (Linux /proc, darwin `ps`). Mechanism reference only — ownership
  keyed to the *server* process, not to any agent scope.

Platform support: systemd user scopes are Linux-only; darwin relies on
process-group kill; win32 has neither — socket discovery + `.info`/pid metadata
is the only portable mechanism piz currently has. `detached:true` /
double-forking remain ruled out.

---

## 5. Test inventory — exact commands and smallest cases

Runnable commands (from `AGENTS.md`, `apps/zcode-cli/package.json`,
`scripts/fork-tests.mjs`; none executed):

- `mise exec -- node apps/zcode-cli/scripts/fork-tests.mjs` — selected tier;
  flags `--full`, `--promote-gate`, `--package <name>`, `--dry-run`.
  ALWAYS_RUN: `packages/adapters/tests/client-request-signing.test.ts`
  (signing gate) and `packages/bootstrap/tests/socket-listener.test.ts`
  (socket listener contract). EXTRA_NODE_TESTS for `@zcode/cli`:
  `tests/attach-resume-target.test.ts`. STRIPPED_ENV strips
  `ZCODE_WORKSPACE_IDENTITY`, `ZCODE_ATTACH_CORE`, `ZCODE_SERVER_BIN`,
  `HERDR_*` — ambient env otherwise dooms fake-core harnesses.
  `REQUIRES_BUILD["@zcode/cli"] = ["dist/zcode.cjs"]` — node:test files exec
  built artifacts; missing build = NOT RUN.
- `pnpm --dir apps/zcode-cli test` / `typecheck` / `lint` — full CLI scripts.
- `scripts/measure-attach.sh` — N PTY attach clients against one core via
  PATH `zcode` + `ensureServer` (real processes, memory measurement).
- Frozen harness (do not rerun): `mise exec -- node
  scripts/repro-acp-core-lifetime.mts --runtime <dist-runtime>` — real
  binaries + systemd scope retirement (`--case scope-cleanup` /
  `--case plain-eof`).

Relevant existing test files:

- CLI: `tests/app-server-spawn.test.ts` (socket derivation incl.
  identity-hashed case L106–141, lock/reclaim/reuse, `ZCODE_ATTACH_CORE`
  marker); `attach-adapter/client/commands/interactions/herdr-reporter/
  osc-status-reporter/resume-fallback/resume-target/exit-resume-hint/
  model-option/skills/binary.smoke` tests; `acp-sessions.test.ts` (real-lane
  connect/close L130, resume waiter L141, close-failure L161, fresh transport
  L178); `acp-agent/project/main/commands` tests; `cwd-option.test.ts`;
  `provider-runtime-env.test.ts`; `cli.unit.test.ts`.
- Bootstrap: `socket-listener.test.ts`, `zcode-protocol.test.ts`,
  `zcode-protocol-transport.test.ts`, `v4-gateway.test.ts`,
  `v4-gateway-sessions-index.test.ts`, `session-resident-pool.test.ts`,
  `workspace.test.ts`, `subagent-workspace.test.ts`,
  `mcp-project-config.test.ts`, `account-config-delivery.test.ts`.
- Shared: `packages/shared/src/app-server-attach/contract.test.ts` (schema +
  `resolveWorkspaceKey` fallback). **Type/schema duplication root shared vs
  CLI:** CLI imports contract + protocol schemas from `@zcode/shared` — no
  duplicated schema source observed; root `packages/shared` is the single
  definition site (gap: not exhaustively diffed).

Smallest cases that would fail absent the fix:

(a) *One core across two workspaces/frontends* — at discovery time
`resolveSocketPath({workspacePath:A}) ≠ resolveSocketPath({workspacePath:B})`
by construction (the old app-server-spawn.test.ts pinned the workspace-keyed
derivation). **Correction (2026-11-08, implementation landed):**
`resolveSocketPath` no longer takes a workspace — it returns the fixed
`<dataBaseDir>/.zcode/v2/sockets/core.sock`; the rewritten test pins the
data-root derivation and the ACP test asserts two cwd lanes converge on one
endpoint. The remaining check below (b/c) is unchanged.

(b) *Retiring spawning client cannot kill shared core* — only demonstrable with
real binaries + systemd scope retirement (frozen repro artifacts already
captured). Any fixture-level claim here must be labeled fixture-only: no in-repo
test exercises cgroup scope retirement; `detached:true` unit tests prove
stdio/signal detachment only.

(c) *Workspace isolation inside one core* — session-level pieces exist and are
tested (`listSessions` workspaceKey filter, v4 sessions-index bucketing,
`record.workspace` binding). **Gap:** no existing test puts two different
`workspaceKey`s through *one* socket-mode server process; multi-workspace
coverage today is per-context (one client, one workspace) or v4-gateway unit
level. A minimal real test: one `runZCodeProtocolAgent` + two `AttachClient`s
on one socket, distinct workspace refs, assert `session/list` scoping — needs
the bootstrap test harness (node:test + fixtures; no model calls; no build if
tsx-run, but the package script does exec `dist` for some tests — check per
file).

(d) *Last-client/active-work cleanup* — `exitWhenDrained` + `isReapable` logic
exists; **no dedicated test found** covering drained-exit after multi-client
detach (gap). `socket-listener.test.ts` covers listener ownership/stale-file
reclaim only.

Real-interface test possible today without builds/model calls: the
`app-server-spawn.test.ts` pattern — fake `app-server` binary bound to a unix
socket, real `ensureServer` + lock/probe logic, real `.pid`/`.info` files —
extends naturally to "two workspaces → ? sockets" as soon as the target
derivation is decided. Bootstrap-side, `socket-listener.test.ts` +
`zcode-protocol.test.ts` fixtures drive real sockets without models.

---

## Evidence gaps (explicit)

1. Whether `createZCodeApp`'s config layer re-reads `ZCODE_WORKSPACE_IDENTITY`
   (or other workspace env) from the merged app env — not traced this session.
2. `.info`/`.pid` semantics under a singleton (fields record workspace key);
   nothing consumes them today — decision needed whether to keep/repurpose.
3. No existing test for two workspaceKeys in one socket-mode server (§5c) or
   for drained-exit timing (§5d).
4. `sessionResidentPool` and `v4Gateway` are per-connection; residency/resource
   accounting when many workspaces share one process is untested.
5. Reverse-request ownership under one core: `latestProtocolServer` last-writer
   attribution and `sessionOwnerRedirects` were observed, not exhaustively
   mapped for multi-client workspace routing (thin clients lack
   `sessionWorkspaceRoutingEnabled`).
6. Whether `AcpCoreSessions`'s single env-derived identity should apply to all
   lanes under one core (it currently poisons every cwd's workspaceKey the same
   way).
7. Root `packages/shared` vs CLI schema duplication — imports observed unified;
   not exhaustively audited.

## Blocking questions for the lead (none found as contradictions)

No contradiction blocks the design: the one-core requirement is achievable
against observed seams — session/workspace data is already parameterized
per-session; the workspace coupling lives almost entirely in (i) socket
derivation, (ii) spawn argv/env, (iii) spawn-cwd fallbacks, (iv)
process-global callbacks keyed to `latestProtocolServer`, and (v) the
owner/lifetime question (which existing mechanism — scope-adjacent spawn,
ledger, or supervisor — owns the singleton is a product decision, not
evidence).

## Touched files

- `docs/fork/reports/2026-11-08-single-core-discovery.md` (this report; created)
