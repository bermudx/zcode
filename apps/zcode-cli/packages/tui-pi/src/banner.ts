// 启动横幅：PIZ 方块字 logo（与 React 前端 ZCODE idle logo 同一字族），
// 版本、按键提示与 model scope 行在 logo 右侧排布；挂在 transcript 之前，
// 像 pi 自己的横幅一样随历史向上滚走。modelOptions 经 startup 异步到达，
// 到达前该行留空，横幅高度不变。

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { TuiModelOption } from "@zcode/tui/internals";
import type { PiTheme } from "./theme.js";

const PIZ_LOGO_LINES = [
  "██████╗ ██╗███████╗",
  "██╔══██╗██║╚══███╔╝",
  "██████╔╝██║  ███╔╝ ",
  "██╔═══╝ ██║ ███╔╝  ",
  "██║     ██║███████╗",
  "╚═╝     ╚═╝╚══════╝",
] as const;

const LOGO_WIDTH = 19;
const INFO_GAP = "   ";
const HINT_LINE_1 = "esc interrupt · ctrl+c/d clear/exit · shift+tab mode · ctrl+o info";
const HINT_LINE_2 = "/ commands · ! shell · ctrl+p/l models · ctrl+x/n/t copy/new/think";

export class PiBanner implements Component {
  private models: readonly TuiModelOption[] = [];

  constructor(
    private readonly theme: PiTheme,
    private readonly version: string | undefined,
  ) {}

  setModels(models: readonly TuiModelOption[]): void {
    this.models = models;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.theme;
    const info: string[] = [
      "",
      `${theme.bold("piz")}${this.version ? ` ${theme.muted(`v${this.version}`)}` : ""}`,
      theme.muted(HINT_LINE_1),
      theme.muted(HINT_LINE_2),
      theme.muted(this.modelScope()),
      "",
    ];
    const lines = PIZ_LOGO_LINES.map(
      (logo, index) => `${theme.accent(logo)}${INFO_GAP}${info[index] ?? ""}`,
    );
    // 任何行超宽都会让 doRender 抛错；窄终端截断而不是折行。
    return ["", ...lines.map((line) => truncateToWidth(line, Math.max(1, width))), ""];
  }

  private modelScope(): string {
    if (this.models.length === 0) return "";
    const labels = this.models.map((model) => model.ref.modelId || model.label);
    return `models: ${labels.join(", ")}`;
  }
}

export { LOGO_WIDTH, PIZ_LOGO_LINES };
