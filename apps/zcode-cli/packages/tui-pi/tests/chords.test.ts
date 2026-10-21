// Chord guards driven through the real input channel: VirtualTerminal →
// TuiMainScreen listeners → dispatchChord / focused component. Asserts on the
// shared status constants so wording stays pinned to internals.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CTRL_C_EXIT_PROMPT,
  ESCAPE_PAUSE_PROMPT,
  NO_ACTIVE_OUTPUT_STATUS,
  NO_SELECTABLE_MODEL_STATUS,
  PROMPT_DRAFT_CLEARED_STATUS,
  SIDEBAR_HIDDEN_STATUS,
  SIDEBAR_LEADER_HINT,
  SIDEBAR_SHOWN_STATUS,
} from "@zcode/tui/internals";
import type { TuiSubmitPromptResult } from "@zcode/tui/internals";
import {
  CTRL_C,
  CTRL_D,
  CTRL_L,
  CTRL_P,
  CTRL_X,
  CTRL_Y,
  ESC,
  SHIFT_TAB,
  createHarness,
} from "./harness.js";

const modelOption = (providerId: string, modelId: string) =>
  ({ label: `${providerId}/${modelId}`, ref: { providerId, modelId } }) as never;

test("Ctrl+C clears a non-empty draft before arming exit", async () => {
  const h = createHarness();
  h.feed("draft");
  assert.equal(h.draftText(), "draft");
  h.feed(CTRL_C);
  assert.equal(h.draftText(), "");
  assert.equal(h.store.state.status, PROMPT_DRAFT_CLEARED_STATUS);
  assert.equal(h.exitCode(), undefined);
  await h.stop();
});

test("Ctrl+C on empty draft prompts, second press exits", async () => {
  const h = createHarness();
  h.feed(CTRL_C);
  assert.equal(h.store.state.status, CTRL_C_EXIT_PROMPT);
  assert.equal(h.exitCode(), undefined);
  h.feed(CTRL_C);
  assert.equal(h.exitCode(), 0);
  await h.stop();
});

test("Ctrl+D exits only on an empty draft", async () => {
  const h = createHarness();
  h.feed(CTRL_D);
  assert.equal(h.exitCode(), 0);
  await h.stop();
});

test("Ctrl+D keeps a non-empty draft alive", async () => {
  const h = createHarness();
  h.feed("x");
  h.feed(CTRL_D);
  assert.equal(h.exitCode(), undefined);
  await h.stop();
});

test("single Esc while idle reports no active output", async () => {
  const h = createHarness();
  h.feed(ESC);
  assert.equal(h.store.state.status, NO_ACTIVE_OUTPUT_STATUS);
  await h.stop();
});

test("double Esc while busy aborts the active turn", async () => {
  const h = createHarness();
  const controller = new AbortController();
  h.store.turnAbort.current = controller;
  h.store.set("busy", true);
  h.feed(ESC);
  assert.equal(h.store.state.status, ESCAPE_PAUSE_PROMPT);
  assert.equal(controller.signal.aborted, false);
  h.feed(ESC);
  assert.equal(controller.signal.aborted, true);
  await h.stop();
});

test("Shift+Tab cycles collaboration mode through options.setMode", async () => {
  const seen: string[] = [];
  const h = createHarness({
    setMode: async (mode) => {
      seen.push(String(mode));
      return { mode: mode as never, response: `Mode switched to ${mode}.` };
    },
  });
  h.feed(SHIFT_TAB);
  await h.flush();
  assert.equal(seen.length, 1);
  assert.equal(h.store.state.mode, seen[0]);
  await h.stop();
});

test("Ctrl+P reports when no selectable models exist", async () => {
  const h = createHarness({ modelOptions: [] });
  h.feed(CTRL_P);
  assert.equal(h.store.state.status, NO_SELECTABLE_MODEL_STATUS);
  await h.stop();
});

test("Ctrl+P rotates to the next model with a silent /model submit", async () => {
  const submitted: string[] = [];
  const result: TuiSubmitPromptResult = { response: "Model switched." };
  const h = createHarness({
    initialModel: "prov/a",
    modelOptions: [modelOption("prov", "a"), modelOption("prov", "b")],
    submitPrompt: async (input) => {
      submitted.push(input.text);
      return result;
    },
  });
  h.feed(CTRL_P);
  await h.flush();
  assert.deepEqual(submitted, ["/model prov/b"]);
  assert.equal(h.store.state.status, "Model switched.");
  await h.stop();
});

test("Ctrl+L opens a filterable model selection panel", async () => {
  const h = createHarness({
    modelOptions: [modelOption("prov", "a"), modelOption("prov", "b")],
  });
  h.feed(CTRL_L);
  const selection = h.store.state.selection;
  assert.ok(selection);
  assert.equal(selection.title, "Switch model");
  assert.equal(selection.filterable, true);
  assert.equal(selection.items.length, 2);
  await h.stop();
});

test("Ctrl+Y copies the last agent reply through writeClipboardText", async () => {
  const copied: string[] = [];
  const h = createHarness({
    writeClipboardText: async (text) => {
      copied.push(text);
    },
  });
  h.store.set("messages", [{ content: "final answer", role: "agent" }]);
  h.feed(CTRL_Y);
  await h.flush();
  assert.deepEqual(copied, ["final answer"]);
  assert.equal(h.store.state.status, "Copied last assistant reply.");
  await h.stop();
});

test("Ctrl+Y without a reply reports the failure", async () => {
  const h = createHarness();
  h.feed(CTRL_Y);
  assert.equal(h.store.state.status, "No assistant reply to copy.");
  await h.stop();
});

test("Ctrl+X B toggles the session info overlay", async () => {
  const h = createHarness();
  h.feed(CTRL_X);
  assert.equal(h.store.state.status, SIDEBAR_LEADER_HINT);
  h.feed("b");
  assert.equal(h.store.state.status, SIDEBAR_SHOWN_STATUS);
  h.feed(ESC);
  assert.equal(h.store.state.status, SIDEBAR_HIDDEN_STATUS);
  await h.stop();
});
