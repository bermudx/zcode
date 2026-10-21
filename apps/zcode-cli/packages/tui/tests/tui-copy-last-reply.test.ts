import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { testRender } from "@mbears/opentui-react/test-utils";
import { TuiApp } from "../src/app.js";
import { lastAgentReplyText } from "../src/app-transcript-stream.js";
import type { TuiOptions } from "../src/types.js";

function flushKeyEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("lastAgentReplyText returns the last agent message text", () => {
  assert.equal(
    lastAgentReplyText([
      { role: "user", content: "q" },
      { role: "agent", content: "first" },
      { role: "agent", content: "second" },
      { role: "user", content: "follow up" },
    ]),
    "second",
  );
});

test("lastAgentReplyText skips agent messages without text", () => {
  const toolOnly = {
    content: "",
    parts: [
      {
        detailLines: [],
        status: "completed" as const,
        toolCallId: "t1",
        toolName: "bash",
        type: "tool" as const,
      },
    ],
    role: "agent" as const,
  };
  assert.equal(
    lastAgentReplyText([{ role: "agent", content: "earlier reply" }, toolOnly]),
    "earlier reply",
  );
  assert.equal(lastAgentReplyText([{ role: "user", content: "hi" }]), undefined);
  assert.equal(lastAgentReplyText([toolOnly]), undefined);
});

test("lastAgentReplyText joins text parts and excludes thought/tool parts", () => {
  const message = {
    content: "",
    parts: [
      {
        contentCharCount: 9,
        status: "thought" as const,
        text: "reasoning",
        type: "thought" as const,
      },
      { text: "part one", type: "text" as const },
      {
        detailLines: [],
        status: "completed" as const,
        toolCallId: "t",
        toolName: "read",
        type: "tool" as const,
      },
      { text: "part two", type: "text" as const },
    ],
    role: "agent" as const,
  };
  assert.equal(lastAgentReplyText([message]), "part one\n\npart two");
});

test("Ctrl-Y copies the last assistant reply to the clipboard", async () => {
  const written: string[] = [];
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  const options: TuiOptions = {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "assistant reply text" }),
    writeClipboardText: async (text) => {
      written.push(text);
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
        exitOnCtrlC: false,
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 140,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      await view.mockInput.typeText("hi");
      view.mockInput.pressEnter();
      await flushKeyEvents();
      await view.renderOnce();
    });

    // submitPrompt 是异步的，多刷一轮让回复落进 messages。
    await act(async () => {
      assert.ok(view);
      await flushKeyEvents();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      view.mockInput.pressKey("y", { ctrl: true });
      await flushKeyEvents();
      await view.renderOnce();
    });

    // 键事件经 stdin 解析异步到达，状态更新比按键晚一拍；多刷一轮再取帧。
    await act(async () => {
      assert.ok(view);
      await flushKeyEvents();
      await view.renderOnce();
    });

    assert.deepEqual(written, ["assistant reply text"]);
    const frame = view.captureCharFrame();
    assert.equal(frame.includes("Copied last assistant reply."), true);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});

test("Ctrl-Y with no assistant reply does not touch the clipboard", async () => {
  const written: string[] = [];
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  const options: TuiOptions = {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: async () => ({ response: "done" }),
    writeClipboardText: async (text) => {
      written.push(text);
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
        exitOnCtrlC: false,
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 140,
      },
    );
    await view.renderOnce();
  });

  try {
    await act(async () => {
      assert.ok(view);
      view.mockInput.pressKey("y", { ctrl: true });
      await flushKeyEvents();
      await view.renderOnce();
    });

    await act(async () => {
      assert.ok(view);
      await flushKeyEvents();
      await view.renderOnce();
    });

    assert.deepEqual(written, []);
    const frame = view.captureCharFrame();
    assert.equal(frame.includes("No assistant reply to copy."), true);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
});
