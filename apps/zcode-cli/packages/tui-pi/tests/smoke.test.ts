// VirtualTerminal smoke render: mount the app on a stub terminal, feed a
// prompt through the real input channel, assert transcript + statusline land
// in the terminal byte stream.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CTRL_O, ENTER, ESC, createHarness } from "./harness.js";

test("mount renders composer statusline into the terminal", async () => {
  const h = createHarness({ initialMode: "build", initialModel: "prov/model" });
  await h.flush();
  const out = h.output();
  // pi 语法：model • mode；单 provider 无 (provider) 前缀。
  assert.match(out.replace(/\x1b\[[0-9;:]*m/g, ""), /model • build/);
  assert.match(out, /model/);
  await h.stop();
});

test("typed draft and submit flow through the real input channel", async () => {
  const h = createHarness({
    submitPrompt: async () => ({ response: "smoke reply" }),
  });
  h.resetOutput();
  h.feed("hello pi");
  assert.equal(h.draftText(), "hello pi");
  h.feed(ENTER);
  await h.flush();
  const out = h.output();
  assert.match(out, /hello pi/);
  assert.match(out, /smoke reply/);
  assert.equal(h.draftText(), "");
  await h.stop();
});

test("Ctrl+O paints the info overlay into the terminal stream", async () => {
  const h = createHarness({ initialMode: "plan" });
  await h.flush();
  h.resetOutput();
  h.feed(CTRL_O);
  await h.flush();
  assert.match(h.output(), /Session/);
  h.feed(ESC);
  await h.stop();
});
