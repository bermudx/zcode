import assert from "node:assert/strict";
import { test } from "node:test";
import { keyEventFromInput } from "../src/keys.js";

test("keyEventFromInput maps ctrl bytes to named KeyEvents", () => {
  const key = keyEventFromInput("\x03");
  assert.equal(key?.name, "c");
  assert.equal(key?.ctrl, true);
  assert.equal(key?.meta, false);
});

test("keyEventFromInput maps named terminal keys", () => {
  assert.equal(keyEventFromInput("\x1b")?.name, "escape");
  assert.equal(keyEventFromInput("\r")?.name, "return");
  assert.equal(keyEventFromInput("\x7f")?.name, "backspace");
  assert.equal(keyEventFromInput("\x1b[5~")?.name, "pageup");
  assert.equal(keyEventFromInput("\x1b[6~")?.name, "pagedown");
  assert.equal(keyEventFromInput("\x1b[A")?.name, "up");
});

test("keyEventFromInput maps shift+tab before tab", () => {
  const key = keyEventFromInput("\x1b[Z");
  assert.equal(key?.name, "tab");
  assert.equal(key?.shift, true);
});

test("keyEventFromInput maps printable input with sequence", () => {
  const lower = keyEventFromInput("a");
  assert.equal(lower?.name, "a");
  assert.equal(lower?.sequence, "a");
  assert.equal(lower?.shift, false);

  const upper = keyEventFromInput("A");
  assert.equal(upper?.name, "A");
  assert.equal(upper?.sequence, "A");
  assert.equal(upper?.shift, true);
});

test("keyEventFromInput maps multi-char input runs", () => {
  const key = keyEventFromInput("hello");
  assert.equal(key?.sequence, "hello");
});

test("keyEventFromInput returns undefined for unrecognized data", () => {
  assert.equal(keyEventFromInput(""), undefined);
  assert.equal(keyEventFromInput("\x1b[999~"), undefined);
});
