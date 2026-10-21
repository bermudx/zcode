import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteAttachArgv } from "../src/attach/attach-argv.js";

test("attach 命令重写为 tui --tui-frontend=pi --shared-core", () => {
  assert.deepEqual(rewriteAttachArgv(["attach"]), [
    "tui",
    "--tui-frontend",
    "pi",
    "--shared-core",
  ]);
});

test("attach 后续 flag 原样透传", () => {
  assert.deepEqual(rewriteAttachArgv(["attach", "--cwd", "/tmp/x", "--no-color"]), [
    "tui",
    "--tui-frontend",
    "pi",
    "--shared-core",
    "--cwd",
    "/tmp/x",
    "--no-color",
  ]);
});

test("非 attach 命令不重写", () => {
  assert.deepEqual(rewriteAttachArgv(["tui", "--shared-core"]), [
    "tui",
    "--shared-core",
  ]);
  assert.deepEqual(rewriteAttachArgv(["--prompt", "hi"]), ["--prompt", "hi"]);
});

test("--attach 值型附件旗标不受影响", () => {
  // --attach 是多值 string（prompt 文件附件）：值形式必须原样保留，不能被 attach 语义吞掉。
  assert.deepEqual(
    rewriteAttachArgv(["--prompt", "x", "--attach", "a.png"]),
    ["--prompt", "x", "--attach", "a.png"],
  );
});
