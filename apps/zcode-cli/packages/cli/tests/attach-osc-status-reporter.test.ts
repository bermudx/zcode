// attach OSC 7501 reporter 单测：字节格式（base64/截断/定界）、事件→状态
// 映射（含 resultType 分支）、interaction 端口、去重、写失败禁用、finish。
// 真实终端不进测试——write 以捕获桩注入，断言的是出站字节契约
// （docs/design/v2/tui-attach-shared-core.md「OSC 7501 程序状态上报」；
// 协议 https://mitchellh.com/writing/program-status-osc7501）。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  AttachOscStatusReporter,
  formatOsc7501,
  type OscStatusWrite,
} from "../src/attach/osc-status-reporter.js";

const ST = "\x1b\\";
const PREFIX = "\x1b]7501;";

function recordedWrite(): { write: OscStatusWrite; chunks: string[] } {
  const chunks: string[] = [];
  const write: OscStatusWrite = (chunk) => {
    chunks.push(chunk);
  };
  return { write, chunks };
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

function makeReporter(): {
  reporter: AttachOscStatusReporter;
  chunks: string[];
} {
  const { write, chunks } = recordedWrite();
  return { reporter: new AttachOscStatusReporter({ app: "piz", write }), chunks };
}

test("formatOsc7501：state 必选字段 + app，无 msg 时无 msg 段", () => {
  assert.equal(
    formatOsc7501({ state: "idle", app: "piz" }),
    `${PREFIX}state=idle:app=piz${ST}`,
  );
});

test("formatOsc7501：kind 在 state 后，msg 为 UTF-8 base64", () => {
  const msg = "permission: Bash rm -rf";
  assert.equal(
    formatOsc7501({ state: "blocked", kind: "permission", app: "piz", msg }),
    `${PREFIX}state=blocked:kind=permission:app=piz:msg=${Buffer.from(msg, "utf8").toString("base64")}${ST}`,
  );
  // 非 ASCII 也走 base64（不能裸进转义序列）。
  const unicode = "审批 Bash";
  const formatted = formatOsc7501({ state: "blocked", kind: "question", app: "piz", msg: unicode });
  const body = formatted.slice(PREFIX.length, -ST.length);
  const msgValue = body.split(":").find((field) => field.startsWith("msg="))!.slice(4);
  assert.equal(Buffer.from(msgValue, "base64").toString("utf8"), unicode);
});

test("formatOsc7501：msg 超 160 字符先截断再编码", () => {
  const msg = "x".repeat(200);
  const formatted = formatOsc7501({ state: "error", app: "piz", msg });
  const msgValue = formatted
    .slice(PREFIX.length, -ST.length)
    .split(":")
    .find((field) => field.startsWith("msg="))!
    .slice(4);
  assert.equal(
    Buffer.from(msgValue, "base64").toString("utf8"),
    "x".repeat(160),
  );
});

test("bind 上报 idle；换绑退订旧句柄 sink 并再次 idle", () => {
  const { reporter, chunks } = makeReporter();
  const first = fakeSession("sess-1");
  reporter.bind(first);
  assert.deepEqual(chunks, [`${PREFIX}state=idle:app=piz${ST}`]);

  const second = fakeSession("sess-2");
  reporter.bind(second);
  assert.equal(first.sinkCount(), 0, "old session sink must be unsubscribed");
  assert.equal(second.sinkCount(), 1);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1], `${PREFIX}state=idle:app=piz${ST}`);
});

test("事件映射：working → done / cancelled→idle / error_*→error / turn_error→error", () => {
  const { reporter, chunks } = makeReporter();
  const session = fakeSession("sess-1");
  reporter.bind(session);
  chunks.length = 0;

  session.emit(makeEvent(SessionEventType.TurnStarted, {}));
  assert.deepEqual(chunks, [`${PREFIX}state=working:app=piz${ST}`]);
  chunks.length = 0;

  session.emit(
    makeEvent(SessionEventType.TurnComplete, { resultType: "success" }),
  );
  assert.deepEqual(chunks, [`${PREFIX}state=done:app=piz${ST}`]);
  chunks.length = 0;

  session.emit(
    makeEvent(SessionEventType.TurnComplete, { resultType: "cancelled" }),
  );
  assert.deepEqual(chunks, [`${PREFIX}state=idle:app=piz${ST}`]);
  chunks.length = 0;

  session.emit(
    makeEvent(SessionEventType.TurnComplete, { resultType: "error_max_turns" }),
  );
  assert.deepEqual(chunks, [
    `${PREFIX}state=error:app=piz:msg=${Buffer.from("error_max_turns", "utf8").toString("base64")}${ST}`,
  ]);
  chunks.length = 0;

  session.emit(
    makeEvent(SessionEventType.TurnError, {
      error: { message: "provider 429", type: "model" },
    }),
  );
  assert.deepEqual(chunks, [
    `${PREFIX}state=error:app=piz:msg=${Buffer.from("provider 429", "utf8").toString("base64")}${ST}`,
  ]);
});

