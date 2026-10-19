import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { testRender } from "@mbears/opentui-react/test-utils";
import { TuiApp } from "../src/app.js";
import { shouldExitOnCtrlD } from "../src/app-keyboard-helpers.js";
import type { TuiOptions, TuiPromptInput } from "../src/types.js";

function flushKeyEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("Ctrl-D exit gate requires an empty draft and no attachments", () => {
  assert.equal(shouldExitOnCtrlD({ draftValue: "", hasAttachments: false }), true);
  assert.equal(shouldExitOnCtrlD({ draftValue: "draft", hasAttachments: false }), false);
  assert.equal(shouldExitOnCtrlD({ draftValue: "", hasAttachments: true }), false);
});

test("Ctrl-D exits immediately when the composer is empty", async () => {
  let exitCount = 0;
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  const options: TuiOptions = {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "done" }),
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => {
          exitCount += 1;
        },
        options,
      }),
      {
        exitOnCtrlC: false,
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      view.mockInput.pressKey("d", { ctrl: true });
      await flushKeyEvents();
      await view.renderOnce();
    });

    assert.equal(exitCount, 1);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("Ctrl-D does not exit with a non-empty draft and leaves it untouched", async () => {
  let exitCount = 0;
  const submitted: TuiPromptInput[] = [];
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  const options: TuiOptions = {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async (input) => {
      submitted.push(input);
      return { response: "done" };
    },
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => {
          exitCount += 1;
        },
        options,
      }),
      {
        exitOnCtrlC: false,
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      await view.mockInput.typeText("draft survives");
      await flushKeyEvents();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressKey("d", { ctrl: true });
      await flushKeyEvents();
      await view.renderOnce();
    });

    assert.equal(exitCount, 0);

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressEnter();
      await flushKeyEvents();
      await view.renderOnce();
    });

    assert.deepEqual(submitted, ["draft survives"]);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("Ctrl-D does not exit while draft attachments are pending", async () => {
  let exitCount = 0;
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  const options: TuiOptions = {
    noColor: true,
    readClipboardImage: async () => ({
      dataUrl: "data:image/png;base64,aW1hZ2U=",
      mediaType: "image/png",
      sizeBytes: 5,
    }),
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "done" }),
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => {
          exitCount += 1;
        },
        options,
      }),
      {
        exitOnCtrlC: false,
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      await view.mockInput.pressKeys(["\x16"]);
      await flushKeyEvents();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressKey("d", { ctrl: true });
      await flushKeyEvents();
      await view.renderOnce();
    });

    assert.equal(exitCount, 0);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("Ctrl-D exits on a single press while the Ctrl-C confirmation is pending", async () => {
  let exitCount = 0;
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  const options: TuiOptions = {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "done" }),
  };

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: async () => ({ kind: "empty" }),
        hasCopyableSelection: () => false,
        onExit: () => {
          exitCount += 1;
        },
        options,
      }),
      {
        exitOnCtrlC: false,
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      view.mockInput.pressCtrlC();
      await flushKeyEvents();
      await view.renderOnce();
    });

    assert.equal(exitCount, 0);

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressKey("d", { ctrl: true });
      await flushKeyEvents();
      await view.renderOnce();
    });

    assert.equal(exitCount, 1);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});
