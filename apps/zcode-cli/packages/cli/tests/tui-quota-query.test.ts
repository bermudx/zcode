// 额度读数接线（tui-prompt-handler-queries）：submitPrompt.readUsageQuota
// 委托 CommandCenterApp.readCodingPlanQuota；缺席时显式报错，不静默吞。

import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageQuotaSnapshot } from "@zcode/shared";
import { attachTuiAppQueries } from "../src/tui-prompt-handler-queries.js";
import type { TuiPromptHandler } from "../src/tui-command-state.js";

test("readUsageQuota delegates to the app's coding-plan quota read", async () => {
  const snapshot: UsageQuotaSnapshot = { level: "glm-coding-plan", limits: [] };
  let calls = 0;
  const submitPrompt = {} as TuiPromptHandler;
  attachTuiAppQueries(submitPrompt, async () => {
    calls += 1;
    return {
      readCodingPlanQuota: async () => snapshot,
    } as never;
  });
  const result = await submitPrompt.readUsageQuota?.();
  assert.equal(calls, 1);
  assert.equal(result, snapshot);
});

test("readUsageQuota surfaces an explicit error when the app lacks the surface", async () => {
  const submitPrompt = {} as TuiPromptHandler;
  attachTuiAppQueries(submitPrompt, async () => ({}) as never);
  await assert.rejects(submitPrompt.readUsageQuota?.(), /Coding plan quota is unavailable/);
});
