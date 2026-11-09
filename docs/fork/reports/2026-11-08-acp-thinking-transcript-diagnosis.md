# ACP thinking transcript diagnosis (2026-11-08)

Operator report: "Thinking data is not remaining as part of the transcript in
T3 when using piz ACP." Branch: `fix/acp-thinking-transcript-loss`.

## Verdict

The thinking pipeline works end to end on the installed (promoted) pair. The
reported loss does not reproduce. Live wire evidence and T3's persisted
projection both show reasoning present for `acpRegistry_piz` sessions.

## Evidence

Live probe of the installed `piz acp` (`dist-runtime`, PROMOTED_FROM
`4caa31d5`, spawned the same way T3 spawns it — `piz acp`, connected to the
live shared core `core-0236619fada005a1.sock`). Scripted NDJSON-RPC client;
counted `session/update` notification types:

| model | effort | agent_thought_chunk | agent_message_chunk |
|---|---|---|---|
| GLM-5.3 | max | 158 | 36 |
| GLM-5.3-Flash | max | 53 | 37 |
| GLM-5.3-Flash | low | **0** | 1 |

After `session/close` → `session/resume` → prompt: thought chunks still
stream (17 on turn 1, 11 on the resumed turn 2 for a separate probe).

T3 persisted projection (`~/.t3/userdata/statev2.sqlite`,
`orchestration_v2_projection_turn_items`): 858 `reasoning` items owned by
`acpRegistry_piz` across ~19 threads, all `completed`, `streaming:false`,
with non-empty `text`, position rows, and correct interleaved ordering with
`assistant_message`/tool items. Latest written 2026-11-09T01:47Z (same day
as the report). piz core `~/.zcode/cli/db/db.sqlite` `part` records likewise
hold `reasoning` parts for the ACP-driven sessions (`sess_d9ed0d91`,
`sess_0fd855d8`).

## Code path (all verified)

- `acp-project.ts` `AcpEventProjector.projectStreaming` maps
  `payload.kind === "reasoning_delta"` → `sessionUpdate: "agent_thought_chunk"`
  with `messageId` (required by T3's schema — present).
- The ACP lane subscribes with `eventFormat: "raw"`; raw delivery bypasses
  `shouldExposeSessionEventToProtocol` and delta batching entirely, so
  `reasoning_delta` events pass through unconditionally.
- `acp-agent.ts` drains the update queue (`await pendingDrain`) before the
  `session/prompt` response returns, so chunks land inside T3's active turn
  window (`assistantUpdatesOpenRef` gate).
- T3 side: `agent_thought_chunk` → `appendText(context, "reasoning")` →
  `turn_item.updated` of type `reasoning` — the items above.
- `loadSession: false`; `session/resume` replays nothing. T3 renders its own
  persisted projection on thread reopen, which retains reasoning.

## Plausible explanations for the observation

1. **The model emitted no reasoning for those turns.** GLM-5.3-Flash at
   `low` effort produced zero `reasoning_content` — there is nothing to
   persist. If the affected thread ran a low effort level or a trivial
   prompt, "thinking not remaining" is "no thinking was produced". Effort
   `max` produces chunks on both models.
2. **Collapsed work-log grouping.** Long piz threads accumulate many
   reasoning items (one thread has 109). T3 defers completed reasoning into
   "N work items"/"Thought" rollup rows — content is behind an expand
   control, which can read as "not in the transcript". Same behavior as
   other providers.
3. **`session/load` is unimplemented.** If a T3 surface ever relies on
   agent-side transcript replay rather than its own store, piz cannot
   supply it — but that would drop all content, not just thinking, and T3's
   own projection demonstrably retains reasoning today.
4. **Stale build.** `agent_thought_chunk` support landed 2026-11-06
   (`6c7b1e1a`) and the promoted pair is 2026-11-08. Anything observed on an
   older pair would show the symptom.

## Follow-ups

- If the operator can name the affected T3 thread or time, correlate:
  `SELECT type,count(*) FROM orchestration_v2_projection_turn_items
   WHERE thread_id='<id>' GROUP BY 1` — `reasoning` rows with text mean T3
   persisted it and the issue is rendering-side; zero rows mean the model
   never reasoned (check the selected effort level).
- Probe scripts left at `/tmp/piz-acp-probe/probe*.mjs` (spawn `piz acp`,
  JSON-RPC over stdio, count update types).
