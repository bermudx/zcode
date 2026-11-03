import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LogLevel } from "@zcode/contracts";
import {
  DefaultLogRedactor,
  LOG_CLEANUP_STARTUP_DELAY_MS,
  cleanupLogRetention,
  createNodeLoggerFactory,
  formatLocalLogDate,
  flushLocalTtftLogs,
} from "../src/logging/index.js";
import {
  createStorageFsFaultInjector,
  resetStorageFsFaultInjectorForTests,
  setStorageFsFaultInjectorForTests,
} from "../src/storage/fs-fault-injection.js";

const NUMERIC_USAGE_FIELDS = [
  "tokens",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "usageInputTokens",
  "usageOutputTokens",
  "usageTotalTokens",
  "usageCacheReadTokens",
  "usageCacheWriteTokens",
  "usageReasoningTokens",
];

describe("DefaultLogRedactor numeric usage", () => {
  it.each(NUMERIC_USAGE_FIELDS)("preserves nonnegative integer %s at nested locations", (key) => {
    const context = {
      [key]: 0,
      usage: { [key]: 1234 },
      categories: [{ contributors: [{ [key]: 42, apiKey: "hidden" }] }],
    };

    expect(new DefaultLogRedactor().redact(context)).toEqual({
      [key]: 0,
      usage: { [key]: 1234 },
      categories: [{ contributors: [{ [key]: 42, apiKey: "[Redacted]" }] }],
    });
  });

  it.each([
    ["numeric string", "1234"],
    ["credential string", "secret-value"],
    ["empty string", ""],
    ["negative", -1],
    ["fraction", 0.5],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["null", null],
    ["undefined", undefined],
    ["boolean", true],
    ["object", { tokens: 42, apiKey: "hidden" }],
    ["array", [42, "hidden"]],
    ["boxed number", new Number(42)],
  ])("redacts %s under every allowed field", (_label, value) => {
    const context = Object.fromEntries(NUMERIC_USAGE_FIELDS.map((key) => [key, value]));

    expect(new DefaultLogRedactor().redact({ nested: context })).toEqual({
      nested: Object.fromEntries(NUMERIC_USAGE_FIELDS.map((key) => [key, "[Redacted]"])),
    });
  });

  it.each([
    "token",
    "customTokens",
    "accessToken",
    "refresh_token",
    "apiKey",
    "api-key",
    "authorization",
    "cookie",
    "credential",
    "password",
    "secret",
    "secretInputTokens",
    "apiKeyUsageTotalTokens",
    "authorizationTokens",
    "credentialTokens",
    "inputTokensSecret",
    "myusageInputTokens",
    "inputTokensExtra",
    "InputTokens",
    "USAGETOTALTOKENS",
  ])("keeps credential and unknown field %s protected", (key) => {
    for (const value of [1234, "hidden", { tokens: 42, safe: "hidden" }]) {
      expect(new DefaultLogRedactor().redact({ nested: { [key]: value } })).toEqual({
        nested: { [key]: "[Redacted]" },
      });
    }
  });

  it("redacts sensitive parents before inspecting allowed counters", () => {
    const secret = Object.fromEntries(NUMERIC_USAGE_FIELDS.map((key) => [key, 42]));
    const context = {
      usage: { inputTokens: 1234, token: secret, credentials: [secret] },
      authorization: { usage: secret, apiKey: "hidden" },
      tokens: secret,
    };

    expect(new DefaultLogRedactor().redact(context)).toEqual({
      usage: { inputTokens: 1234, token: "[Redacted]", credentials: "[Redacted]" },
      authorization: "[Redacted]",
      tokens: "[Redacted]",
    });
  });
});

