import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { isStrayTerminalResponse, QuietProcessTerminal } from "../src/terminal-input-filter.js";
import { queryTerminalColorsAtStartup } from "../src/terminal-startup.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

test("isStrayTerminalResponse: 应答序列被识别为需丢弃", () => {
  const strays = [
    "\x1b[?1;2;4c", // DA1
    "\x1b[?62;4;6;22c", // DA1 多参数
    "\x1b[>0;1;0c", // DA2
    "\x1b]10;rgb:ffff/ffff/ffff\x07", // OSC 10 BEL
    "\x1b]11;rgb:0000/0000/0000\x1b\\", // OSC 11 ST
    "\x1b]4;0;rgb:abab/cdcd/efef\x07", // OSC 4
    "\x1b]52;c;aGVsbG8=\x07", // OSC 52 剪贴板回复
    "\x1bP>|xterm(382)\x1b\\", // DCS XTVersion
    "\x1b_Ga=1,f=24;\x1b\\", // APC kitty graphics
    "\x1b[?1;2y", // DECRQM
    "\x1b[24;80R", // CPR
  ];
  for (const sequence of strays) {
    assert.ok(isStrayTerminalResponse(sequence), `should drop ${JSON.stringify(sequence)}`);
  }
});

test("isStrayTerminalResponse: 正常按键与 lib 消费的应答不误伤", () => {
  const keep = [
    "a",
    "\r",
    "\x1b", // 孤 ESC 是 Escape 键
    "\x1b[A", // 上箭头
    "\x1b[Z", // Shift+Tab
    "\x1b[1;5A", // Ctrl+Up
    "\x1b[200~pasted\x1b[201~", // bracketed paste
    "\x1b[6;480;1280t", // cell-size 应答（queryCellSize 特性路径）
    "\x1b[?997;1n", // DEC 2031 配色上报（lib 无条件消费）
    "\x1b[>4;2m".replace("m", "~"), // 防呆：~ 结尾按键序列
    "\x1b[I", // focus in
    "\x1b[O", // focus out
  ];
  for (const sequence of keep) {
    assert.equal(isStrayTerminalResponse(sequence), false, `should keep ${JSON.stringify(sequence)}`);
  }
});

test("queryTerminalColorsAtStartup: DA1 哨兵收尾、颜色解析、用户字节 unshift", async () => {
  const stdin = new PassThrough();
  let sent = "";
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      sent += chunk.toString("latin1");
      cb();
    },
  }) as unknown as NodeJS.WriteStream;

  const promise = queryTerminalColorsAtStartup({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    timeoutMs: 2000,
  });
  assert.ok(sent.includes("\x1b]10;?"), "OSC 10 query sent");
  assert.ok(sent.includes("\x1b[c"), "DA1 sentinel sent");

  const started = Date.now();
  stdin.write("\x1b]10;rgb:aaaa/bbbb/cccc\x07");
  stdin.write("\x1b]11;rgb:1010/2020/3030\x1b\\"); // ST 结尾形态
  stdin.write("\x1b]4;0;rgb:0000/0000/0000\x07");
  stdin.write("hi"); // 排空窗口内的用户按键
  stdin.write("\x1b[?1;2;4c"); // DA1 哨兵 → 完成

  const colors = await promise;
  assert.ok(Date.now() - started < 1000, "DA1 sentinel must finish promptly, not via timeout");
  assert.deepEqual(colors.foreground, { r: 170, g: 187, b: 204 });
  assert.deepEqual(colors.background, { r: 16, g: 32, b: 48 });
  assert.equal(colors.palette, undefined, "16 色未齐时 palette 不上报");

  // 用户字节经 unshift 回到流里，不丢输入。
  const leftover = stdin.read() as Buffer | null;
  assert.ok(leftover !== null && leftover.toString("latin1").includes("hi"));
});

test("queryTerminalColorsAtStartup: 应答迟到跨 chunk 也能解析", async () => {
  const stdin = new PassThrough();
  const stdout = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream;
  const promise = queryTerminalColorsAtStartup({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    timeoutMs: 2000,
  });
  // OSC 回复切成两瓣到达，哨兵在第三瓣。
  const started = Date.now();
  stdin.write("\x1b]11;rgb:ff");
  stdin.write("ff/ffff/ffff\x07\x1b[?1;2;4c");
  const colors = await promise;
  assert.ok(Date.now() - started < 1000, "DA1 sentinel must finish promptly");
  assert.deepEqual(colors.background, { r: 255, g: 255, b: 255 });
});

test("queryTerminalColorsAtStartup: 终端不应答时按超时兜底", async () => {
  const stdin = new PassThrough();
  const stdout = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream;
  const started = Date.now();
  const colors = await queryTerminalColorsAtStartup({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    timeoutMs: 80,
  });
  assert.ok(Date.now() - started >= 80);
  assert.equal(colors.foreground, undefined);
});

