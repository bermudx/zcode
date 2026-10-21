// Translate pi-tui raw input into the ParsedKey shape the shared keyboard
// handlers (`handleApprovalKey`, `handleSelectionKey`, `handleQuestionKey`)
// consume. Only the fields they read matter: name, ctrl, meta, shift, sequence.

import { matchesKey } from "@earendil-works/pi-tui";
import type { KeyEvent, ParsedKey } from "@mbears/opentui-core";

const NAMED_KEYS = [
  ["escape", "escape"],
  ["up", "up"],
  ["down", "down"],
  ["left", "left"],
  ["right", "right"],
  ["return", "return"],
  ["backspace", "backspace"],
  ["pageUp", "pageup"],
  ["pageDown", "pagedown"],
  ["home", "home"],
  ["end", "end"],
  ["delete", "delete"],
  ["insert", "insert"],
  ["f1", "f1"],
  ["f2", "f2"],
  ["f3", "f3"],
  ["f4", "f4"],
] as const;

const makeKey = (input: {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
  raw?: string;
}): ParsedKey => ({
  ctrl: input.ctrl ?? false,
  eventType: "press",
  meta: input.meta ?? false,
  name: input.name,
  number: false,
  option: false,
  raw: input.raw ?? input.sequence ?? "",
  sequence: input.sequence ?? "",
  shift: input.shift ?? false,
  source: "raw",
});

export const keyEventFromInput = (data: string): KeyEvent | undefined => {
  if (matchesKey(data, "shift+tab"))
    return makeKey({ name: "tab", raw: data, shift: true }) as unknown as KeyEvent;
  if (matchesKey(data, "tab")) return makeKey({ name: "tab", raw: data }) as unknown as KeyEvent;
  if (matchesKey(data, "space"))
    return makeKey({ name: "space", raw: data, sequence: " " }) as unknown as KeyEvent;

  for (const [piName, name] of NAMED_KEYS) {
    if (matchesKey(data, piName)) return makeKey({ name, raw: data }) as unknown as KeyEvent;
  }

  // ctrl+a..z arrives as a single control byte (except \t \r \x1b already handled).
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return makeKey({
        ctrl: true,
        name: String.fromCharCode(code + 96),
        raw: data,
      }) as unknown as KeyEvent;
    }
  }

  // Printable input: single chars and multi-char runs (fast typing / IME bursts).
  // opentui semantics: `name` is the unshifted key (letters lowercase), `shift`
  // carries case — shared handlers compare `key.name === "o"` literally and
  // re-apply shift themselves via printableKey().
  if (data.length > 0 && [...data].every((c) => c >= " " && c !== "\x7f")) {
    const single = data.length === 1;
    return makeKey({
      name: single ? data.toLowerCase() : "",
      raw: data,
      sequence: data,
      shift: single && data !== data.toLowerCase(),
    }) as unknown as KeyEvent;
  }
  return undefined;
};
