# ACP effort option missing in T3 Code

## Finding

The operator supplied a screenshot of the Piz model picker in T3 Code.
Its Options column shows Mode but no effort control.

Read-only inspection of the local source identifies a missing ACP mapping in
piz. This is not evidence of a missing T3 option-rendering capability.

## Source evidence

- `apps/zcode-cli/packages/cli/src/acp/acp-project.ts`:
  `buildConfigOptions()` returns only the `model` select option.
  Its input includes model settings only, not the session's
  `settings.thoughtLevel` state.
- `apps/zcode-cli/packages/cli/src/acp/acp-agent.ts`:
  `configOptionsFor()` passes only `snapshot.settings.model`.
  The `session/set_config_option` handler accepts only `configId: "model"`;
  every other config id receives an invalid-params error.
  New/resumed sessions and model-change notifications all use this same
  model-only projection.
- `apps/zcode-cli/packages/cli/src/attach/attach-session.ts`:
  `getThoughtLevel()` and `setThoughtLevel()` already exist.
  The setter calls the existing core `sessionSetThoughtLevel` command and
  applies the returned snapshot.
- `packages/shared/src/zcode-protocol/index.ts`:
  `settings.thoughtLevel` carries enabled/current/defaultLevel/available.
  Available choices have `value`, `label`, and optional `description`.
- The separate local checkout at `/home/daniel/build/t3code` was read, not
  changed. Its `packages/provider-acp/src/server/sessionConfig.ts` maps an ACP
  select option with `category: "thought_level"` to a provider option with
  `role: "reasoning"`. The adjacent `sessionConfig.test.ts` includes a case
  for this mapping. These tests were inspected, not run.
- The existing piz ACP tests assert the model option and model mutation,
  but do not cover effort advertisement or mutation.

## Repair boundary

The missing connection is:

```text
core snapshot.settings.thoughtLevel
  → ACP config option, category thought_level
  → T3 reasoning control
  → session/set_config_option
  → existing AttachSessionHandle.setThoughtLevel()
  → core mutation and returned snapshot
```

Keep core as the owner. Use its actual supported choices and current value;
do not invent low/medium/high levels for every model. Check new/resume,
effort mutation, model-dependent choices, unsupported values, and config
updates when implementing the repair. No new core command is indicated by
this inspection.

## Scope and limits

This was an investigation, not authorization to change runtime behavior.
Only this report was added. No build, test run, installation, model request,
provider reconfiguration, core restart, network fetch, or push was performed.
The installed bundles and exact running T3 revision were not checked.
The supported effort values for the operator's live GLM models remain
unverified; neither the screenshot nor static code establishes them.

The pre-existing untracked adapters backup directory was left untouched.
There is no configured fork issue tracker, as recorded in `FORK.md`.

## Implementation follow-up

The operator authorized the repair using Fusion with piz and GLM Flash.
The lead session has no inherited Herdr connection or explicit operator-supplied
socket/session. The local Herdr skill requires an explicit connection outside
Herdr, so worker launch is blocked pending that choice. No worker was started
and no runtime code was changed during this setup attempt.

## Review of `patch/acp-reasoning-effort` (99e5646d)

Read-only diff review. No tests or builds run.

Verdict: correct design, OK to merge. Live check still required.

- Correct: choices come from the current model's `reasoning.levels`, not
  `thoughtLevel.available`. The attach handle unions `available` across
  models (`attach-session.ts` `mergeCatalog`), so the shared
  `zcodeSessionSettingsToZCodeConfigOptions` projection would show wrong
  levels here. Re-implementing in the CLI is justified.
- Correct: setter validates at the ACP boundary, awaits the core, returns
  options from the confirmed snapshot. Unknown config ids still rejected.
- Tests cover new/resume, set, invalid values, model switch vs union,
  core rejection, fallback order, provider/model identity.

Later (non-blocking):

1. `currentValue` can be `""` when several levels exist and none of
   current/default match. `""` is not a listed choice; T3 may render an
   empty or broken select. Pick the first level instead, or verify T3.
2. After a model switch, if core keeps a `thoughtLevel.current` the new
   model does not support, ACP shows the fallback value while core may
   send the old one. Unverified: core clamp behavior on `setModel` was not
   traced. Check live by switching GLM-5.3 → Flash with a non-shared level.
3. Effort changes made by another client are not pushed to T3 (documented
   in the spec as a known gap).
