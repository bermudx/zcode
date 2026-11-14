import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { HttpClientPort, HttpClientResponse } from "@zcode/contracts";
import { createSharedZCodeCredentialStore } from "@zcode/adapters/auth";
import type { EnvRecord } from "@zcode/adapters/model";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import type { LoginZCodeCliOptions } from "../src/auth-login.js";
import {
  createProtocolAuthLoginHandlers,
  type ProtocolAuthLoginDeps,
} from "../src/zcode-protocol/auth-login.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { startProcessProviderRegistryRuntime } from "../src/app/process-provider-registry-runtime.js";
import { resolveStandaloneCodingPlanProvider } from "../src/app/standalone-account-provider-runtime.js";

const authorizeUrl = "https://login.example.test/authorize?state=test-state";
const ready = {
  status: "ready",
  token: "test-backend-jwt",
  user: { user_id: "test-account", name: "Test User" },
  zai: { access_token: "test-oauth-token" },
};
const TEST_PROJECT_MATERIAL = {
  apiKeyId: "test-api-key-id",
  organizationId: "test-org",
  projectId: "test-project",
  token: "test-project-token",
};

function response(data: unknown, status = 200): HttpClientResponse {
  const body = new TextEncoder().encode(JSON.stringify({ code: 0, data }));
  return {
    body,
    bytes: body.length,
    durationMs: 0,
    headers: {},
    status,
    statusText: "test",
    url: "https://example.test",
  };
}

type LogEntry = { context?: Record<string, unknown>; level: string; message: string };

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-auth-proto-"));
  const personalFile = join(dir, "provider_config.json");
  const personal = new NodePersonalProviderConfigRepository({
    filePath: personalFile,
    pollingIntervalMs: false,
  });
  await personal.update((current) => current);
  personal.dispose();
  const env: EnvRecord = {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: resolve(
      import.meta.dirname,
      "../../../../../config/provider/zcode-builtin.json",
    ),
    ZCODE_CREDENTIAL_SECRET: "test-encryption-key",
    ZCODE_DATA_BASE_DIR: dir,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalFile,
  };
  const logs: LogEntry[] = [];
  const logger = {
    child: () => logger,
    debug: (message: string, context?: Record<string, unknown>) =>
      logs.push({ context, level: "debug", message }),
    error: (message: string, context?: Record<string, unknown>) =>
      logs.push({ context, level: "error", message }),
    info: (message: string, context?: Record<string, unknown>) =>
      logs.push({ context, level: "info", message }),
    warn: (message: string, context?: Record<string, unknown>) =>
      logs.push({ context, level: "warn", message }),
  };
  const context = {
    deps: { env },
    getClientDetachSignal: () => new AbortController().signal,
    logger,
    notify: () => undefined,
    sessions: new Map(),
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, dir, env, logger, logs };
}

function httpClientFixture(init?: Partial<{ authorizeUrl: string; expiresAt: number }>) {
  const requests: Parameters<HttpClientPort["request"]>[0][] = [];
  let polls = 0;
  const f = {
    poll: async (): Promise<HttpClientResponse> => response(ready),
    requests,
    httpClient: {
      async request(request, options) {
        requests.push(request);
        assert.ok(options?.signal);
        if (request.method === "POST") {
          return response({
            authorize_url: init?.authorizeUrl ?? authorizeUrl,
            expires_at: init?.expiresAt ?? Math.floor(Date.now() / 1000) + 120,
            flow_id: "flow-1",
            poll_interval_sec: 1,
          });
        }
        return f.poll();
      },
    } as HttpClientPort,
  };
  return f;
}

const apiKeyResolver = {
  async resolveMaterial() {
    return TEST_PROJECT_MATERIAL;
  },
} as unknown as LoginZCodeCliOptions["apiKeyResolver"];

