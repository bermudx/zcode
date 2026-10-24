// ctrl+v / alt+v clipboard image paste: placeholder + DraftAttachment →
// submitPrompt {text, attachments} wire shape, busy/unsupported/no-image
// statuses, placeholder-edit reconcile, in-flight clipboard-read dedupe.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiPromptInput } from "@zcode/tui/internals";
import { createHarness, ENTER } from "./harness.js";

const CTRL_V = "\x16";
const ALT_V = "\x1bv";
const BACKSPACE = "\x7f";

const pngImage = {
  dataUrl: "data:image/png;base64,QUJD",
  mediaType: "image/png" as const,
  sizeBytes: 3,
};

const collectPrompts = () => {
  const prompts: TuiPromptInput[] = [];
  return {
    prompts,
    submitPrompt: async (input: TuiPromptInput) => {
      prompts.push(input);
      return { response: "ok" };
    },
  };
};

test("ctrl+v pastes a clipboard image as [image #N] and submits it as an image attachment", async () => {
  const { prompts, submitPrompt } = collectPrompts();
  const h = createHarness({
    readClipboardImage: async () => pngImage,
    submitPrompt,
  });
  try {
    h.feed("describe this ");
    h.feed(CTRL_V);
    await h.flush();
    assert.equal(h.draftText(), "describe this [image #1]");
    const drafts = h.store.state.draftAttachments;
    assert.equal(drafts.length, 1);
    assert.deepEqual(drafts[0], {
      dataUrl: pngImage.dataUrl,
      id: 1,
      mediaType: "image/png",
      placeholder: "[image #1]",
      sizeBytes: 3,
      type: "image",
    });
    assert.equal(h.store.state.status, "Attached [image #1].");

    h.feed(ENTER);
    await h.flush();
    assert.equal(prompts.length, 1);
    const input = prompts[0]!;
    assert.ok(typeof input !== "string");
    assert.equal(input.text, "describe this [image #1]");
    assert.deepEqual(input.attachments, [
      { content: pngImage.dataUrl, path: "[image #1]", type: "image" },
    ]);
    assert.equal(h.store.state.draftAttachments.length, 0);
  } finally {
    await h.stop();
  }
});

test("alt+v is the Windows fallback chord for image paste", async () => {
  const { prompts, submitPrompt } = collectPrompts();
  const h = createHarness({
    readClipboardImage: async () => pngImage,
    submitPrompt,
  });
  try {
    h.feed(ALT_V);
    await h.flush();
    assert.equal(h.draftText(), "[image #1]");
    h.feed(ENTER);
    await h.flush();
    const input = prompts[0]!;
    assert.ok(typeof input !== "string");
    assert.equal(input.text, "[image #1]");
    assert.equal(input.attachments?.length, 1);
  } finally {
    await h.stop();
  }
});

test("a draft with only image placeholders still submits", async () => {
  const { prompts, submitPrompt } = collectPrompts();
  const h = createHarness({
    readClipboardImage: async () => pngImage,
    submitPrompt,
  });
  try {
    h.feed(CTRL_V);
    await h.flush();
    h.feed(ENTER);
    await h.flush();
    const input = prompts[0]!;
    assert.ok(typeof input !== "string");
    assert.equal(input.attachments?.[0]?.type, "image");
  } finally {
    await h.stop();
  }
});

test("image paste is rejected while a turn is active", async () => {
  let calls = 0;
  const h = createHarness({
    readClipboardImage: async () => {
      calls += 1;
      return pngImage;
    },
  });
  try {
    h.store.set("busy", true);
    h.feed(CTRL_V);
    await h.flush();
    assert.equal(calls, 0);
    assert.equal(h.store.state.status, "Image paste is available when the prompt is idle.");
    assert.equal(h.draftText(), "");
  } finally {
    await h.stop();
  }
});

test("missing clipboard reader reports unavailability instead of throwing", async () => {
  const h = createHarness({});
  try {
    h.feed(CTRL_V);
    await h.flush();
    assert.equal(h.store.state.status, "Image paste is not available in this terminal.");
  } finally {
    await h.stop();
  }
});

test("empty clipboard and unsupported payloads get their own statuses", async () => {
  const h = createHarness({ readClipboardImage: async () => null });
  try {
    h.feed(CTRL_V);
    await h.flush();
    assert.equal(h.store.state.status, "No image found in clipboard.");
  } finally {
    await h.stop();
  }

  const h2 = createHarness({
    readClipboardImage: async () => ({
      dataUrl: "data:text/plain;base64,AAAA",
      mediaType: "image/png",
    }),
  });
  try {
    h2.feed(CTRL_V);
    await h2.flush();
    assert.equal(
      h2.store.state.status,
      "Clipboard image is not a supported image format.",
    );
    assert.equal(h2.store.state.draftAttachments.length, 0);
  } finally {
    await h2.stop();
  }
});

