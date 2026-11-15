---
name: session-management
description: Required reading before modifying ZCode session management (left-side task list, tasks-index.sqlite, sessions-index, CLI session store, title/status/pinned/archived/unread/deleted, virtual projects and roots, workspace identity, related migrations). It distills the design rationale, historical bug root causes and invariants of the 2026-09 "virtual project and data-ownership consolidation" refactor and the grouping restore into a checklist, so future maintainers know why it was designed this way and which lines must not be crossed.
---

# Session Management Design Distillation

Use this skill when the change touches any of the following: `packages/services/src/session/taskIndexRepo.ts`, `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts`, `zcodeTaskServiceAdapter.ts`, the `packages/ui` sidebar / task list / project tree, `apps/zcode-cli/packages/adapters/src/storage/session-store/*`, the sessions-index protocol, workspace / project / roots data structures, or migrations in either database.

Authoritative specs: `docs/superpowers/specs/2026-09-09-virtual-project-design.md` and `docs/ui/task-grouped-view.md`. The 2026-10-13 grouping-restore ruling supersedes the earlier plan of merging Groups into Projects. This skill does not repeat the specs; it only explains the "why" and "how to avoid the pitfalls".

## 1. One-Sentence Principle

**Session facts belong to the CLI; organization state belongs to the Host; every field has exactly one writer.**

```text
CLI  db.sqlite      existence (soft-delete time_deleted), title+title_source, time_created/updated, last_outcome, message body, goal, fork, trace
Host tasks-index    project_id, pinned, archived, unread_at(+CAS), sort_order, projects/roots/hosts, scheduled/idle-time; the controller separately stores cross-device group members and their order
                    cli_* columns = read-only mirror of CLI facts, sole writer taskIndexSyncer
Forbidden: CLI writes the app DB; Host writes db.sqlite; Host writes Date.now() or snapshot-derived values into any cli_* column
```

### Why

Before the refactor there were 30+ Bugfix comments around title / status (`rg "Bugfix" packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts packages/services/src/session/taskIndexRepo.ts`), almost all in two categories:

1. The Host writing session facts on the CLI's behalf: `updated_at = Date.now()` (rename / status changes) diverged from the CLI's `time_updated`, causing sort-order jitter and forcing the UI to trust only sessions-index `lastActivityAt`; rename wrote locally first and then notified the CLI best-effort, warning only on failure, so the two sides disagreed on "is this a manual title"; `task_status` was inferred backwards from the snapshot, always completed after cold start, with leftover running states absorbed only by UI rules.
2. The CLI deciding the row set on the Host's behalf: in 3.4.0 a sessions-index snapshot missing summary made historical tasks disappear from the Grouped view (`docs/superpowers/specs/2026-07-20-sidebar-task-row-authority-design.md`); the CLI cold seed resurrected sessions the app had deleted, and the app could only suppress them with tombstones.

Conclusion: the question is not "which database is better" but "who knows this fact first-hand". What happened in a session is known only to the CLI; what the user did to the list is known only to the Host/UI; the CLI is one process per workspace and may be offline, so a cross-workspace list must be persisted on the Host side (the `onDynamicWorkspaceEvent` comment explicitly forbids spinning up an Agent just to build the list).

## 2. Invariants (check each one before changing code)

