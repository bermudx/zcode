import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteAttachArgv } from "../src/attach/attach-argv.js";
import { parseAttachEntryArgs } from "../src/attach/attach-entry-args.js";

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

test("`acp` 子命令先于旗标解析：其余旗标不参与 ACP 模式", () => {
  const parsed = parseAttachEntryArgs(["acp"]);
  assert.equal(parsed.action, "acp");
  assert.equal(parsed.initialModel, undefined);
  assert.equal(parsed.resume.continueSession, false);
  // 编辑器只传 `acp`；即便混入 attach 旗标也不该被当成 attach 启动参数。
  const mixed = parseAttachEntryArgs(["acp", "--resume", "sess-1"]);
  assert.equal(mixed.action, "acp");
  assert.equal(mixed.resume.resumeSessionId, undefined);
});

test("`acp` 只在子命令位生效，不作为旗标值被吞掉", () => {
  // --model acp 是模型名，不是子命令。
  const parsed = parseAttachEntryArgs(["--model", "acp"]);
  assert.equal(parsed.action, undefined);
  assert.equal(parsed.initialModel, "acp");
  assert.equal(parseAttachEntryArgs(["--help"]).action, "help");
});
