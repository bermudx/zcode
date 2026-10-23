// attach herdr reporter 单测：env 门、事件→状态映射、绑定 resume argv、
// seq 单调、换绑解订阅、exec 参数数组。真实 herdr CLI 不进测试——
// exec 以桩注入，断言的是出站 argv 契约（docs/design/v2/tui-attach-shared-core.md）。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  AttachHerdrReporter,
  createAttachHerdrReporter,
  type HerdrExec,
} from "../src/attach/herdr-reporter.js";

const HERDR_ENV = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p2",
  HERDR_BIN_PATH: "/usr/local/bin/herdr",
};

interface CapturedCall {
  bin: string;
  args: string[];
}

function recordedExec(): { exec: HerdrExec; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const exec: HerdrExec = (bin, args) => {
    calls.push({ bin, args: [...args] });
    return Promise.resolve();
  };
  return { exec, calls };
}

interface FakeSession {
  sessionId: string;
  addSink: (sink: (event: SessionEvent) => void) => () => void;
  emit: (event: SessionEvent) => void;
  sinkCount: () => number;
}

function fakeSession(sessionId: string): FakeSession {
  const sinks = new Set<(event: SessionEvent) => void>();
  return {
    sessionId,
    addSink: (sink) => {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
    emit: (event) => {
      for (const sink of sinks) sink(event);
    },
    sinkCount: () => sinks.size,
  };
}

let eventSeq = 0;
function makeEvent(type: string, payload?: unknown): SessionEvent {
  eventSeq += 1;
  return {
    id: `evt-${eventSeq}`,
    sessionId: "sess-fixture",
    type,
    timestamp: new Date(),
    traceId: "trace-fixture",
    sequenceNumber: eventSeq,
    payload,
  } as SessionEvent;
}

function stateOf(call: CapturedCall): string {
  const index = call.args.indexOf("--state");
  assert.ok(index >= 0, "missing --state");
  return call.args[index + 1]!;
}

function seqOf(call: CapturedCall): bigint {
  const index = call.args.indexOf("--seq");
  assert.ok(index >= 0, "missing --seq");
  return BigInt(call.args[index + 1]!);
}

test("createAttachHerdrReporter requires HERDR_ENV=1 plus pane and bin", () => {
  const { exec } = recordedExec();
  assert.equal(createAttachHerdrReporter({ env: {}, exec }), undefined);
  assert.equal(createAttachHerdrReporter({ env: { HERDR_ENV: "0" }, exec }), undefined);
  assert.equal(
    createAttachHerdrReporter({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
      exec,
    }),
    undefined,
  );
  assert.equal(
    createAttachHerdrReporter({
      env: { HERDR_ENV: "1", HERDR_BIN_PATH: "/bin/herdr" },
      exec,
    }),
    undefined,
  );
  assert.ok(createAttachHerdrReporter({ env: HERDR_ENV, exec }));
});

test("bind reports idle with session id and piz --resume argv", () => {
  const { exec, calls } = recordedExec();
  const reporter = createAttachHerdrReporter({ env: HERDR_ENV, exec })!;
  reporter.bind(fakeSession("sess-abc"));

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.bin, "/usr/local/bin/herdr");
  assert.deepEqual(call.args.slice(0, 8), [
    "pane", "report-agent", "w1:p2",
    "--source", "piz", "--agent", "piz", "--state",
  ]);
  assert.equal(stateOf(call), "idle");
  const sessionIndex = call.args.indexOf("--agent-session-id");
  assert.ok(sessionIndex >= 0);
  assert.equal(call.args[sessionIndex + 1], "sess-abc");
  const dashDash = call.args.lastIndexOf("--");
  assert.ok(dashDash >= 0);
  assert.deepEqual(call.args.slice(dashDash + 1), ["piz", "--resume", "sess-abc"]);
});

