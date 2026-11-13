import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ZCODE_PROTOCOL_VERSION,
  zcodeProtocolErrorCodes,
  type DynamicWorkflowMode,
  type ZCodeProtocolMcpServer,
} from "@zcode/shared";
import { AcpCoreSessions } from "../src/acp/acp-sessions.js";
import type { AttachSessionHandle } from "../src/attach/attach-session.js";

// 协议 fixture 不是 live core；但使用真实 socket、AttachRuntime 和 session handle，
// 防止 fake session 层再次掩盖 client 未安装或 waiter 被替换的错误。
function snapshot(sessionId: string) {
  return {
    messages: [],
    protocol: { name: "ZCode Protocol", version: ZCODE_PROTOCOL_VERSION },
    runtime: { eventSeq: 0, pendingRequestIds: [], stateRevision: 0 },
    projection: {
      activeToolCalls: [], backgroundJobs: [], contextUsed: 0, contextWindow: 200_000,
      mode: "build", pendingPermissions: [], sessionId, status: "idle",
      totalTokenCount: 0, turnCount: 0,
    },
    session: {
      createdAt: 1, updatedAt: 1, mode: "build", sessionId,
      sessionKind: "interactive", status: "idle", title: "ACP test",
      traceId: "trace-test", workspace: { workspaceKey: "/workspace", workspacePath: "/workspace" },
    },
    settings: {
      mode: { current: "build" },
      model: {
        available: [{
          label: "test-model", ref: { modelId: "test-model", providerId: "test" },
          properties: {
            inputFormat: {
              supportsAudio: false, supportsImage: false, supportsPdf: false,
              supportsText: true, supportsVideo: false,
            },
            outputFormat: { supportsText: true },
          },
        }],
        current: { modelId: "test-model", providerId: "test" },
      },
      thoughtLevel: { available: [], current: "medium", enabled: true },
    },
  };
}

