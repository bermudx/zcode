import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionId, createTurnId, type SessionId } from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import {
  createExploreSubagentPort,
  type ExploreSubagentRuntimeRequest,
  type ParentTaskNotificationCommand,
} from "../src/subagent/runner.js";

// fork: SendMessage 在 child turn 收尾时被拒收后，消息不得被静默丢弃（spec: tool/07-subagent.md
// 「被拒收的消息与终态收口」）。真实 child runtime 收尾时 steerable=false，steerTurn 拒收，sink.send 抛错。

const AGENT_ID = "agent_queue_1";
const REJECTED = "Subagent message rejected: turn_not_steerable";

let outputRootDir: string;

beforeAll(async () => {
  outputRootDir = await mkdtemp(join(tmpdir(), "zcode-sendmessage-queue-"));
});

afterAll(async () => {
  await rm(outputRootDir, { force: true, recursive: true });
});

describe("SendMessage rejected by a winding-down child turn", () => {
  it("resumes the completed child with the rejected message and says so in the completion notification", async () => {
    const harness = createHarness();
    await harness.startAgent();
    await harness.waitForSink();

    const result = await harness.send("also check the retry path", "Extra scope");
    expect(result).toMatchObject({ status: "success", delivery: "queued" });
    expect(result.message).toContain("is finishing its current turn");

    harness.firstTurn.resolve();
    await waitForCondition(() => harness.notifications.length === 2);

    expect(harness.prompts).toEqual(["Run slowly", "also check the retry path"]);
    expect(harness.notifications[0]?.text).toContain(
      "1 message(s) sent with SendMessage arrived after this turn stopped accepting input",
    );
    expect(harness.notifications[1]?.text).toContain("report for also check the retry path");
    expect((await harness.port.getTask?.(AGENT_ID))?.pendingMessages ?? []).toEqual([]);
  });

  it("redelivers a message queued before the sink existed when the registration flush is rejected", async () => {
    const beforeSink = createDeferred<void>();
    const harness = createHarness({ beforeSink, gateFirstTurn: false });
    await harness.startAgent();

    // 首个 turn 在 beginActiveTurn 之前（上下文初始化、SessionStart hooks）尚无 sink。
    const result = await harness.send("look at the lockfile too", "Lockfile");
    expect(result).toMatchObject({ status: "success", delivery: "queued" });
    expect(result.message).toBe(
      `Message queued for delivery to ${AGENT_ID} at its next tool round.`,
    );

    beforeSink.resolve();
    await waitForCondition(() => harness.notifications.length === 2);
    expect(harness.prompts).toEqual(["Run slowly", "look at the lockfile too"]);
  });

  it("merges several rejected messages into one resumed prompt in send order", async () => {
    const harness = createHarness();
    await harness.startAgent();
    await harness.waitForSink();

    await harness.send("first follow-up", "One");
    await harness.send("second follow-up", "Two");
    harness.firstTurn.resolve();
    await waitForCondition(() => harness.notifications.length === 2);

    expect(harness.prompts).toEqual([
      "Run slowly",
      "One\n\nfirst follow-up\n\nTwo\n\nsecond follow-up",
    ]);
    expect(harness.notifications[0]?.text).toContain("2 message(s) sent with SendMessage");
  });

  it("does not resurrect a stopped child and reports the message as not delivered", async () => {
    const harness = createHarness();
    await harness.startAgent();
    await harness.waitForSink();
    await harness.send("never mind, also do Y", "Y");

    await harness.port.stopTask?.(AGENT_ID);
    harness.firstTurn.resolve();
    await waitForMacrotasks(5);

    expect(harness.prompts).toEqual(["Run slowly"]);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.text).toContain(
      "1 message(s) sent with SendMessage were not delivered: the agent was stopped before it could receive them.",
    );
  });

  it("does not resurrect a failed child and reports the message as not delivered", async () => {
    const harness = createHarness({ failFirstTurn: true });
    await harness.startAgent();
    await harness.waitForSink();
    await harness.send("and Z", "Z");

    harness.firstTurn.resolve();
    await waitForCondition(() => harness.notifications.length === 1);
    await waitForMacrotasks(5);

    expect(harness.prompts).toEqual(["Run slowly"]);
    expect(harness.notifications[0]?.text).toContain("<status>failed</status>");
    expect(harness.notifications[0]?.text).toContain(
      "1 message(s) sent with SendMessage were not delivered: the agent failed before it could receive them.",
    );
  });

  it("drops a message queued on a rewound branch but redelivers one sent after the rewind", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const harness = createHarness({ registry });
    await harness.startAgent();
    await harness.waitForSink();

    await harness.send("from the abandoned branch", "Stale");
    registry.setActiveBranchGeneration(1);
    await harness.send("from the current branch", "Fresh");

    harness.firstTurn.resolve();
    await waitForCondition(() => harness.notifications.length === 2);

    expect(harness.prompts).toEqual(["Run slowly", "from the current branch"]);
  });

  it("resumes directly when the child completes while the rejected steer was still retrying", async () => {
    const steerSettled = createDeferred<void>();
    const harness = createHarness({ steerSettled });
    await harness.startAgent();
    await harness.waitForSink();

    const pending = harness.send("late but in time", "Late");
    harness.firstTurn.resolve();
    await waitForCondition(() => harness.notifications.length === 1);
    steerSettled.resolve();

    await expect(pending).resolves.toMatchObject({
      status: "success",
      delivery: "resumed_background",
    });
    await waitForCondition(() => harness.notifications.length === 2);
    expect(harness.prompts).toEqual(["Run slowly", "late but in time"]);
    expect(harness.notifications[0]?.text).not.toContain("SendMessage");
  });

  it("returns a failed result when the child fails while the rejected steer was still retrying", async () => {
    const steerSettled = createDeferred<void>();
    const harness = createHarness({ failFirstTurn: true, steerSettled });
    await harness.startAgent();
    await harness.waitForSink();

    const pending = harness.send("too late", "Late");
    harness.firstTurn.resolve();
    await waitForCondition(() => harness.notifications.length === 1);
    steerSettled.resolve();

    await expect(pending).resolves.toMatchObject({ status: "failed" });
    expect((await pending).message).toContain(
      `Message was not delivered: agent ${AGENT_ID} failed before it could receive it.`,
    );
    expect(harness.prompts).toEqual(["Run slowly"]);
  });

  it("tells the lead the message was not delivered when the background resume fails to start", async () => {
    const harness = createHarness({ failResumeStart: true });
    await harness.startAgent();
    await harness.waitForSink();
    await harness.send("one more thing", "More");

    harness.firstTurn.resolve();
    await waitForCondition(() => harness.notifications.length === 2);

    expect(harness.notifications[1]?.text).toContain(
      `1 message(s) you sent with SendMessage to agent ${AGENT_ID} were not delivered: resuming the agent failed: resume start failed.`,
    );
    expect((await harness.port.getTask?.(AGENT_ID))?.status).toBe("completed");
  });
});

