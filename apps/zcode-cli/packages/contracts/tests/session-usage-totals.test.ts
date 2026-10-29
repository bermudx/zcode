import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createSessionEvent,
  summarizeSessionUsageTotals,
} from "../src/index.js";
import type { SessionEvent, SessionId } from "../src/index.js";

const ev = (type: SessionEvent["type"], payload: unknown): SessionEvent =>
  createSessionEvent(type, "sess-1" as SessionId, payload);

describe("summarizeSessionUsageTotals", () => {
  it("folds model_complete and failed-request usage into session totals", () => {
    const totals = summarizeSessionUsageTotals([
      ev(SessionEventType.ModelComplete, {
        content: "a",
        stopReason: "stop",
        usage: { cacheReadTokens: 800, inputTokens: 1_000, outputTokens: 10 },
      }),
      ev(SessionEventType.ModelComplete, {
        content: "b",
        stopReason: "stop",
        usage: { cacheWriteTokens: 50, inputTokens: 500, outputTokens: 5 },
      }),
      ev(SessionEventType.ModelNetworkStatus, {
        type: "model_request_failed",
        usage: { inputTokens: 200, outputTokens: 0 },
      }),
      // 其他 network status 不计。
      ev(SessionEventType.ModelNetworkStatus, { type: "model_request_started" }),
      // 非用量事件不影响计数。
      ev(SessionEventType.TurnComplete, {
        usage: { inputTokens: 9_999, modelRequestCount: 3, outputTokens: 9 },
      }),
    ]);
    expect(totals).toEqual({
      cacheReadTokens: 800,
      cacheWriteTokens: 50,
      inputTokens: 1_700,
      latestCacheHitRate: undefined,
      outputTokens: 15,
    });
  });

  it("inputTokens uses the input-window reading (explicit inputTokens wins)", () => {
    const totals = summarizeSessionUsageTotals([
      ev(SessionEventType.ModelComplete, {
        content: "a",
        stopReason: "stop",
        // inputTokens 已是含 cache 的窗口读数：不再叠加 cache 拆分。
        usage: { cacheReadTokens: 300, cacheWriteTokens: 20, inputTokens: 400, outputTokens: 5 },
      }),
      // 缺 inputTokens 时按 totalTokens - outputTokens 回退。
      ev(SessionEventType.ModelComplete, {
        content: "b",
        stopReason: "stop",
        usage: { outputTokens: 10, totalTokens: 1_000 },
      }),
    ]);
    expect(totals?.inputTokens).toBe(400 + 990);
    expect(totals?.cacheReadTokens).toBe(300);
    expect(totals?.cacheWriteTokens).toBe(20);
  });

  it("latestCacheHitRate tracks the last finite rate, ignoring null", () => {
    const totals = summarizeSessionUsageTotals([
      ev(SessionEventType.ModelComplete, {
        cacheHit: { latestHitRate: 0.42 },
        content: "a",
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
      ev(SessionEventType.ModelComplete, {
        cacheHit: { latestHitRate: 1 },
        content: "b",
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
      ev(SessionEventType.ModelComplete, {
        cacheHit: { latestHitRate: null },
        content: "c",
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
    ]);
    expect(totals?.latestCacheHitRate).toBe(1);
  });

  it("returns undefined when no usage-bearing events exist", () => {
    expect(
      summarizeSessionUsageTotals([
        ev(SessionEventType.SessionCreated, {}),
        ev(SessionEventType.ModelComplete, {
          content: "a",
          stopReason: "stop",
        }),
      ]),
    ).toBeUndefined();
    expect(summarizeSessionUsageTotals([])).toBeUndefined();
  });
});
