# PR #96 built-pair live check — signed GLM turn through the Modal artifact

Date: 2026-11-23 · Verifier: agent session (operator-approved live check) ·
Source under test: `dfe4964e38a83939ff6b7d79c590baa0b29b6db8` (PR #96 head,
upstream v4.0.0 sync) built on Modal → `/tmp/piz-stage/piz-dfe4964e.tar.gz`
**Verdict: PASS+NOTES — real GLM coding-plan turn, request signed, isolated
end to end; server-side allowance split remains unverified**

## What was proven

- **Built pair, not source** — `PROMOTED_FROM` inside the tarball reads
  `dfe4964e38a83939ff6b7d79c590baa0b29b6db8`. The client
  (`zcode-attach.cjs acp`, `agent=piz v0.18.0 protocol=1`) and the core it
  spawned (`zcode.cjs app-server`) both ran from `/tmp/piz-live/root`.
- **Isolated data root** — client env carried
  `ZCODE_DATA_BASE_DIR=/tmp/piz-live/data`, `HOME=/tmp/piz-live/data`,
  `ZCODE_LOG_DIR=/tmp/piz-live/logs`, `ZCODE_RUNTIME_ENV=development`,
  `ZCODE_SERVER_BIN=/tmp/piz-live/root/.../zcode.cjs`. journalctl shows the
  core started 21:05:12 as `piz-core-2e217f8ea73c727d.service` with
  `--socket /tmp/piz-live/data/.zcode/v2/sockets/core.sock --cwd
  /tmp/piz-live/data` and exited cleanly at 21:05:45 (33 s, 6.5 s CPU) after
  the session closed. The operator's own `piz-core-07359b7ae1597acd` unit
  was never touched.
- **Real credential, correctly handed off** — `credential-source` = `os`
  (entries `enc:v2:os:*`, key bound to the credentials file path). Copied
  `credentials.json`/`provider_config.json`/`cli/config.json` into the
  scratch root, then `shareKeyWithCopiedCredentials` registered the same
  key under the scratch path's keyring entry; decrypt verified. Keyring
  entry deleted after the run.
- **Signed request, first attempt** — scratch JSONL log contains
  `model.client_signing.signed_sent` (debug, visible because
  `ZCODE_RUNTIME_ENV=development`) with
  `providerId: "account:zai-individual-coding-plan"`,
  `signedAttempt: 1`, `requestId: 5adc8695-0254-411b-b244-27c3073c0cf9`.
  The same requestId appears as `x-request-id` in the model-io dump —
  identical request. No `unsigned_sent`, `handshake_failed`,
  `verify_rejected`, `bypass_entered`, or `request_failed_closed` events
  exist in the log.
- **Real completed model turn** — ACP `session/new` reported models
  `account:zai-individual-coding-plan/GLM-5.3` and `…/GLM-5.3-Flash`
  (current = GLM-5.3); `session/prompt` "Reply with exactly the word: ok"
  returned `agent_message_chunk` `ok` then `stopReason=end_turn` in 7 s.
  `db.sqlite → model_usage` has `usage_model_main_turn` `completed`/
  `end_turn` on `account:zai-individual-coding-plan`/`GLM-5.3` with
  `{inputTokens: 12796, outputTokens: 3, totalTokens: 12799,
  cacheReadTokens: 9408}`.

## How it was driven

Throwaway Node driver `/tmp/piz-live/drive.mjs` spawns
`node <scratch>/zcode-attach.cjs acp` (NDJSON over stdio), then:
`initialize` → `session/new {cwd:/tmp/piz-live/ws, mcpServers:[]}` →
`session/prompt` → `session/close`. Agent→client requests
(`session/request_permission`, `elicitation/create`) answered
deny/cancel; none were issued. Full wire log: `/tmp/piz-live/driver.log`.

## Limits

- **Allowance (~2/3) split is server-side** — local `model_usage` records
  the turn but the coding-plan extra-quota accounting cannot be observed
  from this machine. Marked unverified, per
  `docs/coding-plan/client-request-signing-and-usage-allowance.md`.
- **One turn, one model** — GLM-5.3 individual coding plan only; the
  Flash variant and other providers were not exercised.
- **Signing headers not in model-io** — signing headers are applied at
  the transport layer after the AI SDK request record is written; the
  `signed_sent` event is the direct evidence, cross-checked by requestId.

## Cleanup state

- `piz-core-2e217f8ea73c727d.service` exited on its own; no piz units
  remain in `systemctl --user list-units`.
- Scratch keyring entry (service `ZCode Credential Encryption`, account
  `sha256(/tmp/piz-live/data/.zcode/v2/credentials.json)`) deleted.
- Evidence preserved under `/tmp/piz-live/` (`driver.log`, `logs/`,
  `data/`, extracted `root/` 3.1 GB) until next reboot.

## Re-run sketch

```
ZCODE_DATA_BASE_DIR=/tmp/piz-live/data \
ZCODE_SERVER_BIN=/tmp/piz-live/root/apps/zcode-cli/packages/cli/dist-runtime/zcode.cjs \
node /tmp/piz-live/root/apps/zcode-cli/packages/cli/dist-runtime/zcode-attach.cjs acp
# then speak ACP v1: initialize → session/new → session/prompt
```
