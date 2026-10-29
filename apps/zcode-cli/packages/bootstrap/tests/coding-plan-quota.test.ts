// Coding Plan 额度拉取：provider 解析（family 分流 + API key 访问门）、
// envelope 校验（parseZaiQuota 同门）、错误路径。凭据不落日志。

import { describe, expect, it } from "vitest";
import type { ProviderRegistryModelSource } from "../src/app/provider-registry-model-runtime.js";
import type { Provider } from "@zcode/provider";
import {
  CodingPlanQuotaUnavailableError,
  fetchCodingPlanQuota,
  parseCodingPlanQuotaEnvelope,
  resolveCodingPlanQuotaProvider,
} from "../src/app/coding-plan-quota.js";

const provider = (over: {
  providerId: string;
  group?: string;
  accessType?: string;
  apiKey?: string;
  accountType?: "zai" | "bigmodel";
  mode?: string;
  entitled?: boolean;
  builtinModelIds?: string[];
}): Provider =>
  ({
    config: {
      access: {
        apiKey: over.apiKey,
        type: over.accessType ?? "api",
        ...(over.accessType === "zhipu-account"
          ? {
              accountType: over.accountType,
              entitled: over.entitled,
              mode: over.mode,
            }
          : {}),
      },
      builtinModelIds: over.builtinModelIds,
      group: over.group,
    },
    models: [],
    providerId: over.providerId,
    providerName: over.providerId,
    templateId: over.providerId,
  }) as unknown as Provider;

const registry = (providers: Provider[]): ProviderRegistryModelSource =>
  ({
    getProvider: () => undefined,
    getModel: () => undefined,
    getView: () => ({ providers, revision: 1 }),
    onDidChange: () => () => {},
    validateSelection: () => ({ ok: true }),
  }) as unknown as ProviderRegistryModelSource;

