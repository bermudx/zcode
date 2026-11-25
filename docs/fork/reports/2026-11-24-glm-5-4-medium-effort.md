# GLM-5.4 missing "medium" reasoning effort via ACP — personal rules override

Date: 2026-11-24 · Verifier: agent session · Branch: `fix/glm-5-4-medium-t3-acp`
**Verdict: FIXED at the data layer — `~/.zcode/v2/provider_config.json` now
overlays `reasoningLevel.values = ["low","medium","high","max"]` for GLM-5.4 on
all six account coding-plan providers; verified through the real
`@zcode/provider` resolution code. End-to-end ACP advertisement applies on the
next `session/new` (1 s personal-config polling); not re-verified against the
live core.**

## Root cause

GLM-5.4's advertised effort levels do not come from this repo. The live builtin
config is a remotely downloaded release — `GET /api/v1/client/configs` returns
`builtin_provider_config_json` →
`zcode-builtin-production-4135.json` (revision 48), materialized under
`~/.zcode/v2/runtime/provider/linux-x86_64/<appVersion>/endpoint-*/zcode-builtin.json`.
Remote releases win over the repo-bundled `config/provider/zcode-builtin.json`
by revision, so editing the bundled file cannot change what runs.

In rev48, GLM-5.4 exists only as `enabled` flags (`templateModelRules` for
`zai-api`/`bigmodel-api`, `builtinProviderModelRules` for the six
`account:*coding-plan`/`start-plan` providers). No rule sets its
`reasoningLevel`. It inherits the catch-all `modelRules` entry
`modelMatch: "(?:.*/)?glm[^/]*"` → `values: ["low","high","max"]` — the same
rule GLM-5.3* legitimately uses. GLM-5.2 has a dedicated rule
(`.*GLM-5\.2.*` → `["disabled","high","max"]`); upstream simply has not shipped
a GLM-5.4-specific level set yet. Z.AI's `reasoning_effort` docs support
medium for GLM-5.2+ except GLM-5.3/5.3-Flash, so `["low","medium","high","max"]`
is the correct set (default stays `max`, the last value).

The ACP surface needs no change: `buildModelState` (PR #91) forwards
`optionSpecs.reasoningLevel.values` resolved by
`ModelConfigRules.composeEffective(builtin, personal)` in
`packages/provider/src/resolver.ts`. For `anthropic-messages` + `.*glm-5.*`,
`modelApiRules` maps `output_config.effort = reasoningLevel` verbatim, so
`"medium"` reaches the wire as-is.

## Fix applied (machine-local, not a repo change)

`~/.zcode/v2/provider_config.json` → `config.modelConfigRules.providerModelRules`
gained six sparse entries — `account:zai-individual-coding-plan`,
`account:zai-team-coding-plan`, `account:zai-start-plan`,
`account:bigmodel-individual-coding-plan`,
`account:bigmodel-team-coding-plan`, `account:bigmodel-start-plan` — each:

```json
{"providerId": "account:<id>", "modelId": "GLM-5.4",
 "config": {"optionSpecs": {"reasoningLevel": {"values": ["low","medium","high","max"]}}}}
```

Personal `provider-model` rules are exact-match overlays appended after all
builtin rules; the sparse `values` replaces the catch-all while the builtin
`map` is preserved (`ConfigOverlay.overlayValue` keeps base when next is
undefined). Pre-edit backup: `/tmp/provider_config.json.bak-1795573421`.

## Verification

Real code, real files — no fixtures: imported the compiled
`@zcode/provider` from `~/build/piz` (`dist/index.js`, run under `bun` for the
TS-only `@zcode/model-option-map` dep), fed it the live rev48 release file and
the edited personal file through `parseZCodeBuiltinModelConfigRules` +
`parsePersonalModelConfigRules` + `ModelConfigRules.composeEffective` +
`resolve({providerId, modelId: "GLM-5.4", apiType: "anthropic-messages",
baseUrl: "https://api.z.ai/api/anthropic"})` — the same inputs
`resolver.ts` uses for account providers.

- GLM-5.4 → `["low","medium","high","max"]`, default `max`, on all six providers.
- GLM-5.3 / GLM-5.3-Flash → unchanged `["low","high","max"]`.
- GLM-5.2 → unchanged `["disabled","high","max"]`.

## Notes for future maintainers

- **Remove the six personal rules** once upstream ships a dedicated GLM-5.4
  `reasoningLevel` rule — the overlay would otherwise mask it.
- The same technique fixes any future upstream-owned builtin data gap:
  personal `providerModelRules`/`manualProviderModelRules` in
  `~/.zcode/v2/provider_config.json` overlay builtin rules per
  provider+model; bundled-config edits do not (remote release wins by
  revision).
- A carried code patch in provider resolution was considered and rejected:
  invasive for a data fix upstream will likely ship, and it would still need a
  CI build + promotion + core restart to take effect.
