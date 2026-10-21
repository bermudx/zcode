import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  listenProtocolSocket,
  probeProtocolSocket,
  type ProtocolSocketListener,
} from "../src/zcode-protocol/socket-listener.js";

const temporaryDirectories: string[] = [];
const openListeners: ProtocolSocketListener[] = [];
const openSockets: Socket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await Promise.all(openListeners.splice(0).map((listener) => listener.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function socketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-protocol-socket-"));
  temporaryDirectories.push(directory);
  return join(directory, "core-test.sock");
}

async function listenEcho(path: string): Promise<ProtocolSocketListener> {
  const listener = await listenProtocolSocket({
    socketPath: path,
    onConnection: (socket) => socket.on("data", (chunk) => socket.write(chunk)),
  });
  openListeners.push(listener);
  return listener;
}

function connectClient(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
    openSockets.push(socket);
  });
}

function roundTrip(socket: Socket, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("data", (chunk) => resolve(chunk.toString("utf8")));
    socket.once("error", reject);
    socket.write(payload);
  });
}

describe.skipIf(process.platform === "win32")("listenProtocolSocket", () => {
  it("accepts multiple concurrent client connections", async () => {
    const path = await socketPath();
    await listenEcho(path);

    const [first, second] = await Promise.all([
      connectClient(path),
      connectClient(path),
    ]);
    await expect(roundTrip(first, "hello-a\n")).resolves.toBe("hello-a\n");
    await expect(roundTrip(second, "hello-b\n")).resolves.toBe("hello-b\n");
  });

  it("close() destroys clients and removes the socket file", async () => {
    const path = await socketPath();
    const listener = await listenEcho(path);
    const client = await connectClient(path);
    const clientClosed = new Promise<void>((resolve) =>
      client.once("close", () => resolve()),
    );

    await listener.close();
    await clientClosed;
    await expect(stat(path)).rejects.toThrow();
    await expect(listener.closed).resolves.toBeUndefined();
  });

  it("reclaims a stale socket file but refuses to hijack a live listener", async () => {
    const path = await socketPath();
    // 真陈旧 socket：子进程 bind 后被 SIGKILL，socket 文件残留但无人监听。
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(path)});`,
      ],
      { stdio: "ignore" },
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await stat(path).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    // 等内核释放占用：被 SIGKILL 后 socket 文件仍在，connect 立即 ECONNREFUSED。
    expect(await probeProtocolSocket(path)).toBe(false);

    const listener = await listenEcho(path);
    expect(await probeProtocolSocket(path)).toBe(true);
    await listener.close();

    // 存活 listener：不能抢占同一个 socket path。
    await listenEcho(path);
    await expect(listenEcho(path)).rejects.toThrow(/already serving/);
  });

  it("refuses to remove a non-socket file at the socket path", async () => {
    const path = await socketPath();
    await writeFile(path, "not a socket");
    await expect(listenEcho(path)).rejects.toThrow(/non-socket file/);
    expect(await readFile(path, "utf8")).toBe("not a socket");
  });
});
