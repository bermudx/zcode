import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { connect } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { ZCODE_WORKSPACE_IDENTITY_ENV } from "@zcode/shared";

/** socket 就绪等待上限：60s。10s 曾在开机风暴下误杀仍在正常启动的 core：
 *  2026-10-25 实测 herdr 开机恢复同时拉起十余个 agent 进程，core 从 spawn 到
 *  listen 需要 >10s（平静时约 2s），所有 attach 客户端在 10s 处超时并 SIGTERM
 *  掉即将就绪的子进程，piz --resume 全灭。60s 容忍冷启动竞争；core 真正
 *  失败时 childExit 路径仍快速报错，不会等到超时。 */
const APP_SERVER_READY_TIMEOUT_MS = 60_000;
const APP_SERVER_PROBE_INTERVAL_MS = 50;
const APP_SERVER_PROBE_TIMEOUT_MS = 500;
/** 启动锁被视为 stale 的兜底时长：锁文件读不出 pid 时用 mtime 判定。 */
const APP_SERVER_LOCK_STALE_MS = APP_SERVER_READY_TIMEOUT_MS * 2;
const APP_SERVER_HASH_ALGORITHM = "sha256";
const APP_SERVER_HASH_LENGTH = 16;
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\zcode-core-";
/** systemd-run 的 stderr 只用于失败诊断，有界收集防异常洪泛。 */
const SERVICE_RUNNER_STDERR_LIMIT = 4_096;
const SERVICE_RUNNER_STDERR_MESSAGE_LIMIT = 2_000;

const CORE_SERVICE_UNIT_PREFIX = "piz-core-";
const CORE_SERVICE_UNIT_SUFFIX = ".service";
/** 默认拉起器：Linux user service manager 的前端。 */
const DEFAULT_SERVICE_RUNNER = "systemd-run";

/** attach 共享 core 的 herdr 抑制标记：core env 烘焙的 pane 归属对
 *  spawn 之后 attach 进来的其他客户端无效，`~/.zcode/herdr-hook.sh`
 *  见此标记即 no-op（docs/design/v2/tui-attach-shared-core.md）。 */
export const ZCODE_ATTACH_CORE_ENV = "ZCODE_ATTACH_CORE";

/** 可执行体形态：`file` + 可选前置参数（如 node + 脚本路径）。 */
export interface AppServerLaunchSpec {
  file: string;
  argsPrefix?: readonly string[];
}

/** core 可执行体：默认 PATH 上的 `zcode`；测试可注入 node + 假 server 脚本。 */
export interface AppServerSpawnSpec extends AppServerLaunchSpec {
  /** 测试注入：替换 systemd-run 启动器（fixture-only，不代表 cgroup/
   *  生命周期证据——fixture 只模拟「受理→exec」语义）。 */
  serviceRunner?: AppServerLaunchSpec;
}

export interface EnsureAppServerOptions {
  /** 显式 socket 路径（测试/调试覆盖）；默认按数据根派生单一 core.sock。 */
  socketPath?: string;
  env?: NodeJS.ProcessEnv;
  /** 与 provider-runtime-env 同一约定：<dataBaseDir>/.zcode/v2/sockets。 */
  dataBaseDir?: string;
  spawnSpec?: AppServerSpawnSpec;
  waitForSocketMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform | string;
  /** 启动/复用诊断（stderr 约定：一行一条，不带换行）；缺省静默。 */
  log?: (line: string) => void;
}

export interface EnsureAppServerResult {
  socketPath: string;
  /** true = 本次调用拉起了新 server；false = 复用了已在监听的 server。 */
  started: boolean;
}

/** service-instance 变量属于「管理器↔服务」通道：客户端 env 同名值一律不透传。 */
const SERVICE_INSTANCE_ENV_NAMES = new Set([
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "LISTEN_FDS",
  "LISTEN_FDNAMES",
  "LISTEN_PID",
  "NOTIFY_SOCKET",
  "WATCHDOG_PID",
  "WATCHDOG_USEC",
]);
/** 客户端归属变量前缀：pane/thread 归属是拉起方私有事实，泄漏进共享 core
 *  会让后来客户端读到错位的归属（herdr 误报正是这类事故）。 */
