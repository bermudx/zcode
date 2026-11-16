import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { REQUIRED_BUILD_ARTIFACTS } from "../../../scripts/fork-tests.mjs";

// CI 的 check job 跨 run 缓存并回放 turbo 任务输出（docs/fork/verification.md）。
// browser-use 的构建把 browser client 写到 scripts/browser-client.mjs（dist/ 之外，
// 且被 .gitignore 忽略），generic build 任务只声明 dist/** —— 缓存命中回放的新
// checkout 因此缺这个文件，build-sea 的官方插件资产断言随之失败（issue #85）。
// 这里钉住不变量：测试必需的生成产物必须要么已入库，要么落在声明的 build outputs 里。
const cliWorkspaceRoot = resolve(import.meta.dirname, "..", "..", "..");
const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..", "..");

const readTurboTasks = async () =>
  JSON.parse(await readFile(join(cliWorkspaceRoot, "turbo.json"), "utf8")).tasks ?? {};

// 只需要覆盖 turbo outputs 的两种既有写法：字面路径与 `dir/**`。
const outputPatternMatches = (pattern, relativePath) => {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`).test(relativePath);
};

const isCommitted = (relativePath) =>
  spawnSync("git", ["ls-files", "--", relativePath], { cwd: repoRoot, encoding: "utf8" })
    .stdout.trim()
    .length > 0;

// apps/zcode-cli/packages/<dir>/<rest> → 用该包的 package name 查包级覆盖，
// 没有覆盖时回落到 generic build 任务。
const coveredByBuildOutputs = async (tasks, workspaceRelativePath) => {
  const [, packageDirectory, ...rest] = workspaceRelativePath.split("/");
  if (packageDirectory === undefined || rest.length === 0) return false;
  const packageRoot = join(cliWorkspaceRoot, "packages", packageDirectory);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const task = tasks[`${manifest.name}#build`] ?? tasks.build;
  const pathInsidePackage = rest.join("/");
  return (task?.outputs ?? []).some((pattern) => outputPatternMatches(pattern, pathInsidePackage));
};

test("browser-use build declares its generated browser client as a turbo output", async () => {
  const tasks = await readTurboTasks();
  const task = tasks["@zcode/browser-use-plugin#build"] ?? tasks.build;
  assert.ok(task, "apps/zcode-cli/turbo.json must define a build task");
  assert.ok(
    task.outputs.includes("scripts/browser-client.mjs"),
    "turbo cache hits must restore scripts/browser-client.mjs; declare it in the build task outputs (issue #85)",
  );
  assert.ok(
    task.outputs.includes("dist/**"),
    "a package-specific build override must keep caching dist/**",
  );
});

test("required CLI build artifacts are committed or covered by turbo build outputs", async () => {
  const tasks = await readTurboTasks();
  for (const artifact of REQUIRED_BUILD_ARTIFACTS) {
    // 根 workspace 产物（packages/shared 等）不经过 apps/zcode-cli 的 turbo 图，
    // CI 用独立的 tsc -b / pnpm 步骤构建，这里只约束 CLI workspace 内的条目。
    if (!artifact.startsWith("apps/zcode-cli/")) continue;
    if (isCommitted(artifact)) continue;
    assert.ok(
      await coveredByBuildOutputs(tasks, artifact.slice("apps/zcode-cli/".length)),
      `${artifact} is neither committed nor a declared turbo build output — ` +
        "a cache-hit CI build restores a tree without it (issue #85)",
    );
  }
});
