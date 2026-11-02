import { describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import {
  createModelId,
  createModelProviderId,
  type ModelNetworkStatusEvent,
} from "@zcode/contracts";
import { createStatusContext, publishModelStatus } from "../src/model/runner-status.js";

const event: ModelNetworkStatusEvent = {
  attempt: 1,
  maxAttempts: 1,
  providerId: createModelProviderId("provider"),
  modelId: createModelId("model"),
  requestId: "request",
  timestamp: "2026-07-22T00:00:00.000Z",
  traceId: "trace" as never,
  transport: "http",
  type: "model_request_started",
};

describe("publishModelStatus", () => {
  it("把 Core stream recovery attribution 带入所有 Adapter status event", () => {
    const streamRecovery = {
      attemptId: "recovery-attempt",
      maxRetries: 10,
      recoveredFromRequestId: "failed-request",
      retryNumber: 2,
    };
    const context = createStatusContext({
      maxAttempts: 1,
      request: {
        messages: [],
        streamRecovery,
      },
      resolved: {
        baseURL: "https://api.example.com/v1",
        providerKind: "anthropic",
        providerId: event.providerId,
        modelId: event.modelId,
      } as never,
      transport: "sse",
    });

    expect(context.streamRecovery).toEqual(streamRecovery);
  });

  it("同时投递 request sink 与 adapter telemetry sink", async () => {
    const requestPublish = vi.fn();
    const telemetryPublish = vi.fn();
    await publishModelStatus(event, {
      requestStatusSink: { publish: requestPublish },
      statusSink: { publish: telemetryPublish },
    });
    expect(requestPublish).toHaveBeenCalledWith(event);
    expect(telemetryPublish).toHaveBeenCalledWith(event);
  });

  it("同一个 sink 不重复投递", async () => {
    const publish = vi.fn();
    const sink = { publish };
    await publishModelStatus(event, { requestStatusSink: sink, statusSink: sink });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("原始失败只交给进程级观测 sink，不进入 request sink", async () => {
    const failureEvent: ModelNetworkStatusEvent = {
      ...event,
      durationMs: 10,
      message: "Provider request failed.",
      reason: "network_error",
      retryable: false,
      type: "model_request_failed",
    };
    const rawError = Object.assign(new Error("socket reset by peer"), {
      code: "ECONNRESET",
    });
    const requestPublish = vi.fn();
    const telemetryPublish = vi.fn();
    const telemetryPublishFailure = vi.fn();

    await publishModelStatus(failureEvent, {
      failureError: rawError,
      requestStatusSink: { publish: requestPublish },
      statusSink: {
        publish: telemetryPublish,
        publishFailure: telemetryPublishFailure,
      },
    });

    expect(requestPublish).toHaveBeenCalledWith(failureEvent);
    expect(requestPublish).not.toHaveBeenCalledWith(failureEvent, rawError);
    expect(telemetryPublish).not.toHaveBeenCalled();
    expect(telemetryPublishFailure).toHaveBeenCalledWith(failureEvent, rawError);
  });

  it("一个 sink 失败时仍投递另一个 sink，且不污染模型主链路", async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const telemetryPublish = vi.fn();
    await expect(
      publishModelStatus(event, {
        logger: logger as never,
        requestStatusSink: {
          publish: () => {
            throw new Error("usage sink unavailable");
          },
        },
        statusSink: { publish: telemetryPublish },
      }),
    ).resolves.toBeUndefined();
    expect(telemetryPublish).toHaveBeenCalledWith(event);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe("publishModelStatus auth failure logging", () => {
  const failureEvent: ModelNetworkStatusEvent = {
    ...event,
    durationMs: 10,
    errorCode: "provider_not_configured",
    message: "Provider authentication failed.",
    reason: "auth_failed",
    retryable: false,
    statusCode: 401,
    type: "model_request_failed",
  };

  function createLogger() {
    return {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
  }

  function loggedFailureContext(logger: ReturnType<typeof createLogger>): Record<string, unknown> {
    const [, context] = logger.warn.mock.calls.at(-1) as [string, Record<string, unknown>];
    return context;
  }

  // 回归（2026-11-02）：z.ai SSE 中途 401 被归一成 “Provider authentication failed.” 后，
  // 日志只剩状态码，provider 自己的 authentication_error 文案和响应正文全部丢失。
  it("keeps the provider's own 401 payload in the failure log", async () => {
    const logger = createLogger();
    const error = new APICallError({
      isRetryable: false,
      message: "Provider authentication failed.",
      responseBody: JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "token expired at 2026-11-02T21:53:38Z",
        },
      }),
      statusCode: 401,
      url: "https://api.z.ai/api/anthropic/v1/messages",
    });

    await publishModelStatus(failureEvent, { failureError: error, logger: logger as never });

    expect(loggedFailureContext(logger)).toMatchObject({
      event: "model.request.failed",
      providerErrorType: "authentication_error",
      providerErrorMessage: "token expired at 2026-11-02T21:53:38Z",
      statusCode: 401,
    });
    expect(loggedFailureContext(logger).providerResponseBody).toContain("authentication_error");
  });

  it("redacts credential-shaped text and bounds the body", async () => {
    const logger = createLogger();
    const error = new APICallError({
      isRetryable: false,
      message: "Forbidden",
      responseBody: JSON.stringify({
        error: {
          message: `Bearer ${"a".repeat(40)} rejected`,
          type: "permission_error",
        },
        padding: "x".repeat(4_000),
      }),
      statusCode: 403,
    });

    await publishModelStatus(
      { ...failureEvent, reason: "auth_failed", statusCode: 403 },
      { failureError: error, logger: logger as never },
    );

    const context = loggedFailureContext(logger);
    const body = String(context.providerResponseBody);
    expect(body).not.toContain("a".repeat(40));
    expect(body).toContain("Bearer [redacted]");
    expect(body.length).toBeLessThan(2_000);
    expect(body).toContain("[truncated");
  });

  it("reads the provider payload through a terminal stream wrapper's cause", async () => {
    const logger = createLogger();
    const apiError = new APICallError({
      isRetryable: false,
      message: "Provider authentication failed.",
      responseBody: JSON.stringify({
        error: { message: "token expired", type: "authentication_error" },
      }),
      statusCode: 401,
    });

    await publishModelStatus(failureEvent, {
      failureError: new Error("Provider authentication failed.", { cause: apiError }),
      logger: logger as never,
    });

    expect(loggedFailureContext(logger)).toMatchObject({
      providerErrorMessage: "token expired",
      providerErrorType: "authentication_error",
      statusCode: 401,
    });
  });

  it("does not log provider bodies for non-auth failures", async () => {
    const logger = createLogger();
    const error = new APICallError({
      isRetryable: true,
      message: "Provider returned a server error.",
      responseBody: JSON.stringify({ error: { message: "upstream exploded", type: "api_error" } }),
      statusCode: 502,
    });

    await publishModelStatus(
      { ...failureEvent, message: "Provider returned a server error.", statusCode: 502 },
      { failureError: error, logger: logger as never },
    );

    const context = loggedFailureContext(logger);
    expect(context.providerResponseBody).toBeUndefined();
    expect(context.providerErrorType).toBeUndefined();
  });
});