const CLIENT_OWNERSHIP_ENV_PREFIXES = ["HERDR_", "T3CODE_"];
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 不进 service env 的名字：workspace 身份、客户端归属、service-instance 变量。 */
function isCoreEnvExcluded(name: string): boolean {
  return (
    name === ZCODE_WORKSPACE_IDENTITY_ENV ||
    SERVICE_INSTANCE_ENV_NAMES.has(name) ||
    CLIENT_OWNERSHIP_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** 解析数据根：option > ZCODE_DATA_BASE_DIR > homedir；去空白后必须非空。 */
function resolveDataBaseDir(
  options: Pick<EnsureAppServerOptions, "dataBaseDir">,
  env: NodeJS.ProcessEnv,
): string {
  const dataBaseDir =
    options.dataBaseDir ?? env.ZCODE_DATA_BASE_DIR?.trim() ?? homedir();
  if (dataBaseDir.trim().length === 0) {
    throw new Error("app-server data root must be a non-blank path");
  }
  return dataBaseDir;
}

/**
 * 派生共享 core 的 socket 路径：`<dataBaseDir>/.zcode/v2/sockets/core.sock`。
 * 单一 core：路径只由数据根决定，不含 workspace/frontend/provider 标识；
 * workspace 身份只出现在会话级协议参数里。Windows 下 Unix socket 文件不可
 * 用，按 Node 约定退到 named pipe（按数据根 hash，未实测）。
 */
export function resolveSocketPath(
  options: Pick<EnsureAppServerOptions, "dataBaseDir" | "env" | "platform"> = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const dataBaseDir = resolveDataBaseDir(options, env);
  if (platform === "win32") {
    const hash = createHash(APP_SERVER_HASH_ALGORITHM)
      .update(dataBaseDir)
      .digest("hex")
      .slice(0, APP_SERVER_HASH_LENGTH);
    return `${WINDOWS_PIPE_PREFIX}${hash}`;
  }
  if (!isAbsolute(dataBaseDir)) {
    throw new Error(`app-server data root must be an absolute path: ${dataBaseDir}`);
  }
  return join(dataBaseDir, ".zcode", "v2", "sockets", "core.sock");
}

/** service unit 名：只由 socket 路径派生——稳定，绝不含 cwd/provider/
 *  version/frontend。不同数据根自然得到不同 unit。 */
function resolveServiceUnitName(socketPath: string): string {
  const hash = createHash(APP_SERVER_HASH_ALGORITHM)
    .update(socketPath)
    .digest("hex")
    .slice(0, APP_SERVER_HASH_LENGTH);
  return `${CORE_SERVICE_UNIT_PREFIX}${hash}${CORE_SERVICE_UNIT_SUFFIX}`;
}

/**
 * 组装 service env 与拉起 argv（纯函数，便于审查）：
 * - service env = 客户端 env 过滤后转发；`--setenv=NAME` 只带变量名，
 *   值由 systemd-run 从自己的 env 解析——值/secret 绝不进 argv。
 * - `UnsetEnvironment=` 防 manager 侧同名变量漏进服务：workspace 身份与
 *   service-instance 名恒入列，客户端归属名按调用方 env 实到补列。
 */
function buildServiceRunnerArgs(input: {
  unitName: string;
  dataBaseDir: string;
  socketPath: string;
  spec: AppServerLaunchSpec;
  runnerArgsPrefix: readonly string[];
  forwardedEnvNames: readonly string[];
  unsetEnvNames: readonly string[];
}): string[] {
  return [
    ...input.runnerArgsPrefix,
    "--user",
    "--quiet",
    "--collect",
    "--service-type=exec",
    "--expand-environment=no",
    `--unit=${input.unitName}`,
    `--property=WorkingDirectory=${input.dataBaseDir}`,
    "--property=StandardInput=null",
    "--property=StandardOutput=null",
    "--property=StandardError=journal",
    ...input.unsetEnvNames.map((name) => `--property=UnsetEnvironment=${name}`),
    ...input.forwardedEnvNames.map((name) => `--setenv=${name}`),
    "--",
    "/usr/bin/env",
    "--",
    input.spec.file,
    ...(input.spec.argsPrefix ?? []),
    "app-server",
    "--socket",
    input.socketPath,
    "--no-plugins",
    "--cwd",
    input.dataBaseDir,
  ];
}

/** systemd-run stderr → 有界、去控制字节的单行失败上下文（不回显 env/argv；
 *  含换行的原文会破坏一行一条的 stderr 诊断约定）。 */
function sanitizeRunnerStderr(raw: string): string {
  return [...raw]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, SERVICE_RUNNER_STDERR_MESSAGE_LIMIT);
}

/**
 * 幂等确保共享 core 可用：先探测已有 socket；不存在时经 O_CREAT|O_EXCL
 * 原子锁保证并发调用者中只有一人请求拉起。Linux 拉起路径是
 * `systemd-run --user` 瞬时 service（piz-core-<sha256(socketPath)[:16]>）：
 * core 生命周期归 user 服务管理器，客户端 scope 退役杀不死它。
 * systemd-run exit 0 只代表受理——继续探测 socket 到就绪上限。
 * 无 service manager 的平台显式报错，绝不回落 detached spawn。
 */
export async function ensureServer(
  options: EnsureAppServerOptions,
): Promise<EnsureAppServerResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // Unix-only：spawn 不走 shell，任何文件系统/探测之前先拒绝。
  if (platform === "win32") {
    throw new Error("ensureServer does not support spawning app-server on win32");
  }
  if (options.socketPath !== undefined) {
    if (options.socketPath.trim().length === 0) {
      throw new Error("socketPath must be a non-empty path when provided");
    }
    if (!isAbsolute(options.socketPath)) {
      throw new Error(`socketPath must be an absolute path: ${options.socketPath}`);
    }
  }
  const socketPath = options.socketPath ?? resolveSocketPath(options);
  const waitForSocketMs = options.waitForSocketMs ?? APP_SERVER_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? APP_SERVER_PROBE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + waitForSocketMs;

  if (await probeSocket(socketPath)) {
    options.log?.(`app-server: reusing shared core at ${socketPath}`);
    return { socketPath, started: false };
  }

  // 非 Linux Unix（含 darwin）：已监听 socket 上面已复用；socket 缺席时显式
  // 失败——不回落 detached/double-fork spawn，那会把 core 生命周期绑回客户
  // 端 scope（T3 scope 退役杀 core 的事故正是这么来的）。
  if (platform !== "linux") {
    throw new Error(
      `app-server auto-start requires a user service manager (Linux systemd --user); ` +
        `on ${platform} start the shared core under an independent supervisor, e.g. ` +
        `\`zcode app-server --socket '${socketPath}' --no-plugins\`, then retry`,
    );
  }

  // service WorkingDirectory 与 --cwd 用中性数据根：core 进程 cwd 只做
  // 「客户端漏传 workspace」的兜底，绝不能继承首个拉起者的 workspace。
  const dataBaseDir = resolveDataBaseDir(options, env);
  if (!isAbsolute(dataBaseDir)) {
    throw new Error(`app-server data root must be an absolute path: ${dataBaseDir}`);
  }

  // socket 目录与数据根都要存在：数据根是 service WorkingDirectory/--cwd，
  // 不存在会让 manager 受理失败（显式 socketPath 时数据根在 socket 目录之外）。
  await mkdir(dirname(socketPath), { recursive: true });
  await mkdir(dataBaseDir, { recursive: true });
  const lockPath = `${socketPath}.lock`;

  let lockHeld = false;
  while (now() < deadline) {
    try {
      // O_CREAT|O_EXCL：writeFile 的 wx flag 原子完成创建+写入+关闭，
      // 写入失败不会泄漏 FileHandle。
      await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
      lockHeld = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // 锁已消失或 stale 锁被原子回收 → 立刻重抢；活 pid / 刚创建的锁探测
      // socket 后按原节奏等待。
      if ((await inspectHeldLock(lockPath, now)) === "gone") continue;
      if (await probeSocket(socketPath)) return { socketPath, started: false };
      await sleep(pollIntervalMs);
    }
  }
  if (!lockHeld) {
    // 锁被持满整个窗口但对方恰好就绪：仍算复用成功而非误报超时。
    if (await probeSocket(socketPath)) return { socketPath, started: false };
    throw new Error(`Timed out waiting for app-server startup lock: ${lockPath}`);
  }

  let child: ChildProcess | undefined;
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let childError: Error | undefined;
  let runnerStderr = "";
  try {
    // 抢到锁 ≠ 独享 socket：上一个持锁者可能在就绪后才放锁，再探一次，
    // 复用已有 server 而不是重复拉起/误删它的 socket。
    if (await probeSocket(socketPath)) return { socketPath, started: false };

    // spawnSpec（测试注入）> ZCODE_SERVER_BIN（瘦客户端/探针指定 core 入口）> PATH zcode。
    const spec = options.spawnSpec ?? { file: env?.ZCODE_SERVER_BIN?.trim() || "zcode" };
    const runner = spec.serviceRunner ?? { file: DEFAULT_SERVICE_RUNNER };
    const unitName = resolveServiceUnitName(socketPath);

    // service env：过滤后的客户端 env + 固定项。--setenv 只传变量名，值经
    // systemd-run 自己的 env（= childEnv）解析——argv/日志里没有 secret。
    const childEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) continue;
      if (!ENV_NAME_PATTERN.test(name)) continue;
      if (isCoreEnvExcluded(name)) continue;
      childEnv[name] = value;
    }
    // 显式数据根必须传进服务进程，否则 server 端按 homedir 另解一份数据根。
    childEnv.ZCODE_DATA_BASE_DIR = dataBaseDir;
    // 中性 PWD 与 WorkingDirectory/--cwd 对齐：服务 env 不残留拉起者目录。
    childEnv.PWD = dataBaseDir;
    // attach 共享 core 标记：core 由本客户端（zcode attach / zcode-attach/piz）
    // 拉起且可被多客户端复用，任何 spawn env 里的 HERDR_PANE_ID 都不可能是
    // 全部客户端的真实 pane。~/.zcode/herdr-hook.sh 见此标记即 no-op，由
    // 客户端侧 herdr-reporter 上报真实 pane 归属
    // （docs/design/v2/tui-attach-shared-core.md）。
    childEnv[ZCODE_ATTACH_CORE_ENV] = "1";

    // UnsetEnvironment 兜底 manager 侧 env（systemctl --user import-environment
    // 带进来的）：workspace 身份与 service-instance 名恒入列（后者是 systemd
    // 通道变量，值由 manager 分配，外来同名一律是污染）；客户端归属名按
    // 调用方 env 实到补列——manager env 不可枚举，看不到的无法预防。
    const unsetEnvNames = [
      ZCODE_WORKSPACE_IDENTITY_ENV,
      ...SERVICE_INSTANCE_ENV_NAMES,
      ...Object.keys(env)
        .filter(
          (name) =>
            name !== ZCODE_WORKSPACE_IDENTITY_ENV &&
            !SERVICE_INSTANCE_ENV_NAMES.has(name) &&
            CLIENT_OWNERSHIP_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
        )
        .toSorted(),
    ];
    const runnerArgs = buildServiceRunnerArgs({
      unitName,
      dataBaseDir,
      socketPath,
      spec,
      runnerArgsPrefix: runner.argsPrefix ?? [],
      forwardedEnvNames: Object.keys(childEnv).toSorted(),
      unsetEnvNames,
    });

    options.log?.(`app-server: requesting shared core start via ${unitName}`);
    child = spawn(runner.file, runnerArgs, {
      // 拉起器是短寿命注册进程，不是 core 本身：env 带过滤后的 service env
      // 供 --setenv=NAME 解析；stderr 接管收集做失败上下文；stdin/stdout 断开。
      env: childEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (runnerStderr.length < SERVICE_RUNNER_STDERR_LIMIT) {
        runnerStderr += chunk.slice(0, SERVICE_RUNNER_STDERR_LIMIT - runnerStderr.length);
      }
    });
    child.once("error", (error) => {
      childError = error;
    });
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
    });
    // 'spawn' 未触发说明拉起器根本没起来（ENOENT/权限），直接携带原始
    // error 失败；不能把没出生的进程写进 .pid/.info 登记成 owner。
    await new Promise<void>((resolve, reject) => {
      child!.once("spawn", () => resolve());
      child!.once("error", (error) =>
        reject(
          new Error(`app-server service manager spawn failed: ${error.message}`, {
            cause: error,
          }),
        ),
      );
    });

    // .pid/.info 由 server 端在 listen 成功后自登记（bind 成功者才是 owner）；
    // 客户端在这里写会在双拉起竞争下登记死进程，也从不把登记文件当就绪/归属
    // 证据读——它可能滞后或陈旧（上次 core 的残留）。本端只等 socket 就绪。
    // 就绪窗口从拉起器进程 OS spawn 完成起算（'spawn' 事件之后、manager 受理
    // 结果返回之前），不吃前面锁等待的预算：锁竞争获胜时剩余的锁预算可能已
    // 近零，不能把刚受理的 core 立刻判死。
    const readyDeadline = now() + waitForSocketMs;
    for (;;) {
      if (childError) {
        throw new Error(
          `app-server service manager failed (unit ${unitName}): ${childError.message}`,
          { cause: childError },
        );
      }
      if (childExit && childExit.code !== 0) {
        // 受理失败：报错前再探一次 socket——同名 unit 可能已被并行启动
        // 的先前请求带起，或者先前仍在启动的服务此刻刚就绪。
        if (await probeSocket(socketPath)) return { socketPath, started: false };
        const detail = sanitizeRunnerStderr(runnerStderr);
        throw new Error(
          `app-server service start failed (unit ${unitName}, exit=${childExit.code}, ` +
            `signal=${childExit.signal})${detail ? `: ${detail}` : ""}`,
        );
      }
      if (await probeSocket(socketPath)) {
        return { socketPath, started: true };
      }
      // childExit.code === 0：服务被受理，core 仍在 exec/listen——继续探测。
      if (now() >= readyDeadline) {
        throw new Error(
          `Timed out waiting for app-server socket: ${socketPath} ` +
            `(service unit ${unitName}; inspect with: systemctl --user status ${unitName})`,
        );
      }
      await sleep(pollIntervalMs);
    }
  } catch (error) {
    // 失败路径只回收仍在运行的拉起器本身（systemd-run 是短寿命注册进程，
    // 不是共享服务）；绝不按 unit/进程组停共享 core——其他客户端可能正在用。
    if (child && !childExit && child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        /* 拉起器可能已退出 */
      }
    }
    // spawn 失败路径不清理 .pid/.info：登记权在 server 端（listen 后自写），
    // 本调用从未写过；删别人登记的文件才是破坏。socket 路径同样不归本次调用所有。
    throw error;
  } finally {
    child?.stderr?.destroy();
    child?.unref();
    await releaseOwnedLock(lockPath).catch(() => undefined);
  }
}

