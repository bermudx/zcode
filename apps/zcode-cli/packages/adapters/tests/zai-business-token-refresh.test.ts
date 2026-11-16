import { describe, expect, it, vi } from "vitest";
import { type HttpClientPort } from "@zcode/contracts";
import {
  CodingPlanApiKeyError,
  createCodingPlanApiKeyResolver,
} from "../src/auth/coding-plan-api-key.js";

function response(data: unknown) {
  return { status: 200, body: new TextEncoder().encode(JSON.stringify({ code: 200, data })) };
}

describe("Z.ai business token", () => {
  it("uses the stored business token directly and never exchanges it during resolve", async () => {
    const requests: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
    }> = [];
    const request = vi.fn(
      async (input: { url: string; method: string; headers: Record<string, string> }) => {
        requests.push(input);
        if (input.url.endsWith("getCustomerInfo"))
          return response({
            organizations: [
              { organizationId: "org", projects: [{ projectId: "project" }] },
            ],
          });
        if (input.url.endsWith("/api_keys"))
          return response(
            input.method === "POST" ? { apiKey: "key", name: "zcode-api-key" } : [],
          );
        return response({
          accessToken: "project-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        });
      },
    );
    const resolver = createCodingPlanApiKeyResolver({
      httpClient: { request } as unknown as HttpClientPort,
    });

    await expect(
      resolver.resolve({
        family: "zai",
        accessToken: "stored-business-token",
        accountIdentity: "user",
      }),
    ).resolves.toBe("project-token");

    expect(requests.some(({ url }) => url.endsWith("/api/auth/z/login"))).toBe(false);
    expect(requests.length).toBeGreaterThan(0);
    for (const downstream of requests)
      expect(new Headers(downstream.headers).get("authorization")).toBe(
        "Bearer stored-business-token",
      );
  });

  it("keeps issue #50 structured reasons on login-exchange failures", async () => {
    const request = vi.fn(async ({ url }: { url: string }) => {
      if (url.endsWith("/api/auth/z/login"))
        return {
          status: 200,
          body: new TextEncoder().encode(
            JSON.stringify({ code: 1002, msg: "login expired" }),
          ),
        };
      throw new Error("unexpected request");
    });
    const observe = vi.fn();
    const resolver = createCodingPlanApiKeyResolver({
      httpClient: { request } as unknown as HttpClientPort,
      observe,
    });

    const error = await resolver.exchangeZaiBusinessToken("raw-oauth-token").catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(CodingPlanApiKeyError);
    expect(error).toMatchObject({
      message: "project_token_login_failed",
      loginFailure: { code: "1002", msg: "login expired" },
    });
    expect(observe).toHaveBeenCalledExactlyOnceWith({
      family: "zai",
      stage: "resolve",
      code: "project_token_login_failed",
      zaiCode: "1002",
      zaiMessage: "login expired",
    });
    expect(JSON.stringify(observe.mock.calls)).not.toContain("raw-oauth-token");
  });
});
