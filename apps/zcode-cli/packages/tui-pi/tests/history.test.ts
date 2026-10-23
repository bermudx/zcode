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

// Kitty keyboard protocol (pi-tui pushes `\x1b[>7u`, flag 2 = event types):
// one physical key produces press `\x1b[1;1:1A`, repeat `:2`, release `:3`.
const KITTY_UP_PRESS = "\x1b[1;1:1A";
const KITTY_UP_REPEAT = "\x1b[1;1:2A";
const KITTY_UP_RELEASE = "\x1b[1;1:3A";
const KITTY_DOWN_RELEASE = "\x1b[1;1:3B";

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

test("kitty key release does not fire a second recall", async () => {
  const h = createHarness(historyOptions(["first", "second"]));
  h.feed(KITTY_UP_PRESS);
  await h.flush();
  assert.equal(h.draftText(), "first");
  // 物理上仍是同一次按键：release 不得再前进一步（否则一次 ↑ 落到第二条）。
  h.feed(KITTY_UP_RELEASE);
  await h.flush();
  assert.equal(h.draftText(), "first");
  await h.stop();
});

test("kitty Down press+release steps back exactly once", async () => {
  const h = createHarness(historyOptions(["first", "second"]));
  h.feed(KITTY_UP_PRESS);
  await h.flush();
  h.feed(KITTY_UP_PRESS);
  await h.flush();
  assert.equal(h.draftText(), "second");
  h.feed("\x1b[1;1:1B"); // Down press → "first", index=1
  await h.flush();
  assert.equal(h.draftText(), "first");
  // release 再来一步会把 stash 提前恢复（bug 表现：一次 ↓ 直接回到空草稿）。
  h.feed(KITTY_DOWN_RELEASE);
  await h.flush();
  assert.equal(h.draftText(), "first");
  await h.stop();
});

test("kitty key repeat still steps like a press", async () => {
  const h = createHarness(historyOptions(["first", "second"]));
  h.feed(KITTY_UP_PRESS);
  await h.flush();
  h.feed(KITTY_UP_REPEAT);
  await h.flush();
  assert.equal(h.draftText(), "second");
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