/**
 * 探测 socket 是否有 server 在接受连接。
 * 只有「确实没有 listener」才算空缺：ENOENT（无文件）/ECONNREFUSED（陈旧 socket
 * 无人监听）。权限等其他 IO 错误与探测超时上抛，不能当成可占用。
 */
export async function probeSocket(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out probing app-server socket: ${socketPath}`));
    }, APP_SERVER_PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

/**
 * 读已有锁决定等待策略：锁已消失 → 重抢；锁内 pid 已死或锁无效且超过 stale
 * 时限 → 经原子 rename 回收后重抢；活 pid / 刚创建的锁 → 继续等待。
 */
async function inspectHeldLock(
  lockPath: string,
  now: () => number,
): Promise<"gone" | "wait"> {
  let info;
  let raw;
  try {
    [info, raw] = await Promise.all([stat(lockPath), readFile(lockPath, "utf8")]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw error;
  }
  const pid = Number(raw.trim());
  const stale =
    Number.isInteger(pid) && pid > 0
      ? !isProcessAlive(pid)
      : now() - info.mtimeMs >= APP_SERVER_LOCK_STALE_MS;
  if (!stale) return "wait";
  return (await reclaimStaleLock(lockPath, info.ino)) ? "gone" : "wait";
}

/**
 * 原子回收 stale 锁。rename 是唯一能「移走该路径当前 inode」的原子操作，且
 * 多个竞争者里只有一方能成功。移出后比对 inode：拿到的正是先前读过并判死的
 * 那份锁才允许删除；若锁位在读后已被竞争者替换（新持锁者），把移出的 inode
 * 经 link 放回原路径（link 遇已存在路径失败，绝不覆盖），视为他人持有。
 * 这把「读判死 → 删文件」的 TOCTOU 窗口收敛到 rename 单点上。
 */
async function reclaimStaleLock(
  lockPath: string,
  expectedIno: number,
): Promise<boolean> {
  const reclaimedPath = `${lockPath}.reclaim-${process.pid}-${Date.now()}`;
  try {
    await rename(lockPath, reclaimedPath);
  } catch (error) {
    // 锁文件已被竞争者回收：锁位现状由下一轮 inspectHeldLock 重新判定。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const reclaimed = await lstat(reclaimedPath);
  if (reclaimed.ino === expectedIno) {
    await rm(reclaimedPath, { force: true });
    return true;
  }
  // rename 瞬间锁位已换成另一份（可能仍活的）锁：归还原路径，绝不替别人删锁。
  try {
    await link(reclaimedPath, lockPath);
  } catch (error) {
    // EEXIST：锁位已被新调用方写下的锁占用，移出的 inode 作废丢弃。
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await rm(reclaimedPath, { force: true });
  return false;
}

/** 只释放本调用写下的锁：内容不是自己的 pid 就留给实际持锁者。 */
async function releaseOwnedLock(lockPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    // 锁已不在或读不出内容：保守不删，由持锁者/操作者处置。
    return;
  }
  if (raw.trim() !== `${process.pid}`) return;
  await rm(lockPath, { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
