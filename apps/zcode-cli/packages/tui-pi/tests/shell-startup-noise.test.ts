// 交互 `!cmd` 启动噪声按流剥离的回归测试：stdout/stderr 是两条独立管道，
// 合并缓冲的到达顺序由调度决定（CI 42569167651 实测 probe-out 先于两行
// job-control 诊断到达）。用假 bash（真实 $SHELL 解析 + 真 spawn 的 Node
// 子进程）加 sleep 确定性复现两种交错；真 bash 的端到端用例仍在
// shell.test.ts 里。

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runShellCommand } from "../src/shell.js";

/**
 * 假 bash：$SHELL 解析走真实 exists/可执行位路径，子进程是真 spawn 的
 * Node 进程（argv `+m -ic <command>` 被忽略），stdout/stderr 的到达顺序
 * 由场景里的 sleep 决定——确定复现 CI 42569167651 上 probe-out 先于两行
 * job-control 诊断到达、合并流首剥离失败的交错。
 */
const writeFakeBash = (dir: string): string => {
  const file = join(dir, "bash");
  writeFileSync(
    file,
    `#!${process.execPath}
const NOISE =
  "bash: cannot set terminal process group (-1): Inappropriate ioctl for device\\n" +
  "bash: no job control in this shell\\n";
const LECTURE =
  'To run a command as administrator (user "root"), use "sudo <command>".\\n' +
  'See "man sudo_root" for details.\\n\\n';
const LOOKALIKE = "bash: no job control in this shell\\n";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (text) => process.stdout.write(text);
const err = (text) => process.stderr.write(text);
const scenario = process.env.ZZ_FAKE_BASH_SCENARIO;
const main = async () => {
  if (scenario === "stdout-first") {
    out("probe-out\\n");
    await sleep(200);
    err(NOISE);
  } else if (scenario === "stderr-first") {
    err(NOISE);
    await sleep(200);
    out("probe-out\\n");
  } else if (scenario === "lecture") {
    out(LECTURE + "probe-out\\n");
    await sleep(200);
    err(NOISE);
  } else if (scenario === "stdout-lookalike") {
    err(NOISE);
    await sleep(50);
    out(LOOKALIKE);
  } else if (scenario === "extra-noise") {
    err(NOISE);
    err(LOOKALIKE);
    err("rc-custom-warning\\n");
    await sleep(150);
    out("probe-out\\n");
  } else if (scenario === "nonzero") {
    err("rc failure line\\n");
    await sleep(150);
    out("partial-out\\n");
    process.exitCode = 3;
  } else if (scenario === "split-prefix") {
    // 诊断行被管道切块拆成两次写；命令输出插在中间到达。
    err("bash: cannot set terminal process group (-1): Inappropriate ioctl");
    await sleep(150);
    out("probe-out\\n");
    await sleep(150);
    err(" for device\\nbash: no job control in this shell\\n");
  } else if (scenario === "split-lecture") {
    out('To run a command as administrator (user "root"), use "sudo <command>".\\n');
    await sleep(150);
    err(NOISE);
    await sleep(150);
    out('See "man sudo_root" for details.\\n\\nprobe-out\\n');
  } else if (scenario === "spill") {
    err(NOISE);
    await sleep(150);
    for (let i = 1; i <= 3000; i++) out(\`line-\${i}\\n\`);
  } else if (scenario === "evicted-head") {
    err("stderr-first-user-line\\n");
    await sleep(150);
    // 逐行大流量把 stderr 首块挤出滚动缓冲；sleep 让诊断落在保留段尾部。
    for (let i = 0; i < 700; i++) out("x".repeat(199) + "\\n");
    await sleep(150);
    err(LOOKALIKE);
  } else {
    err(\`unknown scenario: \${scenario}\\n\`);
    process.exitCode = 2;
  }
};
void main();
`,
  );
  chmodSync(file, 0o755);
  return file;
};

