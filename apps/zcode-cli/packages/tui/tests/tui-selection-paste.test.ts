import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { pasteBytes } from "@mbears/opentui-core/testing";
import { testRender } from "@mbears/opentui-react/test-utils";
import { TuiApp } from "../src/app.js";
import type { SelectionState } from "../src/app-model.js";
import { applySelectionPaste, pastedInputText } from "../src/app-selection-paste.js";
import type { TuiOptions, TuiSelection, TuiSelectionInput } from "../src/types.js";

const API_KEY_ITEM_INPUT = {
  cancelStatus: "API key entry cancelled. Choose a setup method.",
  clearStatus: "API key input cleared.",
  emptyStatus: "API key is required.",
  help: "Enter saves the key. Esc returns to setup choices.",
  mask: true,
  placeholder: "Paste API key",
  primary: "Z.AI Coding Plan API Key",
  secondary: "Paste the key here. It is hidden while typing.",
  status: "Enter the API key, then press Enter.",
  submitStatus: "Saving API key...",
} satisfies TuiSelectionInput;

const BASE_SELECTION: SelectionState = {
  emptyMessage: "No login options are available.",
  filter: "",
  help: "Use Up/Down to choose, Enter to select.",
  items: [
    {
      command: "/login zai-coding-plan",
      id: "zai-coding-plan",
      primary: "Z.AI Coding Plan",
    },
    {
      command: "/login bigmodel-coding-plan",
      id: "bigmodel-coding-plan",
      primary: "BigModel Coding Plan",
    },
    {
      command: "/login zai-coding-plan-api-key",
      id: "zai-coding-plan-api-key",
      input: API_KEY_ITEM_INPUT,
      primary: "Z.AI Coding Plan API Key",
    },
  ],
  prompt: "Choose a login or API key setup method.",
  selectedIndex: 0,
  title: "Set Up Coding Plan",
};

const ACTIVE_API_KEY_INPUT: NonNullable<SelectionState["input"]> = {
  ...API_KEY_ITEM_INPUT,
  command: "/login zai-coding-plan-api-key",
  itemId: "zai-coding-plan-api-key",
  value: "",
};

type RenderedTui = NonNullable<Awaited<ReturnType<typeof testRender>>>;

// 提交结果、选择面板切换等状态经由异步链路落地，单次 renderOnce 不保证已完成；
// 逐次渲染直到目标文案出现，避免用例依赖微任务时序。
async function renderUntilFrameContains(
  view: RenderedTui,
  marker: string,
  attempts = 10,
): Promise<string> {
  let frame = view.captureCharFrame();
  for (let attempt = 0; attempt < attempts && !frame.includes(marker); attempt += 1) {
    await act(async () => {
      await Promise.resolve();
      await view.renderOnce();
    });
    frame = view.captureCharFrame();
  }
  return frame;
}

test("pastedInputText keeps printable text and drops ANSI, control and newline characters", () => {
  assert.equal(pastedInputText(pasteBytes("abc.def")), "abc.def");
  assert.equal(pastedInputText(pasteBytes("abc.def\n")), "abc.def");
  assert.equal(pastedInputText(pasteBytes("\u001b[31mabc.def\u001b[0m")), "abc.def");
  assert.equal(pastedInputText(pasteBytes("a\tb\r\nc")), "abc");
  assert.equal(pastedInputText(pasteBytes("")), undefined);
  assert.equal(pastedInputText(pasteBytes("\n\r\n")), undefined);
});

test("applySelectionPaste appends to the active selection input", () => {
  let selection: SelectionState | undefined = {
    ...BASE_SELECTION,
    input: { ...ACTIVE_API_KEY_INPUT },
  };
  const consumed = applySelectionPaste(selection, "abc.def", (next) => {
    selection = typeof next === "function" ? next(selection) : next;
  });

  assert.equal(consumed, true);
  assert.equal(selection?.input?.value, "abc.def");
  assert.equal(selection?.filter, "");
});

test("applySelectionPaste appends after existing input text", () => {
  let selection: SelectionState | undefined = {
    ...BASE_SELECTION,
    input: { ...ACTIVE_API_KEY_INPUT, value: "abc." },
  };
  applySelectionPaste(selection, "def", (next) => {
    selection = typeof next === "function" ? next(selection) : next;
  });

  assert.equal(selection?.input?.value, "abc.def");
});

