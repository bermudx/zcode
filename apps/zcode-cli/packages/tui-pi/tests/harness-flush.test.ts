// harness.flush 的轮询语义回归（P003-F1）：flush 不再是固定 40ms sleep，
// 而是「等待条件成立 + 渲染 settle」的条件轮询（硬超时 + 明确报错）。固定
// sleep 在跨进程边界（`!cmd` 子进程）超过预算时让断言偶发失败——这里直接
// 锁定语义本身：晚于任何固定预算才变真的条件也必须等到。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./harness.js";

test("flush waits for a condition that becomes true after any fixed budget", async () => {
  const h = createHarness();
  try {
    let condition = false;
    // 120ms：超过旧实现 40ms sleep 的三倍，固定预算必然漏掉。
    setTimeout(() => {
      condition = true;
    }, 120);
    const startedAt = Date.now();
    await h.flush(() => condition);
    assert.equal(condition, true, "flush must not return before the condition holds");
    assert.ok(Date.now() - startedAt >= 100, "flush must have waited for the late condition");
  } finally {
    await h.stop();
  }
});

test("flush fails loud with an informative error at the deadline", async () => {
  const h = createHarness();
  try {
    await assert.rejects(
      h.flush(() => false, 150),
      /flush\(\) timed out after 150ms/,
      "an unsatisfiable condition must surface a deadline error, not a silent return",
    );
  } finally {
    await h.stop();
  }
});

test("flush without a condition settles once pending renders fired", async () => {
  const h = createHarness();
  try {
    // 现有 91 处 flush() 无参调用方的默认路径：触发一次同步状态变更 + 渲染，
    // flush 必须等到该渲染落地（输出里能看到）才返回。
    h.store.set("status", "flush-default-probe");
    await h.flush();
    assert.ok(
      h.output().includes("flush-default-probe"),
      "flush() must return after the pending render reached the terminal",
    );
  } finally {
    await h.stop();
  }
});
