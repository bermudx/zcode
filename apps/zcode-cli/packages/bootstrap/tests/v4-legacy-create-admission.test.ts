import { describe, expect, it, vi } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ProjectId, SessionId } from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeSessionStateSnapshotSchema,
  type ZCodeProtocolMessage,
} from "@zcode/shared";
import { V4_METHODS, commandAckSchema } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeApp, ZCodeAppOptions } from "../src/app/types.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

// piz attach 用旧 session/create 建会话、用 v4 sendText 提交。旧 create 的 record 缺省
// persistence:"immediate"，而 runtime 要到首条输入才落 session 行；v4 admission 必须以
// runtime 落行事实为准先落行，否则 session_input 撞 session(id) 外键（2026-11-02 live e2e）。
// 见 docs/design/v2/tui-attach-shared-core.md「输入提交迁移到 v4」。

const workspace = {
  workspacePath: "/workspace/v4-legacy-create-admission",
  workspaceKey: "/workspace/v4-legacy-create-admission",
};

async function request(
  server: ZCodeProtocolAgentServer,
  message: ZCodeProtocolMessage,
): Promise<unknown> {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

async function setup(options: { runtimePersistedAtCreate: boolean }) {
  const store = await createSqliteSessionStore({ dbPath: ":memory:" });
  let persisted = false;
  const ensurePersisted = vi.fn();
  const server = new ZCodeProtocolAgentServer({
    createZCodeApp: (appOptions) => {
      // fake 只读 sessionId/traceContext/runtimeConfig；server 注入前尚无 providerRegistry。
      const app = createFakeApp(appOptions as ZCodeAppOptions);
      const sessionId = app.sessionId;
      const writeRow = async () => {
        if (await store.getSession(sessionId)) return;
        await store.createSession({
          id: sessionId,
          projectID: "project_v4_legacy_create" as ProjectId,
          slug: "v4-legacy-create",
          directory: workspace.workspacePath,
          path: workspace.workspacePath,
          title: "v4 legacy create",
          version: "test-version",
          time: { created: 1, updated: 1 },
        });
      };
      return {
        ...app,
        runtime: {
          ...app.runtime,
          // 与真实 AgentRuntime 同构：落行只经统一首发持久化边界，isSessionPersisted 反映落行事实。
          isSessionPersisted: () => persisted,
          ensureSessionPersistedForExternalActivity: async (text: string) => {
            ensurePersisted(text);
            await writeRow();
            persisted = true;
          },
        } as never,
        sendInput: async () => ({ kind: "started", turnId: "turn_1" }) as never,
        submitPrompt: async () => ({ traceId: app.traceId }) as never,
      } satisfies ZCodeApp;
    },
    cwd: workspace.workspacePath,
    sessionStore: store,
  });
  const created = zcodeSessionStateSnapshotSchema.parse(
    await request(server, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    }),
  );
  const sessionId = created.session.sessionId as SessionId;
  if (options.runtimePersistedAtCreate) {
    await store.createSession({
      id: sessionId,
      projectID: "project_v4_legacy_create" as ProjectId,
      slug: "v4-legacy-create",
      directory: workspace.workspacePath,
      path: workspace.workspacePath,
      title: "v4 legacy create",
      version: "test-version",
      time: { created: 1, updated: 1 },
    });
    persisted = true;
  }
  return { ensurePersisted, server, sessionId, store };
}

function sendText(sessionId: string, commandId: string) {
  return {
    id: 2,
    method: V4_METHODS.command,
    params: {
      clientId: "attach-test",
      commandId,
      issuedAt: 10,
      payload: { heldQueueDisposition: "keepQueueAndSend", text: "hello from attach" },
      sessionId,
      type: "sendText",
    },
  } as const;
}

describe("v4 input admission on legacy session/create sessions", () => {
  it("persists the runtime session row before writing the input ledger", async () => {
    const { ensurePersisted, server, sessionId, store } = await setup({
      runtimePersistedAtCreate: false,
    });
    try {
      expect(await store.getSession(sessionId)).toBeFalsy();

      const response = await server.handleMessage(sendText(sessionId, "attach-cmd-legacy-1"));
      expect(response && "error" in response ? response.error : undefined).toBeUndefined();
      const ack = commandAckSchema.parse((response as { result: unknown }).result);
      expect(ack.status).toBe("accepted");
      expect(ack.result).toMatchObject({ type: "inputAccepted", inputId: "attach-cmd-legacy-1" });

      expect(ensurePersisted).toHaveBeenCalledTimes(1);
      expect(ensurePersisted).toHaveBeenCalledWith("hello from attach");
      expect(await store.getSession(sessionId)).toBeTruthy();
      const inputs = await store.listSessionInputs!({ sessionID: sessionId });
      expect(inputs.map((input) => input.id)).toContain("queue_attach-cmd-legacy-1");
    } finally {
      await store.close();
    }
  });

  it("does not re-run first persistence once the runtime row exists", async () => {
    const { ensurePersisted, server, sessionId, store } = await setup({
      runtimePersistedAtCreate: true,
    });
    try {
      const ack = commandAckSchema.parse(
        await request(server, sendText(sessionId, "attach-cmd-legacy-2")),
      );
      expect(ack.status).toBe("accepted");
      expect(ensurePersisted).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });
});