describe("Node logging adapter", () => {
  it("生产等级保留 TTFT，使用异步写入并沿用脱敏", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-ttft-"));
    try {
      const logger = createNodeLoggerFactory({ logDir, minLevel: LogLevel.Info }).createLogger(
        "model",
      );
      logger.info("model first content", {
        event: "ttft.model.first_content",
        requestId: "request",
        apiKey: "secret",
      });
      await flushLocalTtftLogs();
      const [file] = await readdir(logDir);
      const content = await readFile(join(logDir, file!), "utf8");
      expect(content).toContain("ttft.model.first_content");
      expect(content).not.toContain("secret");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
  afterEach(() => {
    resetStorageFsFaultInjectorForTests();
  });

  it("formats log file dates from the local calendar day", () => {
    expect(formatLocalLogDate(new Date(2026, 4, 5, 2, 46, 0))).toBe("2026-05-05");
  });

  it("writes structured JSONL and redacts sensitive context keys", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-"));

    try {
      const logger = createNodeLoggerFactory({ logDir, minLevel: LogLevel.Debug })
        .createLogger("test")
        .child({
          event: "test.event",
          traceId: "trace_123" as never,
        });

      logger.info("hello", {
        apiKey: "secret",
        nested: {
          token: "token-value",
          safe: "visible",
        },
      });

      const files = await readdir(logDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/);

      const content = await readFile(join(logDir, files[0]!), "utf8");
      const entry = JSON.parse(content.trim()) as {
        context: { apiKey: string; nested: { safe: string; token: string } };
        event: string;
        level: string;
        traceId: string;
      };

      expect(entry.level).toBe("info");
      expect(entry.event).toBe("test.event");
      expect(entry.traceId).toBe("trace_123");
      expect(entry.context.apiKey).toBe("[Redacted]");
      expect(entry.context.nested.token).toBe("[Redacted]");
      expect(entry.context.nested.safe).toBe("visible");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("preserves usage counters in JSONL context and serialized error causes without leaking secrets", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-usage-"));

    try {
      const logger = createNodeLoggerFactory({ logDir }).createLogger("test");
      const cause = Object.assign(new Error("Provider failure"), {
        context: {
          usage: { inputTokens: 1234, outputTokens: 0, cacheReadTokens: "hidden" },
          apiKey: { tokens: 42, secret: "hidden" },
        },
      });
      const error = Object.assign(new Error("Turn failed", { cause }), {
        context: { usageTotalTokens: 1234, tokens: { totalTokens: 42, secret: "hidden" } },
      });

      logger.error("Usage diagnostics", error, {
        usageInputTokens: 1234,
        usageOutputTokens: 0,
        snapshot: { totalTokens: 42, categories: [{ tokens: 42 }] },
        usageReasoningTokens: "hidden",
        secretInputTokens: 42,
      });

      const [file] = await readdir(logDir);
      const content = await readFile(join(logDir, file!), "utf8");
      expect(JSON.parse(content.trim())).toMatchObject({
        context: {
          usageInputTokens: 1234,
          usageOutputTokens: 0,
          snapshot: { totalTokens: 42, categories: [{ tokens: 42 }] },
          usageReasoningTokens: "[Redacted]",
          secretInputTokens: "[Redacted]",
        },
        error: {
          context: { usageTotalTokens: 1234, tokens: "[Redacted]" },
          cause: {
            message: "Provider failure",
            context: {
              usage: { inputTokens: 1234, outputTokens: 0, cacheReadTokens: "[Redacted]" },
              apiKey: "[Redacted]",
            },
          },
        },
      });
      expect(content).not.toContain("hidden");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("does not throw when the log sink cannot be written", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-log-fail-"));
    const fileAsDirectory = join(tempRoot, "not-a-directory");

    try {
      await writeFile(fileAsDirectory, "");
      const logger = createNodeLoggerFactory({ logDir: fileAsDirectory }).createLogger("test");

      expect(() => logger.info("still returns")).not.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("swallows injected fs faults before JSONL append", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-fault-"));

    setStorageFsFaultInjectorForTests(
      createStorageFsFaultInjector([
        {
          id: "D05-log-append-enospc",
          code: "ENOSPC",
          operations: ["appendFile"],
          pathEndsWith: ".jsonl",
        },
      ]),
    );

    try {
      const logger = createNodeLoggerFactory({ logDir }).createLogger("test");

      expect(() => logger.info("still returns")).not.toThrow();
      await expect(readdir(logDir)).resolves.toEqual([]);
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("swallows injected fs faults before log directory creation", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-log-fault-"));
    const logDir = join(tempRoot, "logs");

    setStorageFsFaultInjectorForTests(
      createStorageFsFaultInjector([
        {
          id: "D05-log-mkdir-eacces",
          code: "EACCES",
          operations: ["mkdir"],
          pathEndsWith: "logs",
        },
      ]),
    );

    try {
      const logger = createNodeLoggerFactory({ logDir }).createLogger("test");

      expect(() => logger.warn("still returns")).not.toThrow();
      await expect(readdir(tempRoot)).resolves.toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("defaults to debug logging in development mode", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-dev-"));

    try {
      const logger = createNodeLoggerFactory({
        env: { ZCODE_RUNTIME_ENV: "development" },
        logDir,
      }).createLogger("test");

      logger.debug("dev-only");

      const files = await readdir(logDir);
      expect(files).toHaveLength(1);
      const content = await readFile(join(logDir, files[0]!), "utf8");
      const entry = JSON.parse(content.trim()) as { level: string; message: string };
      expect(entry.level).toBe("debug");
      expect(entry.message).toBe("dev-only");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("ignores ambient NODE_ENV when resolving development logging", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-node-env-ignored-"));

    try {
      const logger = createNodeLoggerFactory({
        env: { NODE_ENV: "development" },
        logDir,
      }).createLogger("test");

      logger.debug("hidden");

      const files = await readdir(logDir);
      expect(files).toHaveLength(0);
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("ignores ZCODE_LOG_LEVEL so development mode keeps debug logging", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-dev-env-ignored-"));

    try {
      const logger = createNodeLoggerFactory({
        env: { ZCODE_RUNTIME_ENV: "development", ZCODE_LOG_LEVEL: "info" },
        logDir,
      }).createLogger("test");

      logger.debug("still-visible");

      const files = await readdir(logDir);
      expect(files).toHaveLength(1);
      const content = await readFile(join(logDir, files[0]!), "utf8");
      const entry = JSON.parse(content.trim()) as { level: string; message: string };
      expect(entry.level).toBe("debug");
      expect(entry.message).toBe("still-visible");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("writes error cause chains with redacted diagnostic context", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-cause-"));

    try {
      const logger = createNodeLoggerFactory({ logDir, minLevel: LogLevel.Debug })
        .createLogger("test")
        .child({
          event: "turn.failed",
          traceId: "trace_failed" as never,
        });
      const cause = new Error("Model provider is missing an API key: openai") as Error & {
        code?: string;
        context?: Record<string, unknown>;
      };
      cause.name = "AiSdkModelAdapterError";
      cause.code = "provider_not_configured";
      cause.context = {
        apiKey: "secret-value",
        envKey: "ZCODE_API_KEY",
        providerId: "openai",
      };

      const error = new Error("Turn execution failed") as Error & {
        cause?: unknown;
        code?: string;
        type?: string;
      };
      error.code = "UNKNOWN_ERROR";
      error.type = "unknown_error";
      error.cause = cause;

      logger.error("Turn failed", error, { module: "core.runtime", status: "failed" });

      const files = await readdir(logDir);
      const content = await readFile(join(logDir, files[0]!), "utf8");
      const entry = JSON.parse(content.trim()) as {
        error: {
          cause: {
            code: string;
            context: {
              apiKey: string;
              envKey: string;
              providerId: string;
            };
            message: string;
            name: string;
          };
          code: string;
          message: string;
          type: string;
        };
      };

      expect(entry.error.message).toBe("Turn execution failed");
      expect(entry.error.code).toBe("UNKNOWN_ERROR");
      expect(entry.error.type).toBe("unknown_error");
      expect(entry.error.cause.name).toBe("AiSdkModelAdapterError");
      expect(entry.error.cause.code).toBe("provider_not_configured");
      expect(entry.error.cause.message).toBe("Model provider is missing an API key: openai");
      expect(entry.error.cause.context.providerId).toBe("openai");
      expect(entry.error.cause.context.envKey).toBe("ZCODE_API_KEY");
      expect(entry.error.cause.context.apiKey).toBe("[Redacted]");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("cleans only zcode JSONL logs older than the retention window", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-retention-"));

    try {
      await Promise.all([
        writeFile(join(logDir, "zcode-2026-05-01.jsonl"), "old\n"),
        writeFile(join(logDir, "zcode-2026-05-02.jsonl"), "cutoff\n"),
        writeFile(join(logDir, "zcode-2026-05-08.jsonl"), "today\n"),
        writeFile(join(logDir, "zcode-2026-04-30.txt"), "other\n"),
        writeFile(join(logDir, "other-2026-04-30.jsonl"), "other\n"),
      ]);

      const result = await cleanupLogRetention({
        logDir,
        now: new Date(2026, 4, 8, 12, 0, 0),
      });

      await expect(readdir(logDir).then((files) => files.sort())).resolves.toEqual([
        "other-2026-04-30.jsonl",
        "zcode-2026-04-30.txt",
        "zcode-2026-05-02.jsonl",
        "zcode-2026-05-08.jsonl",
      ]);
      expect(result).toMatchObject({
        cutoffDate: "2026-05-02",
        deletedFiles: ["zcode-2026-05-01.jsonl"],
        failedFiles: [],
        retentionDays: 7,
        scannedFiles: 3,
        status: "completed",
      });
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("schedules retention cleanup once with the startup delay and unrefs the timer", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "zcode-log-schedule-"));
    const factory = createNodeLoggerFactory({ logDir });
    const timer = {
      unrefCalls: 0,
      unref() {
        this.unrefCalls += 1;
      },
    };
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];

    try {
      const first = factory.scheduleLogRetentionCleanup({
        setTimeout(callback, delayMs) {
          scheduled.push({ callback, delayMs });
          return timer;
        },
      });
      const second = factory.scheduleLogRetentionCleanup({
        setTimeout(callback, delayMs) {
          scheduled.push({ callback, delayMs });
          return timer;
        },
      });

      expect(first).toBe(timer);
      expect(second).toBeUndefined();
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.delayMs).toBe(LOG_CLEANUP_STARTUP_DELAY_MS);
      expect(timer.unrefCalls).toBe(1);
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
});
