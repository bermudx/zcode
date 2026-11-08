import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// .info 字段断言用普通 JSON：@zcode/shared 解析到主 checkout 旧 dist（仍要
// workspaceIdentity），直接引源码又会拖入整条 shared 依赖链。新 schema 的
// 运行时校验由根 packages/shared 的 contract.test.ts 覆盖。
import {
  ensureServer,
  probeSocket,
  resolveSocketPath,
} from "../src/app-server-spawn.js";

const temporaryDirectories: string[] = [];
/** fixture runner 私有进程登记文件路径（每测试目录一份，JSONL {pid,cwd}）。 */
const fixturePidRegistries = new Set<string>();

test.afterEach(async () => {
  // 只回收「确属本测试」的 fixture 进程：假 runner/测试自己把 spawn 的进程
  // {pid,cwd} 写进测试目录私有登记；逐个复核 /proc/<pid>/cwd 确为登记的私有
  // 工作目录（pid 复用撞上无关进程时绝不杀）后才 SIGKILL，并等其真正退出
  // 再删目录——.sock 还攥在活进程手里时 rm 不是干净状态。生产返回的
  // {socketPath, started} 不含 pid，回收从不依赖 launcher 登记的 .pid。
  for (const registryPath of fixturePidRegistries) {
    let entries: Array<{ pid: number; cwd: string }>;
    try {
      entries = (await readFile(registryPath, "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { pid: number; cwd: string });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    for (const entry of entries) await stopFixtureProcess(entry);
  }
  fixturePidRegistries.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 回收一个登记过的 fixture 进程：存活则先复核 cwd 身份再 SIGKILL，并等待
 *  真实退出。/proc 不可用的平台退化为只凭私有登记本身（登记由本测试自己
 *  的 fixture 写入，已是身份证据）。 */
async function stopFixtureProcess(entry: { pid: number; cwd: string }): Promise<void> {
  if (!isAlive(entry.pid)) return;
  const procfsAvailable = await stat("/proc/self").then(
    () => true,
    () => false,
  );
  if (procfsAvailable) {
    let actualCwd: string;
    try {
      actualCwd = await realpath(`/proc/${entry.pid}/cwd`);
    } catch {
      return; // 进程刚好退出
    }
    let expectedCwd: string;
    try {
      expectedCwd = await realpath(entry.cwd);
    } catch {
      // 登记的目录解析不了→无法核实身份，绝不按 pid 杀（报告 fixture 异常）。
      assert.fail(`fixture registry cwd not resolvable: ${entry.cwd}`);
    }
    assert.equal(
      actualCwd,
      expectedCwd,
      `fixture pid ${entry.pid} cwd mismatch — refusing to kill an unrelated process`,
    );
  }
  process.kill(entry.pid, "SIGKILL");
  const deadline = Date.now() + 5_000;
  while (isAlive(entry.pid)) {
    assert.ok(Date.now() < deadline, `fixture pid ${entry.pid} did not exit after SIGKILL`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-app-server-spawn-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureRegistryPath(directory: string): string {
  return join(directory, "fixture-pids.jsonl");
}

/** 测试直接拉起的进程（如 stale .pid 的 sentinel）也纳入同一私有登记，
 *  统一走 afterEach 的「cwd 身份复核 → SIGKILL → 等退出」回收路径。 */
async function registerFixtureProcess(
  directory: string,
  entry: { pid: number; cwd: string },
): Promise<void> {
  const registryPath = fixtureRegistryPath(directory);
  fixturePidRegistries.add(registryPath);
  await appendFile(registryPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function readFixtureRegistry(
  directory: string,
): Promise<Array<{ pid: number; cwd: string }>> {
  return (await readFile(fixtureRegistryPath(directory), "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { pid: number; cwd: string });
}

/** 测试统一入口：dataBaseDir 缺省落在本测试私有目录（fixture core 的
 *  WorkingDirectory/--cwd 也用它，绝不碰操作者 home）；FAKE_RUNNER_PID_FILE
 *  指向同目录私有登记——回收只凭这份登记，不依赖 ensureServer 返回值。 */
async function ensureTestServer(
  directory: string,
  options: Parameters<typeof ensureServer>[0],
): Promise<Awaited<ReturnType<typeof ensureServer>>> {
  const registryPath = fixtureRegistryPath(directory);
  fixturePidRegistries.add(registryPath);
  return await ensureServer({
    dataBaseDir: join(directory, "data-root"),
    ...options,
    env: { FAKE_RUNNER_PID_FILE: registryPath, ...options.env },
  });
}

/** .pid/.info/.env 由 server 在 listen 回调里异步自写（真 server 合同：
 *  bind 成功者才是 owner），socket 可连不代表登记文件已落盘；ensureServer 的
 *  就绪信号只有 socket。负载下立即 readFile 曾 ENOENT。且 writeFile 是
 *  先建空文件再写内容——只等「文件存在」会读到空串（曾实测 '' !== '1'），
 *  必须等「内容非空」。登记文件按合同都不为空。 */
async function waitForRegistrationFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (content.trim() !== "") return content;
    if (Date.now() > deadline) {
      throw new Error(`registration file never became non-empty: ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 假 core（服务可执行体）：按 --socket 参数 bind 一个 unix socket 并自登记
 *  .pid/.info/.env（与真 server 的 listen 后自登记合同一致：bind 成功者才是
 *  owner；.env 是这份 fixture 私有的 env 快照，供断言 service env 过滤）。
 *  FAKE_CORE_LISTEN_DELAY_MS 是真实 bind 前延迟：await 在 listen 调用之前，
 *  延迟期间 socket 确实不可连（旧版本先 listen 后等，探测立即成功，延迟只
 *  拖慢登记写入——「等就绪」路径根本没被压到）。FAKE_EVENTS_FILE 有值时在
 *  listen 回调写一行 `core-listening <ms>`，供断言受理与就绪的真实时序。 */
async function writeFakeServerScript(directory: string): Promise<string> {
  const scriptPath = join(directory, "fake-app-server.mjs");
  await writeFile(
    scriptPath,
    `import { createServer } from "node:net";
import { appendFile, writeFile } from "node:fs/promises";
const socketIndex = process.argv.indexOf("--socket");
const socketPath = process.argv[socketIndex + 1];
const delay = Number(process.env.FAKE_CORE_LISTEN_DELAY_MS || "0");
const eventsFile = process.env.FAKE_EVENTS_FILE;
const server = createServer((socket) => socket.end());
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
server.listen(socketPath, async () => {
  if (eventsFile) await appendFile(eventsFile, "core-listening " + Date.now() + "\\n", "utf8");
  await writeFile(socketPath + ".pid", process.pid + "\\n", "utf8");
  await writeFile(socketPath + ".env", JSON.stringify({
    attachCore: process.env.ZCODE_ATTACH_CORE ?? null,
    workspaceIdentity: process.env.ZCODE_WORKSPACE_IDENTITY ?? null,
    herdrPane: process.env.HERDR_PANE_ID ?? null,
    t3code: process.env.T3CODE_FAKE ?? null,
    notifySocket: process.env.NOTIFY_SOCKET ?? null,
    invocationId: process.env.INVOCATION_ID ?? null,
    secret: process.env.ZCODE_TEST_SECRET ?? null,
    dataBaseDir: process.env.ZCODE_DATA_BASE_DIR ?? null,
    pwd: process.env.PWD ?? null,
  }), "utf8");
  await writeFile(socketPath + ".info", JSON.stringify({
    version: "9.9.9-test",
    scope: "user",
    socketPath,
    startedAt: new Date().toISOString(),
  }), "utf8");
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
  );
  return scriptPath;
}

/** fixture-only 假 service manager（替代 systemd-run，不代表 cgroup/生命周期
 *  证据）：模拟「受理 → exec」语义——把 argv 落盘供断言，按 --setenv=NAME
 *  名单从自己 env 取值（值绝不进 argv），UnsetEnvironment 删除名字，注入
 *  一份「管理器侧」污染 env（workspace/客户端归属名）来验证 unset 生效，
 *  然后 detached spawn `--` 之后的真正 core 命令并 exit 0——systemd-run
 *  受理后同样立刻退出，不就绪由 socket 探测兜底。退出前把刚 spawn 的
 *  core child {pid,cwd} 追加进 FAKE_RUNNER_PID_FILE 私有登记（测试回收用，
 *  与 server 自登记的 .pid 是两码事），并按 FAKE_EVENTS_FILE 写一行
 *  `manager-accepted <ms>`。 */
async function writeFakeServiceRunnerScript(directory: string): Promise<string> {
  const scriptPath = join(directory, "fake-service-runner.mjs");
  await writeFile(
    scriptPath,
    `import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const argvFile = process.env.FAKE_RUNNER_ARGV_FILE;
if (argvFile) {
  writeFileSync(argvFile, JSON.stringify(args), "utf8");
  appendFileSync(argvFile + ".count", "1\\n", "utf8");
}
const failCode = Number(process.env.FAKE_RUNNER_EXIT_CODE || "0");
if (failCode !== 0) {
  process.stderr.write(process.env.FAKE_RUNNER_STDERR || "fake runner failed");
  process.exit(failCode);
}
// 第一个裸 "--" 才结束 runner 选项解析：命令体内 /usr/bin/env 之后还有第二个。
const separator = args.indexOf("--");
const command = args.slice(separator + 1);
const forwarded = new Set();
const unset = new Set();
let workingDirectory = process.cwd();
for (const arg of args) {
  if (arg.startsWith("--setenv=")) forwarded.add(arg.slice("--setenv=".length));
  if (arg.startsWith("--property=UnsetEnvironment=")) {
    unset.add(arg.slice("--property=UnsetEnvironment=".length));
  }
  if (arg.startsWith("--property=WorkingDirectory=")) {
    workingDirectory = arg.slice("--property=WorkingDirectory=".length);
  }
}
const serviceEnv = {
  HERDR_PANE_ID: "stale-manager-pane",
  T3CODE_FAKE: "stale-manager-t3",
  ZCODE_WORKSPACE_IDENTITY: "stale-manager-workspace",
  NOTIFY_SOCKET: "stale-manager-notify",
  INVOCATION_ID: "stale-manager-invocation",
  ...process.env,
};
for (const name of unset) delete serviceEnv[name];
for (const name of forwarded) {
  if (process.env[name] !== undefined) serviceEnv[name] = process.env[name];
}
const real = command.slice(2);
const child = spawn(real[0], real.slice(1), {
  cwd: workingDirectory,
  detached: true,
  env: serviceEnv,
  stdio: "ignore",
});
child.unref();
const registryFile = process.env.FAKE_RUNNER_PID_FILE;
if (registryFile && child.pid) {
  appendFileSync(
    registryFile,
    JSON.stringify({ pid: child.pid, cwd: workingDirectory }) + "\\n",
    "utf8",
  );
}
const eventsFile = process.env.FAKE_EVENTS_FILE;
if (eventsFile) appendFileSync(eventsFile, "manager-accepted " + Date.now() + "\\n", "utf8");
process.exitCode = 0;
`,
  );
  return scriptPath;
}

function fakeSpawnSpec(scriptPath: string, runnerScriptPath: string) {
  return {
    file: process.execPath,
    argsPrefix: [scriptPath],
    serviceRunner: { file: process.execPath, argsPrefix: [runnerScriptPath] },
  } as const;
}

test("resolveSocketPath derives the single data-root core.sock (workspace-independent)", async () => {
  const base = await temporaryDirectory();
  // 单一 core：同一个数据根只有一个端点——两个不同 workspace 的调用方得到同一路径。
  assert.equal(
    resolveSocketPath({ dataBaseDir: base }),
    join(base, ".zcode", "v2", "sockets", "core.sock"),
  );
});

test("resolveSocketPath resolves the data root env > option precedence and rejects relative roots", async () => {
  const base = await temporaryDirectory();
  const other = await temporaryDirectory();
  assert.equal(
    resolveSocketPath({ env: { ZCODE_DATA_BASE_DIR: base } }),
    join(base, ".zcode", "v2", "sockets", "core.sock"),
  );
  assert.equal(
    resolveSocketPath({ dataBaseDir: other, env: { ZCODE_DATA_BASE_DIR: base } }),
    join(other, ".zcode", "v2", "sockets", "core.sock"),
  );
  // 不同数据根 → 不同 socket（有意隔离的 profile），但同一数据根永远同一个 core。
  assert.notEqual(
    resolveSocketPath({ dataBaseDir: base }),
    resolveSocketPath({ dataBaseDir: other }),
  );
  assert.throws(
    () => resolveSocketPath({ dataBaseDir: "relative/root" }),
    /absolute path/,
  );
  assert.throws(
    () => resolveSocketPath({ dataBaseDir: "   " }),
    /non-blank/,
  );
});

test("resolveSocketPath uses a named pipe hashed from the data root on win32", async () => {
  const expectedHash = createHash("sha256")
    .update("C:\\data-root")
    .digest("hex")
    .slice(0, 16);
  const socketPath = resolveSocketPath({
    dataBaseDir: "C:\\data-root",
    platform: "win32",
  });
  assert.equal(socketPath, `\\\\.\\pipe\\zcode-core-${expectedHash}`);
});

test("ensureServer starts via the user service runner and reuses a live socket", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-test.sock");
  const scriptPath = await writeFakeServerScript(directory);
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  const argvFile = join(directory, "runner-argv.json");

  const result = await ensureTestServer(directory, {
    socketPath,
    env: { FAKE_RUNNER_ARGV_FILE: argvFile },
    spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
    waitForSocketMs: 10_000,
  });
  assert.equal(result.started, true);
  assert.equal(result.socketPath, socketPath);
  // 结果形状只有 {socketPath, started}：登记文件是操作者元数据，不进返回值。
  assert.deepEqual(Object.keys(result).toSorted(), ["socketPath", "started"]);
  // server 自登记的 .pid 写的是真 core pid——与本测试私有登记里 runner 记下的
  // child pid 一致（fixture 级交叉验证，生产端不读 .pid）。
  const pidFile = (await waitForRegistrationFile(`${socketPath}.pid`)).trim();
  const registry = await readFixtureRegistry(directory);
  assert.equal(pidFile, String(registry.at(-1)?.pid));
  const info = JSON.parse(
    await waitForRegistrationFile(`${socketPath}.info`),
  ) as { version?: unknown; scope?: unknown; socketPath?: unknown; startedAt?: unknown };
  assert.equal(info.version, "9.9.9-test");
  assert.equal(info.scope, "user");
  assert.equal(info.socketPath, socketPath);
  assert.equal(typeof info.startedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(info.startedAt as string)));
  // 单一 core 元数据不得再携带 workspace 身份（旧 schema 字段）。
  assert.equal("workspaceIdentity" in info, false);

  const reused = await ensureTestServer(directory, {
    socketPath,
    env: {},
    spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
  });
  assert.equal(reused.started, false);
  assert.deepEqual(Object.keys(reused).toSorted(), ["socketPath", "started"]);
});

test("concurrent ensureServer callers issue exactly one service request on the same socket", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-race.sock");
  const scriptPath = await writeFakeServerScript(directory);
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  const argvFile = join(directory, "runner-argv.json");
  const options = {
    socketPath,
    env: { FAKE_RUNNER_ARGV_FILE: argvFile },
    spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
    waitForSocketMs: 10_000,
  };

  const results = await Promise.all(
    Array.from({ length: 6 }, () => ensureTestServer(directory, options)),
  );
  assert.equal(results.filter((r) => r.started).length, 1);
  assert.equal(results.filter((r) => !r.started).length, 5);
  for (const result of results) {
    assert.equal(result.socketPath, socketPath);
  }
  // 锁保证只有一个调用方走到拉起请求：runner argv 恰好落盘一次。
  const invocations = (await readFile(`${argvFile}.count`, "utf8")).trim().split("\n");
  assert.equal(invocations.length, 1);
  // 锁释放后不应残留 lock 文件。
  assert.rejects(readFile(`${socketPath}.lock`, "utf8"));
});

test("service argv requests a user service (not a scope) with neutral cwd and no workspace env", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const dataBaseDir = join(directory, "data-root");
  const socketPath = join(directory, "core-argv.sock");
  const scriptPath = await writeFakeServerScript(directory);
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  const argvFile = join(directory, "runner-argv.json");

  const result = await ensureTestServer(directory, {
    socketPath,
    dataBaseDir,
    env: {
      FAKE_RUNNER_ARGV_FILE: argvFile,
      HERDR_PANE_ID: "pane-7",
      T3CODE_FAKE: "t3-value",
      NOTIFY_SOCKET: "/run/notify",
      INVOCATION_ID: "caller-invocation",
      ZCODE_WORKSPACE_IDENTITY: "/first/spawner/workspace",
      ZCODE_TEST_SECRET: "s3cr3t-value",
    },
    spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
    waitForSocketMs: 10_000,
  });
  assert.equal(result.started, true);

  const argv = JSON.parse(await readFile(argvFile, "utf8")) as string[];
  const unitHash = createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
  // user service（不是 --scope）：unit 只由 socket 路径派生，稳定、无 cwd/
  // provider/version/frontend 标识。
  assert.ok(argv.includes("--user"));
  assert.ok(argv.includes("--collect"));
  assert.ok(argv.includes("--service-type=exec"));
  assert.ok(argv.includes("--expand-environment=no"));
  assert.ok(!argv.includes("--scope"));
  assert.ok(argv.includes(`--unit=piz-core-${unitHash}.service`));
  assert.ok(argv.includes(`--property=WorkingDirectory=${dataBaseDir}`));
  assert.ok(argv.includes("--property=StandardInput=null"));
  assert.ok(argv.includes("--property=StandardOutput=null"));
  assert.ok(argv.includes("--property=StandardError=journal"));
  // UnsetEnvironment：workspace 身份恒入列，调用方 env 里出现的排除名也在。
  assert.ok(argv.includes("--property=UnsetEnvironment=ZCODE_WORKSPACE_IDENTITY"));
  assert.ok(argv.includes("--property=UnsetEnvironment=HERDR_PANE_ID"));
  assert.ok(argv.includes("--property=UnsetEnvironment=T3CODE_FAKE"));
  assert.ok(argv.includes("--property=UnsetEnvironment=NOTIFY_SOCKET"));
  assert.ok(argv.includes("--property=UnsetEnvironment=INVOCATION_ID"));
  // --setenv 只传变量名：值/secret 绝不进 argv。
  for (const arg of argv) {
    if (arg.startsWith("--setenv=")) {
      assert.match(arg, /^--setenv=[A-Za-z_][A-Za-z0-9_]*$/);
    }
  }
  assert.ok(!argv.includes("--setenv=ZCODE_WORKSPACE_IDENTITY"));
  assert.ok(!argv.includes("--setenv=HERDR_PANE_ID"));
  assert.ok(!argv.includes("--setenv=T3CODE_FAKE"));
  assert.ok(!argv.includes("--setenv=NOTIFY_SOCKET"));
  assert.ok(!argv.includes("--setenv=INVOCATION_ID"));
  assert.ok(argv.includes("--setenv=ZCODE_ATTACH_CORE"));
  assert.ok(argv.includes("--setenv=ZCODE_DATA_BASE_DIR"));
  assert.ok(argv.includes("--setenv=PWD"));
  assert.ok(argv.includes("--setenv=ZCODE_TEST_SECRET"));
  assert.ok(!argv.some((arg) => arg.includes("s3cr3t")));
  assert.ok(!argv.some((arg) => arg.includes("stale")));
  // 命令尾部：/usr/bin/env -- <core> <argsPrefix> app-server --socket <path>
  // --no-plugins --cwd <数据根>。第一个裸 "--" 是 runner 与命令体的分隔。
  const separator = argv.indexOf("--");
  assert.deepEqual(argv.slice(separator + 1, separator + 3), ["/usr/bin/env", "--"]);
  const command = argv.slice(separator + 3);
  assert.equal(command[0], process.execPath);
  assert.equal(command[1], scriptPath);
  assert.deepEqual(command.slice(-6), [
    "app-server",
    "--socket",
    socketPath,
    "--no-plugins",
    "--cwd",
    dataBaseDir,
  ]);

  // service env（fixture 快照）：workspace/客户端归属/service-instance 名全部
  // 被剥——连管理器侧 stale 值也靠 UnsetEnvironment 抹掉；secret 经 env 转发。
  const serviceEnv = JSON.parse(
    await waitForRegistrationFile(`${socketPath}.env`),
  ) as Record<string, string | null>;
  assert.equal(serviceEnv.attachCore, "1");
  assert.equal(serviceEnv.workspaceIdentity, null);
  assert.equal(serviceEnv.herdrPane, null);
  assert.equal(serviceEnv.t3code, null);
  assert.equal(serviceEnv.notifySocket, null);
  assert.equal(serviceEnv.invocationId, null);
  assert.equal(serviceEnv.secret, "s3cr3t-value");
  assert.equal(serviceEnv.dataBaseDir, dataBaseDir);
  assert.equal(serviceEnv.pwd, dataBaseDir);
});

test("ensureServer keeps probing after the launcher exits 0 while the listener is still coming up", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-slow.sock");
  const scriptPath = await writeFakeServerScript(directory);
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  const eventsFile = join(directory, "events.log");
  // systemd-run exit 0 = 受理不就绪：假 runner 受理后立刻退出，core 延迟
  // bind（真 bind 前延迟，socket 在延迟期间确实不可连）。
  const result = await ensureTestServer(directory, {
    socketPath,
    env: {
      FAKE_CORE_LISTEN_DELAY_MS: "600",
      FAKE_EVENTS_FILE: eventsFile,
    },
    spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
    waitForSocketMs: 10_000,
    pollIntervalMs: 20,
  });
  assert.equal(result.started, true);
  // 事件标记证明这次真的经历了「受理不就绪」：manager-accepted 必须早于
  // core-listening，而 ensureServer 的返回只能发生在 listening 之后——探测
  // 循环确实跨越了受理到 bind 的空窗（旧 fixture 延迟在 listen 之后，
  // socket 即刻可连，这个时序断言当时无法满足）。
  const events = (await readFile(eventsFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [name, at] = line.split(" ");
      return { name, at: Number(at) };
    });
  const acceptedAt = events.find((event) => event.name === "manager-accepted")?.at;
  const listeningAt = events.find((event) => event.name === "core-listening")?.at;
  assert.ok(acceptedAt !== undefined, "runner must record manager-accepted");
  assert.ok(listeningAt !== undefined, "core must record core-listening");
  assert.ok(
    listeningAt > acceptedAt,
    `core must bind after manager acceptance (accepted=${acceptedAt} listening=${listeningAt})`,
  );
  assert.ok(
    listeningAt - acceptedAt >= 300,
    `bind gap ${listeningAt - acceptedAt}ms is too small — the delay must hold the socket unbound`,
  );
});

test("a failing service manager reports an explicit error and kills no shared service", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-fail.sock");
  const scriptPath = await writeFakeServerScript(directory);
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  const argvFile = join(directory, "runner-argv.json");

  await assert.rejects(
    ensureTestServer(directory, {
      socketPath,
      env: {
        FAKE_RUNNER_ARGV_FILE: argvFile,
        FAKE_RUNNER_EXIT_CODE: "42",
        FAKE_RUNNER_STDERR: "unit rejected by manager\n",
      },
      spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
      waitForSocketMs: 5_000,
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const unitHash = createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
      assert.match(message, /service start failed/);
      assert.match(message, new RegExp(`piz-core-${unitHash}`));
      assert.match(message, /unit rejected by manager/);
      return true;
    },
  );
  // 失败路径不残留锁，也没有拉起任何 core 进程可停。
  assert.rejects(readFile(`${socketPath}.lock`, "utf8"));
  assert.rejects(readFile(`${socketPath}.pid`, "utf8"));
});

test("a service accepted but never listening times out with unit identity for inspection", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-never-ready.sock");
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  // core 可执行体立即退出：systemd-run 已受理（exit 0），launcher 死亡不等于
  // core 死亡——继续探测到超时并报出 unit 供人工检查。
  const deadScript = join(directory, "dead-server.mjs");
  await writeFile(deadScript, "process.exit(1);\n");

  await assert.rejects(
    ensureTestServer(directory, {
      socketPath,
      env: {},
      spawnSpec: fakeSpawnSpec(deadScript, runnerPath),
      waitForSocketMs: 1_500,
      pollIntervalMs: 20,
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const unitHash = createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
      assert.match(message, /Timed out waiting for app-server socket/);
      assert.match(message, new RegExp(`piz-core-${unitHash}`));
      return true;
    },
  );
  assert.rejects(readFile(`${socketPath}.lock`, "utf8"));
});

test("an already-live socket is reused even when the service manager is unavailable", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-reuse.sock");
  const scriptPath = await writeFakeServerScript(directory);
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  const started = await ensureTestServer(directory, {
    socketPath,
    env: {},
    spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
    waitForSocketMs: 10_000,
  });
  assert.equal(started.started, true);

  const reused = await ensureTestServer(directory, {
    socketPath,
    env: {},
    spawnSpec: {
      file: "definitely-missing-core",
      serviceRunner: { file: "/nonexistent/systemd-run" },
    },
  });
  assert.equal(reused.started, false);
});

test("a missing service manager fails explicitly with no detached fallback", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-no-manager.sock");
  const scriptPath = await writeFakeServerScript(directory);

  await assert.rejects(
    ensureTestServer(directory, {
      socketPath,
      env: {},
      spawnSpec: {
        file: process.execPath,
        argsPrefix: [scriptPath],
        serviceRunner: { file: "/nonexistent/systemd-run" },
      },
      waitForSocketMs: 5_000,
    }),
    /service manager spawn failed|ENOENT/,
  );
});

test("non-Linux unix fails explicitly instead of falling back to a detached spawn", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-darwin.sock");
  await assert.rejects(
    ensureTestServer(directory, { socketPath, env: {}, platform: "darwin" }),
    /user service manager|independent supervisor/,
  );
});

test("non-Linux unix still reuses an already-listening socket", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-darwin-reuse.sock");
  const scriptPath = await writeFakeServerScript(directory);
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  const started = await ensureTestServer(directory, {
    socketPath,
    env: {},
    spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
    waitForSocketMs: 10_000,
  });
  assert.equal(started.started, true);

  const reused = await ensureTestServer(directory, {
    socketPath,
    env: {},
    platform: "darwin",
  });
  assert.equal(reused.started, false);
});

test("probeSocket reports false for a missing socket", async () => {
  const directory = await temporaryDirectory();
  assert.equal(await probeSocket(join(directory, "absent.sock")), false);
});

test("ensureServer validates explicit socket paths and the data root before touching the filesystem", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  await assert.rejects(
    ensureServer({ socketPath: "   ", env: {} }),
    /non-empty path/,
  );
  await assert.rejects(
    ensureServer({ socketPath: "relative/core.sock", env: {} }),
    /absolute path/,
  );
  // 显式 socket 缺席时的拉起路径同样要求绝对数据根（--cwd/WorkingDirectory）。
  const directory = await temporaryDirectory();
  await assert.rejects(
    ensureServer({
      socketPath: join(directory, "x.sock"),
      dataBaseDir: "relative/root",
      env: {},
    }),
    /absolute path/,
  );
});

test("ensureServer reclaims a stale lock left by a dead pid", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-stale-lock.sock");
  const scriptPath = await writeFakeServerScript(directory);
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  // 死锁：pid 远超系统 pid_max，isProcessAlive 必为 false。
  await writeFile(`${socketPath}.lock`, "4000000\n");

  const result = await ensureTestServer(directory, {
    socketPath,
    env: {},
    spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
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
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  // 活锁：写入本测试进程自己的 pid——活 pid 不可回收，等锁直到超时。
  await writeFile(`${socketPath}.lock`, `${process.pid}\n`);

  await assert.rejects(
    ensureTestServer(directory, {
      socketPath,
      env: {},
      spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
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

test("ensureServer gives the spawned service a full ready window after a contested lock wait", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-slow-start.sock");
  const scriptPath = await writeFakeServerScript(directory);
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  const eventsFile = join(directory, "events.log");
  // 回归 2026-10-25 开机风暴：锁等待与就绪等待共用同一 deadline 时，等锁耗尽的
  // 预算会让刚受理的 core 只剩近零就绪窗口被误杀。就绪窗口必须从拉起器 spawn
  // 起算。两阶段各自占独立预算才能过：真锁等待(900) + 真 bind 前延迟(1200)
  // = 2100 > WAIT_MS(2000)——共享 deadline 下此用例必超时；每阶段余量也留足
  // （锁 900/2000，就绪 ~1200+spawn/2000）。
  const WAIT_MS = 2_000;
  const LOCK_HOLD_MS = 900;
  const BIND_DELAY_MS = 1_200;
  // 活 pid 锁：不能回收，只能等持有者自行释放；持有时长刻意吃掉大半共享预算。
  const lockPath = `${socketPath}.lock`;
  await writeFile(lockPath, `${process.pid}\n`);
  let lockReleasedAt = 0;
  const lockRelease = setTimeout(() => {
    lockReleasedAt = Date.now();
    void rm(lockPath, { force: true });
  }, LOCK_HOLD_MS);
  try {
    const result = await ensureTestServer(directory, {
      socketPath,
      env: {
        FAKE_CORE_LISTEN_DELAY_MS: String(BIND_DELAY_MS),
        FAKE_EVENTS_FILE: eventsFile,
      },
      spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
      waitForSocketMs: WAIT_MS,
      pollIntervalMs: 20,
    });
    assert.equal(result.started, true);
    assert.equal(result.socketPath, socketPath);
  } finally {
    clearTimeout(lockRelease);
  }
  // 真时序复核（不靠 delay 配置推断）：manager 受理只能在锁释放之后，
  // bind 只能在受理之后且相隔接近 BIND_DELAY_MS（延迟在 listen 之前）。
  const events = (await readFile(eventsFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [name, at] = line.split(" ");
      return { name, at: Number(at) };
    });
  const acceptedAt = events.find((event) => event.name === "manager-accepted")?.at;
  const listeningAt = events.find((event) => event.name === "core-listening")?.at;
  assert.ok(acceptedAt !== undefined, "runner must record manager-accepted");
  assert.ok(listeningAt !== undefined, "core must record core-listening");
  assert.ok(
    acceptedAt >= lockReleasedAt,
    `manager acceptance (${acceptedAt}) must follow the lock release (${lockReleasedAt})`,
  );
  assert.ok(
    listeningAt - acceptedAt >= BIND_DELAY_MS - 200,
    `bind gap ${listeningAt - acceptedAt}ms is too small — the pre-bind delay must be real`,
  );
});

test("a stale pre-existing .pid is never acted on: the sentinel keeps running", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket path only");
    return;
  }
  const directory = await temporaryDirectory();
  const socketPath = join(directory, "core-stale-pid.sock");
  const scriptPath = await writeFakeServerScript(directory);
  const runnerPath = await writeFakeServiceRunnerScript(directory);
  // 陈旧登记：.pid 指向一个与本 core 无关的存活进程。登记文件只是操作者
  // 元数据（可能滞后/陈旧）——ensureServer 不得读它、不得按它行事，更不
  // 能把它当 kill 目标。
  const sentinel = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 60000)"],
    { cwd: directory, stdio: "ignore" },
  );
  assert.ok(sentinel.pid !== undefined, "sentinel must spawn");
  await registerFixtureProcess(directory, { pid: sentinel.pid, cwd: directory });
  await writeFile(`${socketPath}.pid`, `${sentinel.pid}\n`, "utf8");

  const result = await ensureTestServer(directory, {
    socketPath,
    env: {},
    spawnSpec: fakeSpawnSpec(scriptPath, runnerPath),
    waitForSocketMs: 10_000,
  });
  assert.equal(result.started, true);
  // 结果只含 {socketPath, started}：陈旧 .pid 不进入返回值，也没被当 kill
  // 目标——sentinel 必须仍然存活。
  assert.deepEqual(Object.keys(result).toSorted(), ["socketPath", "started"]);
  process.kill(sentinel.pid, 0);
  // 新 bind 的 server 用真实自登记覆盖那份陈旧文件。等 .info（它不曾预置，
  // 且在 listen 回调里最后写）落盘后再读 .pid——不能按「文件非空」等 .pid，
  // 陈旧内容本身已非空会拿到旧值。
  await waitForRegistrationFile(`${socketPath}.info`);
  const registeredPid = Number(
    (await readFile(`${socketPath}.pid`, "utf8")).trim(),
  );
  assert.notEqual(registeredPid, sentinel.pid);
});
