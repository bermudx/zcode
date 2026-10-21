/**
 * tui-pi 标准调用示例：cli 的 --tui-frontend=pi 路径动态 import 本包后
 * 直接调用 runTui；调用方只准备 TuiOptions（含端口注入），不接触内部。
 */
import type { TuiOptions } from "@zcode/tui/internals";
import type { TuiPiContract } from "./contract.js";

export function exampleTuiPi(contract: TuiPiContract, options: TuiOptions): Promise<number> {
  return contract.runTui(options);
}
