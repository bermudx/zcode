import type { Stats } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Logger } from "@zcode/contracts";

/** 区分「陈旧的 socket 文件」与「另一个存活 server」的探测时限。 */
const SOCKET_PROBE_TIMEOUT_MS = 500;

export interface ProtocolSocketListener {
  readonly socketPath: string;
  /** listener 完全关闭（close() 或运行期致命错误）后 resolve；永不 reject。 */
  readonly closed: Promise<void>;
  /** 停止接受新连接、销毁已接入 socket、删除 socket 文件（非 Windows）。幂等。 */
  close(): Promise<void>;
}

export interface ProtocolSocketListenerOptions {
  socketPath: string;
  /**
   * 每接入一个客户端同步调用一次；socket 输入在回调接入流监听前由内核缓冲，
   * 回调内部允许先做完异步装配再开始读。
   */
  onConnection: (socket: Socket) => void;
  signal?: AbortSignal;
  logger?: Logger;
  /** 注入测试；默认 process.platform。Windows 下 socketPath 是 named pipe，不落文件。 */
  platform?: NodeJS.Platform | string;
}

/**
 * `zcode app-server --socket <path>` 的传输层监听。
 *
 * 所有权边界：listener 只负责接入与存活期的 socket 文件；每个已接入连接上的
 * 协议 server / session / 插件资源归入口层 attach 回调所有——连接断开由
 * `ZCodeProtocolAgentServer.disconnectClient` + shutdown 走现有 owner 语义，
 * listener 不干预。进程退出路径统一走 close()，不做 idle 自动退出。
 */
export async function listenProtocolSocket(
  options: ProtocolSocketListenerOptions,
): Promise<ProtocolSocketListener> {
  const socketPath = options.socketPath;
  const platform = options.platform ?? process.platform;
  const fileBacked = platform !== "win32";
  const sockets = new Set<Socket>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  options.signal?.throwIfAborted();
  if (fileBacked) {
    await mkdir(dirname(socketPath), { recursive: true });
    await reclaimStaleSocketFile(socketPath);
  }
  options.signal?.throwIfAborted();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // 连接在异步 attach 完成前就可能被对端 reset；没有 error 监听，晚期
    // ECONNRESET 会成为未处理异常。这里只观测，连接所有权仍归 attach 回调。
    socket.on("error", (error) => {
      options.logger?.warn("ZCode Protocol socket client transport error", {
        errorType: error instanceof Error ? error.name : typeof error,
        event: "zcode_protocol.socket.client.error",
        module: "bootstrap.zcode_protocol",
      });
    });
    try {
      options.onConnection(socket);
    } catch (error) {
      options.logger?.warn("ZCode Protocol socket connection attach failed", {
        errorType: error instanceof Error ? error.name : typeof error,
        event: "zcode_protocol.socket.attach.failed",
        module: "bootstrap.zcode_protocol",
      });
      socket.destroy();
    }
  });
  let bound = false;
  const listenSettled = new Promise<{ error?: Error }>((resolve) => {
    server.once("listening", () => {
      bound = true;
      resolve({});
    });
    server.once("error", (error) => resolve({ error }));
  });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      options.signal?.removeEventListener("abort", onAbort);
      // listen 仍在进行中时先等它分出胜负：只有 bind 成功的 listener 才拥有
      // socket 文件；未 bound 时绝不能 unlink——那可能是另一个存活 listener
      // 的路径，或根本不是 socket。bound 后由 Node 的 server.close 自行移除文件。
      const outcome = await listenSettled;
      if (!bound) {
        resolveClosed();
        return;
      }
      // 先毁连接再 close：server.close 只在既有连接全部结束后才返回。
      // Set 迭代期间 delete 是安全的（'close' 回调里 sockets.delete）。
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      resolveClosed();
    })();
    return closePromise;
  };
  const onAbort = () => void close();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  server.on("error", (error) => {
    options.logger?.error("ZCode Protocol socket listener failed", error, {
      event: "zcode_protocol.socket.listener.failed",
      module: "bootstrap.zcode_protocol",
    });
    void close();
  });

  server.listen(socketPath);
  const outcome = await listenSettled;
  if (outcome.error) {
    // bind 竞争落败（回收后被另一进程抢先）：再探一次，存活 server 报明确错误
    // 而不是把裸 EADDRINUSE 抛给调用方。
    if (
      (outcome.error as NodeJS.ErrnoException).code === "EADDRINUSE" &&
      fileBacked &&
      (await probeProtocolSocket(socketPath))
    ) {
      throw new Error(`ZCode Protocol socket is already serving: ${socketPath}`);
    }
    throw outcome.error;
  }
  // abort 在 listen 成功后到达：close() 走 bound 分支正常释放 path 与连接。
  options.signal?.throwIfAborted();

  return {
    socketPath,
    closed,
    close,
  };
}

/**
 * 探测 socket 是否仍有 server 在接受连接。
 * 只有「确实没有 listener」才算空缺：ENOENT（无文件）/ECONNREFUSED（陈旧 socket
 * 无人监听）。权限等其他 IO 错误与探测超时上抛，不能当成可回收。
 */
export async function probeProtocolSocket(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out probing protocol socket: ${socketPath}`));
    }, SOCKET_PROBE_TIMEOUT_MS);
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
 * socket 文件残留（上次进程被杀没走到 close）不是占用证据；先探测，连不上才回收。
 * 只回收真正的陈旧 unix socket：lstat 判型，普通文件、目录、symlink 一律不删
 * （由后续 bind 失败或这里的拒绝错误原样上抛）。回收与 listen 之间另一进程可能
 * 抢先绑定——此时 listen 抛 EADDRINUSE，照常上抛。
 */
async function reclaimStaleSocketFile(socketPath: string): Promise<void> {
  let before: Stats;
  try {
    before = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!before.isSocket()) {
    throw new Error(
      `Refusing to remove non-socket file at protocol socket path: ${socketPath}`,
    );
  }
  if (await probeProtocolSocket(socketPath)) {
    throw new Error(`ZCode Protocol socket is already serving: ${socketPath}`);
  }
  // 探测失败到删除不是原子的：期间另一进程可能已重新 bind 同路径。inode 变化
  // 或文件消失即放弃回收，交给 listen 的 EADDRINUSE/already-serving 兜底——
  // 绝不能 unlink 一个刚绑定、正在提供服务的 socket。
  const after = await lstat(socketPath).catch(() => undefined);
  if (!after || !after.isSocket() || after.ino !== before.ino) return;
  await rm(socketPath, { force: true });
}
