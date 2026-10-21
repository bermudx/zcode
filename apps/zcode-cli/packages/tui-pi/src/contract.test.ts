import assert from "node:assert/strict";
import { test } from "node:test";

import { tuiPiModule } from "./module.js";
import { runPiTui } from "./run-tui.js";

// 契约工件自检（node:test；本包测试套件在 tests/ 下运行，本文件只随
// tsc 编译校验形态）。只 import module 与公共入口，不触达内部实现。
test("tui-pi contract declares its module manifest and public entrypoint", () => {
  assert.equal(tuiPiModule.id, "tui-pi");
  assert.deepEqual([...tuiPiModule.requires], ["shared", "zcode-cli"]);
  assert.equal(typeof runPiTui, "function");
});