describe("resolveCodingPlanQuotaProvider", () => {
  it("picks the first coding-plan family provider with an API key", async () => {
    const resolved = await resolveCodingPlanQuotaProvider(
      registry([
        provider({ apiKey: undefined, group: "zai-family", providerId: "zai-nokey" }),
        provider({ apiKey: "k2", group: "bigmodel-family", providerId: "bigmodel" }),
        provider({ apiKey: "k1", group: "zai-family", providerId: "zai" }),
      ]),
    );
    expect(resolved?.providerId).toBe("bigmodel");
    expect(resolved?.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  });

  it("routes the zai family to api.z.ai", async () => {
    const resolved = await resolveCodingPlanQuotaProvider(
      registry([provider({ apiKey: "k", group: "zai-family", providerId: "zai" })]),
    );
    expect(resolved?.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
  });

  it("skips zhipu-account access without a resolver and non-coding-plan providers", async () => {
    expect(
      await resolveCodingPlanQuotaProvider(
        registry([
          provider({
            accessType: "zhipu-account",
            accountType: "zai",
            entitled: true,
            group: "zai-family",
            mode: "individual-coding-plan",
            providerId: "zai-acct",
          }),
          provider({ apiKey: "k", group: "other-family", providerId: "other" }),
        ]),
      ),
    ).toBeNull();
  });

  it("resolves an entitled individual-coding-plan account provider via the account resolver", async () => {
    const calls: Array<{ modelId: string; providerId: string }> = [];
    const resolved = await resolveCodingPlanQuotaProvider(
      registry([
        provider({
          accessType: "zhipu-account",
          accountType: "zai",
          builtinModelIds: ["GLM-5.3"],
          entitled: true,
          group: "zai-family",
          mode: "individual-coding-plan",
          providerId: "account:zai-individual-coding-plan",
        }),
      ]),
      async (input) => {
        calls.push({ modelId: input.modelId, providerId: input.providerId });
        expect(input.accountAccess).toEqual({
          accountType: "zai",
          entitled: true,
          mode: "individual-coding-plan",
          type: "zhipu-account",
        });
        return "plan-key";
      },
    );
    expect(calls).toEqual([{ modelId: "GLM-5.3", providerId: "account:zai-individual-coding-plan" }]);
    expect(resolved?.apiKey).toBe("plan-key");
    expect(resolved?.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
  });

  it("falls through when the account resolver returns null or throws, then picks a later API-key provider", async () => {
    let sawAccountProvider = false;
    const resolved = await resolveCodingPlanQuotaProvider(
      registry([
        provider({
          accessType: "zhipu-account",
          accountType: "bigmodel",
          entitled: true,
          group: "bigmodel-family",
          mode: "individual-coding-plan",
          providerId: "acct-no-cred",
        }),
        provider({
          accessType: "zhipu-account",
          accountType: "zai",
          entitled: true,
          group: "zai-family",
          mode: "individual-coding-plan",
          providerId: "acct-throws",
        }),
        provider({ apiKey: "k1", group: "zai-family", providerId: "zai-key" }),
      ]),
      async (input) => {
        if (input.providerId === "acct-no-cred") return null;
        sawAccountProvider = true;
        throw new Error("project_token_login_required");
      },
    );
    expect(sawAccountProvider).toBe(true);
    expect(resolved?.apiKey).toBe("k1");
    expect(resolved?.providerId).toBe("zai-key");
  });

  it("skips non-entitled and non-individual account access", async () => {
    const calls: string[] = [];
    const resolve = async (input: { providerId: string }): Promise<string | null> => {
      calls.push(input.providerId);
      return "plan-key";
    };
    const resolved = await resolveCodingPlanQuotaProvider(
      registry([
        provider({
          accessType: "zhipu-account",
          accountType: "zai",
          entitled: false,
          group: "zai-family",
          mode: "individual-coding-plan",
          providerId: "acct-logged-out",
        }),
        provider({
          accessType: "zhipu-account",
          accountType: "zai",
          entitled: true,
          group: "zai-family",
          mode: "team-coding-plan",
          providerId: "acct-team",
        }),
        provider({
          accessType: "zhipu-account",
          accountType: "bigmodel",
          entitled: true,
          group: "bigmodel-family",
          mode: "start-plan",
          providerId: "acct-start",
        }),
      ]),
      resolve,
    );
    expect(calls).toEqual([]);
    expect(resolved).toBeNull();
  });
});

describe("parseCodingPlanQuotaEnvelope", () => {
  it("accepts the success/200 envelope and normalizes limits to the shared shape", () => {
    const snapshot = parseCodingPlanQuotaEnvelope({
      code: 200,
      data: {
        level: "glm-coding-plan",
        limits: [
          {
            percentage: 1,
            serverOnlyField: "ignored",
            type: "TOKENS_LIMIT",
            unit: "3", // 不合型 → 字段缺席，entry 存活
            usage: 100,
            usageDetails: [{ modelCode: "glm-5.3-flash", note: "x", usage: 100 }],
          },
          { type: "", usageDetails: [] }, // 空 type → 整条丢弃
          { usageDetails: [] }, // 无 type → 整条丢弃
          { type: "TOKENS_LIMIT", usageDetails: "junk" }, // 非 array usageDetails → []
        ],
      },
      success: true,
    });
    expect(snapshot?.level).toBe("glm-coding-plan");
    expect(snapshot?.limits).toHaveLength(2);
    expect(snapshot?.limits[0]).toEqual({
      percentage: 1,
      type: "TOKENS_LIMIT",
      usage: 100,
      usageDetails: [{ modelCode: "glm-5.3-flash", usage: 100 }],
    });
    expect(snapshot?.limits[1]).toEqual({ type: "TOKENS_LIMIT", usageDetails: [] });
  });

  it("drops usageDetail entries without a modelCode and defaults their usage to 0", () => {
    const snapshot = parseCodingPlanQuotaEnvelope({
      code: 200,
      data: {
        level: null,
        limits: [
          {
            type: "TOKENS_LIMIT",
            usageDetails: [
              { modelCode: "glm-5.3" },
              { usage: 5 },
              "junk",
              { displayName: "GLM 5.3 Flash", modelCode: "glm-5.3-flash", usage: "7" },
            ],
          },
        ],
      },
      success: true,
    });
    expect(snapshot?.limits[0]?.usageDetails).toEqual([
      { modelCode: "glm-5.3", usage: 0 },
      { displayName: "GLM 5.3 Flash", modelCode: "glm-5.3-flash", usage: 0 },
    ]);
  });

  it("rejects non-success envelopes and missing limits", () => {
    expect(parseCodingPlanQuotaEnvelope({ code: 200, success: false })).toBeNull();
    expect(parseCodingPlanQuotaEnvelope({ code: 500, success: true })).toBeNull();
    expect(parseCodingPlanQuotaEnvelope({ data: {}, success: true })).toBeNull();
  });
});

describe("fetchCodingPlanQuota", () => {
  const okResponse = (body: unknown): Response =>
    ({ json: async () => body, ok: true, status: 200 }) as unknown as Response;

  it("sends the bearer token and returns the snapshot", async () => {
    let authHeader: string | undefined;
    const snapshot = await fetchCodingPlanQuota({
      fetchImpl: async (_url, init) => {
        authHeader = new Headers(init?.headers).get("Authorization") ?? undefined;
        return okResponse({ code: 200, data: { level: null, limits: [] }, success: true });
      },
      registry: registry([provider({ apiKey: "secret-key", group: "zai-family", providerId: "zai" })]),
    });
    expect(authHeader).toBe("Bearer secret-key");
    expect(snapshot.limits).toEqual([]);
  });

  it("surfaces http failures as quota-unavailable errors without echoing the key", async () => {
    await expect(
      fetchCodingPlanQuota({
        fetchImpl: async () => ({ ok: false, status: 502 }) as unknown as Response,
        registry: registry([provider({ apiKey: "secret-key", group: "zai-family", providerId: "zai" })]),
      }),
    ).rejects.toThrow(CodingPlanQuotaUnavailableError);
  });

  it("maps a non-JSON 200 body to the explicit quota-unavailable error", async () => {
    await expect(
      fetchCodingPlanQuota({
        fetchImpl: async () =>
          ({
            json: async () => {
              throw new SyntaxError("Unexpected token < in JSON at position 0");
            },
            ok: true,
            status: 200,
          }) as unknown as Response,
        registry: registry([provider({ apiKey: "secret-key", group: "zai-family", providerId: "zai" })]),
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("fails closed when no provider carries an API key", async () => {
    await expect(
      fetchCodingPlanQuota({
        registry: registry([provider({ group: "zai-family", providerId: "zai-nokey" })]),
      }),
    ).rejects.toThrow(CodingPlanQuotaUnavailableError);
  });

  it("fetches with the account-resolved plan key for account providers", async () => {
    let authHeader: string | undefined;
    let requestedUrl: string | undefined;
    const snapshot = await fetchCodingPlanQuota({
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        authHeader = new Headers(init?.headers).get("Authorization") ?? undefined;
        return okResponse({ code: 200, data: { level: "glm-coding-plan", limits: [] }, success: true });
      },
      registry: registry([
        provider({
          accessType: "zhipu-account",
          accountType: "zai",
          builtinModelIds: ["GLM-5.3"],
          entitled: true,
          group: "zai-family",
          mode: "individual-coding-plan",
          providerId: "account:zai-individual-coding-plan",
        }),
      ]),
      resolveAccountApiKey: async () => "resolved-plan-key",
    });
    expect(requestedUrl).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(authHeader).toBe("Bearer resolved-plan-key");
    expect(snapshot.level).toBe("glm-coding-plan");
  });
});
