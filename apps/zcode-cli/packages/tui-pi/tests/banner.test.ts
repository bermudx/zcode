// 启动横幅：logo + 版本 + 提示常驻转写顶端；model scope 行位恒占、
// 内容在 startup 选项到达前为空。

import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiModelOption } from "@zcode/tui/internals";
import { PiBanner } from "../src/banner.js";
import { createPiTheme } from "../src/theme.js";
import { createHarness } from "./harness.js";

const model = (modelId: string): TuiModelOption =>
  ({
    label: modelId,
    ref: { modelId, providerId: "zai" },
  }) as TuiModelOption;

test("banner renders the PIZ logo, version and key hints", () => {
  const theme = createPiTheme({ noColor: true });
  const lines = new PiBanner(theme, "9.9.9").render(80).map(stripTerminalSequences);
  assert.ok(lines.some((line) => line.includes("██████╗")), "block logo present");
  assert.ok(lines.some((line) => line.includes("piz v9.9.9")), "version present");
  assert.ok(lines.some((line) => line.includes("esc interrupt")), "hint line present");
});

test("model scope fills in once startup options arrive", () => {
  const theme = createPiTheme({ noColor: true });
  const banner = new PiBanner(theme, "1.0.0");
  assert.ok(
    !banner.render(80).some((line) => line.includes("models:")),
    "no scope before models land",
  );
  banner.setModels([model("glm-5.3"), model("deep-v4")]);
  assert.ok(
    banner.render(80).some((line) => line.includes("models: glm-5.3, deep-v4")),
    "scope lists model ids",
  );
});

test("banner lines never exceed the render width", () => {
  const theme = createPiTheme({ noColor: false });
  const banner = new PiBanner(theme, "1.0.0");
  banner.setModels([model("glm-5.3"), model("glm-5.3-flash"), model("deep-v4")]);
  for (const line of banner.render(24)) assert.ok(visibleWidth(line) <= 24);
});

test("applyStartupOptions feeds modelOptions into the banner", async () => {
  const h = createHarness({ version: "1.2.3" });
  try {
    h.resetOutput();
    await h.app.applyStartupOptions({ modelOptions: [model("glm-5.3")] });
    await h.flush();
    assert.match(h.output(), /models: glm-5\.3/);
    assert.match(h.output(), /piz v1\.2\.3/);
  } finally {
    await h.stop();
  }
});