test("session events map turn_started->working, permission->blocked, ends->idle", () => {
  const { exec, calls } = recordedExec();
  const reporter = createAttachHerdrReporter({ env: HERDR_ENV, exec })!;
  const session = fakeSession("s1");
  reporter.bind(session);
  calls.length = 0;

  session.emit(makeEvent(SessionEventType.TurnStarted));
  assert.equal(stateOf(calls.at(-1)!), "working");
  // herdr 语义：state 上报必须重带 session ref，否则清掉 pane 会话归属。
  const working = calls.at(-1)!;
  assert.equal(
    working.args[working.args.indexOf("--agent-session-id") + 1],
    "s1",
  );
  assert.deepEqual(working.args.slice(working.args.lastIndexOf("--") + 1), [
    "piz", "--resume", "s1",
  ]);

  session.emit(
    makeEvent(SessionEventType.PermissionRequested, { toolName: "bash_exec" }),
  );
  const blocked = calls.at(-1)!;
  assert.equal(stateOf(blocked), "blocked");
  assert.equal(
    blocked.args[blocked.args.indexOf("--message") + 1],
    "permission: bash_exec",
  );

  // 许可解除回到回合内 working（turn 未结束）。
  session.emit(makeEvent(SessionEventType.PermissionResolved));
  assert.equal(stateOf(calls.at(-1)!), "working");

  session.emit(makeEvent(SessionEventType.TurnComplete));
  assert.equal(stateOf(calls.at(-1)!), "idle");

  // turn_error 同样收口为 idle。
  session.emit(makeEvent(SessionEventType.TurnStarted));
  session.emit(makeEvent(SessionEventType.TurnError));
  assert.equal(stateOf(calls.at(-1)!), "idle");

  // 无 toolName 的 permission_requested 不带 --message，但状态仍是 blocked。
  session.emit(makeEvent(SessionEventType.TurnStarted));
  session.emit(makeEvent(SessionEventType.PermissionRequested));
  const bare = calls.at(-1)!;
  assert.equal(stateOf(bare), "blocked");
  assert.equal(bare.args.includes("--message"), false);

  // denied 时回合已结束 → 回 idle。
  session.emit(makeEvent(SessionEventType.TurnComplete));
  session.emit(makeEvent(SessionEventType.PermissionDenied));
  assert.equal(stateOf(calls.at(-1)!), "idle");
});

test("rebind unsubscribes the old handle and reports the new session", () => {
  const { exec, calls } = recordedExec();
  const reporter = createAttachHerdrReporter({ env: HERDR_ENV, exec })!;
  const first = fakeSession("s-old");
  reporter.bind(first);
  const second = fakeSession("s-new");
  reporter.bind(second);

  assert.equal(first.sinkCount(), 0);
  assert.equal(second.sinkCount(), 1);
  const bindCall = calls.at(-1)!;
  assert.equal(bindCall.args[bindCall.args.indexOf("--agent-session-id") + 1], "s-new");
  assert.deepEqual(bindCall.args.slice(bindCall.args.lastIndexOf("--") + 1), [
    "piz", "--resume", "s-new",
  ]);

  // 旧句柄迟到的 turn_started 不得影响 pane。
  calls.length = 0;
  first.emit(makeEvent(SessionEventType.TurnStarted));
  assert.equal(calls.length, 0);
});

test("seq is strictly increasing even within the same millisecond", () => {
  const { exec, calls } = recordedExec();
  const reporter = createAttachHerdrReporter({ env: HERDR_ENV, exec })!;
  const session = fakeSession("s1");
  reporter.bind(session);
  for (let i = 0; i < 5; i++) {
    session.emit(makeEvent(SessionEventType.TurnStarted));
    session.emit(makeEvent(SessionEventType.TurnComplete));
  }
  const seqs = calls.map(seqOf);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i]! > seqs[i - 1]!, `seq ${seqs[i]} not > ${seqs[i - 1]}`);
  }
});

test("exec failures are swallowed and routed to onError, never thrown", async () => {
  const failures: unknown[] = [];
  let fail = true;
  const exec: HerdrExec = () =>
    fail ? Promise.reject(new Error("herdr gone")) : Promise.resolve();
  const reporter = createAttachHerdrReporter({
    env: HERDR_ENV,
    exec,
    onError: (error) => failures.push(error),
  })!;
  const session = fakeSession("s1");
  reporter.bind(session);
  session.emit(makeEvent(SessionEventType.TurnStarted));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures.length, 2);
  assert.equal((failures[0] as Error).message, "herdr gone");
  fail = false;
});
