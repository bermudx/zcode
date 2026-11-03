import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@zcode/contracts";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
import {
  activateSessionForResume,
  listSessionSubagents,
  readSession,
} from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import { createConversationV4Gateway } from "../src/zcode-protocol/v4-bridge.js";

interface RecordedLog {
  context?: Record<string, unknown>;
  level: "debug" | "error" | "info" | "warn";
  message: string;
}

function createRecordingLogger(logs: RecordedLog[]): Logger {
  const logger = {
    child: () => logger,
    debug: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "debug", message, context }),
    error: (message: string, _error?: Error, context?: Record<string, unknown>) =>
      logs.push({ level: "error", message, context }),
    info: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "info", message, context }),
    warn: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "warn", message, context }),
  } as Logger;
  return logger;
}

function contextWithLogger(
  logger: Logger,
  overrides: Record<string, unknown> = {},
): ZCodeProtocolAgentServerContext {
  return {
    deps: {},
    sessions: new Map(),
    logger,
    ...overrides,
  } as unknown as ZCodeProtocolAgentServerContext;
}

describe("session lifecycle diagnostics", () => {
  it("records the active-runtime miss before readSession reports Session is not active", async () => {
    const logs: RecordedLog[] = [];
    const context = contextWithLogger(createRecordingLogger(logs));

    await expect(
      readSession(context, {
        deliveryKind: "desktop-continuous",
        sessionId: "sess_missing",
      }),
    ).rejects.toThrow("Session is not active: sess_missing");

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({
          event: "zcode_protocol.session.require_missing",
          deliveryKind: "desktop-continuous",
          operation: "session_read",
          sessionId: "sess_missing",
        }),
      }),
    );
  });

  it("records the persisted-session miss when cold resume cannot find the id", async () => {
    const logs: RecordedLog[] = [];
    const context = contextWithLogger(createRecordingLogger(logs), {
      deps: {
        sessionStore: {
          getSession: async () => null,
        },
      },
    });

    await expect(activateSessionForResume(context, { sessionId: "sess_missing" })).rejects.toThrow(
      "Session not found: sess_missing",
    );

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({
          event: "zcode_protocol.session.resume_persisted_missing",
          sessionId: "sess_missing",
        }),
      }),
    );
  });

  it("records the durable parent miss that surfaces through v4 hydration", async () => {
    const logs: RecordedLog[] = [];
    const context = contextWithLogger(createRecordingLogger(logs), {
      deps: {
        sessionStore: {
          getSession: async () => null,
        },
      },
    });

    await expect(
      listSessionSubagents(context, { sessionId: "sess_missing", endedLimit: 1 }),
    ).rejects.toThrow("Session not found: sess_missing");

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({
          event: "zcode_protocol.session.persisted_missing",
          operation: "session_subagents",
          sessionId: "sess_missing",
        }),
      }),
    );
  });

  it.each(["immediate", "deferred"])(
    "returns an empty subagent list for a live unpersisted %s session",
    async (persistence) => {
      const logs: RecordedLog[] = [];
      const getSession = vi.fn(async () => null);
      const context = contextWithLogger(createRecordingLogger(logs), {
        deps: { sessionStore: { getSession } },
        sessions: new Map([
          [
            "sess_draft",
            {
              app: { runtime: { isSessionPersisted: () => false } },
              persistence,
              stateRevision: 7,
            },
          ],
        ]),
      });

      await expect(
        listSessionSubagents(context, { sessionId: "sess_draft", endedLimit: 1 }),
      ).resolves.toEqual({
        revision: 7,
        childSessionIds: [],
        running: [],
        ended: { total: 0, items: [] },
      });
      expect(getSession).toHaveBeenCalledOnce();
      expect(logs).toEqual([]);
    },
  );

  it("does not hide a missing durable parent behind a stale deferred policy", async () => {
    const logs: RecordedLog[] = [];
    const context = contextWithLogger(createRecordingLogger(logs), {
      deps: { sessionStore: { getSession: async () => null } },
      sessions: new Map([
        [
          "sess_persisted",
          {
            app: { runtime: { isSessionPersisted: () => true } },
            persistence: "deferred",
            stateRevision: 7,
          },
        ],
      ]),
    });

    await expect(
      listSessionSubagents(context, { sessionId: "sess_persisted", endedLimit: 1 }),
    ).rejects.toThrow("Session not found: sess_persisted");
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({
          event: "zcode_protocol.session.persisted_missing",
          activeSession: true,
        }),
      }),
    );
  });

  it("rereads a stale missing parent when first persistence completes during the read", async () => {
    let persisted = false;
    const logs: RecordedLog[] = [];
    const getSession = vi
      .fn()
      .mockImplementationOnce(async () => {
        persisted = true;
        return null;
      })
      .mockResolvedValue({ id: "sess_creating", time: { updated: 1 } });
    const context = contextWithLogger(createRecordingLogger(logs), {
      deps: { sessionStore: { getSession, messages: async () => [] } },
      sessions: new Map([
        [
          "sess_creating",
          {
            app: {
              runtime: {
                isSessionPersisted: () => persisted,
                getProjection: async () => undefined,
              },
            },
            eventStore: { getEvents: async () => [] },
            stateRevision: 7,
          },
        ],
      ]),
    });

    await expect(
      listSessionSubagents(context, { sessionId: "sess_creating", endedLimit: 1 }),
    ).resolves.toMatchObject({ revision: 7, childSessionIds: [], running: [], ended: { total: 0 } });
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(logs).toEqual([]);
  });

  it("propagates storage failures even when the live parent is unpersisted", async () => {
    const failure = new Error("fixture session read failed");
    const context = contextWithLogger(createRecordingLogger([]), {
      deps: {
        sessionStore: {
          getSession: async () => {
            throw failure;
          },
        },
      },
      sessions: new Map([
        [
          "sess_draft",
          { app: { runtime: { isSessionPersisted: () => false } }, stateRevision: 1 },
        ],
      ]),
    });

    await expect(
      listSessionSubagents(context, { sessionId: "sess_draft", endedLimit: 1 }),
    ).rejects.toBe(failure);
  });

  it("includes the session and phase when the gateway hydration source fails", async () => {
    const errors: Array<{
      context?: Record<string, unknown>;
      error: unknown;
      scope: string;
    }> = [];
    const gateway = new ConversationV4Gateway({
      sessionExists: () => true,
      executeCommand: async () => undefined,
      emitWireFrame: () => undefined,
      loadPersistedEvents: async () => {
        throw new Error("Session not found: sess_missing");
      },
      onError: (scope, error, context) => errors.push({ scope, error, context }),
    });

    await gateway.subscribe({
      topic: conversationTopic("sess_missing"),
      connectionId: "conn-test",
      clientMode: "desktop-continuous",
    });

    expect(errors).toContainEqual(
      expect.objectContaining({
        scope: "v4.hydrate",
        context: expect.objectContaining({
          phase: "loadPersistedEvents",
          sessionId: "sess_missing",
        }),
      }),
    );
  });

  it("records a missing persisted session before v4 cold resume returns notFound", async () => {
    const logs: RecordedLog[] = [];
    const context = contextWithLogger(createRecordingLogger(logs), {
      deps: {
        sessionStore: {
          getSession: async () => null,
        },
      },
    });
    const gateway = createConversationV4Gateway(context);

    await expect(
      gateway.subscribe({
        topic: conversationTopic("sess_missing"),
        connectionId: "conn-test",
        clientMode: "desktop-continuous",
      }),
    ).rejects.toThrow("Session is not active and not persisted: sess_missing");

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        context: expect.objectContaining({
          event: "zcode_protocol.v4.resume_persisted_missing",
          sessionId: "sess_missing",
        }),
      }),
    );
  });

  it("includes the session and phase when cold resume itself fails", async () => {
    const errors: Array<{
      context?: Record<string, unknown>;
      error: unknown;
      scope: string;
    }> = [];
    const gateway = new ConversationV4Gateway({
      sessionExists: () => false,
      executeCommand: async () => undefined,
      emitWireFrame: () => undefined,
      resumePersistedSession: async () => {
        throw new Error("activation failed");
      },
      onError: (scope, error, context) => errors.push({ scope, error, context }),
    });

    await expect(
      gateway.subscribe({
        topic: conversationTopic("sess_resume_failed"),
        connectionId: "conn-test",
        clientMode: "desktop-continuous",
      }),
    ).rejects.toThrow("Failed to resume persisted session sess_resume_failed");

    expect(errors).toContainEqual(
      expect.objectContaining({
        scope: "v4.subscribe.resume",
        context: expect.objectContaining({
          phase: "resumePersistedSession",
          sessionId: "sess_resume_failed",
        }),
      }),
    );
  });
});