const hasScript = (): boolean => {
  try {
    execFileSync("script", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// responding-pty：script(1) 的 pty 当终端——父进程看见查询后回 OSC 10/11、
// OSC 4;0..15 全套与 DA 哨兵，再在渲染完成后补发迟到回复与用户抢跑按键。
// 断言：回复字节零回显零渲染；用户按键经 unshift 存活并出现在 composer。
test("responding pty: 回复零回显、迟到回复被吞、TUI 渲染 status line", async (t) => {
  if (process.platform !== "linux" || !hasScript()) {
    t.skip("needs Linux + util-linux `script` for a real pty");
    return;
  }

  const fixture = resolve(TEST_DIR, "fixtures/pi-tui-pty-child.ts");
  const child = spawn(
    "script",
    ["-qefc", `"${process.execPath}" --import tsx "${fixture}"`, "/dev/null"],
    {
      env: { ...process.env, TERM: "xterm-256color" },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );

  const FG_MARK = "rgb:ee11/ee22/ee33";
  const BG_MARK = "rgb:1010/2020/3030";
  const LATE_MARK = "rgb:ab12/cd34/ef56";
  const DA_REPLY = "\x1b[?1;2;4c";
  const USER_TEXT = "zzuser";

  let output = "";
  let repliesSent = false;
  let lateSent = false;
  let sawStatus = false;

  const sendReplies = () => {
    repliesSent = true;
    const palette = Array.from(
      { length: 16 },
      (_, i) => `\x1b]4;${i};rgb:0${i.toString(16)}00/0${i.toString(16)}00/0${i.toString(16)}00\x07`,
    ).join("");
    // 回复之间夹带用户按键：排空窗口内的可打印输入应经 unshift 存活。
    child.stdin.write(
      `\x1b]10;${FG_MARK}\x07` +
        `\x1b]11;${BG_MARK}\x07` +
        palette +
        USER_TEXT +
        DA_REPLY,
    );
    setTimeout(() => {
      lateSent = true;
      // 迟到回复：哨兵之后到达，必须被静默吞掉。
      child.stdin.write(`\x1b]4;0;${LATE_MARK}\x07\x1b]52;c;aGVsbG8=\x07${DA_REPLY}`);
    }, 400);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("latin1");
    if (!repliesSent && output.includes("\x1b]10;?")) {
      // 真终端的应答有 ms 级延迟；50ms 后回复更贴近实测时序。
      setTimeout(sendReplies, 50);
    }
    // meta 行恒挂：默认 mode `yolo` 一渲染即出现在 pty 输出里。
    if (repliesSent && !sawStatus && output.includes("yolo")) {
      sawStatus = true;
    }
  });

  try {
    const deadline = Date.now() + 20_000;
    while ((!sawStatus || !lateSent) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    // 给迟到回复与回显一个落地窗口。
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));

    assert.ok(repliesSent, "sentinel query observed");
    assert.ok(sawStatus, "TUI status line rendered in pty output");
    for (const marker of [FG_MARK, BG_MARK, LATE_MARK, "aGVsbG8", "1;2;4c"]) {
      assert.equal(output.includes(marker), false, `pty output must not echo/render ${marker}`);
    }
    assert.ok(output.includes(USER_TEXT), "early-typed user input survived the drain");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("QuietProcessTerminal: 排空遗留的 raw 不污染 wasRaw，stop() 落回 canonical", () => {
  // 回归：queryTerminalColorsAtStartup 排空后不回拨 raw——lib start() 按
  // stdin.isRaw 记录 wasRaw，漏写值被当成"用户原状态"，stop() 会把真实
  // 终端"恢复"成 raw（piz 退出后 tty 滞留 raw）。start() 前置 canonical
  // 拨回后，lib 记录的恢复原状必须是 cooked：termios 序列末位为 false。
  const stdin = process.stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => NodeJS.ReadStream;
  };
  // delete 需要可选项视图（ReadStream 声明里二者非可选）。
  const mutableStdin = stdin as unknown as {
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => NodeJS.ReadStream;
  };
  const stdout = process.stdout;
  const hadIsRaw = Object.prototype.hasOwnProperty.call(stdin, "isRaw");
  const originalIsRaw = stdin.isRaw;
  const hadSetRawMode = Object.prototype.hasOwnProperty.call(stdin, "setRawMode");
  const originalSetRawMode = stdin.setRawMode;
  const originalWrite = stdout.write;
  const applied: boolean[] = [];
  try {
    stdin.isRaw = true; // 模拟启动查询排空留下的 raw
    stdin.setRawMode = (mode: boolean) => {
      applied.push(mode);
      stdin.isRaw = mode;
      return stdin;
    };
    stdout.write = (() => true) as typeof stdout.write; // 吞掉协商转义序列

    const terminal = new QuietProcessTerminal();
    terminal.start(() => {}, () => {});
    terminal.stop();

    // [前置拨回 cooked, lib start() 切 raw, lib stop() 恢复记录值]
    assert.deepEqual(applied, [false, true, false]);
  } finally {
    stdout.write = originalWrite;
    if (hadSetRawMode && originalSetRawMode !== undefined) {
      stdin.setRawMode = originalSetRawMode;
    } else {
      delete mutableStdin.setRawMode;
    }
    if (hadIsRaw && originalIsRaw !== undefined) {
      stdin.isRaw = originalIsRaw;
    } else {
      delete mutableStdin.isRaw;
    }
  }
});
