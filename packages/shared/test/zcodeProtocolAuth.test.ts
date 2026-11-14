import { describe, expect, it } from "vitest";
import {
  zcodeAuthConfigureApiKeyParamsSchema,
  zcodeAuthConfigureApiKeyResultSchema,
  zcodeAuthLoginCompleteParamsSchema,
  zcodeAuthLoginCompleteResultSchema,
  zcodeAuthLoginStartParamsSchema,
  zcodeAuthLoginStartResultSchema,
  zcodeAuthLogoutParamsSchema,
  zcodeAuthLogoutResultSchema,
  zcodeProtocolMethods,
} from "../src/index.js";

describe("zcode protocol auth/* contracts", () => {
  it("exposes the four thin-client auth methods", () => {
    expect(zcodeProtocolMethods.authLoginStart).toBe("auth/loginStart");
    expect(zcodeProtocolMethods.authLoginComplete).toBe("auth/loginComplete");
    expect(zcodeProtocolMethods.authConfigureApiKey).toBe("auth/configureApiKey");
    expect(zcodeProtocolMethods.authLogout).toBe("auth/logout");
  });

  it("round-trips loginStart params and result", () => {
    expect(zcodeAuthLoginStartParamsSchema.parse({ provider: "bigmodel" })).toEqual({
      provider: "bigmodel",
    });
    expect(() => zcodeAuthLoginStartParamsSchema.parse({ provider: "openai" })).toThrow();
    expect(() =>
      zcodeAuthLoginStartParamsSchema.parse({ provider: "zai", extra: true }),
    ).toThrow();
    const result = {
      authorizeUrl: "https://z.ai/oauth?state=x",
      expiresAt: 1_800_000_000,
      flowId: "flow-1",
      pollIntervalSec: 2,
    };
    expect(zcodeAuthLoginStartResultSchema.parse(result)).toEqual(result);
    expect(() =>
      zcodeAuthLoginStartResultSchema.parse({ ...result, pollToken: "secret" }),
    ).toThrow();
  });

  it("round-trips loginComplete ok/failure variants", () => {
    expect(zcodeAuthLoginCompleteParamsSchema.parse({ flowId: "f" })).toEqual({ flowId: "f" });
    const ok = {
      configPath: "/x/provider_config.json",
      credentialsPath: "/x/credentials.json",
      model: "glm-5",
      ok: true,
      provider: "zai",
      user: { user_id: "u1", name: "N" },
    } as const;
    expect(zcodeAuthLoginCompleteResultSchema.parse(ok)).toEqual(ok);
    const failed = { error: "Authorization timed out. Please retry login.", ok: false } as const;
    expect(zcodeAuthLoginCompleteResultSchema.parse(failed)).toEqual(failed);
    // 失败分支不允许携带成功字段。
    expect(() =>
      zcodeAuthLoginCompleteResultSchema.parse({ ...failed, model: "m" }),
    ).toThrow();
  });

  it("round-trips configureApiKey params and result", () => {
    expect(
      zcodeAuthConfigureApiKeyParamsSchema.parse({ apiKey: "sk-x", provider: "zai" }),
    ).toEqual({ apiKey: "sk-x", provider: "zai" });
    expect(() =>
      zcodeAuthConfigureApiKeyParamsSchema.parse({ apiKey: " ", provider: "zai" }),
    ).toThrow();
    const ok = {
      configPath: "/x/provider_config.json",
      model: "glm-5",
      ok: true,
      provider: "bigmodel",
    } as const;
    expect(zcodeAuthConfigureApiKeyResultSchema.parse(ok)).toEqual(ok);
    expect(
      zcodeAuthConfigureApiKeyResultSchema.parse({ error: "write failed", ok: false }),
    ).toEqual({ error: "write failed", ok: false });
    // 结果体不允许回显 apiKey（strict 多余字段即拒）。
    expect(() =>
      zcodeAuthConfigureApiKeyResultSchema.parse({ ...ok, apiKey: "sk-x" }),
    ).toThrow();
  });

  it("round-trips logout params and result", () => {
    expect(zcodeAuthLogoutParamsSchema.parse({})).toEqual({});
    expect(zcodeAuthLogoutParamsSchema.parse({ provider: "zai" })).toEqual({ provider: "zai" });
    expect(() => zcodeAuthLogoutParamsSchema.parse({ provider: "openai" })).toThrow();
    expect(zcodeAuthLogoutResultSchema.parse({ credentialsPath: "/x", ok: true })).toEqual({
      credentialsPath: "/x",
      ok: true,
    });
  });
});
