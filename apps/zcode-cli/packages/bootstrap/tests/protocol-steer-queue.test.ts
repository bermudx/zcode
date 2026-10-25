// attach steer lane 的服务端行为：session/send delivery:"steer" 直驱
// app.steerTurn（guide），拒绝族如实回 guard.steerRejected.{reason}；
// session/discardPendingInputs 逐项桥 removeQueueItem（Alt+Up 撤回）。
// 客户端侧（回退 follow-up 队列、本地摘除）见 cli tests/attach-adapter.test.ts。

import { describe, expect, it, vi } from "vitest";
import {
  zcodeProtocolMethods,
  zcodeSessionSendResultSchema,
  zcodeSessionStateSnapshotSchema,
} from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

const workspace = {
  workspacePath: "/workspace/app",
  workspaceKey: "/workspace/app",
};

async function requestResult(
  server: ZCodeProtocolAgentServer,
  message: ZCodeProtocolMessage,
): Promise<unknown> {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

async function createSession(server: ZCodeProtocolAgentServer): Promise<string> {
  const created = zcodeSessionStateSnapshotSchema.parse(
    await requestResult(server, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    }),
  );
  return created.session.sessionId;
}

function startServer(appOverrides: Record<string, unknown>): ZCodeProtocolAgentServer {
  return new ZCodeProtocolAgentServer({
    createZCodeApp: (options) => createFakeApp(options, appOverrides as never),
    cwd: workspace.workspacePath,
    version: "test-version",
  });
}

describe("session/send delivery steer", () => {
  it("steers into the active turn and returns the steerQueued receipt", async () => {
    const steerTurn = vi.fn(async () => ({
      kind: "queued",
      pendingInputId: "pend-1",
      queueLength: 2,
      turnId: "turn-7",
    }));
    const server = startServer({ steerTurn });
    const sessionId = await createSession(server);

    const result = zcodeSessionSendResultSchema.parse(
      await requestResult(server, {
        id: 2,
        method: zcodeProtocolMethods.sessionSend,
        params: {
          sessionId,
          content: "redirect please",
          delivery: "steer",
          inputId: "in-steer-1",
          queryId: "q-1",
        },
      }),
    );

    expect(result.steerQueued).toEqual({
      pendingInputId: "pend-1",
      queueLength: 2,
      turnId: "turn-7",
    });
    expect(steerTurn).toHaveBeenCalledWith(
      "redirect please",
      expect.objectContaining({ delivery: "guide", inputId: "in-steer-1", queryId: "q-1" }),
    );
  });

  it("reports core rejections as guard.steerRejected.{reason} without starting a turn", async () => {
    const steerTurn = vi.fn(async () => ({
      kind: "rejected",
      reason: "turn_not_steerable",
    }));
    const server = startServer({ steerTurn });
    const sessionId = await createSession(server);

    await expect(
      server.handleMessage({
        id: 2,
        method: zcodeProtocolMethods.sessionSend,
        params: { sessionId, content: "redirect", delivery: "steer" },
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32010,
        data: { reasonCode: "guard.steerRejected.turn_not_steerable" },
      },
    });
  });

  it("rejects steer with attachments instead of silently dropping them", async () => {
    const steerTurn = vi.fn();
    const server = startServer({ steerTurn });
    const sessionId = await createSession(server);

    await expect(
      server.handleMessage({
        id: 2,
        method: zcodeProtocolMethods.sessionSend,
        params: {
          sessionId,
          content: "see attached",
          delivery: "steer",
          attachments: [{ kind: "file", localPath: "notes.txt" }],
        },
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32010,
        data: { reasonCode: "guard.steerAttachmentsUnsupported" },
      },
    });
    expect(steerTurn).not.toHaveBeenCalled();
  });
});

describe("session/discardPendingInputs", () => {
  it("bridges removeQueueItem per id and reports only actually removed ids", async () => {
    const removed = new Set(["pend-1", "pend-3"]);
    const removeQueueItem = vi.fn(async (id: string) => removed.has(id));
    const server = startServer({ removeQueueItem });
    const sessionId = await createSession(server);

    const result = (await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionDiscardPendingInputs,
      params: { sessionId, pendingInputIds: ["pend-1", "pend-2", "pend-3"] },
    })) as { removed: string[] };

    expect(result.removed).toEqual(["pend-1", "pend-3"]);
    expect(removeQueueItem).toHaveBeenCalledTimes(3);
    expect(removeQueueItem).toHaveBeenNthCalledWith(
      1,
      "pend-1",
      expect.objectContaining({ reason: "user_removed" }),
    );
  });

  it("keeps going when a single removal throws, reporting the survivors", async () => {
    const removeQueueItem = vi.fn(async (id: string) => {
      if (id === "pend-boom") throw new Error("store unavailable");
      return true;
    });
    const server = startServer({ removeQueueItem });
    const sessionId = await createSession(server);

    const result = (await requestResult(server, {
      id: 2,
      method: zcodeProtocolMethods.sessionDiscardPendingInputs,
      params: { sessionId, pendingInputIds: ["pend-boom", "pend-ok"] },
    })) as { removed: string[] };

    expect(result.removed).toEqual(["pend-ok"]);
  });
});
