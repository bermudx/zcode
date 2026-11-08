# Short model names at startup

Branch: `patch/short-model-aliases`.

## Problem and result

`piz --model glm-5.3` compared the short name case-sensitively with the
catalog's `GLM-5.3`. The account provider prefix was not the real requirement:
the lowercase name never matched. Earlier tests used lowercase catalog IDs.

The attach startup resolver now:

- Matches short model IDs without case sensitivity and emits catalog spelling.
- Prefers the snapshot's current provider when the same model has several
  providers; unresolved ambiguity still lists candidates instead of guessing.
- Preserves the existing unique-match behavior across providers.
- Accepts quoted effort suffixes, for example `'glm-5.3$high'`, and uses the
  catalog's effort spelling. Unknown effort fails before setting a model.
- Preserves literal model IDs containing `$` and exact full-ref handling.

Ownership and order are unchanged:

```text
core create/resume snapshot → subscribe → resolve startup name from snapshot
  → existing setModel validation → session/setModel → TUI
```

No default-preference writes, protocol changes, provider-specific alias table,
signing changes, builds, promotion, wrapper changes, core restarts or pushes.
No hosted fork issue was opened: FORK.md says this fork has no public tracker.

## Evidence

- A Piz/GLM-5.3 research subagent traced the catalog and resolver. A separate
  Piz review is pending.
- Dependencies were initially absent. The first architecture command could not
  load TypeScript; this was not a pass. Existing local dependency directories
  and dependency dist outputs were then copied with filesystem copy-on-write
  into this worktree, with no download and no edits to the source checkout.
- Architecture baseline and post-change check: 0 violations. The policy marks
  the broad CLI module unmanaged; this does not prove CLI runtime correctness.
- CLI package `tsc --noEmit`: passed.
- Oxlint on the three source files and test file: no errors; one existing
  unsafe-optional-chaining warning in the older effort test.
- Initial focused run: 50 cases, 48 passed, 2 failed. Both failures were new
  assertions against a nonexistent top-level TUI `initialModel` field: startup
  model loading is lazy. The actual `session/setModel` assertions passed.
  Removed those incorrect assertions; resume still checks its initial-result
  model. Also changed the existing bare-name integration case to use the real
  uppercase/account-provider shape.
- Reran only the three modified cases: 3/3 passed. Across the initial run and
  this correction run, all 50 targeted model/argv cases have passing results.
  The unmodified tests were not rerun.

The socket integration tests use a fake core and an injected TUI, not the
operator's live core or terminal. Account-provider overlap was traced in code,
not verified against the live account catalog. Live account billing, allowance
eligibility and an installed-binary model turn remain unverified.

The selected fork runner, full workspace checks, full suite, CI and build were
not run for this local patch. There is no pushed commit or CI result.

## Try the isolated startup regression

From this worktree, this single command exercises create and resume with a
lowercase name, duplicate providers and an effort suffix in the fake-core
harness. It does not start or alter the operator's installed core:

```sh
env -u ZCODE_SERVER_BIN -u ZCODE_WORKSPACE_IDENTITY -u ZCODE_ATTACH_CORE -u ZCODE_RUNTIME_ENV -u ZCODE_BUILTIN_PROVIDER_CONFIG_FILE -u ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE -u ZCODE_PERSONAL_PROVIDER_CONFIG_FILE -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_BIN_PATH mise exec -- pnpm --dir apps/zcode-cli --filter @zcode/cli exec node --disable-warning=DEP0205 --import tsx --test --test-name-pattern='^(create: lowercase alias|resume: lowercase alias)' tests/attach-model-option.test.ts
```

The installed `piz` remains unchanged. Merge and promotion need operator
approval and the existing promotion gates.
