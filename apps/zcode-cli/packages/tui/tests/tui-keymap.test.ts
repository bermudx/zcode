import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { testRender } from "@mbears/opentui-react/test-utils";
import { TuiApp } from "../src/app.js";
import {
  ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS,
  createDoublePressGuard,
  nextSelectableModelOption,
  resolveDoublePressIntent,
} from "../src/app-keyboard.js";
import type { TuiModelOption, TuiOptions } from "../src/types.js";

function flushKeyEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type RenderedApp = Awaited<ReturnType<typeof testRender>>;

async function settle(view: RenderedApp, rounds = 2): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await flushKeyEvents();
      await view.renderOnce();
    });
  }
}

async function typeText(view: RenderedApp, text: string): Promise<void> {
  await act(async () => {
    await view.mockInput.typeText(text);
    await flushKeyEvents();
  });
  await settle(view);
}

async function pressKey(view: RenderedApp, press: () => void, rounds = 2): Promise<void> {
  await act(async () => {
    press();
    await flushKeyEvents();
  });
  await settle(view, rounds);
}

function modelOption(
  providerId: string,
  modelId: string,
  label: string,
  disabledReason?: string,
): TuiModelOption {
  return {
    ref: { providerId, modelId },
    label,
    properties: {
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
    },
    ...(disabledReason ? { disabledReason } : {}),
  };
}

const models: TuiModelOption[] = [
  modelOption("p", "one", "One"),
  modelOption("p", "two", "Two", "no plan"),
  modelOption("p", "three", "Three"),
];