test("interactive startup-noise strip is per-stream, not pipe arrival order", async (t) => {
  if (process.platform === "win32") {
    // 假 bash 依赖 POSIX shebang/可执行位；Windows 上 $SHELL 分支不走、
    // resolveEscapeShell 走 Git Bash 链，本用例无从挂接。
    t.skip("fake-bash fixture requires POSIX shebang + exec bit");
    return;
  }
  const bindir = mkdtempSync(join(tmpdir(), "zcode-shell-fakebash-"));
  const cwd = mkdtempSync(join(tmpdir(), "zcode-shell-order-"));
  try {
    const shell = writeFakeBash(bindir);
    const envFor = (scenario: string): NodeJS.ProcessEnv => ({
      ...process.env,
      SHELL: shell,
      ZZ_FAKE_BASH_SCENARIO: scenario,
    });
    // CI 失败形态（stdout 先到）与正常形态（stderr 先到）都必须剥干净。
    for (const scenario of ["stdout-first", "stderr-first"] as const) {
      const run = await runShellCommand({ command: "probe", cwd, env: envFor(scenario) });
      assert.equal(run.exitCode, 0, `${scenario}: ${run.output}`);
      assert.equal(run.output, "probe-out\n", scenario);
    }
    // stdout 流首的 Ubuntu sudo 提示整块剔除，stderr 噪声同样剔除。
    const lecture = await runShellCommand({ command: "probe", cwd, env: envFor("lecture") });
    assert.equal(lecture.output, "probe-out\n");
    // 用户 stdout 里长得像 job-control 的行不按 stderr 规则剥。
    const lookalike = await runShellCommand({ command: "probe", cwd, env: envFor("stdout-lookalike") });
    assert.equal(lookalike.output, "bash: no job control in this shell\n");
    // 诊断行被管道切块拆成多块的跨块流首拼接：剥离按拼接后的流首匹配，
    // 插在中间到达的命令输出不受影响。
    const split = await runShellCommand({ command: "probe", cwd, env: envFor("split-prefix") });
    assert.equal(split.output, "probe-out\n");
    // sudo 提示块同样跨块拆分、与 stderr 噪声交错：仍整块剔除。
    const splitLecture = await runShellCommand({ command: "probe", cwd, env: envFor("split-lecture") });
    assert.equal(splitLecture.output, "probe-out\n");
    // 2 行上限之外的第 3 条同款行与非匹配 rc 行都保留，不宽泛剥离。
    const extra = await runShellCommand({ command: "probe", cwd, env: envFor("extra-noise") });
    assert.equal(
      extra.output,
      "bash: no job control in this shell\nrc-custom-warning\nprobe-out\n",
    );
    // 非零退出码与其余 stderr 输出原样保留。
    const nonzero = await runShellCommand({ command: "probe", cwd, env: envFor("nonzero") });
    assert.equal(nonzero.exitCode, 3);
    assert.equal(nonzero.output, "rc failure line\npartial-out\n");
    // spill 保留原始流首噪声（行数兜底开启也回填 stderr 块），尾部已剔除。
    const spill = await runShellCommand({ command: "probe", cwd, env: envFor("spill") });
    assert.equal(spill.truncated, true);
    assert.ok(!spill.output.includes("job control"), spill.output);
    assert.ok(spill.output.startsWith("line-1001\n"), spill.output.slice(0, 30));
    assert.ok(spill.fullOutputPath);
    const spilled = readFileSync(spill.fullOutputPath!, "utf8");
    assert.ok(
      spilled.startsWith("bash: cannot set terminal process group"),
      "spill keeps raw startup noise",
    );
    assert.ok(spilled.includes("line-3000\n"), "spill keeps full output");
    rmSync(spill.fullOutputPath!, { force: true });
    // 流首已被滚动淘汰的流不再剥离：保留段流首的同款行其实是中段用户输出。
    const evicted = await runShellCommand({ command: "probe", cwd, env: envFor("evicted-head") });
    assert.ok(
      evicted.output.includes("bash: no job control in this shell"),
      "retained mid-stream lookalike must survive head eviction",
    );
    if (evicted.fullOutputPath) {
      assert.ok(
        readFileSync(evicted.fullOutputPath, "utf8").includes("stderr-first-user-line"),
        "spill keeps the evicted head",
      );
      rmSync(evicted.fullOutputPath, { force: true });
    }
  } finally {
    rmSync(bindir, { force: true, recursive: true });
    rmSync(cwd, { force: true, recursive: true });
  }
});
