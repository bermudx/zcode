// Interactive panels: SelectionPanel (navigate / filter / input / pending /
// paste) and ApprovalPanel (decision cycle / question wizard) driven through
// the same raw-input → ParsedKey → shared-handler path the app uses.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionBrokerResult } from "@zcode/contracts";
import {
  createQuestionPromptState,
  createSelectionState,
  selectionInputDisplayValue,
  type ApprovalPrompt,
} from "@zcode/tui/internals";
import { setActiveTuiThemeMode } from "@zcode/tui/internals";
import { ApprovalPanel, QueuedInputsRow, SelectionPanel } from "../src/panels.js";
import { AppStore } from "../src/store.js";
import { createPiTheme } from "../src/theme.js";
import { DOWN, ENTER, ESC, paste } from "./harness.js";

const theme = () => {
  setActiveTuiThemeMode("dark");
  return createPiTheme({ noColor: true });
};

const selectionState = (items: Array<Record<string, unknown>>, extra = {}) =>
  createSelectionState({
    emptyMessage: "Nothing here.",
    filterable: true,
    items: items as never,
    prompt: "Pick one.",
    title: "Pick",
    ...extra,
  });

const selectionPanel = (options: {
  items: Array<Record<string, unknown>>;
  extra?: Record<string, unknown>;
  submitted?: Array<{ options?: unknown; value: string }>;
}) => {
  const store = new AppStore();
  const submitted = options.submitted ?? [];
  const selection = selectionState(options.items, options.extra);
  const panel = new SelectionPanel(
    selection,
    store,
    theme(),
    async (value: string, opts?: unknown) => {
      submitted.push({ options: opts, value });
    },
    () => {},
  );
  return { panel, selection, store, submitted };
};

test("arrow navigation and Enter submit the highlighted item command", async () => {
  const { panel, selection, store, submitted } = selectionPanel({
    items: [
      { command: "/model a", id: "a", primary: "Model A" },
      { command: "/model b", id: "b", primary: "Model B" },
    ],
  });
  panel.handleInput(DOWN);
  assert.equal(selection.selectedIndex, 1);
  panel.handleInput(ENTER);
  assert.deepEqual(submitted, [{ options: undefined, value: "/model b" }]);
  assert.equal(store.state.selection, undefined);
});

test("typing filters items; backspace edits the filter", () => {
  const { panel, selection } = selectionPanel({
    items: [
      { command: "/a", id: "a", primary: "alpha" },
      { command: "/b", id: "b", primary: "beta" },
    ],
  });
  panel.handleInput("b");
  panel.handleInput("e");
  assert.equal(selection.filter, "be");
  panel.handleInput("\x7f");
  assert.equal(selection.filter, "b");
});

test("bracketed paste feeds the filter through the shared handler", () => {
  const { panel, selection } = selectionPanel({
    items: [
      { command: "/a", id: "a", primary: "alpha" },
      { command: "/b", id: "b", primary: "beta" },
    ],
  });
  panel.handleInput(paste("alp\nbeta"));
  // Newlines are control chars — filtered out like React's pastedInputText.
  assert.equal(selection.filter, "alpbeta");
});

test("Esc dismisses the selection", () => {
  const { panel, store } = selectionPanel({ items: [{ command: "/a", id: "a", primary: "a" }] });
  store.set("selection", selectionState([{ command: "/a", id: "a", primary: "a" }]));
  panel.handleInput(ESC);
  assert.equal(store.state.selection, undefined);
  assert.equal(store.state.status, "Selection cancelled.");
});

test("item with input opens the input substate; paste appends to its value", () => {
  const store = new AppStore();
  const submitted: string[] = [];
  const selection = selectionState(
    [
      {
        command: "/login zai-coding-plan-api-key",
        id: "key",
        input: { mask: true, primary: "API key" },
        primary: "Paste API key",
      },
    ],
    { filterable: true },
  );
  const panel = new SelectionPanel(
    selection,
    store,
    theme(),
    async (value: string) => {
      submitted.push(value);
    },
    () => {},
  );
  panel.handleInput(ENTER);
  const withInput = store.state.selection;
  assert.ok(withInput?.input);
  panel.handleInput(paste("sk-live-789"));
  assert.equal(store.state.selection?.input?.value, "sk-live-789");
  panel.handleInput(ENTER);
  assert.equal(store.state.selection, undefined);
  assert.deepEqual(submitted, ["/login zai-coding-plan-api-key sk-live-789"]);
});

test("masked input renders through selectionInputDisplayValue", () => {
  const display = selectionInputDisplayValue({
    command: "/login",
    itemId: "k",
    mask: true,
    primary: "API key",
    value: "secret",
  });
  assert.equal(display, "******");
});

