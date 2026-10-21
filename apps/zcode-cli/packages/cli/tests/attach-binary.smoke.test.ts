import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

// 冒烟测试：真实 PTY（util-linux `script`）下 boot 打包产物 dist/zcode-attach.cjs，
// 由 ensureServer 经 ZCODE_SERVER_BIN 拉起真实 app-server core（dist/zcode.cjs），
// 断言 pty 日志里出现 TUI status line（`mode:`），证明 thin 客户端可独立渲染。
// 依赖产物与 POSIX 工具，环境不满足时 t.skip：
//   - linux only（`script -qefc` 为 util-linux 语法；macOS script(1) 参数不同 —— 残余风险已知）
//   - 需先 `pnpm --filter @zcode/cli build`（产物不在源码仓库内）

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ATTACH_BIN = join(PKG_ROOT, "dist", "zcode-attach.cjs");
const CORE_BIN = join(PKG_ROOT, "dist", "zcode.cjs");
const WAIT_MS = 45_000;
const POLL_MS = 250;

const hasScript = (): boolean => {
  try {
    execFileSync("script", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const terminate = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 已退出 */
    }
  }
};

test("zcode-attach.cjs boots under a pty, spawns core, renders TUI status line", async (t) => {
  if (process.platform !== "linux" || !hasScript()) {
    t.skip("needs Linux + util-linux `script` for a real pty");
    return;
  }
  if (!existsSync(ATTACH_BIN) || !existsSync(CORE_BIN)) {
    t.skip("dist/zcode-attach.cjs / dist/zcode.cjs not built");
    return;
  }

  const base = await mkdtemp(join(tmpdir(), "zcode-attach-smoke-"));
  const workspace = join(base, "workspace");
  const home = join(base, "home");
  const dataDir = join(base, "data");
  const binDir = join(base, "bin");
  const logPath = join(base, "client.log");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(binDir, { recursive: true });

  // ZCODE_SERVER_BIN 只接受单个可执行文件；shim 掉 dist 的 exec-bit 依赖。
  const serverShim = join(binDir, "zcode-core");
  await writeFile(serverShim, `#!/bin/sh\nexec "${process.execPath}" "${CORE_BIN}" "$@"\n`, "utf8");
  await chmod(serverShim, 0o755);

  // script 自成进程组（detached），kill 组即可清掉 pty+client；core 由 pid 文件清理。
  const child = spawn(
    "script",
    ["-qefc", `cd '${workspace}' && '${process.execPath}' '${ATTACH_BIN}'`, logPath],
    {
      detached: true,
      env: {
        ...process.env,
        HOME: home,
        ZCODE_DATA_BASE_DIR: dataDir,
        ZCODE_SERVER_BIN: serverShim,
      },
      stdio: "ignore",
    },
  );
  child.unref();

  const socketsDir = join(dataDir, ".zcode", "v2", "sockets");
  const serverPid = async (): Promise<number | undefined> => {
    try {
      for (const name of await readdir(socketsDir)) {
        if (name.endsWith(".pid")) {
          const pid = Number((await readFile(join(socketsDir, name), "utf8")).trim());
          if (Number.isInteger(pid) && pid > 0) return pid;
        }
      }
    } catch {
      /* sockets dir not created yet */
    }
    return undefined;
  };

  const deadline = Date.now() + WAIT_MS;
  let logText = "";
  let pid: number | undefined;
  try {
    while (Date.now() < deadline) {
      logText = existsSync(logPath) ? await readFile(logPath, "utf8") : "";
      pid = await serverPid();
      if (logText.includes("mode:") && pid !== undefined) break;
      await delay(POLL_MS);
    }

    assert.ok(pid !== undefined, "core pid file should exist (server auto-spawned)");
    assert.match(logText, /mode:\w+/, "pty log should contain the TUI status line");
  } finally {
    terminate(child.pid);
    const cleanupPid = pid ?? (await serverPid());
    if (cleanupPid !== undefined) {
      try {
        process.kill(cleanupPid, "SIGTERM");
      } catch {
        /* core 已退出 */
      }
    }
    await delay(300);
    await rm(base, { force: true, recursive: true });
  }
});