interface HarnessOptions {
  beforeSink?: Deferred<void>;
  failFirstTurn?: boolean;
  failResumeStart?: boolean;
  gateFirstTurn?: boolean;
  registry?: InMemoryRuntimeTaskRegistry;
  steerSettled?: Deferred<void>;
}

function createHarness(input: HarnessOptions = {}) {
  const sessionId = createSessionId("sendmessage-queue");
  const turnId = createTurnId("sendmessage-queue-turn");
  const firstTurn = createDeferred<void>();
  const prompts: string[] = [];
  const notifications: ParentTaskNotificationCommand[] = [];
  const trace = { traceId: "trace_sendmessage_queue", spanId: "span_parent", sessionId, turnId };

  const runExploreAgent = async (request: ExploreSubagentRuntimeRequest) => {
    prompts.push(request.prompt);
    const isFirstTurn = prompts.length === 1;
    if (!isFirstTurn && input.failResumeStart) {
      throw new Error("resume start failed");
    }
    await request.onSessionReady?.();
    if (isFirstTurn) await input.beforeSink?.promise;
    request.registerMessageSink?.({
      send: async () => {
        await input.steerSettled?.promise;
        throw new Error(REJECTED);
      },
    });
    if (isFirstTurn && input.gateFirstTurn !== false) await firstTurn.promise;
    if (isFirstTurn && input.failFirstTurn) throw new Error("child turn failed");
    return { events: [], response: `report for ${request.prompt}`, traceId: trace.traceId };
  };

  const port = createExploreSubagentPort({
    createAgentId: () => AGENT_ID,
    emitParentEvent: async () => {},
    enqueueParentTaskNotification: (notification) => {
      notifications.push(notification);
      return undefined;
    },
    outputRootDir,
    runExploreAgent,
    ...(input.registry ? { runtimeTaskRegistry: input.registry } : {}),
  });

  return {
    firstTurn,
    notifications,
    port,
    prompts,
    async startAgent() {
      await port.start!({
        agentType: "general-purpose",
        description: "Queue test",
        parentToolCallId: "call_agent",
        prompt: "Run slowly",
        sessionId,
        trace,
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      });
    },
    async waitForSink() {
      await waitForCondition(
        async () => (await port.getTask?.(AGENT_ID))?.messageSink !== undefined,
      );
    },
    send(message: string, summary: string) {
      return port.sendMessage!(sendRequest(sessionId, turnId, trace, message, summary));
    },
  };
}

function sendRequest(
  sessionId: SessionId,
  turnId: ReturnType<typeof createTurnId>,
  trace: { traceId: string; spanId: string; sessionId: SessionId; turnId: typeof turnId },
  message: string,
  summary: string,
) {
  return {
    message,
    parentToolCallId: `call_send_${summary}`,
    sessionId,
    summary,
    to: AGENT_ID,
    trace,
    turnId,
    workingDirectory: outputRootDir,
    workspaceRoot: outputRootDir,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitForMacrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
