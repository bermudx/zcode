import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAttachResumeTarget } from "../src/attach/attach-command.js";

const workspace = {
  workspaceIdentity: undefined,
  workspaceKey: "/tmp/ws",
  workspacePath: "/tmp/ws",
};

/** 假 client：只回 sessionList，记录是否被调用。 */
const fakeClient = (sessions: unknown[]) => {
  let listCalls = 0;
  return {
    get listCalls() {
      return listCalls;
    },
    request: async (method: string) => {
      if (method.endsWith("session/list")) {
        listCalls += 1;
        return { sessions };
      }
      throw new Error(`unexpected method ${method}`);
    },
  } as never;
};

test("no resume intent resolves to no target (caller creates a new session)", async () => {
  const client = fakeClient([{ id: "sess-old", updatedAt: 10 }]);
  const target = await resolveAttachResumeTarget({
    client,
    continueSession: false,
    resumeSessionId: undefined,
    workspace,
  });
  assert.equal(target, undefined);
  assert.equal(
    (client as unknown as { listCalls: number }).listCalls,
    0,
    "no resume intent must not even list sessions",
  );
});

test("--resume <id> returns that id without listing sessions", async () => {
  const client = fakeClient([{ id: "sess-other", updatedAt: 99 }]);
  const target = await resolveAttachResumeTarget({
    client,
    continueSession: false,
    resumeSessionId: "sess-explicit",
    workspace,
  });
  assert.equal(target, "sess-explicit");
  assert.equal((client as unknown as { listCalls: number }).listCalls, 0);
});

test("-c/--continue picks the most recently updated session, not the last listed", async () => {
  // server 返回顺序不保证：这里故意把陈旧会话放在最后。
  const client = fakeClient([
    { id: "sess-newest", updatedAt: 300 },
    { id: "sess-middle", updatedAt: 200 },
    { id: "sess-stale", updatedAt: 100 },
  ]);
  const target = await resolveAttachResumeTarget({
    client,
    continueSession: true,
    resumeSessionId: undefined,
    workspace,
  });
  assert.equal(target, "sess-newest");
});

test("-c/--continue falls back to createdAt when updatedAt is missing", async () => {
  const client = fakeClient([
    { id: "sess-old", createdAt: 100 },
    { id: "sess-recent", createdAt: 500 },
  ]);
  const target = await resolveAttachResumeTarget({
    client,
    continueSession: true,
    resumeSessionId: undefined,
    workspace,
  });
  assert.equal(target, "sess-recent");
});

test("-c/--continue with no sessions resolves to no target", async () => {
  const client = fakeClient([]);
  const target = await resolveAttachResumeTarget({
    client,
    continueSession: true,
    resumeSessionId: undefined,
    workspace,
  });
  assert.equal(target, undefined);
});

test("sessionList failure degrades to no target instead of throwing", async () => {
  const client = {
    request: async () => {
      throw new Error("core gone");
    },
  } as never;
  const target = await resolveAttachResumeTarget({
    client,
    continueSession: true,
    resumeSessionId: undefined,
    workspace,
  });
  assert.equal(target, undefined);
});
