// start() 后的纵深防御：到达 input 管线的"终端应答"序列一律静默丢弃。
//
// 背景：终端查询回复（OSC 10/11/4、DA、CPR、DCS、APC、DECRQM 等）只会作为
// 对我们查询的应答或终端噪声到达 stdin；键盘输入永远不会产生这些形态。
// pi-tui 只消费它自己挂着 query 时的回复，窗口之外到达的回复会一路落到
// composer 被当成按键文本回显（]10;rgb:… 乱码、^[[?1;2;4c）。
//
// 实现位置：包装传给 ProcessTerminal.start 的 onInput——位于 stdinBuffer
// 拆分之后、handleTerminalInput 之前；不改库内部（不 fork）。
// 注意不丢弃：\u001b[6;h;wt（queryCellSize 应答，lib 无条件消费）与
// \u001b[?997;{1,2}n（DEC 2031 配色上报，lib 无条件消费）——二者是特性路径。
// 权衡：\u001b[<n>;<m>R（CPR）与部分终端的修饰 F3 同形；按探针修复规格仍丢弃。

import { ProcessTerminal } from "@earendil-works/pi-tui";

// 控制字符经具名常量插值进 new RegExp：模式即终端应答序列，字面量形态
// 反而更不可读，且可避开 no-control-regex 对字面量的误伤式告警。
const BEL = "\x07";
const ESC = "\x1b";
const re = (body: string): RegExp => new RegExp(body);

const STRAY_RESPONSE_PATTERNS = [
  re(`^${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)$`), // OSC 回复（10/11/4;N/52/标题等）
  re(`^${ESC}P[\\s\\S]*?${ESC}\\\\$`), // DCS 回复（XTVersion、DECRQSS 等）
  re(`^${ESC}_G[\\s\\S]*?(?:${ESC}\\\\|${BEL})$`), // APC / kitty graphics 回复
  re(`^${ESC}\\[\\?[\\d;]*c$`), // DA1
  re(`^${ESC}\\[>[\\d;]*c$`), // DA2/DA3
  re(`^${ESC}\\[\\?\\d+(?:;\\d+)*y$`), // DECRQM
  re(`^${ESC}\\[\\d+;\\d+R$`), // CPR（修饰 F3 同形的已知权衡，见文件头注释）
];

/** 该序列是"无人等待的终端应答"，必须丢弃而不是当作键盘输入。 */
export const isStrayTerminalResponse = (data: string): boolean =>
  STRAY_RESPONSE_PATTERNS.some((pattern) => pattern.test(data));

/**
 * ProcessTerminal 薄子类：在 stdinBuffer → inputHandler 之间加一层
 * 应答序列丢弃。Kitty/DA 协商发生在 stdinBuffer 内部（更上游），不受影响；
 * lib 自身消费路径（cell-size、2031 上报）不在丢弃清单内，亦不受影响。
 */
export class QuietProcessTerminal extends ProcessTerminal {
  override start(
    onInput: (data: string) => void,
    onResize: () => void,
  ): void {
    super.start(
      (data) => {
        if (!isStrayTerminalResponse(data)) onInput(data);
      },
      onResize,
    );
  }
}