test("pending item shows pending state and Esc cancels via callback", async () => {
  const store = new AppStore();
  let cancelled = 0;
  const submitted: Array<{ options?: unknown; value: string }> = [];
  const selection = selectionState([
    {
      command: "/resume latest",
      id: "r",
      pending: { primary: "Resuming…" },
      primary: "Resume session",
    },
  ]);
  const panel = new SelectionPanel(
    selection,
    store,
    theme(),
    async (value: string, opts?: unknown) => {
      submitted.push({ options: opts, value });
    },
    () => {
      cancelled += 1;
    },
  );
  panel.handleInput(ENTER);
  assert.equal(store.state.selection?.pending?.command, "/resume latest");
  assert.equal(submitted[0]!.value, "/resume latest");
  panel.handleInput(ESC);
  assert.equal(cancelled, 1);
  assert.equal(store.state.selection?.pending, undefined);
});

const approvalPrompt = (
  request: Record<string, unknown>,
  resolved: PermissionBrokerResult[],
): ApprovalPrompt => ({
  cleanup: () => {},
  reject: () => {},
  request: request as never,
  resolve: (result) => {
    resolved.push(result);
  },
  selectedDecision: "allow_once",
});

test("approval panel cycles decisions and Enter resolves allow", () => {
  const store = new AppStore();
  const resolved: PermissionBrokerResult[] = [];
  const approval = approvalPrompt(
    { input: { command: "rm -rf x" }, toolName: "Bash" },
    resolved,
  );
  store.set("approvalQueue", [approval]);
  const panel = new ApprovalPanel(approval, store, theme());
  panel.handleInput(DOWN);
  assert.equal(store.state.approvalQueue[0]!.selectedDecision, "allow_project");
  panel.handleInput(ENTER);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.decision, "allow");
  assert.equal(store.state.approvalQueue.length, 0);
});

test("Esc denies the approval", () => {
  const store = new AppStore();
  const resolved: PermissionBrokerResult[] = [];
  const approval = approvalPrompt({ toolName: "Bash" }, resolved);
  store.set("approvalQueue", [approval]);
  const panel = new ApprovalPanel(approval, store, theme());
  panel.handleInput(ESC);
  assert.equal(resolved[0]!.decision, "deny");
});

test("question wizard: Other flow produces a modify result with answers", () => {
  const store = new AppStore();
  const resolved: PermissionBrokerResult[] = [];
  const approval = approvalPrompt({ toolName: "AskUserQuestion" }, resolved);
  approval.questionState = createQuestionPromptState({
    questions: [
      {
        header: "h",
        multiSelect: false,
        options: [{ label: "Option A" }],
        question: "Pick?",
      },
    ],
  });
  store.set("approvalQueue", [approval]);
  const panel = new ApprovalPanel(approval, store, theme());

  panel.handleInput("o");
  assert.equal(store.state.approvalQueue[0]!.questionState?.editingOther, true);
  for (const char of "custom") panel.handleInput(char);
  panel.handleInput(ENTER);
  const state = store.state.approvalQueue[0]!.questionState!;
  assert.equal(state.otherText["Pick?"], "custom");
  assert.equal(state.editingOther, false);
  panel.handleInput(ENTER); // submits the answer → review page
  assert.equal(store.state.approvalQueue[0]!.questionState?.reviewing, true);
  panel.handleInput(ENTER); // confirm → modify result
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.decision, "modify");
  assert.equal(store.state.approvalQueue.length, 0);
});

test("question wizard Esc denies", () => {
  const store = new AppStore();
  const resolved: PermissionBrokerResult[] = [];
  const approval = approvalPrompt({ toolName: "AskUserQuestion" }, resolved);
  approval.questionState = createQuestionPromptState({
    questions: [{ multiSelect: false, options: [{ label: "A" }], question: "Q?" }],
  });
  store.set("approvalQueue", [approval]);
  const panel = new ApprovalPanel(approval, store, theme());
  panel.handleInput(ESC);
  assert.equal(resolved[0]!.decision, "deny");
});

test("QueuedInputsRow renders queued texts plus the Alt+Up restore hint", () => {
  // pi-mono 对齐：队列区必须提示 dequeue 键——否则恢复入口不可发现。
  const row = new QueuedInputsRow(
    [{ id: "p1", text: "first" }, { id: "p2", text: "second" }],
    theme(),
  );
  const lines = row.render(80).join("\n");
  assert.ok(lines.includes("first"));
  assert.ok(lines.includes("second"));
  assert.match(lines, /Alt\+Up restores queued inputs/);
});
