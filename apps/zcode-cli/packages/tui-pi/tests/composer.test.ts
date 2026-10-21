// Draft command parsing: slash commands map to pi SlashCommand entries and
// /model /effort /mode expose argument completions from live option lists —
// the pi equivalent of the React frontend's draft suggestion panels.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiEffortOption, TuiModelOption } from "@zcode/tui/internals";
import { toPiSlashCommands } from "../src/composer.js";

const commands = () =>
  [
    { name: "model", summary: "Switch model", usage: "/model <provider/model>" },
    { name: "effort", summary: "Set effort", usage: "/effort <level>" },
    { name: "mode", summary: "Switch mode", usage: "/mode <mode>" },
    { name: "help", summary: "Show help", usage: "/help" },
  ] as never;

const models = (): readonly TuiModelOption[] =>
  [
    { label: "Alpha", ref: { modelId: "alpha", providerId: "prov" } },
    { label: "Beta", ref: { modelId: "beta", providerId: "prov" } },
  ] as never;

const efforts = (): readonly TuiEffortOption[] =>
  [
    { id: "high", label: "High" },
    { id: "low", label: "Low" },
  ] as never;

test("slash commands map name/summary/argumentHint", () => {
  const mapped = toPiSlashCommands(commands(), models, efforts)!;
  const model = mapped.find((command) => command.name === "model")!;
  assert.equal(model.description, "Switch model");
  assert.equal(model.argumentHint, "<provider/model>");
  const help = mapped.find((command) => command.name === "help")!;
  assert.equal(help.argumentHint, undefined);
});

test("/model argument completions filter live model options", () => {
  const mapped = toPiSlashCommands(commands(), models, efforts)!;
  const model = mapped.find((command) => command.name === "model")!;
  const all = model.getArgumentCompletions!("");
  assert.equal(all.length, 2);
  const filtered = model.getArgumentCompletions!("beta");
  assert.deepEqual(
    filtered.map((item) => item.value),
    ["prov/beta"],
  );
});

test("/effort and /mode expose their argument domains", () => {
  const mapped = toPiSlashCommands(commands(), models, efforts)!;
  const effort = mapped.find((command) => command.name === "effort")!;
  assert.deepEqual(
    effort.getArgumentCompletions!("h").map((item) => item.value),
    ["high"],
  );
  const mode = mapped.find((command) => command.name === "mode")!;
  const modes = mode.getArgumentCompletions!("").map((item) => item.value);
  assert.deepEqual(modes, ["plan", "build", "guarded", "yolo"]);
  assert.deepEqual(
    mode.getArgumentCompletions!("y").map((item) => item.value),
    ["yolo"],
  );
});

test("commands without argument domains have no completions", () => {
  const mapped = toPiSlashCommands(commands(), models, efforts)!;
  const help = mapped.find((command) => command.name === "help")!;
  assert.equal(help.getArgumentCompletions, undefined);
});

test("empty command list yields undefined", () => {
  assert.equal(toPiSlashCommands([], models, efforts), undefined);
  assert.equal(toPiSlashCommands(undefined, models, efforts), undefined);
});
