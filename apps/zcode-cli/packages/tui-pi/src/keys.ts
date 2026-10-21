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

const PASTE_START_MARKER = "\x1b[200~";
const PASTE_END_MARKER = "\x1b[201~";

// pi-tui 把终端 bracketed paste 重包 \x1b[200~…\x1b[201~ 标记后经普通输入通道
// 发给焦点组件（React 端走独立 paste 事件）。这里拆标记并按 React 端
// pastedInputText 同样的过滤（只保留可打印字符）还原成逐字流；空数组也算
// 一次粘贴，调用方照样消费掉。
export const pastedCharsFromInput = (data: string): string[] | undefined => {
  if (!data.startsWith(PASTE_START_MARKER) || !data.endsWith(PASTE_END_MARKER)) return undefined;
  const inner = data.slice(PASTE_START_MARKER.length, data.length - PASTE_END_MARKER.length);
  return [...inner].filter((char) => char >= " " && char !== "\x7f");
};

// 与 keyEventFromInput 的可打印单字符分支同形：name 取未加 shift 的小写键名，
// shift 表达大小写；空格走 space 分支。共享 handler 的 printableKey 按
// name === "space" / name.length === 1 / sequence 兜底取值。
export const keyEventForChar = (char: string): KeyEvent => {
  if (char === " ")
    return makeKey({ name: "space", raw: " ", sequence: " " }) as unknown as KeyEvent;
  return makeKey({
    name: char.toLowerCase(),
    raw: char,
    sequence: char,
    shift: char !== char.toLowerCase(),
  }) as unknown as KeyEvent;
};

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
