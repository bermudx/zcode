import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import {
  appServerAttachWorkspaceSchema,
  resolveWorkspaceKey,
  ZCODE_WORKSPACE_IDENTITY_ENV,
  type AppServerAttachWorkspace,
} from "@zcode/shared";

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

/** attach 共享 core 的 herdr 抑制标记：core env 烘焙的 pane 归属对
 *  spawn 之后 attach 进来的其他客户端无效，`~/.zcode/herdr-hook.sh`
 *  见此标记即 no-op（docs/design/v2/tui-attach-shared-core.md）。 */
export const ZCODE_ATTACH_CORE_ENV = "ZCODE_ATTACH_CORE";

/** 子进程形态：默认 PATH 上的 `zcode`；测试可注入 node + 假 server 脚本。 */
export interface AppServerSpawnSpec {
  file: string;
  argsPrefix?: readonly string[];
}

export interface EnsureAppServerOptions {
  workspace: AppServerAttachWorkspace;
  /** 显式 socket 路径（调试用）；默认按 workspace 身份派生。 */
  socketPath?: string;
  env?: NodeJS.ProcessEnv;
  /** 与 provider-runtime-env 同一约定：<dataBaseDir>/.zcode/v2/sockets。 */
  dataBaseDir?: string;
  /** 写入 .info 的 zcode 版本。 */
  version?: string;
  spawnSpec?: AppServerSpawnSpec;
  waitForSocketMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform | string;
}

export interface EnsureAppServerResult {
  socketPath: string;
  /** true = 本次调用拉起了新 server；false = 复用了已在监听的 server。 */
  started: boolean;
  pid?: number;
}

/**
 * 派生共享 core 的 socket 路径：`<dataBaseDir>/.zcode/v2/sockets/core-<hash>.sock`，
 * hash = sha256(resolveWorkspaceKey(workspace)).slice(0,16)，与 project-root 同一摘要约定。
 * Windows 下 Unix socket 文件不可用，按 Node 约定退到 named pipe。
 */
export function resolveSocketPath(
  workspace: AppServerAttachWorkspace,
  options: Pick<EnsureAppServerOptions, "dataBaseDir" | "env" | "platform"> = {},
): string {
  const parsed = appServerAttachWorkspaceSchema.parse(workspace);
  const hash = createHash(APP_SERVER_HASH_ALGORITHM)
    .update(resolveWorkspaceKey(parsed))
    .digest("hex")
    .slice(0, APP_SERVER_HASH_LENGTH);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return `${WINDOWS_PIPE_PREFIX}${hash}`;
  }
  const env = options.env ?? process.env;
  const dataBaseDir =
    options.dataBaseDir ?? env.ZCODE_DATA_BASE_DIR?.trim() ?? homedir();
  return join(dataBaseDir, ".zcode", "v2", "sockets", `core-${hash}.sock`);
}

/**
 * 幂等拉起共享 core：先探测已有 socket；不存在时经 O_CREAT|O_EXCL 原子锁保证
 * 并发调用者中只有一人 spawn `zcode app-server --socket <path> --no-plugins`
 * （detached + setsid + stdio ignore + unref），写出 .pid/.info 后等待 socket 就绪。
 */
