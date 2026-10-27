// usage/codingPlanQuota 协议面：参数与结果 schema、与 usage-quota.ts 纯类型
// 的结构漂移门（schema 演进必须同步纯类型，反之亦然）。

import { describe, expect, it } from "vitest";
import type { UsageQuotaSnapshot } from "../src/usage-quota.js";
import {
  zcodeUsageCodingPlanQuotaParamsSchema,
  zcodeUsageQuotaSnapshotSchema,
  _typecheckUsageQuotaSnapshot,
} from "../src/zcode-protocol/index.js";

describe("usage/codingPlanQuota schema", () => {
  it("parses the account-level params", () => {
    expect(
      zcodeUsageCodingPlanQuotaParamsSchema.parse({ sessionId: "sess-1" }),
    ).toEqual({ sessionId: "sess-1" });
    expect(() => zcodeUsageCodingPlanQuotaParamsSchema.parse({})).toThrow();
  });

  it("parses a quota snapshot with token windows and optional reset fields", () => {
    const snapshot: UsageQuotaSnapshot = {
      level: "glm-coding-plan",
      limits: [
        {
          nextResetTime: 1_800_000_000_000,
          number: 5,
          percentage: 1,
          type: "TOKENS_LIMIT",
          unit: 3,
          usage: 100,
          usageDetails: [{ modelCode: "glm-5.3-flash", usage: 100 }],
        },
      ],
    };
    expect(zcodeUsageQuotaSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("keeps usageDetails required at the protocol boundary; external wire is normalized core-side", () => {
    // 外部监控 wire 里 usageDetails 可缺席（core 侧 parseCodingPlanQuotaEnvelope
    // 兜底为 []），协议面不得回退成那种形状——客户端严格收。
    expect(() =>
      zcodeUsageQuotaSnapshotSchema.parse({
        level: null,
        limits: [{ type: "TOKENS_LIMIT", usage: 1 }],
      }),
    ).toThrow(/usageDetails/);
  });

  it("keeps the zod schema structurally aligned with the pure types", () => {
    // 编译期 Equal 门（双向同型判定）落到运行时可断言的常量；任一侧漂移
    // （含 schema 侧放松字段）= schema 与类型漂移。
    expect(_typecheckUsageQuotaSnapshot).toBe(true);
  });
});
