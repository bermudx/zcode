import {
  getTerminalColorMode,
  parseColor,
  styleText,
  type SelectListTheme,
  type TerminalColorMode,
  type TextStyle,
} from "@earendil-works/pi-tui";
import type { TuiThemeTokens } from "@zcode/tui/internals";
import { activeTuiTheme } from "@zcode/tui/internals";

export type Style = (text: string) => string;

type TokenKey = keyof TuiThemeTokens;

const IDENTITY: Style = (text) => text;

export type PiTheme = {
  accent: Style;
  border: Style;
  danger: Style;
  dim: Style;
  muted: Style;
  panel: Style;
  success: Style;
  text: Style;
  userBg: Style;
  warning: Style;
  bold: Style;
  selectList: SelectListTheme;
  tokens: TuiThemeTokens;
};

export const createPiTheme = (input: {
  colorMode?: TerminalColorMode;
  noColor?: boolean;
}): PiTheme => {
  const tokens = activeTuiTheme();

  if (input.noColor) {
    return {
      accent: IDENTITY,
      bold: IDENTITY,
      border: IDENTITY,
      danger: IDENTITY,
      dim: IDENTITY,
      muted: IDENTITY,
      panel: IDENTITY,
      selectList: {
        description: IDENTITY,
        noMatch: IDENTITY,
        scrollInfo: IDENTITY,
        selectedPrefix: IDENTITY,
        selectedText: IDENTITY,
      },
      success: IDENTITY,
      text: IDENTITY,
      tokens,
      userBg: IDENTITY,
      warning: IDENTITY,
    };
  }

  const mode = input.colorMode ?? getTerminalColorMode();
  const paint =
    (token: TokenKey, attrs?: TextStyle): Style =>
    (text) =>
      styleText(text, { ...attrs, fg: parseColor(tokens[token]) }, mode);

  const accent = paint("accent");
  const muted = paint("textMuted");
  return {
    accent,
    bold: (text) => styleText(text, { bold: true }, mode),
    border: paint("border"),
    danger: paint("error"),
    dim: (text) => styleText(text, { dim: true }, mode),
    muted,
    panel: paint("backgroundPanel"),
    selectList: {
      description: muted,
      noMatch: muted,
      scrollInfo: muted,
      selectedPrefix: accent,
      selectedText: paint("selectedListItemText"),
    },
    success: paint("success"),
    text: paint("text"),
    tokens,
    userBg: (text) => styleText(text, { bg: parseColor(tokens.backgroundMessageUser) }, mode),
    warning: paint("warning"),
  };
};