async function fixture(t: test.TestContext, workflowMode: DynamicWorkflowMode = "onDemand") {
  const directory = await mkdtemp(join(tmpdir(), "acp-sessions-"));
  const socketPath = join(directory, "core.sock");
  const sockets = new Set<Socket>();
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const connectedRefs: Array<{ workspaceIdentity?: string; workspacePath: string }> = [];
  let connectionCount = 0;
  let rejectClose = false;
  let rejectResume = false;
  let seq = 0;
  let promptInput: string | undefined;
  // fake core 的内存 record 表：create/resume 登记，subscribe 只认在表会话；
  // evictSessions 模拟 core 重启丢内存 record，驱动 AttachRuntime 冷恢复分支。
  const resident = new Set<string>();
  const catalogs = {
    commands: { commands: [] as unknown[] },
    skills: { authority: "workspace", skills: [] as unknown[] },
  };
  const notify = (sessionId: string, type: string, payload: Record<string, unknown>) => {
    for (const socket of sockets) socket.write(`${JSON.stringify({
      method: "session/rawEvent",
      params: {
        id: `event-${++seq}`, payload, sequenceNumber: seq, sessionId,
        timestamp: new Date().toISOString(), traceId: "trace-test", turnId: "turn-test", type,
      },
    })}\n`);
  };
  const server = createServer((socket) => {
    connectionCount++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)) as {
          id: string; method: string; params: Record<string, unknown>;
        };
        buffer = buffer.slice(newline + 1);
        requests.push(message);
        const sessionId = String(message.params.sessionId ?? `session-${requests.length}`);
        let result: unknown = {};
        let error: { code: number; message: string } | undefined;
        if (message.method === "session/create") {
          resident.add(sessionId);
          result = snapshot(sessionId);
        } else if (message.method === "session/resume") {
          if (rejectResume) {
            error = { code: -32000, message: "injected resume failure" };
          } else {
            resident.add(sessionId);
            result = snapshot(sessionId);
          }
        } else if (message.method === "commands/referenceCatalog") {
          result = catalogs.commands;
        } else if (message.method === "skills/referenceCatalog") {
          result = catalogs.skills;
        } else if (message.method === "session/subscribe") {
          if (resident.has(sessionId)) {
            result = { eventSeq: seq, events: [], rawEvents: [], sessionId };
          } else {
            error = {
              code: zcodeProtocolErrorCodes.sessionUnavailable,
              message: "injected missing record",
            };
          }
        } else if (message.method === "session/close") {
          if (rejectClose) {
            error = { code: -32000, message: "injected close failure" };
          } else {
            resident.delete(sessionId);
          }
        } else if (message.method === "v4/command") {
          result = { commandId: message.params.commandId, status: "accepted", revisionAtDecision: 0 };
          if (message.params.type === "sendText") {
            promptInput = String(message.params.commandId);
            notify(sessionId, "turn_started", { inputId: promptInput });
          }
        }
        socket.write(`${JSON.stringify(
          error ? { id: message.id, error } : { id: message.id, result },
        )}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const sessions = new AcpCoreSessions({
    env: {},
    ensureConnected: async (ref) => {
      connectedRefs.push(ref);
      return { socketPath };
    },
    workflowMode,
  });
  t.after(async () => {
    await sessions.closeAll();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    catalogs, sessions, requests, sockets, notify, connectedRefs, socketPath,
    get connectionCount() { return connectionCount; },
    get promptInput() { return promptInput; },
    rejectClose: (reject: boolean) => { rejectClose = reject; },
    rejectResume: (reject: boolean) => { rejectResume = reject; },
    evictSessions: (...sessionIds: string[]) => {
      for (const sessionId of sessionIds) resident.delete(sessionId);
    },
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for socket event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("ACP real lane connects for new/resume and closes its owned socket", async (t) => {
  const f = await fixture(t);
  const opened = await f.sessions.open("/workspace");
  const resumed = await f.sessions.resume({ cwd: "/workspace", sessionId: "persisted" });
  assert.equal(resumed.handle.sessionId, "persisted");
  assert.ok(f.requests.some((r) => r.method === "session/subscribe" && r.params.sessionId === opened.handle.sessionId));
  assert.equal(f.connectionCount, 1);
  await f.sessions.closeAll();
  await until(() => f.sockets.size === 0);
});

test("ACP lanes for different cwds converge on the single core and keep per-cwd workspace refs", async (t) => {
  const f = await fixture(t);
  await f.sessions.open("/workspace");
  await f.sessions.open("/other");
  // 单一 core：per-cwd lane 只是到同一端点的多条连接；workspace 身份仍随
  // 会话级请求按 cwd 发送，不进入传输选择。
  assert.equal(f.connectionCount, 2);
  const creates = f.requests.filter((r) => r.method === "session/create");
  assert.deepEqual(
    creates.map((r) => (r.params.workspace as { workspacePath: string }).workspacePath),
    ["/workspace", "/other"],
  );
  assert.deepEqual(
    f.connectedRefs.map((r) => r.workspacePath),
    ["/workspace", "/other"],
  );
});

test("ACP bound resume preserves the active prompt waiter", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.open("/workspace");
  const prompt = session.handle.submitPrompt("hello");
  await until(() => f.promptInput !== undefined);
  const resumed = await f.sessions.resume({ cwd: "/workspace", sessionId: session.handle.sessionId });
  assert.equal(resumed, session);
  f.notify(session.handle.sessionId, "turn_complete", { inputId: f.promptInput, response: "done" });
  assert.equal((await prompt).response, "done");
  const firstInput = f.promptInput;
  const followup = session.handle.submitPrompt("again");
  await until(() => f.promptInput !== firstInput);
  f.notify(session.handle.sessionId, "turn_complete", { inputId: f.promptInput, response: "again" });
  assert.equal((await followup).response, "again");
  await assert.rejects(
    f.sessions.resume({ cwd: "/other-workspace", sessionId: session.handle.sessionId }),
    /different cwd/,
  );
});

test("ACP close failure retains binding for retry; successful close removes recovery", async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.open("/workspace");
  f.rejectClose(true);
  await assert.rejects(f.sessions.closeSession(session.handle.sessionId), /injected close failure/);
  assert.equal(f.sessions.get(session.handle.sessionId), session);
  f.rejectClose(false);
  await f.sessions.closeSession(session.handle.sessionId);
  assert.equal(f.sessions.get(session.handle.sessionId), undefined);
  const before = f.requests.length;
  for (const socket of f.sockets) socket.destroy();
  await until(() => f.connectionCount === 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(!f.requests.slice(before).some((r) =>
    r.method === "session/resume" || r.method === "session/subscribe"));
});

test("ACP slash catalog keeps interactive-only commands for the interactive client (issue #22)", async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.open("/workspace");
  f.catalogs.commands.commands = [
    {
      description: "Interactive only", disableNonInteractive: true, name: "tui-only",
      path: "/workspace/.zcode/commands/tui-only.md", scope: "project", source: "zcode",
    },
    {
      description: "Any context", name: "review",
      path: "/workspace/.zcode/commands/review.md", scope: "project", source: "zcode",
    },
  ];
  // 同名技能与 interactive-only 命令共存：滤掉命令会让技能借「无同名命令」裁定
  // 抢走本该由 facade 展开的路径。
  f.catalogs.skills.skills = [
    {
      description: "same-named skill", enabled: true, id: "skill-tui-only",
      name: "tui-only", path: "/home/u/.agents/skills/tui-only", scope: "user",
    },
  ];
  const catalog = await f.sessions.slashCatalog(session.handle.sessionId);
  // ACP 是交互式客户端：/name 原文转发后 core facade 展开不查
  // disableNonInteractive（那只服务 app-server/headless 目录），滤掉既漏报
  // 广告又让同名技能顶替（issue #22）。
  assert.deepEqual(
    catalog.commands.map((command) => command.name).sort(),
    ["review", "tui-only"],
  );
  assert.deepEqual(catalog.skills.map((skill) => skill.name), ["tui-only"]);
});

test("ACP slash catalog keeps each skill's plain name beside qualifiedName (issue #24)", async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.open("/workspace");
  // Skill 工具 resolver 按 name 或 qualifiedName 命中：投影丢裸名会让
  // `/skill review` 误报 Unknown——目录行两个名字都要留住。
  f.catalogs.skills.skills = [
    {
      description: "plugin skill", enabled: true, id: "glm:plugin:/p/review",
      name: "review", path: "/p/review", pluginName: "acp-registry",
      qualifiedName: "acp-registry:review", scope: "plugin", source: "plugin",
    },
    {
      description: "plain skill", enabled: true, id: "glm:workspace:/repo/lint",
      name: "lint", path: "/repo/lint", scope: "workspace", source: "zcode",
    },
  ];
  const catalog = await f.sessions.slashCatalog(session.handle.sessionId);
  assert.deepEqual(catalog.skills, [
    {
      description: "plugin skill",
      name: "review",
      qualifiedName: "acp-registry:review",
    },
    { description: "plain skill", name: "lint" },
  ]);
});

test("ACP reconnect opens a fresh transport for handles and lifecycle requests", async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.open("/workspace");
  const initialSubscriptions = f.requests.filter((r) => r.method === "session/subscribe").length;
  for (const socket of f.sockets) socket.destroy();
  await until(() => f.requests.filter((r) => r.method === "session/subscribe").length > initialSubscriptions);
  assert.equal(f.connectionCount, 2);
  await session.handle.setMode("plan");
  await f.sessions.open("/workspace");
  await f.sessions.resume({ cwd: "/workspace", sessionId: "cold-after-reconnect" });
  await f.sessions.closeSession(session.handle.sessionId);
  assert.ok(f.requests.some((r) => r.method === "session/close"));
});

// 确定性恢复栅栏：AttachRuntime 在 recoverSession 成功后给句柄注入
// "Reconnected to shared core." session_notice；必须在断线前挂上 sink。
function reconnectedBarrier(handle: AttachSessionHandle): () => Promise<void> {
  let done = false;
  const off = handle.addSink((event) => {
    const payload = event.payload as { message?: unknown } | undefined;
    if (payload?.message === "Reconnected to shared core.") {
      done = true;
      off();
    }
  });
  return async () => await until(() => done);
}

function fakeMcp(marker: string): ZCodeProtocolMcpServer[] {
  return [{
    name: "stdio-fake",
    command: "fake-mcp",
    args: ["--marker", marker],
    env: [{ name: "MCP_FAKE_MARKER", value: marker }],
  }];
}

test("CMCP14 cold recovery replays the last acknowledged mcpServers; [] and omission stay distinct", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const declared = fakeMcp("decl-a");
  const session = await f.sessions.open("/workspace", declared);
  const empty = await f.sessions.open("/workspace", []);
  const plain = await f.sessions.open("/workspace");
  const waitSession = reconnectedBarrier(session.handle);
  const waitEmpty = reconnectedBarrier(empty.handle);
  const waitPlain = reconnectedBarrier(plain.handle);
  f.evictSessions(session.handle.sessionId, empty.handle.sessionId, plain.handle.sessionId);
  for (const socket of f.sockets) socket.destroy();
  await waitSession();
  await waitEmpty();
  await waitPlain();
  // 冷恢复不改绑定：同一个 AcpSession/handle 对象继续服务。
  assert.equal(f.sessions.get(session.handle.sessionId), session);
  const byId = new Map(
    f.requests
      .filter((r) => r.method === "session/resume")
      .map((r) => [String(r.params.sessionId), r]),
  );
  assert.deepEqual(byId.get(session.handle.sessionId)?.params.mcpServers, declared);
  // 显式 [] 是“清空”不是“未声明”，回放时字段必须在且为空数组。
  assert.deepEqual(byId.get(empty.handle.sessionId)?.params.mcpServers, []);
  // 从未声明的会话：mcpServers 字段本身不得出现（省略 ≠ []）。
  const plainResume = byId.get(plain.handle.sessionId);
  assert.ok(plainResume);
  assert.ok(!("mcpServers" in plainResume.params));
});

test("CMCP14 warm reconnect resubscribes without any session/resume", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.open("/workspace", fakeMcp("keep"));
  const wait = reconnectedBarrier(session.handle);
  const before = f.requests.length;
  for (const socket of f.sockets) socket.destroy();
  await wait();
  const after = f.requests.slice(before);
  assert.equal(after.filter((r) => r.method === "session/resume").length, 0);
  assert.ok(after.some(
    (r) => r.method === "session/subscribe" && r.params.sessionId === session.handle.sessionId,
  ));
});

test("CMCP14 replay snapshot tracks bound resume: success replaces, omit/failure retain", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.open("/workspace", fakeMcp("decl-a"));
  const declB = fakeMcp("decl-b");
  await f.sessions.resume({ cwd: "/workspace", sessionId: session.handle.sessionId, mcpServers: declB });
  // 失败的 bound resume 不得覆盖最后已确认声明。
  f.rejectResume(true);
  await assert.rejects(
    f.sessions.resume({
      cwd: "/workspace",
      sessionId: session.handle.sessionId,
      mcpServers: fakeMcp("decl-c"),
    }),
    /injected resume failure/,
  );
  f.rejectResume(false);
  // 省略的 bound resume 保留最新快照（不发协议请求）。
  await f.sessions.resume({ cwd: "/workspace", sessionId: session.handle.sessionId });
  const wait = reconnectedBarrier(session.handle);
  const before = f.requests.length;
  f.evictSessions(session.handle.sessionId);
  for (const socket of f.sockets) socket.destroy();
  await wait();
  const recovery = f.requests.slice(before).filter(
    (r) => r.method === "session/resume" && r.params.sessionId === session.handle.sessionId,
  );
  assert.equal(recovery.length, 1);
  assert.deepEqual(recovery[0].params.mcpServers, declB);
});

// issue #5：ACP lane 的每条 session/create 与 session/resume 都显式带灰度门字段；
// 缺席 = core 按协议 fail-closed（这正是 issue 的故障形态）。fixture 的默认 mode
// 与 run.ts 的 ACP 缺省一致（onDemand）。
test("issue #5: every create/resume shape carries the resolved workflow gate (onDemand)", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.open("/workspace");
  // warm-record resume（mcpServers 声明路径）也带同一份字段。
  await f.sessions.resume({
    cwd: "/workspace",
    sessionId: session.handle.sessionId,
    mcpServers: fakeMcp("warm"),
  });
  // 未绑定会话的冷 resume。
  await f.sessions.resume({ cwd: "/other", sessionId: "cold-resume" });
  // core 重启后的冷恢复 resume（AttachRuntime.recoverSession）同样必须带——
  // 否则冷物化 record 按协议 fail-closed，已激活会话丢工具面。
  const wait = reconnectedBarrier(session.handle);
  f.evictSessions(session.handle.sessionId);
  for (const socket of f.sockets) socket.destroy();
  await wait();
  const creates = f.requests.filter((r) => r.method === "session/create");
  const resumes = f.requests.filter((r) => r.method === "session/resume");
  assert.equal(creates.length, 1);
  // warm（mcpServers）+ cold + 冷恢复三条 session/resume。
  assert.ok(resumes.length >= 3, `expected >=3 resume requests, got ${resumes.length}`);
  for (const r of [...creates, ...resumes]) {
    assert.equal(r.params.dynamicWorkflowEnabled, true, `${r.method} params`);
    assert.equal(r.params.dynamicWorkflowMode, "onDemand", `${r.method} params`);
  }
});

for (const mode of ["disabled", "alwaysOn"] as const) {
  test(`issue #5: --workflow-mode ${mode} reaches create/resume unchanged`, async (t) => {
    const f = await fixture(t, mode);
    await f.sessions.open("/workspace");
    await f.sessions.resume({ cwd: "/other", sessionId: `resume-${mode}` });
    const creates = f.requests.filter((r) => r.method === "session/create");
    const resumes = f.requests.filter((r) => r.method === "session/resume");
    assert.equal(creates.length, 1);
    assert.equal(resumes.length, 1);
    for (const r of [...creates, ...resumes]) {
      assert.equal(r.params.dynamicWorkflowEnabled, mode !== "disabled");
      assert.equal(r.params.dynamicWorkflowMode, mode);
    }
  });
}

