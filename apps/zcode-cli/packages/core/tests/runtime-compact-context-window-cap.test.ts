import { describe, expect, it } from "vitest";

import { getAutoCompactThreshold, type AutoCompactPolicyConfig } from "../src/compact/index.js";
import { setCompactContextWindowCap } from "../src/runtime/methods/config.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal-methods.js";

// setCompactContextWindowCap 只读写 this.config.compact；autoCompactIfNeeded / microcompact
// 每次检查都用 `{ contextWindow: model, ...this.config.compact }` 重新构造策略，所以这里
// 验证状态语义 + 与真实构造方式组合后的阈值即可。
function fakeRuntime(compact?: AutoCompactPolicyConfig) {
  return { config: { compact } } as unknown as AgentRuntimeInternal & {
    config: { compact?: AutoCompactPolicyConfig };
  };
}

function thresholdFor(rt: { config: { compact?: AutoCompactPolicyConfig } }, modelWindow: number) {
  return getAutoCompactThreshold({
    contextWindow: modelWindow,
    ...rt.config.compact,
    maxOutputTokens: 32_000,
  });
}

describe("setCompactContextWindowCap", () => {
  it("sets, replaces and clears the cap without touching other compact settings", () => {
    const rt = fakeRuntime({ enabled: true, bufferTokens: 5_000 });

    setCompactContextWindowCap.call(rt, 262_000);
    expect(rt.config.compact).toEqual({
      enabled: true,
      bufferTokens: 5_000,
      contextWindowCap: 262_000,
    });

    setCompactContextWindowCap.call(rt, 100_000);
    expect(rt.config.compact?.contextWindowCap).toBe(100_000);

    setCompactContextWindowCap.call(rt, undefined);
    expect(rt.config.compact).toEqual({ enabled: true, bufferTokens: 5_000 });
  });

  it("takes effect on the next policy build, never raising a smaller model window", () => {
    const rt = fakeRuntime();
    expect(thresholdFor(rt, 1_000_000)).toBe(1_000_000 - 21_000 - 13_000);

    setCompactContextWindowCap.call(rt, 262_000);
    expect(thresholdFor(rt, 1_000_000)).toBe(228_000);
    expect(thresholdFor(rt, 128_000)).toBe(128_000 - 21_000 - 13_000);

    setCompactContextWindowCap.call(rt, undefined);
    expect(thresholdFor(rt, 1_000_000)).toBe(966_000);
  });
});
