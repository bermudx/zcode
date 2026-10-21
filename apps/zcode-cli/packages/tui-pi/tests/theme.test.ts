import assert from "node:assert/strict";
import { test } from "node:test";
import { setActiveTuiThemeMode } from "@zcode/tui/internals";
import { createPiTheme } from "../src/theme.js";

test("createPiTheme with noColor returns identity styles", () => {
  setActiveTuiThemeMode("dark");
  const theme = createPiTheme({ noColor: true });
  assert.equal(theme.accent("x"), "x");
  assert.equal(theme.danger("x"), "x");
  assert.equal(theme.muted("x"), "x");
  assert.equal(theme.userBg("x"), "x");
  assert.equal(theme.selectList.selectedText("x"), "x");
});

test("createPiTheme resolves active ZCode tokens into pi styles", () => {
  setActiveTuiThemeMode("dark");
  const theme = createPiTheme({ colorMode: "256color" });
  assert.ok(theme.tokens.accent.length > 0);
  const styled = theme.accent("x");
  assert.notEqual(styled, "x");
  assert.match(styled, /\x1b\[/);
  assert.match(styled, /x/);
});