| #   | Invariant                                                                                                                                                                   | Typical symptom when violated                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| I1  | `workspaceKey = workspaceIdentity?.trim() \|\| workspacePath` expresses identity isolation only; execution paths always use `workspacePath` / `root_path`                   | remote identity written into cwd (the 3.4.2 incident)               |
| I2  | a session's bound directory (cwd) never changes after creation; moving a project only changes `project_id`; a group move only changes members and order                     | provider / memory / permissions missing after cold start            |
| I3  | other roots = `additionalDirectories` only (skills / commands / subagents / writable scope); AGENTS.md/settings/MCP/hooks/plugins/memory/permissions follow bound dir chain | another directory's executable config leaks in; MCP/hook clashes    |
| I4  | the CLI knows nothing about projects; the protocol carries only directory lists                                                                                             | a project concept in the CLI = design drift                         |
| I5  | the app DB decides the row set; sessions-index only fills in live fields (phase, lastActivityAt, pending interaction)                                                       | tasks vanish from / reappear in the list                            |
| I6  | sort time = CLI create/activity mirror; running/prewarming first; running: stable by create time; normal: prefers create/update; pin/archive/rename/unread don't move it    | a renamed task jumps to the top                                     |
| I7  | unread uses CAS (`expectedUnreadAt`); only an explicit Host `unreadSignal` may create unread                                                                                | phone read state overwritten by desktop; list flickers each turn    |
| I8  | title priority: user override(`title_source=custom`) > model-generated > first prompt > placeholder "New session"; snapshots never overwrite an override                    | manual title flashes back                                           |
| I9  | delete = CLI soft delete (`time_deleted`); the app's `deleted` is a mirror; cold seed / listSessions / TUI must filter it                                                   | a deleted session resurrects                                        |
| I10 | schemas are add-only: never drop columns or change old column semantics; new columns nullable/defaulted; keep the `ON CONFLICT(workspace_key, task_id)` unique constraint   | old version crashes after downgrade                                 |
| I11 | derived directory hashes (`sessions/{hash}`, `agent-config/{provider}/{hash}`, CLI memory) take real dir + identity, project-independent, never migrate                     | config / memory lost after upgrade                                  |
| I12 | phone remote-control bridge / queue / snapshot keys use only workspaceKey; the desktop-continuous vs phone-replayable boundary never changes                                | remote control crosses sessions                                     |
| I13 | Host org state lives only in original columns; `deleted` / `title_overridden` = "intent pending handoff to CLI", reconciled table-wide at startup, not just NULL backfill   | downgrade-window deletes / renames lost after re-upgrade            |
| I14 | a missing sessions-index snapshot is not a deletion; deletion can come only from `session.removed` or from `sessionsIndex/reconcile` returning deleted                      | tasks resurrect or get wrongly deleted after lost events            |
| I15 | restoring a CLI DB backup must disable foreign keys and verify row counts / hashes; `message`/`part` are ON DELETE CASCADE on `session`, so a bare DELETE wipes bodies      | all messages lost after restore                                     |
| I16 | Host resolves additional dirs centrally across create / explicit resume / V4 subscribe cold recovery; exclusion targets session cwd, not primary; no refresh while one runs | history tasks miss additional dirs; sessions mis-scoped after swap  |
| I17 | unassigned sessions: placed once at first discovery (bit 8); no auto projects; unplaced stay visible in tasks area/timeline/groups; missing app row = unassigned `[]`; missing project / read failure = explicit error | a removed workspace resurrects; a session later gets quietly moved into a project; new TUI sessions fail to open |

## 3. Key Rulings at a Glance (details in spec section 3)

- 2026-10-10 remote ruling: local and remote projects are flat; the Host is not a group. For remote, create a single-directory project first, then the session; creating without a project or dragging in extra directories is not allowed. Unified project order belongs to the controller's sidebar preferences. See `docs/superpowers/specs/2026-10-10-session-manage-upstream-integration.md`.
- Sidebar = global pinned area (sessions + pinned projects) → projects area → tasks area (`project_id IS NULL`, any cwd); `~/.zcode/workspace/*` serves only as the default working directory for globally created tasks. Filters include by project / by group / recently updated; real directories are not nodes, and the old two-level switcher is not coming back.
- Projects: local projects have 0..n same-host roots plus one primary directory, remote projects exactly one fixed directory; the same directory can belong to multiple projects; a new session's cwd = the primary directory; only a local project with 0 roots gets `~/.zcode/workspace/<ts>` auto-created and added as the primary root.
- Deleting a local project or an authoritative online remote project = soft-deleting the container; sessions keep their membership and stay visible in the timeline; creating a new project whose roots set is exactly equal prompts a restore; permanent deletion is not offered. Deleting a remote project while offline removes only the local entry and cache; it does not trigger remote soft delete or restore.
- Removing a root from a local project or changing its primary directory does not affect already-created sessions, scheduled tasks, idle-time tasks or Bots (they freeze cwd and additional directories at creation time); roots changes take effect for running sessions at their next resume.
- Same-named skills / subagents from different roots coexist; the CLI assigns the qualified name `<rootName>/<name>`.
- Groups: the controller-side Host is the sole owner of cross-device groups, and the phone reuses that Host; groups are not built per workspace and groups are not converted into projects. Grouping changes no cwd, project, CLI time, config or permission. Reads are read-only; a single-node move re-checks source/anchor inside the transaction, and absence does not delete; system tasks are grouped only on first discovery and are not pulled back after a manual removal.
- Display preferences: a valid new-format view wins, otherwise fall back to the old organizeBy; the old grouped default opens in by-group mode. New tasks freeze the draft's group placement and commit it idempotently after the first send; never guess it during navigation.
- Remote: project and task organization state stays in the remote app DB; the local machine persists host connection records, project entries the user has added, and basic-info caches. While offline, projects cannot be expanded, renamed or have roots edited; the only project operation allowed is removing the local entry and cache — the remote project and its sessions remain, with no pending-deletion sync queue. A remote project allows only the single fixed root determined at creation; hosts are capped at 20, and saved hosts auto-connect at startup.
- Reconnection refreshes only entries that still exist locally; late responses must not upsert removed entries. setting.json is derived from the local entry list and never rebuilds removed entries in reverse. Re-adding a remote project requires explicit user choice, or explicit addition after a successful online creation; deleting a local host removes only the connection and its entries.
- Agent config management in settings works on real directories (roots deduplicated and flattened); scheduled / idle-time / Bots select virtual projects.