test("去重：相同 (state,kind,msg) 不重复写字节", () => {
  const { reporter, chunks } = makeReporter();
  const session = fakeSession("sess-1");
  reporter.bind(session);
  chunks.length = 0;

  session.emit(makeEvent(SessionEventType.TurnStarted, {}));
  session.emit(makeEvent(SessionEventType.TurnStarted, {}));
  assert.deepEqual(chunks, [`${PREFIX}state=working:app=piz${ST}`]);

  reporter.interactionBlocked("permission", "permission: Bash");
  reporter.interactionBlocked("permission", "permission: Bash");
  assert.equal(chunks.length, 2);
});

test("interaction 端口：blocked 携 kind/msg，settle 回到回合态", () => {
  const { reporter, chunks } = makeReporter();
  const session = fakeSession("sess-1");
  reporter.bind(session);

  // 无在途回合：blocked → resolved 应回 idle。
  reporter.interactionBlocked("question", "Pick one?");
  reporter.interactionResolved();
  assert.deepEqual(chunks, [
    `${PREFIX}state=idle:app=piz${ST}`,
    `${PREFIX}state=blocked:kind=question:app=piz:msg=${Buffer.from("Pick one?", "utf8").toString("base64")}${ST}`,
    `${PREFIX}state=idle:app=piz${ST}`,
  ]);

  // 有在途回合：resolved 回 working。
  chunks.length = 0;
  session.emit(makeEvent(SessionEventType.TurnStarted, {}));
  reporter.interactionBlocked("permission", "permission: Bash");
  reporter.interactionResolved();
  assert.deepEqual(chunks, [
    `${PREFIX}state=working:app=piz${ST}`,
    `${PREFIX}state=blocked:kind=permission:app=piz:msg=${Buffer.from("permission: Bash", "utf8").toString("base64")}${ST}`,
    `${PREFIX}state=working:app=piz${ST}`,
  ]);
});

test("晚到的 settle 不覆盖 done/error 终态", () => {
  const { reporter, chunks } = makeReporter();
  const session = fakeSession("sess-1");
  reporter.bind(session);
  session.emit(makeEvent(SessionEventType.TurnStarted, {}));
  reporter.interactionBlocked("permission", "permission: Bash");
  chunks.length = 0;

  // 回合先结束（done），面板拆除（resolved）晚到。
  session.emit(
    makeEvent(SessionEventType.TurnComplete, { resultType: "success" }),
  );
  reporter.interactionResolved();
  assert.deepEqual(chunks, [`${PREFIX}state=done:app=piz${ST}`]);
});

test("写失败一次性禁用：单次 onError，之后静默", () => {
  const chunks: string[] = [];
  const errors: unknown[] = [];
  let failNext = true;
  const reporter = new AttachOscStatusReporter({
    app: "piz",
    write: (chunk) => {
      if (failNext) {
        failNext = false;
        throw new Error("write after end");
      }
      chunks.push(chunk);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  const session = fakeSession("sess-1");
  reporter.bind(session);
  assert.equal(errors.length, 1, "exactly one diagnostic");
  assert.equal(chunks.length, 0, "nothing written after disable");

  session.emit(makeEvent(SessionEventType.TurnStarted, {}));
  reporter.finish("idle");
  assert.equal(chunks.length, 0);
  assert.equal(errors.length, 1, "no repeat diagnostics");
});

test("finish：绕过去重再发一次，随后退订、事件不再上报", () => {
  const { reporter, chunks } = makeReporter();
  const session = fakeSession("sess-1");
  reporter.bind(session);
  chunks.length = 0;

  reporter.finish("idle");
  assert.deepEqual(chunks, [`${PREFIX}state=idle:app=piz${ST}`]);
  assert.equal(session.sinkCount(), 0, "sink unsubscribed on finish");

  session.emit(makeEvent(SessionEventType.TurnStarted, {}));
  assert.equal(chunks.length, 1, "no emissions after finish");
});

test("finish(error) 带 msg（截断复用 format 的 160 上限）", () => {
  const { reporter, chunks } = makeReporter();
  const session = fakeSession("sess-1");
  reporter.bind(session);
  reporter.finish("error", "core protocol mismatch");
  assert.deepEqual(chunks, [
    `${PREFIX}state=idle:app=piz${ST}`,
    `${PREFIX}state=error:app=piz:msg=${Buffer.from("core protocol mismatch", "utf8").toString("base64")}${ST}`,
  ]);
});
