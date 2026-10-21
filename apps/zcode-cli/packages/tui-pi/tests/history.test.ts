// Cross-session input history: empty-draft Up walks back through
// options.recallPreviousInput(skip), Down returns toward the stashed draft —
// the same state machine as the React frontend's useInputHistory.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DOWN, UP, createHarness } from "./harness.js";

const historyOptions = (entries: string[]) => ({
  recallPreviousInput: async (skip = 0) =>
    entries[skip] ? { text: entries[skip]! } : null,
});

test("Up on an empty draft recalls older entries with an increasing skip", async () => {
  const h = createHarness(historyOptions(["first", "second"]));
  h.feed(UP);
  await h.flush();
  assert.equal(h.draftText(), "first");
  h.feed(UP);
  await h.flush();
  assert.equal(h.draftText(), "second");
  await h.stop();
});

test("Down walks back to the stashed draft and deactivates history", async () => {
  const h = createHarness(historyOptions(["first", "second"]));
  h.feed(UP);
  await h.flush();
  h.feed(UP);
  await h.flush();
  assert.equal(h.draftText(), "second");
  h.feed(DOWN);
  await h.flush();
  assert.equal(h.draftText(), "first");
  h.feed(DOWN);
  await h.flush();
  assert.equal(h.draftText(), "");
  // History inactive again: Down must not resurrect anything.
  h.feed(DOWN);
  await h.flush();
  assert.equal(h.draftText(), "");
  await h.stop();
});

test("Up preserves an in-progress draft in the stash", async () => {
  const h = createHarness(historyOptions(["old"]));
  // React gates Up on draft==="" || historyActive; a non-empty draft without
  // active history does NOT recall — verify Up leaves the draft alone.
  h.feed("wip");
  h.feed(UP);
  await h.flush();
  assert.equal(h.draftText(), "wip");
  await h.stop();
});

test("typing after a recall resets the skip index", async () => {
  const h = createHarness(historyOptions(["first", "second"]));
  h.feed(UP);
  await h.flush();
  h.feed(UP);
  await h.flush();
  assert.equal(h.draftText(), "second");
  h.feed("!");
  h.feed(UP);
  await h.flush();
  // Draft is non-empty again so Up does nothing (gate); history index was
  // reset by the edit — a following clear+Up must restart from skip 0.
  assert.equal(h.draftText(), "second!");
  h.feed("\x03"); // Ctrl+C clears the draft
  h.feed(UP);
  await h.flush();
  assert.equal(h.draftText(), "first");
  await h.stop();
});

test("recall failure surfaces a status instead of throwing", async () => {
  const h = createHarness({
    recallPreviousInput: async () => {
      throw new Error("history backend down");
    },
  });
  h.feed(UP);
  await h.flush();
  assert.ok(h.store.state.status.length > 0);
  assert.equal(h.store.state.statusDetails[0], "history backend down");
  await h.stop();
});