test("editing out the placeholder drops the draft attachment", async () => {
  const h = createHarness({ readClipboardImage: async () => pngImage });
  try {
    h.feed(CTRL_V);
    await h.flush();
    assert.equal(h.store.state.draftAttachments.length, 1);
    // One backspace removes the trailing `]` — placeholder no longer verbatim.
    h.feed(BACKSPACE);
    await h.flush();
    assert.equal(h.store.state.draftAttachments.length, 0);
  } finally {
    await h.stop();
  }
});

test("deleting a placeholder mid-text also drops the attachment", async () => {
  const h = createHarness({ readClipboardImage: async () => pngImage });
  try {
    h.feed("x ");
    h.feed(CTRL_V);
    await h.flush();
    h.feed(" y");
    assert.equal(h.draftText(), "x [image #1] y");
    // 光标移到占位符中间再删：左移两次（过 "y" 与空格）后 backspace 掉 `]`。
    h.feed("\x1b[D");
    h.feed("\x1b[D");
    h.feed(BACKSPACE);
    await h.flush();
    assert.equal(h.draftText(), "x [image #1 y");
    assert.equal(h.store.state.draftAttachments.length, 0);
  } finally {
    await h.stop();
  }
});

test("pasting into a non-whitespace token inserts a separating space", async () => {
  const h = createHarness({ readClipboardImage: async () => pngImage });
  try {
    h.feed("foo");
    h.feed(CTRL_V);
    await h.flush();
    // 占位符不能粘进前一个 token（foo[image #1] 会让 reconcile/submit 都失配）。
    assert.equal(h.draftText(), "foo [image #1]");
  } finally {
    await h.stop();
  }
});

test("slash-command submits still forward draft image attachments to the handler", async () => {
  const { prompts, submitPrompt } = collectPrompts();
  const h = createHarness({
    readClipboardImage: async () => pngImage,
    submitPrompt,
  });
  try {
    h.feed("/model");
    h.feed(CTRL_V);
    await h.flush();
    h.feed(ENTER);
    await h.flush();
    // TUI 层不静默丢附件：`/` 前缀草稿把 attachments 原样交给 prompt handler，
    // 由 command-center 决定拒绝（不在本层消失）。
    const input = prompts[0]!;
    assert.ok(typeof input !== "string");
    assert.equal(input.text, "/model [image #1]");
    assert.equal(input.attachments?.length, 1);
  } finally {
    await h.stop();
  }
});

test("a partially edited @file mention no longer resolves to an attachment", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const workspace = mkdtempSync(join(tmpdir(), "zcode-image-paste-"));
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "a.ts"), "export const a = 1;\n");
  try {
    const { prompts, submitPrompt } = collectPrompts();
    const h = createHarness({ submitPrompt, workspaceDirectory: workspace });
    try {
      h.feed("@src/a.ts");
      h.feed(BACKSPACE); // "@src/a.t" — no longer a resolvable mention.
      h.feed(ENTER);
      await h.flush();
      const input = prompts[0]!;
      // 提交的是纯文本：@src/a.t 指向的文件不存在，不产生附件。
      assert.equal(typeof input === "string" ? input : input.text, "@src/a.t");
      assert.ok(typeof input === "string" || !input.attachments?.length);
    } finally {
      await h.stop();
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("history-restored [image #N] reserves its id — next paste does not collide", async () => {
  const { prompts, submitPrompt } = collectPrompts();
  const h = createHarness({
    readClipboardImage: async () => pngImage,
    // 恢复的历史条目携带一张图片：占位符即 path（提交时我们发的形状）。
    recallPreviousInput: async (skip) =>
      skip === 0
        ? {
            attachments: [
              { content: "data:image/png;base64,T0xE", path: "[image #1]", type: "image" },
            ],
            text: "look [image #1]",
          }
        : null,
    submitPrompt,
  });
  try {
    h.feed("\x1b[A"); // up → 恢复历史草稿
    await h.flush();
    assert.equal(h.draftText(), "look [image #1]");

    h.feed(CTRL_V);
    await h.flush();
    // 新粘贴必须拿到 [image #2]：若复用 [image #1]，同一占位符会绑定两张图。
    assert.equal(h.draftText(), "look [image #1] [image #2]");
    const drafts = h.store.state.draftAttachments;
    assert.deepEqual(
      drafts.map((a) => a.placeholder),
      ["[image #1]", "[image #2]"],
    );
    assert.equal(drafts[0]?.dataUrl, "data:image/png;base64,T0xE");
    assert.equal(drafts[1]?.dataUrl, pngImage.dataUrl);

    h.feed(ENTER);
    await h.flush();
    const input = prompts[0]!;
    assert.ok(typeof input !== "string");
    assert.deepEqual(
      input.attachments?.map((a) => a.path),
      ["[image #1]", "[image #2]"],
    );
  } finally {
    await h.stop();
  }
});

test("rapid double ctrl+v serializes the clipboard read", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const h = createHarness({
    readClipboardImage: async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return pngImage;
    },
  });
  try {
    h.feed(CTRL_V);
    h.feed(CTRL_V);
    assert.equal(calls, 1);
    release?.();
    await h.flush();
    assert.equal(h.draftText(), "[image #1]");
    assert.equal(h.store.state.draftAttachments.length, 1);
  } finally {
    release?.();
    await h.stop();
  }
});
