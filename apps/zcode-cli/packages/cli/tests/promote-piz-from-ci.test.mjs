import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const promoter = resolve(import.meta.dirname, "../../../scripts/promote-piz-from-ci.sh");
const realMv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
const runtimeFiles = [
  "zcode.cjs",
  "zcode-attach.cjs",
  "node_modules/@zcode/tui/package.json",
  "node_modules/@zcode/tui/dist/index.js",
  "node_modules/@zcode/tui-pi/package.json",
  "node_modules/@zcode/tui-pi/dist/index.js",
];

// git 与安装目录使用真实隔离文件；只有 GitHub 边界是 fixture，不冒充线上验证。
async function fixture({ sameCommit = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "piz-ci-promotion-"));
  const root = join(directory, "checkout");
  const bin = join(directory, "bin");
  const artifact = join(directory, "artifact");
  const metadataPath = join(directory, "run.json");
  const downloads = join(directory, "downloads");
  const cli = join(root, "apps/zcode-cli/packages/cli");
  const runtime = join(cli, "dist-runtime");
  await mkdir(root);
  await mkdir(bin);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Promotion fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  await writeFile(join(root, "source.txt"), "verified source\n");
  git("add", "source.txt");
  git("commit", "-m", "build source");
  const buildSha = git("rev-parse", "HEAD");
  if (!sameCommit) git("commit", "--allow-empty", "-m", "same tree, different commit");
  const mainSha = git("rev-parse", "HEAD");
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, "zcode.cjs"), "previous installed core");
  for (const file of runtimeFiles) {
    await mkdir(dirname(join(artifact, file)), { recursive: true });
    await writeFile(join(artifact, file), `verified ${file}`);
  }
  await writeFile(join(artifact, "PROMOTED_FROM"), `${buildSha}\n`);
  const metadata = {
    buildSha, status: "completed", conclusion: "success",
    event: "workflow_dispatch", path: ".github/workflows/ci.yml",
  };
  await writeFile(metadataPath, JSON.stringify(metadata));
  const gh = join(bin, "gh");
  await writeFile(gh, `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
const env = process.env;
const info = JSON.parse(fs.readFileSync(env.FIXTURE_METADATA, "utf8"));
if (args[0] === "api") {
  console.log([info.buildSha, info.status, info.conclusion, info.event, info.path].join("\\t"));
} else if (args[0] === "run" && args[1] === "list") {
  console.log("123");
} else if (args[0] === "run" && args[1] === "download") {
  fs.appendFileSync(env.FIXTURE_DOWNLOADS, args.join(" ") + "\\n");
  if (info.downloadFailure) process.exit(1);
  if (args[args.indexOf("--name") + 1] !== "dist-runtime-" + info.buildSha) process.exit(2);
  fs.cpSync(info.artifact ?? env.FIXTURE_ARTIFACT, args[args.indexOf("--dir") + 1], { recursive: true });
  if (info.advanceMain) {
    const result = cp.spawnSync("git", ["commit", "--allow-empty", "-m", "concurrent main advance"], { cwd: env.FIXTURE_ROOT });
    if (result.status !== 0) process.exit(3);
  }
} else {
  process.exit(4);
}
`);
  await chmod(gh, 0o755);
  const mv = join(bin, "mv");
  await writeFile(mv, `#!${process.execPath}
const cp = require("node:child_process");
const args = process.argv.slice(2);
if (process.env.FIXTURE_FAIL_INSTALL === "1" && args[1] === process.env.FIXTURE_RUNTIME && !args[0].endsWith(".rollback")) process.exit(1);
const result = cp.spawnSync(process.env.FIXTURE_REAL_MV, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
  await chmod(mv, 0o755);
  return {
    root, cli, artifact, runtime, buildSha, mainSha, metadata, downloads, git,
    async updateMetadata(changes) {
      Object.assign(metadata, changes);
      await writeFile(metadataPath, JSON.stringify(metadata));
    },
    promote({ discover = false, failInstall = false } = {}) {
      return spawnSync("sh", [promoter, ...(discover ? [] : ["123"]), "--repo-root", root], {
        encoding: "utf8",
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`,
          FIXTURE_METADATA: metadataPath, FIXTURE_ARTIFACT: artifact,
          FIXTURE_DOWNLOADS: downloads, FIXTURE_ROOT: root,
          FIXTURE_RUNTIME: runtime, FIXTURE_REAL_MV: realMv,
          FIXTURE_FAIL_INSTALL: failInstall ? "1" : "0",
        },
      });
    },
  };
}

