// `@path` → protocol file attachment resolution. The composer's autocomplete
// only writes text; the attachment list is derived from the submitted draft so
// the core actually receives the file.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendFileMentions, resolveFileMentions } from "../src/mentions.js";

const withWorkspace = async (run: (workspace: string) => void): Promise<void> => {
  const workspace = mkdtempSync(join(tmpdir(), "zcode-mentions-"));
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "README.md"), "hello\n");
  writeFileSync(join(workspace, "src", "alpha.ts"), "export const a = 1;\n");
  writeFileSync(join(workspace, "my notes.txt"), "notes\n");
  try {
    run(workspace);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
};

test("existing workspace files become relative attachments", async () => {
  await withWorkspace((workspace) => {
    const mentions = resolveFileMentions({
      text: "please review @src/alpha.ts and @README.md",
      workspaceDirectory: workspace,
    });
    assert.deepEqual(
      mentions.map((mention) => ({ path: mention.path, placeholder: mention.placeholder })),
      [
        { path: "src/alpha.ts", placeholder: "@src/alpha.ts" },
        { path: "README.md", placeholder: "@README.md" },
      ],
    );
  });
});

test("quoted mentions support paths with spaces", async () => {
  await withWorkspace((workspace) => {
    const mentions = resolveFileMentions({
      text: 'summarize @"my notes.txt" please',
      workspaceDirectory: workspace,
    });
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0]!.path, "my notes.txt");
    assert.equal(mentions[0]!.placeholder, '@"my notes.txt"');
  });
});

test("trailing sentence punctuation is not part of the path", async () => {
  await withWorkspace((workspace) => {
    const mentions = resolveFileMentions({
      text: "see @src/alpha.ts, then @README.md.",
      workspaceDirectory: workspace,
    });
    assert.deepEqual(
      mentions.map((mention) => mention.placeholder),
      ["@src/alpha.ts", "@README.md"],
    );
  });
});

test("unknown paths, directories and mid-word @ are ignored", async () => {
  await withWorkspace((workspace) => {
    const mentions = resolveFileMentions({
      text: "mail me@example.com about @missing.ts and @src",
      workspaceDirectory: workspace,
    });
    assert.deepEqual(mentions, []);
  });
});

test("files outside the workspace keep an absolute path", async () => {
  await withWorkspace((workspace) => {
    const outside = mkdtempSync(join(tmpdir(), "zcode-outside-"));
    const file = join(outside, "outside.txt");
    writeFileSync(file, "x\n");
    try {
      const mentions = resolveFileMentions({
        text: `compare @${file}`,
        workspaceDirectory: workspace,
      });
      assert.equal(mentions.length, 1);
      assert.equal(mentions[0]!.path, file);
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });
});

test("duplicate mentions collapse and existing attachments are preserved", async () => {
  await withWorkspace((workspace) => {
    let id = 0;
    const existing = [
      { id: 99, path: "README.md", placeholder: "@README.md", type: "file" as const },
    ];
    const attachments = appendFileMentions({
      allocateId: () => (id += 1),
      existing,
      text: "@README.md then @src/alpha.ts and @src/alpha.ts again",
      workspaceDirectory: workspace,
    });
    assert.deepEqual(
      attachments.map((attachment) => [attachment.type, (attachment as { path: string }).path]),
      [
        ["file", "README.md"],
        ["file", "src/alpha.ts"],
      ],
    );
    // Existing attachment keeps its id; the new one gets a fresh id.
    assert.equal(attachments[0]!.id, 99);
    assert.equal(attachments[1]!.id, 1);
  });
});
