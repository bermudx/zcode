// `@path` mentions in the composer draft → protocol file attachments.
//
// pi-tui's autocomplete only inserts the path text; the shared core never sees
// anything but what we send on the prompt. The React frontend keeps an explicit
// DraftAttachment list built from its own picker panel; the pi frontend has no
// panel, so the draft text itself is the source of truth: every `@token` that
// resolves to a real file inside the workspace becomes a file attachment.

import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DraftAttachment } from "@zcode/tui/internals";

/** `@token` only counts at a token boundary, mirroring the autocomplete
 * trigger rule (start of line, whitespace, or an opening bracket/quote). */
const MENTION_TOKEN_PATTERN = /(?:^|[\s([{<`])@(?:"([^"]+)"|([^\s"'`]+))/gu;
/** Sentence punctuation that can trail a mention: `see @src/a.ts, then`. */
const TRAILING_PUNCTUATION_PATTERN = /[,;:.?!)\]}]+$/u;

export type FileMention = {
  /** Absolute path on disk (used for the existence check / containment test). */
  resolvedPath: string;
  /** Path sent to the core: workspace-relative when inside the workspace. */
  path: string;
  /** Exact source text replaced by the mention, e.g. `@src/a.ts`. */
  placeholder: string;
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Relative POSIX path when the file lives inside the workspace, else absolute. */
const protocolPath = (resolvedPath: string, workspaceDirectory: string): string => {
  const inside = relative(workspaceDirectory, resolvedPath);
  if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) {
    return resolvedPath;
  }
  return inside.split(sep).join("/");
};

export const resolveFileMentions = (input: {
  text: string;
  workspaceDirectory: string;
}): FileMention[] => {
  const mentions: FileMention[] = [];
  const seen = new Set<string>();
  for (const match of input.text.matchAll(MENTION_TOKEN_PATTERN)) {
    const quoted = match[1];
    const bare = match[2];
    const token = quoted ?? bare;
    if (!token) continue;
    // Try the token verbatim first, then without trailing sentence punctuation.
    const candidates = [token];
    const trimmed = token.replace(TRAILING_PUNCTUATION_PATTERN, "");
    if (trimmed.length > 0 && trimmed !== token) candidates.push(trimmed);
    for (const candidate of candidates) {
      const resolvedPath = resolve(input.workspaceDirectory, candidate);
      if (!isFile(resolvedPath)) continue;
      if (seen.has(resolvedPath)) break;
      const placeholder = quoted
        ? `@"${quoted}"`
        : `@${candidate}`;
      if (!input.text.includes(placeholder)) continue;
      seen.add(resolvedPath);
      mentions.push({
        path: protocolPath(resolvedPath, input.workspaceDirectory),
        placeholder,
        resolvedPath,
      });
      break;
    }
  }
  return mentions;
};

/**
 * Draft attachments for a prompt: whatever the frontend already tracked plus
 * every resolvable `@path` in the text (deduplicated by path).
 */
export const appendFileMentions = (input: {
  text: string;
  existing: readonly DraftAttachment[];
  workspaceDirectory: string;
  allocateId: () => number;
}): DraftAttachment[] => {
  const known = new Set(
    input.existing
      .filter((attachment): attachment is DraftAttachment & { path: string } =>
        attachment.type === "file",
      )
      .map((attachment) => resolve(input.workspaceDirectory, attachment.path)),
  );
  const mentions = resolveFileMentions({
    text: input.text,
    workspaceDirectory: input.workspaceDirectory,
  }).filter((mention) => !known.has(mention.resolvedPath));
  if (mentions.length === 0) return [...input.existing];
  return [
    ...input.existing,
    ...mentions.map((mention) => ({
      id: input.allocateId(),
      path: mention.path,
      placeholder: mention.placeholder,
      type: "file" as const,
    })),
  ];
};
