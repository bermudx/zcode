import {
  getTerminalColorMode,
  parseColor,
  styleText,
  type MarkdownTheme,
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
  markdown: MarkdownTheme;
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
      markdown: {
        bold: IDENTITY,
        code: IDENTITY,
        codeBlock: IDENTITY,
        codeBlockBorder: IDENTITY,
        heading: IDENTITY,
        hr: IDENTITY,
        italic: IDENTITY,
        link: IDENTITY,
        linkUrl: IDENTITY,
        listBullet: IDENTITY,
        quote: IDENTITY,
        quoteBorder: IDENTITY,
        strikethrough: IDENTITY,
        underline: IDENTITY,
      },
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
  const paintOn =
    (fg: TokenKey, bg: TokenKey, attrs?: TextStyle): Style =>
    (text) =>
      styleText(
        text,
        { ...attrs, bg: parseColor(tokens[bg]), fg: parseColor(tokens[fg]) },
        mode,
      );

  const accent = paint("accent");
  const muted = paint("textMuted");
  return {
    accent,
    bold: (text) => styleText(text, { bold: true }, mode),
    border: paint("border"),
    danger: paint("error"),
    dim: (text) => styleText(text, { dim: true }, mode),
    // markdown* 记号与 React 前端 app-markdown-theme.ts 的映射保持一致；
    // 终端没有字号，heading/strong 用 bold 属性表达层级。
    markdown: {
      bold: paint("markdownStrong", { bold: true }),
      code: paintOn("markdownCode", "backgroundPanel"),
      codeBlock: paint("markdownCodeBlock"),
      codeBlockBorder: paint("markdownHorizontalRule"),
      heading: paint("markdownHeading", { bold: true }),
      hr: paint("markdownHorizontalRule"),
      italic: paint("markdownEmph", { italic: true }),
      link: paint("markdownLinkText", { underline: true }),
      linkUrl: paint("markdownLink", { underline: true }),
      listBullet: paint("markdownListItem"),
      quote: paint("markdownBlockQuote", { italic: true }),
      quoteBorder: paint("markdownHorizontalRule"),
      // underline/strikethrough 只叠加属性不带色：pi-tui 在 h1 和 link 内
      // 嵌套调用 underline()，带 fg 会把 heading/link 的颜色顶掉。
      strikethrough: (text) => styleText(text, { strikethrough: true }, mode),
      underline: (text) => styleText(text, { underline: true }, mode),
    },
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