## 4. Data and Migration Discipline

- A versioned migration runner is shared by both databases (extracted from `apps/zcode-cli/.../session-store/migration-runner.ts`): `schema_migration(id, checksum, app_version)`, checksums are immutable, unknown ids are ignored.
- Every migration declares `touchedTables` explicitly; the runner backs up only those tables inside the same read transaction (`ATTACH + CREATE TABLE AS SELECT`); backups exist only to recover from migration failure — the normal flow produces them and never consumes them, and no whole-DB snapshot is taken (770MB for the whole local DB vs 16MB at table level).
- Every migration must verify content hashes of all tables before and after on fixtures, with only `touchedTables` allowed to change. The app uses E2E or repeatable runtime acceptance and gains no new business unit tests; CLI migrations keep standalone unit tests. CI keeps `schema.baseline.sql` append-only via diff.
- Compatibility retirement has three phases: V1 reads only the new columns and old columns become write-only; V2 writes `schema_floor` and stops dual writes; V3 physically drops the retired columns / `time_archived` and rebuilds the primary key. The grouping tables have been restored to runtime state and cannot be dropped as the old plan intended. Do not introduce a "permanent" compatibility branch at any phase.
- Downgrade relies on the additive schema, not on backups; unassigned sessions left over from the first migration, added by old versions, or first discovered by the CLI are judged exactly once: they are assigned only if the directory uniquely matches a non-deleted project on the same host; with zero or multiple matches they keep NULL and stay in the tasks area, and no project is auto-created. The only exception is the remote Source Server's first migration: the remote has no old workspace manifest of its own, so single-root projects are created from historical task directories (virtual project spec 2026-10-15 ruling). Old groups, empty groups, system groups, colors, members and order keep being read; the old Group → Project conversion is cancelled, while workspace → Project stays.
- `project_id IS NULL` is a legitimate unassigned state, not a pending-migration marker. At startup, first identify rows added by old versions with `host_id IS NULL`, then backfill identity and first-time assignment in the same transaction; rows created or first inserted by the new version get identity and assignment written atomically. Already-processed NULL rows are not auto-assigned by startup, reconciliation, or the arrival of another project on the same directory; globally created tasks stay explicitly unassigned.
- Migrations reuse the same SQL / Repo; the startup gate initializes business services only after the Host Worker completes. Wait for the lock asynchronously and publish ready only after the migration transaction commits; on failure, fail closed (retry / open the backup directory). Do not build a second migration implementation.

## 5. Pre-Change Checklist

1. Who is the **sole writer** of this field? If you are about to write it from the other side, go back to section 1 and re-judge; usually you should instead send a command (`renameSession` / `deleteSession`) and wait for the mirror.
2. Does your timestamp come from a CLI event or from `Date.now()`? The latter may only be written to the Host organization state's own time columns (`pinned_at`, `meta_updated_at`) and must never enter any sort basis.
3. Would this let sessions-index decide whether a row appears or disappears? Not allowed.
4. Are you using `workspacePath` for identity equality or key building? Remote must carry `workspaceIdentity`.
5. Are new columns / tables nullable or defaulted, were `schema.baseline.sql` and the migration's `touchedTables` updated, and is there per-table hash-verification evidence?
6. Changed CLI config discovery logic? `additionalDirectories` may be consumed only in three places: skills / subagents / path policy; everything else keeps resolving from `workingDirectory` only.
7. For behavior changes to title / status / unread / archive / delete, does the e2e coverage include both crosses: "desktop + phone remote control" and "local + SSH/WSL"?
8. For schema changes, has the e2e been run that upgrades an old fixture → reads/writes through the old code path (including modifying existing rows: delete, rename) → upgrades again?
9. For code touching delete / title, are the three stages — intent bit → lazy handoff → mirror write-back — preserved, along with orphan handling?

## 6. Reference Implementations and Docs

- Current-state facts: `docs/task/task-sqlite-index.md`, `docs/v4-refactor/14-sessions-index.md`, `docs/ui/task-title-authority.md`, `docs/ui/task-unread-state.md`, `docs/task-list-refresh-semantics.md`, `docs/wsl-task-status-inconsistency.md` (root cause of subscriptions being silently replaced).
- Historical decisions: `docs/superpowers/specs/2026-07-13-v4-sidebar-task-state-authority-design.md`, `2026-07-20-sidebar-task-row-authority-design.md`, `docs/local-workspace-path-cold-resume-identity.md`.
- Current grouping and views: `docs/ui/task-grouped-view.md`, `docs/ui/sidebar-task-view-switcher.md`.
- Deprecated (kept only for understanding the downgrade path): `docs/grouped-task-workspace-bootstrap.md`, `apps/zcode-cli/docs/design/v2/multi-workspace.md`.
