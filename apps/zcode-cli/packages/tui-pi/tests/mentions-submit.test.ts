// End-to-end submit wiring for the new composer affordances: `@path` reaches
// the protocol as a file attachment, and a long pasted line survives the real
// render pass (pi-tui throws on any over-wide line).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TuiPromptInput, TuiPromptAttachment } from "@zcode/tui/internals";
import { ENTER, createHarness, paste } from "./harness.js";

const withWorkspace = async (run: (workspace: string) => Promise<void>): Promise<void> => {
  const workspace = mkdtempSync(join(tmpdir(), "zcode-mention-submit-"));
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "alpha.ts"), "export const a = 1;\n");
  try {
    await run(workspace);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
};

test("`@path` in a submitted draft becomes a file attachment", async () => {
  await withWorkspace(async (workspace) => {
    const prompts: TuiPromptInput[] = [];
    const h = createHarness({
      submitPrompt: async (input) => {
        prompts.push(input);
        return { response: "ok" };
      },
      workspaceDirectory: workspace,
    });
    try {
      h.feed("review @src/alpha.ts please");
      h.feed(ENTER);
      await h.flush();
      assert.equal(prompts.length, 1);
      const input = prompts[0]!;
      assert.equal(typeof input, "object");
      assert.ok(typeof input !== "string");
      assert.equal(input.text, "review @src/alpha.ts please");
      assert.deepEqual(
        input.attachments?.map((attachment: TuiPromptAttachment) => attachment.path),
        ["src/alpha.ts"],
      );
      assert.equal(input.attachments?.[0]?.type, "file");
    } finally {
      await h.stop();
    }
  });
});

test("plain prompts carry no attachments", async () => {
  await withWorkspace(async (workspace) => {
    const prompts: TuiPromptInput[] = [];
    const h = createHarness({
      submitPrompt: async (input) => {
        prompts.push(input);
        return { response: "ok" };
      },
      workspaceDirectory: workspace,
    });
    try {
      await h.app.submitValue("no mentions here");
      // submitPipeline normalizes the prompt to {text}; nothing else is added.
      const input = prompts[0]!;
      assert.deepEqual(input, { text: "no mentions here" });
    } finally {
      await h.stop();
    }
  });
});

test("a long pasted line renders without killing the client", async () => {
  await withWorkspace(async (workspace) => {
    const h = createHarness({
      submitPrompt: async () => ({ response: "ok" }),
      workspaceDirectory: workspace,
    });
    try {
      const longLine = `- ${"word ".repeat(120)}tail`;
      h.terminal.columns = 60;
      h.feed(paste(longLine));
      h.feed(ENTER);
      // flush() waits through a real render tick: an over-wide row would throw
      // inside TuiMainScreen.doRender and fail this test as an uncaught error.
      await h.flush();
      const userRow = h.store.state.messages.find((message) => message.role === "user");
      assert.ok(userRow);
      assert.ok(h.output().length > 0);
    } finally {
      await h.stop();
    }
  });
});