test("applySelectionPaste feeds the filter for filterable selections without input", () => {
  let selection: SelectionState | undefined = { ...BASE_SELECTION, selectedIndex: 2 };
  const consumed = applySelectionPaste(selection, "bigmodel", (next) => {
    selection = typeof next === "function" ? next(selection) : next;
  });

  assert.equal(consumed, true);
  assert.equal(selection?.filter, "bigmodel");
  assert.equal(selection?.selectedIndex, 0);
});

test("applySelectionPaste ignores pending and non-filterable selections", () => {
  let pendingSelection: SelectionState | undefined = {
    ...BASE_SELECTION,
    pending: {
      cancelStatus: "Login cancelled.",
      primary: "Waiting for Z.AI authorization",
    },
  };
  assert.equal(
    applySelectionPaste(pendingSelection, "abc.def", (next) => {
      pendingSelection = typeof next === "function" ? next(pendingSelection) : next;
    }),
    false,
  );
  assert.equal(pendingSelection.filter, "");

  let fixedSelection: SelectionState | undefined = { ...BASE_SELECTION, filterable: false };
  assert.equal(
    applySelectionPaste(fixedSelection, "abc.def", (next) => {
      fixedSelection = typeof next === "function" ? next(fixedSelection) : next;
    }),
    false,
  );
  assert.equal(fixedSelection.filter, "");
});

test("bracketed paste into the login panel input submits the manual API key command", async () => {
  let view: RenderedTui | undefined;
  const submitted: string[] = [];
  const loginSelection: TuiSelection = {
    emptyMessage: BASE_SELECTION.emptyMessage,
    help: BASE_SELECTION.help,
    items: BASE_SELECTION.items.map((item) => ({
      command: item.command,
      id: item.id,
      ...(item.input ? { input: API_KEY_ITEM_INPUT } : {}),
      primary: item.primary,
    })),
    prompt: BASE_SELECTION.prompt,
    selectedIndex: 0,
    title: BASE_SELECTION.title,
  };

  const options: TuiOptions = {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (input) => {
      const value = typeof input === "string" ? input : input.text;
      submitted.push(value);
      if (value === "/login") return { response: "", selection: loginSelection };
      return { response: "done" };
    },
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => undefined,
        options,
      }),
      {
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    assert.ok(view);
    const rendered = view;

    await act(async () => {
      await rendered.mockInput.typeText("/login");
      await rendered.renderOnce();
    });
    await act(async () => {
      rendered.mockInput.pressEnter();
      await Promise.resolve();
      await rendered.renderOnce();
    });
    const loginFrame = await renderUntilFrameContains(rendered, "Set Up Coding Plan");
    assert.ok(loginFrame.includes("Set Up Coding Plan"), loginFrame);

    // 登录面板选中 API key 输入行
    await act(async () => {
      rendered.mockInput.pressArrow("down");
      await Promise.resolve();
      await rendered.renderOnce();
    });
    await act(async () => {
      rendered.mockInput.pressArrow("down");
      await Promise.resolve();
      await rendered.renderOnce();
    });
    const itemFrame = await renderUntilFrameContains(rendered, "> Z.AI Coding Plan API Key");
    assert.ok(itemFrame.includes("> Z.AI Coding Plan API Key"), itemFrame);

    await act(async () => {
      rendered.mockInput.pressEnter();
      await Promise.resolve();
      await rendered.renderOnce();
    });
    const inputFrame = await renderUntilFrameContains(rendered, "Paste API key");
    assert.ok(inputFrame.includes("Paste API key"), inputFrame);

    // 终端 bracketed paste：修复前该事件没有消费者，输入值保持为空
    await act(async () => {
      await rendered.mockInput.pasteBracketedText("manual-key");
      await Promise.resolve();
      await rendered.renderOnce();
    });
    const pastedFrame = await renderUntilFrameContains(rendered, "**********");
    assert.ok(pastedFrame.includes("**********"), pastedFrame);

    await act(async () => {
      rendered.mockInput.pressEnter();
      await Promise.resolve();
      await rendered.renderOnce();
    });
    for (let attempt = 0; attempt < 10 && submitted.length < 2; attempt += 1) {
      await act(async () => {
        await Promise.resolve();
        await rendered.renderOnce();
      });
    }

    assert.deepEqual(submitted, ["/login", "/login zai-coding-plan-api-key manual-key"]);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});