test("CMCP14 replay snapshot survives caller mutation; per-session isolation; close excludes recovery", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const declA = fakeMcp("decl-a");
  const a = await f.sessions.open("/workspace", declA);
  const b = await f.sessions.open("/workspace", fakeMcp("decl-b"));
  const closed = await f.sessions.open("/workspace", fakeMcp("decl-closed"));
  await f.sessions.closeSession(closed.handle.sessionId);
  // 调用方在 open 成功后原地改声明（含嵌套 env），回放必须是已确认副本。
  const declAStdio = declA[0] as { command: string; env: Array<{ value: string }> };
  declAStdio.command = "mutated-after-open";
  declAStdio.env[0]!.value = "mutated-env";
  const waitA = reconnectedBarrier(a.handle);
  const waitB = reconnectedBarrier(b.handle);
  const before = f.requests.length;
  f.evictSessions(a.handle.sessionId, b.handle.sessionId, closed.handle.sessionId);
  for (const socket of f.sockets) socket.destroy();
  await waitA();
  await waitB();
  const after = f.requests.slice(before);
  const byId = new Map(
    after.filter((r) => r.method === "session/resume").map((r) => [String(r.params.sessionId), r]),
  );
  assert.deepEqual(byId.get(a.handle.sessionId)?.params.mcpServers, fakeMcp("decl-a"));
  assert.deepEqual(byId.get(b.handle.sessionId)?.params.mcpServers, fakeMcp("decl-b"));
  // 已关闭会话既已注销恢复资格，又不在绑定表：断线后不得有任何它的请求。
  assert.ok(!after.some(
    (r) => r.params.sessionId === closed.handle.sessionId
      && (r.method === "session/resume" || r.method === "session/subscribe"),
  ));
});