async function assertPreviousRuntime(f) {
  assert.equal(await readFile(join(f.runtime, "zcode.cjs"), "utf8"), "previous installed core");
}

test("promotion reuses an identical tree without relabeling the original CI build", async () => {
  const f = await fixture();
  assert.notEqual(f.buildSha, f.mainSha);
  assert.equal(f.git("rev-parse", `${f.buildSha}^{tree}`), f.git("rev-parse", "HEAD^{tree}"));
  const result = f.promote();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.runtime, "PROMOTED_FROM"), "utf8"), `${f.buildSha}\n`);
  assert.equal(await readFile(join(f.runtime, "PROMOTED_ON"), "utf8"), `${f.mainSha}\n`);
  assert.equal(await readFile(join(f.runtime, "PROMOTED_CI_RUN"), "utf8"), "123\n");
  for (const file of runtimeFiles) {
    assert.equal(await readFile(join(f.runtime, file), "utf8"), `verified ${file}`);
  }
  const backups = (await readdir(f.cli)).filter((name) => name.endsWith(".rollback"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(f.cli, backups[0], "zcode.cjs"), "utf8"), "previous installed core");
});

test("promotion still discovers a successful run for the exact main commit", async () => {
  const f = await fixture({ sameCommit: true });
  const result = f.promote({ discover: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.runtime, "PROMOTED_FROM"), "utf8"), `${f.mainSha}\n`);
});

test("promotion rejects any changed tree before downloading the artifact", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "source.txt"), "different source\n");
  f.git("commit", "-am", "change source");
  const result = f.promote();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from main tree/);
  await assert.rejects(readFile(f.downloads), { code: "ENOENT" });
  await assertPreviousRuntime(f);
});

for (const [name, changes] of [
  ["failed run", { conclusion: "failure" }],
  ["unfinished run", { status: "in_progress" }],
  ["push without full gate", { event: "push" }],
  ["different workflow", { path: ".github/workflows/other.yml" }],
  ["malformed SHA", { buildSha: "not-a-sha" }],
  ["unavailable commit", { buildSha: "f".repeat(40) }],
]) {
  test(`promotion rejects ${name} without touching the installed runtime`, async () => {
    const f = await fixture();
    await f.updateMetadata(changes);
    assert.notEqual(f.promote().status, 0);
    await assert.rejects(readFile(f.downloads), { code: "ENOENT" });
    await assertPreviousRuntime(f);
  });
}

for (const staged of [false, true]) {
  test(`promotion rejects ${staged ? "staged" : "unstaged"} tracked changes`, async () => {
    const f = await fixture();
    await writeFile(join(f.root, "source.txt"), "dirty source\n");
    if (staged) f.git("add", "source.txt");
    assert.match(f.promote().stderr, /tracked files differ/);
    await assertPreviousRuntime(f);
  });
}

test("promotion rejects a non-main target even when its tree is identical", async () => {
  const f = await fixture();
  f.git("switch", "-c", "feature");
  assert.match(f.promote().stderr, /not main/);
  await assertPreviousRuntime(f);
});

test("promotion rejects an artifact with a mismatched build marker", async () => {
  const f = await fixture();
  await writeFile(join(f.artifact, "PROMOTED_FROM"), `${f.mainSha}\n`);
  assert.match(f.promote().stderr, /artifact PROMOTED_FROM is not/);
  await assertPreviousRuntime(f);
});

test("promotion rejects an incomplete matched runtime", async () => {
  const f = await fixture();
  const incomplete = await mkdtemp(join(tmpdir(), "piz-incomplete-artifact-"));
  await cp(join(f.artifact, "PROMOTED_FROM"), join(incomplete, "PROMOTED_FROM"));
  // 不删除 fixture 文件；下载只含 provenance 的独立目录。
  await f.updateMetadata({ artifact: incomplete });
  const result = f.promote();
  assert.match(result.stderr, /artifact missing zcode-attach.cjs/);
  await assertPreviousRuntime(f);
});

test("promotion preserves the previous pair when downloading fails", async () => {
  const f = await fixture();
  await f.updateMetadata({ downloadFailure: true });
  const result = f.promote();
  assert.match(result.stderr, /artifact .* not found/);
  await assertPreviousRuntime(f);
});

test("promotion refuses to swap if main advances during download", async () => {
  const f = await fixture();
  await f.updateMetadata({ advanceMain: true });
  assert.match(f.promote().stderr, /main changed during artifact download/);
  await assertPreviousRuntime(f);
});

test("promotion restores the previous pair if the final rename fails", async () => {
  const f = await fixture();
  const result = f.promote({ failInstall: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /previous runtime restored/);
  await assertPreviousRuntime(f);
});