async function renderApp(
  options: Partial<TuiOptions> = {},
  props: {
    copySelection?: () => Promise<{ kind: "copied"; characterCount: number } | { kind: "empty" }>;
    hasCopyableSelection?: () => boolean;
  } = {},
): Promise<RenderedApp> {
  let view: RenderedApp | undefined;

  await act(async () => {
    view = await testRender(
      React.createElement(TuiApp, {
        copySelection: props.copySelection ?? (async () => ({ kind: "empty" })),
        hasCopyableSelection: props.hasCopyableSelection ?? (() => false),
        onExit: () => undefined,
        options: {
          noColor: true,
          stderr: process.stderr,
          stdin: process.stdin,
          stdout: process.stdout,
          submitPrompt: async () => ({ response: "done" }),
          ...options,
        },
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

  assert.ok(view);
  return view;
}

async function destroy(view: RenderedApp): Promise<void> {
  await act(async () => {
    view.renderer.destroy();
  });
}

test("Ctrl-C does not copy a selection or submit the cleared draft", async () => {
  let copyCount = 0;
  const submitted: string[] = [];
  const view = await renderApp(
    {
      submitPrompt: async (input) => {
        submitted.push(typeof input === "string" ? input : input.text);
        return { response: "done" };
      },
    },
    {
      copySelection: async () => {
        copyCount += 1;
        return { kind: "copied", characterCount: 4 };
      },
      hasCopyableSelection: () => true,
    },
  );

  try {
    await typeText(view, "draft");
    assert.equal(view.captureCharFrame().includes("draft"), true);

    await pressKey(view, () => view.mockInput.pressCtrlC());

    assert.equal(copyCount, 0);
    assert.equal(view.captureCharFrame().includes("draft"), false);

    await pressKey(view, () => view.mockInput.pressEnter());

    assert.deepEqual(submitted, []);
  } finally {
    await destroy(view);
  }
});

test("Ctrl-X Y no longer copies the last assistant reply", async () => {
  const written: string[] = [];
  const view = await renderApp({
    submitPrompt: async () => ({ response: "assistant reply text" }),
    writeClipboardText: async (text) => {
      written.push(text);
    },
  });

  try {
    await typeText(view, "hi");
    await pressKey(view, () => view.mockInput.pressEnter(), 3);

    await pressKey(view, () => view.mockInput.pressKey("x", { ctrl: true }));
    await pressKey(view, () => view.mockInput.pressKey("y"));

    assert.deepEqual(written, []);
    assert.equal(view.captureCharFrame().includes("Copied last assistant reply."), false);
  } finally {
    await destroy(view);
  }
});

test("Ctrl-U keeps its editor-local delete-to-line-start behavior", async () => {
  const submitted: string[] = [];
  const view = await renderApp({
    submitPrompt: async (input) => {
      submitted.push(typeof input === "string" ? input : input.text);
      return { response: "done" };
    },
  });

  try {
    await typeText(view, "first");
    await pressKey(view, () => view.mockInput.pressEnter({ shift: true }));
    await typeText(view, "second");
    await pressKey(view, () => view.mockInput.pressKey("u", { ctrl: true }));
    await pressKey(view, () => view.mockInput.pressEnter());

    assert.deepEqual(submitted, ["first"]);
  } finally {
    await destroy(view);
  }
});

test("Ctrl-L opens the model picker and Esc restores the previous draft", async () => {
  const submitted: string[] = [];
  const view = await renderApp({
    initialModel: "p/one",
    modelOptions: models,
    submitPrompt: async (input) => {
      submitted.push(typeof input === "string" ? input : input.text);
      return { response: "done" };
    },
  });

  try {
    await typeText(view, "keep me");
    await pressKey(view, () => view.mockInput.pressKey("l", { ctrl: true }));

    const pickerFrame = view.captureCharFrame();
    assert.equal(pickerFrame.includes("One"), true);
    assert.equal(pickerFrame.includes("Three"), true);

    await pressKey(view, () => view.mockInput.pressEscape());
    await pressKey(view, () => view.mockInput.pressEnter());

    assert.deepEqual(submitted, ["keep me"]);
  } finally {
    await destroy(view);
  }
});

test("Ctrl-P cycles enabled models and keeps the draft without transcript noise", async () => {
  const submitted: string[] = [];
  const view = await renderApp({
    initialModel: "p/one",
    modelOptions: models,
    submitPrompt: async (input) => {
      const text = typeof input === "string" ? input : input.text;
      submitted.push(text);
      return {
        model: text === "/model p/three" ? "p/three" : "p/one",
        response: `Model switched to ${text.slice("/model ".length)}.`,
      };
    },
  });

  try {
    await typeText(view, "compose");
    await pressKey(view, () => view.mockInput.pressKey("p", { ctrl: true }), 4);

    assert.deepEqual(submitted, ["/model p/three"]);
    const frameAfterFirstCycle = view.captureCharFrame();
    assert.equal(frameAfterFirstCycle.includes("compose"), true);
    assert.equal(frameAfterFirstCycle.includes("Model switched to p/three."), true);
    assert.equal(frameAfterFirstCycle.includes("/model p/three"), false);

    await pressKey(view, () => view.mockInput.pressKey("p", { ctrl: true }), 4);

    assert.deepEqual(submitted, ["/model p/three", "/model p/one"]);

    await pressKey(view, () => view.mockInput.pressEnter(), 3);

    assert.deepEqual(submitted, ["/model p/three", "/model p/one", "compose"]);
  } finally {
    await destroy(view);
  }
});

test("Ctrl-P reports when no other selectable model exists", async () => {
  const submitted: string[] = [];
  const view = await renderApp({
    initialModel: "p/one",
    modelOptions: [models[0]!, models[1]!],
    submitPrompt: async (input) => {
      submitted.push(typeof input === "string" ? input : input.text);
      return { response: "done" };
    },
  });

  try {
    await pressKey(view, () => view.mockInput.pressKey("p", { ctrl: true }));

    assert.deepEqual(submitted, []);
    assert.equal(view.captureCharFrame().includes("Only one model available."), true);
  } finally {
    await destroy(view);
  }
});

test("Esc twice within 2 seconds pauses busy output; one press only hints", async () => {
  let capturedSignal: AbortSignal | undefined;
  const view = await renderApp({
    submitPrompt: async (_input, options) => {
      capturedSignal = options.abortSignal;
      return await new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  });

  try {
    await typeText(view, "run");
    await pressKey(view, () => view.mockInput.pressEnter(), 4);

    assert.ok(capturedSignal);

    await pressKey(view, () => view.mockInput.pressEscape());

    assert.equal(capturedSignal.aborted, false);
    assert.equal(view.captureCharFrame().includes("Press Esc again to pause output."), true);

    await pressKey(view, () => view.mockInput.pressEscape());

    assert.equal(capturedSignal.aborted, true);
  } finally {
    await destroy(view);
  }
});

test("Ctrl-V attaches a clipboard image", async () => {
  const view = await renderApp({
    readClipboardImage: async () => ({
      dataUrl: "data:image/png;base64,aGVsbG8=",
      mediaType: "image/png",
      sizeBytes: 5,
    }),
  });

  try {
    await pressKey(view, () => view.mockInput.pressKey("v", { ctrl: true }), 3);

    assert.equal(view.captureCharFrame().includes("Attached [image #1]."), true);
  } finally {
    await destroy(view);
  }
});

test("double-press guard expires after its window", () => {
  const guard = createDoublePressGuard();
  const firstPressAtMs = 1_000;

  assert.equal(
    resolveDoublePressIntent(guard, firstPressAtMs, ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS),
    "arm",
  );
  assert.equal(
    resolveDoublePressIntent(
      guard,
      firstPressAtMs + ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS,
      ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS,
    ),
    "confirm",
  );
  assert.equal(
    resolveDoublePressIntent(
      guard,
      firstPressAtMs + ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS * 2 + 1,
      ESCAPE_PAUSE_CONFIRMATION_WINDOW_MS,
    ),
    "arm",
  );
});

test("nextSelectableModelOption skips disabled models and wraps", () => {
  assert.equal(nextSelectableModelOption(models, "p/one")?.ref.modelId, "three");
  assert.equal(nextSelectableModelOption(models, "p/three")?.ref.modelId, "one");
  assert.equal(nextSelectableModelOption([models[0]!, models[1]!], "p/one"), undefined);
});
