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
}): Provider =>
  ({
    config: {
      access: {
        apiKey: over.apiKey,
        type: over.accessType ?? "api",
      },
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
  it("picks the first coding-plan family provider with an API key", () => {
    const resolved = resolveCodingPlanQuotaProvider(
      registry([
        provider({ apiKey: undefined, group: "zai-family", providerId: "zai-nokey" }),
        provider({ apiKey: "k2", group: "bigmodel-family", providerId: "bigmodel" }),
        provider({ apiKey: "k1", group: "zai-family", providerId: "zai" }),
      ]),
    );
    expect(resolved?.providerId).toBe("bigmodel");
    expect(resolved?.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  });

  it("routes the zai family to api.z.ai", () => {
    const resolved = resolveCodingPlanQuotaProvider(
      registry([provider({ apiKey: "k", group: "zai-family", providerId: "zai" })]),
    );
    expect(resolved?.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
  });

  it("skips zhipu-account access and non-coding-plan providers", () => {
    expect(
      resolveCodingPlanQuotaProvider(
        registry([
          provider({ accessType: "zhipu-account", group: "zai-family", providerId: "zai-acct" }),
          provider({ apiKey: "k", group: "other-family", providerId: "other" }),
        ]),
      ),
    ).toBeNull();
  });
});

describe("parseCodingPlanQuotaEnvelope", () => {
  it("accepts the success/200 envelope and passes limits through", () => {
    const snapshot = parseCodingPlanQuotaEnvelope({
      code: 200,
      data: { level: "glm-coding-plan", limits: [{ percentage: 1, type: "TOKENS_LIMIT", usageDetails: [] }] },
      success: true,
    });
    expect(snapshot?.level).toBe("glm-coding-plan");
    expect(snapshot?.limits).toHaveLength(1);
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

  it("fails closed when no provider carries an API key", async () => {
    await expect(
      fetchCodingPlanQuota({
        registry: registry([provider({ group: "zai-family", providerId: "zai-nokey" })]),
      }),
    ).rejects.toThrow(CodingPlanQuotaUnavailableError);
  });
});
