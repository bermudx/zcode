// responding-pty 测试的子进程 fixture：在 script(1) 的 pty 里跑真实 runPiTui。
// 父进程扮演终端——看见查询字节后回 OSC 10/11、OSC 4 全套与 DA 哨兵，
// 并在渲染完成后补发迟到回复；断言任何回复字节都不被回显/渲染。

import type { TuiOptions } from "@zcode/tui/internals";
import { runPiTui } from "../../src/run-tui.js";

const options = {
  argv: [],
  force: false,
  json: false,
  locale: "en-US",
  noColor: true,
  stderr: process.stderr,
  stdin: process.stdin,
  stdout: process.stdout,
  submitPrompt: async () => ({ response: "" }),
  verbose: false,
} as unknown as TuiOptions;

void runPiTui(options).then((code) => {
  process.exitCode = code;
});