describe("zcode protocol auth/* handlers", () => {
  it("loginStart returns the authorize URL and loginComplete persists credentials", async () => {
    const f = await fixture();
    const http = httpClientFixture();
    const handlers = createProtocolAuthLoginHandlers({
      apiKeyResolver,
      httpClient: http.httpClient,
      sleep: async () => {},
    });
    const start = await handlers.loginStart(f.context, { provider: "zai" });
    expect(start).toEqual({
      authorizeUrl,
      expiresAt: expect.any(Number),
      flowId: "flow-1",
      pollIntervalSec: 1,
    });
    const complete = await handlers.loginComplete(f.context, { flowId: start.flowId });
    assert.equal(complete.ok, true);
    expect(complete.provider).toBe("zai");
    expect(complete.model.length).toBeGreaterThan(0);
    expect(complete.user.user_id).toBe("test-account");
    // poll 用 flow_id + init 期生成的 Bearer pollToken；客户端只见 flowId。
    const polls = http.requests.filter((r) => r.method === "GET");
    expect(polls.length).toBeGreaterThan(0);
    for (const request of polls) {
      expect(request.url).toContain("/oauth/cli/poll/flow-1");
      expect(request.headers?.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
    }
  });

  it("loginComplete reports failure in the result body, not as a protocol error", async () => {
    const f = await fixture();
    const http = httpClientFixture();
    http.poll = async () => response({ status: "failed" });
    const handlers = createProtocolAuthLoginHandlers({
      apiKeyResolver,
      httpClient: http.httpClient,
      sleep: async () => {},
    });
    const start = await handlers.loginStart(f.context, { provider: "zai" });
    const complete = await handlers.loginComplete(f.context, { flowId: start.flowId });
    assert.equal(complete.ok, false);
    expect(complete.error.length).toBeGreaterThan(0);
  });

  it("loginCancel aborts an in-flight loginComplete and removes the flow", async () => {
    const f = await fixture();
    const http = httpClientFixture();
    // poll 永不返回：取消必须经 abort signal 打断，而不是等服务端响应。
    http.poll = () => new Promise<HttpClientResponse>(() => {});
    const handlers = createProtocolAuthLoginHandlers({
      apiKeyResolver,
      httpClient: http.httpClient,
      sleep: async () => {},
    });
    const start = await handlers.loginStart(f.context, { provider: "zai" });
    const completePromise = handlers.loginComplete(f.context, { flowId: start.flowId });
    const cancel = await handlers.loginCancel(f.context, { flowId: start.flowId });
    assert.equal(cancel.ok, true);
    const complete = await completePromise;
    assert.equal(complete.ok, false);
    expect(complete.error).toBe("Login cancelled.");
    // flow 已摘除：同 flowId 的 complete 走未知 flow 分支，不能复活已取消的登录。
    const retry = await handlers.loginComplete(f.context, { flowId: start.flowId });
    assert.equal(retry.ok, false);
    expect(retry.error).toContain("Run /login again");
    await rm(f.dir, { force: true, recursive: true });
  });

  it("loginComplete rejects unknown flow ids", async () => {
    const f = await fixture();
    const handlers = createProtocolAuthLoginHandlers({ httpClient: httpClientFixture().httpClient });
    const complete = await handlers.loginComplete(f.context, { flowId: "nope" });
    assert.equal(complete.ok, false);
    expect(complete.error).toContain("Run /login again");
  });

  it("configureApiKey persists without ever logging the key", async () => {
    const f = await fixture();
    const secretKey = "sk-test-secret-do-not-log-0000";
    const handlers = createProtocolAuthLoginHandlers({ httpClient: httpClientFixture().httpClient });
    const result = await handlers.configureApiKey(f.context, {
      apiKey: secretKey,
      provider: "zai",
    });
    assert.equal(result.ok, true);
    expect(result.provider).toBe("zai");
    const serialized = JSON.stringify(f.logs);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain("test-project-token");
  });

  it("oauth login + api key configure refresh the running Registry without restart", async () => {
    const f = await fixture();
    const store = createSharedZCodeCredentialStore({ env: f.env });
    const http = httpClientFixture();
    const handlers = createProtocolAuthLoginHandlers({
      apiKeyResolver,
      credentialStore: store,
      httpClient: http.httpClient,
      sleep: async () => {},
    });
    const runtime = await startProcessProviderRegistryRuntime(f.env, {
      standalone: { credentialStore: store },
    });
    try {
      const configured = await resolveStandaloneCodingPlanProvider("zai", f.env);
      // 写入发生在同一进程：同路径 credentialStore.onDidChange 监听驱动
      // Account Source + Registry 重建，不等下次启动。
      expect(runtime.runtime.registryService.getProvider(configured.providerId)).toBeUndefined();

      const start = await handlers.loginStart(f.context, { provider: "zai" });
      const complete = await handlers.loginComplete(f.context, { flowId: start.flowId });
      assert.equal(complete.ok, true);
      expect(
        runtime.runtime.registryService.getProvider(configured.providerId)?.models.length,
      ).toBeGreaterThan(0);
      expect(await runtime.modelSelectionConfigRepository.read()).toEqual({
        modelId: configured.modelId,
        providerId: configured.providerId,
      });

      await handlers.logout(f.context, {});
      expect(
        runtime.runtime.registryService.getProvider(configured.providerId),
      ).toBeUndefined();

      const apiKey = await handlers.configureApiKey(f.context, {
        apiKey: "sk-live-key",
        provider: "zai",
      });
      assert.equal(apiKey.ok, true);
      expect(
        runtime.runtime.registryService.getProvider(configured.providerId)?.models.length,
      ).toBeGreaterThan(0);
    } finally {
      runtime.dispose();
      await rm(f.dir, { force: true, recursive: true });
    }
  });

  it("logout removes shared credentials and returns the credentials path", async () => {
    const f = await fixture();
    const handlers = createProtocolAuthLoginHandlers({ httpClient: httpClientFixture().httpClient });
    await handlers.configureApiKey(f.context, { apiKey: "sk-x", provider: "zai" });
    const result = await handlers.logout(f.context, {});
    expect(result.ok).toBe(true);
    expect(result.credentialsPath).toContain("credentials.json");
    await rm(f.dir, { force: true, recursive: true });
  });
});
