// Session-event projection: SessionEvent[] → Message[] through the app's
// applyEvent pipeline (dedup window + main-session gate + shared reducer).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@zcode/tui/internals";
import { createHarness, sessionEvent } from "./harness.js";

const textPartText = (message: Message): string =>
  (message.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");

test("text_delta events accumulate into a streaming agent message", async () => {
  const h = createHarness();
  h.app.applyEvent(
    sessionEvent("model_streaming", { assistantMessageId: "m1", delta: "Hello ", kind: "text_delta" }),
  );
  h.app.applyEvent(
    sessionEvent("model_streaming", { assistantMessageId: "m1", delta: "world", kind: "text_delta" }),
  );
  const messages = h.store.state.messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.role, "agent");
  assert.equal(messages[0]!.streaming, true);
  assert.equal(textPartText(messages[0]!), "Hello world");
  await h.stop();
});

test("finish marks the streaming message complete", async () => {
  const h = createHarness();
  h.app.applyEvent(
    sessionEvent("model_streaming", { assistantMessageId: "m1", delta: "done", kind: "text_delta" }),
  );
  h.app.applyEvent(sessionEvent("model_streaming", { assistantMessageId: "m1", kind: "finish" }));
  assert.equal(h.store.state.messages[0]!.streaming, false);
  await h.stop();
});

test("deltas without assistantMessageId collect into liveModelText", async () => {
  const h = createHarness();
  h.app.applyEvent(sessionEvent("model_streaming", { delta: "partial", kind: "text_delta" }));
  h.app.applyEvent(sessionEvent("model_streaming", { delta: "…", kind: "text_delta" }));
  assert.equal(h.store.state.liveModelText, "partial…");
  assert.equal(h.store.state.messages.length, 0);
  await h.stop();
});

test("tool_call lifecycle upserts a single tool part", async () => {
  const h = createHarness();
  h.app.applyEvent(
    sessionEvent("tool_call_scheduled", {
      input: { file_path: "/tmp/a.ts" },
      toolCallId: "tc1",
      toolName: "read_file",
    }),
  );
  h.app.applyEvent(sessionEvent("tool_call_started", { toolCallId: "tc1" }));
  h.app.applyEvent(
    sessionEvent("tool_call_result", { result: { content: "ok" }, toolCallId: "tc1" }),
  );
  const toolParts = h.store.state.messages.flatMap((message) =>
    (message.parts ?? []).filter((part) => part.type === "tool"),
  );
  assert.equal(toolParts.length, 1);
  const part = toolParts[0]!;
  assert.equal(part.type, "tool");
  if (part.type !== "tool") return;
  assert.equal(part.toolCallId, "tc1");
  assert.equal(part.toolName, "read_file");
  assert.equal(part.status, "completed");
  await h.stop();
});

test("duplicate event ids are deduplicated", async () => {
  const h = createHarness();
  const event = sessionEvent("assistant_message", { content: "once" });
  h.app.applyEvent(event);
  h.app.applyEvent(event);
  assert.equal(h.store.state.messages.length, 1);
  await h.stop();
});

test("non-main-session events are filtered out when getMainSessionId is set", async () => {
  const h = createHarness({ getMainSessionId: () => "sess-main" });
  h.app.applyEvent(
    sessionEvent("assistant_message", { content: "actor chatter" }, { sessionId: "sess-actor" }),
  );
  assert.equal(h.store.state.messages.length, 0);
  h.app.applyEvent(
    sessionEvent("assistant_message", { content: "main reply" }, { sessionId: "sess-main" }),
  );
  assert.equal(h.store.state.messages.length, 1);
  await h.stop();
});

test("turn_started / turn_complete drive status and activeTurnId", async () => {
  const h = createHarness();
  h.app.applyEvent(sessionEvent("turn_started", {}, { turnId: "turn-1" }));
  assert.equal(h.store.state.activeTurnId, "turn-1");
  h.app.applyEvent(sessionEvent("turn_complete", {}, { turnId: "turn-1" }));
  assert.equal(h.store.state.activeTurnId, undefined);
  await h.stop();
});
