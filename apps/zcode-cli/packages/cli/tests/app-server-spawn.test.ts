import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appServerInfoSchema } from "@zcode/shared";
import {
  ensureServer,
  probeSocket,
  resolveSocketPath,
} from "../src/app-server-spawn.js";

const temporaryDirectories: string[] = [];
const spawnedPids: number[] = [];

test.afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 测试 server 可能已退出 */
    }
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-app-server-spawn-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** 记录并登记 spawn 出的假 server pid，保证测试结束全部回收。 */
async function ensureTestServer(
  options: Parameters<typeof ensureServer>[0],
): Promise<Awaited<ReturnType<typeof ensureServer>>> {
  const result = await ensureServer(options);
  if (result.pid !== undefined) spawnedPids.push(result.pid);
  return result;
}

/** 假 server：按 --socket 参数 bind 一个 unix socket 并自登记 .pid/.info（与真 server
 *  的 listen 后自登记合同一致：bind 成功者才是 owner），随后保持进程存活。 */
async function writeFakeServerScript(directory: string): Promise<string> {
  const scriptPath = join(directory, "fake-app-server.mjs");
  await writeFile(
    scriptPath,
    `import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
const socketIndex = process.argv.indexOf("--socket");
const socketPath = process.argv[socketIndex + 1];
const identityIndex = process.argv.indexOf("--cwd");
const identity = identityIndex >= 0 ? process.argv[identityIndex + 1] : process.env.ZCODE_WORKSPACE_IDENTITY;
const versionIndex = process.argv.indexOf("--version");
const version = versionIndex >= 0 ? process.argv[versionIndex + 1] : "9.9.9-test";
const server = createServer((socket) => socket.end());
server.listen(socketPath, async () => {
  await writeFile(socketPath + ".pid", process.pid + "\\n", "utf8");
  await writeFile(socketPath + ".info", JSON.stringify({
    version: version || "9.9.9-test",
    workspaceIdentity: identity || "/workspace/demo",
    startedAt: new Date().toISOString(),
  }), "utf8");
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
  );
  return scriptPath;
}

function fakeSpawnSpec(scriptPath: string) {
  return { file: process.execPath, argsPrefix: [scriptPath] } as const;
}

const workspace = { workspacePath: "/workspace/demo" };

test("resolveSocketPath derives core-<sha256[:16]>.sock under <dataBaseDir>/.zcode/v2/sockets", async () => {
  const base = await temporaryDirectory();
  const socketPath = resolveSocketPath(workspace, { dataBaseDir: base });
  const expectedHash = createHash("sha256")
    .update("/workspace/demo")
    .digest("hex")
    .slice(0, 16);
  assert.equal(
    socketPath,
    join(base, ".zcode", "v2", "sockets", `core-${expectedHash}.sock`),
  );
});

test("resolveSocketPath hashes workspaceIdentity when present", async () => {
  const base = await temporaryDirectory();
  const socketPath = resolveSocketPath(
    { workspacePath: "/workspace/demo", workspaceIdentity: "remote:ws-1" },
    { dataBaseDir: base },
  );
  const expectedHash = createHash("sha256")
    .update("remote:ws-1")
    .digest("hex")
    .slice(0, 16);
  assert.ok(socketPath.endsWith(`core-${expectedHash}.sock`));
  assert.notEqual(
    socketPath,
    resolveSocketPath(workspace, { dataBaseDir: base }),
  );
});

test("resolveSocketPath uses a named pipe on win32", async () => {
  const socketPath = resolveSocketPath(workspace, {
    dataBaseDir: "/unused",
    platform: "win32",
  });
  assert.match(socketPath, /^\\\\\.\\pipe\\zcode-core-[0-9a-f]{16}$/);
});

test("ensureServer spawns a detached server, writes .pid/.info, and reuses a live socket", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-test.sock");
  const scriptPath = await writeFakeServerScript(directory);

  const result = await ensureTestServer({
    workspace,
    socketPath,
    env: {},
    spawnSpec: fakeSpawnSpec(scriptPath),
    version: "9.9.9-test",
    waitForSocketMs: 10_000,
  });
  assert.equal(result.started, true);
  assert.equal(result.socketPath, socketPath);
  assert.ok(result.pid && result.pid > 0);

  const pidFile = (await readFile(`${socketPath}.pid`, "utf8")).trim();
  assert.equal(pidFile, String(result.pid));
  const info = appServerInfoSchema.parse(
    JSON.parse(await readFile(`${socketPath}.info`, "utf8")),
  );
  assert.equal(info.version, "9.9.9-test");
  assert.equal(info.workspaceIdentity, "/workspace/demo");
  assert.ok(!Number.isNaN(Date.parse(info.startedAt)));

  const reused = await ensureServer({
    workspace,
    socketPath,
    env: {},
    spawnSpec: fakeSpawnSpec(scriptPath),
  });
  assert.equal(reused.started, false);
  assert.equal(reused.pid, undefined);
});

test("concurrent ensureServer callers spawn exactly one server", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-race.sock");
  const scriptPath = await writeFakeServerScript(directory);
  const options = {
    workspace,
    socketPath,
    env: {},
    spawnSpec: fakeSpawnSpec(scriptPath),
    waitForSocketMs: 10_000,
  };

  const results = await Promise.all(
    Array.from({ length: 6 }, () => ensureTestServer(options)),
  );
  assert.equal(results.filter((r) => r.started).length, 1);
  assert.equal(results.filter((r) => !r.started).length, 5);
  for (const result of results) {
    assert.equal(result.socketPath, socketPath);
  }
  // 锁释放后不应残留 lock 文件。
  assert.rejects(readFile(`${socketPath}.lock`, "utf8"));
});

test("ensureServer cleans up artifacts when the spawned server exits early", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-dead.sock");
  const scriptPath = join(directory, "dead-server.mjs");
  await writeFile(scriptPath, "process.exit(1);\n");

  await assert.rejects(
    ensureServer({
      workspace,
      socketPath,
      env: {},
      spawnSpec: fakeSpawnSpec(scriptPath),
      waitForSocketMs: 2_000,
      pollIntervalMs: 10,
    }),
    /exited before accepting/,
  );
  assert.rejects(readFile(`${socketPath}.pid`, "utf8"));
  assert.rejects(readFile(`${socketPath}.info`, "utf8"));
  assert.rejects(readFile(`${socketPath}.lock`, "utf8"));
});

test("probeSocket reports false for a missing socket", async () => {
  const directory = await temporaryDirectory();
  assert.equal(await probeSocket(join(directory, "absent.sock")), false);
});

test("ensureServer reclaims a stale lock left by a dead pid", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-stale-lock.sock");
  const scriptPath = await writeFakeServerScript(directory);
  // 死锁：pid 远超系统 pid_max，isProcessAlive 必为 false。
  await writeFile(`${socketPath}.lock`, "4000000\n");

  const result = await ensureTestServer({
    workspace,
    socketPath,
    env: {},
    spawnSpec: fakeSpawnSpec(scriptPath),
    waitForSocketMs: 10_000,
  });
  assert.equal(result.started, true);
  // 回收与正常释放都不应留下锁残留（lock 本体或 reclaim 暂存文件）。
  const leftovers = (await readdir(directory)).filter((name) =>
    name.includes(".lock"),
  );
  assert.deepEqual(leftovers, []);
});

test("ensureServer waits out a live-pid lock instead of stealing it", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-live-lock.sock");
  const scriptPath = await writeFakeServerScript(directory);
  // 活锁：写入本测试进程自己的 pid——活 pid 不可回收，等锁直到超时。
  await writeFile(`${socketPath}.lock`, `${process.pid}\n`);

  await assert.rejects(
    ensureServer({
      workspace,
      socketPath,
      env: {},
      spawnSpec: fakeSpawnSpec(scriptPath),
      waitForSocketMs: 300,
      pollIntervalMs: 20,
    }),
    /startup lock/,
  );
  // 活锁内容必须原样保留，未被回收逻辑误删。
  assert.equal(
    (await readFile(`${socketPath}.lock`, "utf8")).trim(),
    `${process.pid}`,
  );
});
