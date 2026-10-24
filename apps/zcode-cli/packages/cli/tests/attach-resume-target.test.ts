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

test("--resume <full id> listed for this workspace passes through unchanged", async () => {
  const client = fakeClient([{ id: "sess-explicit", updatedAt: 10 }]);
  const target = await resolveAttachResumeTarget({
    client,
    continueSession: false,
    resumeSessionId: "sess-explicit",
    workspace,
  });
  assert.equal(target, "sess-explicit");
  assert.equal((client as unknown as { listCalls: number }).listCalls, 1);
});

test("--resume <unique prefix> expands to the full session id", async () => {
  // 复现操作者形态：8 位截断前缀。列表顺序任意（server 不保证顺序）。
  const client = fakeClient([
    { id: "sess_3852f4bf-2c3c-4e49-81eb-9c141e2f240a", updatedAt: 30 },
    { id: "sess_99f180d5-a07d-4424-87d7-5dda4402a881", updatedAt: 20 },
    { id: "session_64570475a26fc8573a2ab53fc2366149", updatedAt: 10 },
  ]);
  const target = await resolveAttachResumeTarget({
    client,
    continueSession: false,
    resumeSessionId: "sess_99f180d5",
    workspace,
  });
  assert.equal(target, "sess_99f180d5-a07d-4424-87d7-5dda4402a881");
});

test("--resume prefix expansion accepts sessionId field as well as id", async () => {
  const client = fakeClient([{ sessionId: "sess-full-aaaa", updatedAt: 10 }]);
  const target = await resolveAttachResumeTarget({
    client,
    continueSession: false,
    resumeSessionId: "sess-full",
    workspace,
  });
  assert.equal(target, "sess-full-aaaa");
});

test("--resume <ambiguous prefix> throws listing the candidates", async () => {
  const client = fakeClient([
    { id: "sess_99f180d5-aaaa", updatedAt: 30 },
    { id: "sess_99f180d5-bbbb", updatedAt: 20 },
    { id: "sess_other", updatedAt: 10 },
  ]);
  await assert.rejects(
    resolveAttachResumeTarget({
      client,
      continueSession: false,
      resumeSessionId: "sess_99f180d5",
      workspace,
    }),
    /ambiguous: matches 2 sessions \(sess_99f180d5-aaaa, sess_99f180d5-bbbb\)/,
  );
});

test("--resume <no local match> passes the raw id through for session/resume to judge", async () => {
  // 跨 workspace 完整 id 不在本 workspace 列表里：必须原样透传，而不是报错。
  const client = fakeClient([{ id: "sess-local", updatedAt: 10 }]);
  const target = await resolveAttachResumeTarget({
    client,
    continueSession: false,
    resumeSessionId: "sess_55cfc5e6-b55a-4c3e-a0ee-387541e498ea",
    workspace,
  });
  assert.equal(target, "sess_55cfc5e6-b55a-4c3e-a0ee-387541e498ea");
});

test("--resume tolerates sessionList failure by passing the raw id through", async () => {
  const client = {
    request: async () => {
      throw new Error("core gone");
    },
  } as never;
  const target = await resolveAttachResumeTarget({
    client,
    continueSession: false,
    resumeSessionId: "sess-explicit",
    workspace,
  });
  assert.equal(target, "sess-explicit");
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

test("-c/--continue with no sessions errors like the main CLI instead of silently creating", async () => {
  const client = fakeClient([]);
  await assert.rejects(
    resolveAttachResumeTarget({
      client,
      continueSession: true,
      resumeSessionId: undefined,
      workspace,
    }),
    /No resumable session found for \/tmp\/ws/,
  );
});

test("-c/--continue surfaces sessionList failure instead of silently creating", async () => {
  const client = {
    request: async () => {
      throw new Error("core gone");
    },
  } as never;
  await assert.rejects(
    resolveAttachResumeTarget({
      client,
      continueSession: true,
      resumeSessionId: undefined,
      workspace,
    }),
    /--continue could not list sessions for \/tmp\/ws: core gone/,
  );
});