export async function ensureServer(
  options: EnsureAppServerOptions,
): Promise<EnsureAppServerResult> {
  const workspace = appServerAttachWorkspaceSchema.parse(options.workspace);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // Unix-only：spawn 不走 shell，任何文件系统/探测之前先拒绝。
  if (platform === "win32") {
    throw new Error("ensureServer does not support spawning app-server on win32");
  }
  if (options.socketPath !== undefined && options.socketPath.trim().length === 0) {
    throw new Error("socketPath must be a non-empty path when provided");
  }
  const socketPath = options.socketPath ?? resolveSocketPath(workspace, options);
  const waitForSocketMs = options.waitForSocketMs ?? APP_SERVER_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? APP_SERVER_PROBE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + waitForSocketMs;

  if (await probeSocket(socketPath)) {
    return { socketPath, started: false };
  }

  await mkdir(dirname(socketPath), { recursive: true });
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
  try {
    // 抢到锁 ≠ 独享 socket：上一个持锁者可能在就绪后才放锁，再探一次，
    // 复用已有 server 而不是重复 spawn/误删它的 socket。
    if (await probeSocket(socketPath)) return { socketPath, started: false };

    // spawnSpec（测试注入）> ZCODE_SERVER_BIN（瘦客户端/探针指定 core 入口）> PATH zcode。
    const spec = options.spawnSpec ?? { file: env?.ZCODE_SERVER_BIN?.trim() || "zcode" };
    const args = [
      ...(spec.argsPrefix ?? []),
      "app-server",
      "--socket",
      socketPath,
      "--no-plugins",
      "--cwd",
      workspace.workspacePath,
    ];
    const childEnv = { ...env };
    // 显式 dataBaseDir 必须传进子进程，否则 server 端按 homedir 另解一份数据根。
    if (options.dataBaseDir) childEnv.ZCODE_DATA_BASE_DIR = options.dataBaseDir;
    const identityKey = resolveWorkspaceKey(workspace);
    if (identityKey) childEnv[ZCODE_WORKSPACE_IDENTITY_ENV] = identityKey;
    // attach 共享 core 标记：core 由本客户端（zcode attach / zcode-attach/piz）
    // spawn 且可被多客户端复用，spawn env 里烘焙的 HERDR_PANE_ID 只对首个
    // 客户端成立。~/.zcode/herdr-hook.sh 见此标记即 no-op，由客户端侧
    // herdr-reporter 上报真实 pane 归属（docs/design/v2/tui-attach-shared-core.md）。
    childEnv[ZCODE_ATTACH_CORE_ENV] = "1";
    child = spawn(spec.file, args, {
      // detached 在 POSIX 走 setsid；不启用 shell，spawnSpec.file 必须直接可执行。
      detached: true,
      env: childEnv,
      stdio: "ignore",
    });
    child.once("error", (error) => {
      childError = error;
    });
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
    });
    child.unref();
    // 'spawn' 未触发说明二进制根本没起来（ENOENT/权限），直接携带原始 error 失败；
    // 不能把没出生的进程写进 .pid/.info 登记成 owner。
    await new Promise<void>((resolve, reject) => {
      child!.once("spawn", () => resolve());
      child!.once("error", (error) =>
        reject(
          new Error(`app-server spawn failed: ${error.message}`, {
            cause: error,
          }),
        ),
      );
    });

    // .pid/.info 由 server 端在 listen 成功后自登记（bind 成功者才是 owner）；
    // 客户端在这里写会在双 spawn 竞争下登记死进程。本端只等 socket 就绪。
    // 就绪窗口从 spawn 完成起算，不吃前面锁等待的预算：锁竞争获胜时剩余的
    // 锁预算可能已近零，不能把刚出生的 core 立刻判死。
    const readyDeadline = now() + waitForSocketMs;
    while (now() < readyDeadline) {
      if (childError) {
        throw new Error(`app-server spawn failed: ${childError.message}`, {
          cause: childError,
        });
      }
      if (childExit) {
        throw new Error(
          `app-server exited before accepting on ${socketPath} (code=${childExit.code}, signal=${childExit.signal})`,
        );
      }
      if (await probeSocket(socketPath)) {
        return { socketPath, started: true, pid: child.pid };
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`Timed out waiting for app-server socket: ${socketPath}`);
  } catch (error) {
    // spawn 失败路径回收现场，避免留下半初始化文件误导下一次调用。
    if (child?.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        /* 子进程可能已退出 */
      }
    }
    // spawn 失败路径不清理 .pid/.info：登记权在 server 端（listen 后自写），
    // 本调用从未写过；删别人登记的文件才是破坏。socket 路径同样不归本次调用所有。
    throw error;
  } finally {
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
