// 仅隔离复现：复制已安装产物，禁网，不读取用户配置，也不触碰现有 core。
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

type JsonObject = Record<string, unknown>;
type Pending = { resolve(value: JsonObject): void; reject(error: Error): void };
type ProbeClient = {
  child: ChildProcessWithoutNullStreams;
  diagnostics(): string;
  exited: Promise<number | null>;
  rpc: JsonLines;
  scope?: string;
};

function object(value: unknown): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "expected JSON object");
  return value as JsonObject;
}

class JsonLines {
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly output: Writable;

  constructor(input: Readable, output: Writable) {
    this.output = output;
    const reader = createInterface({ input });
    reader.on("line", (line) => {
      try {
        const message = object(JSON.parse(line) as unknown);
        if (typeof message.id !== "number") return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          const error = object(message.error);
          pending.reject(new Error(`RPC error: ${String(error.message)}`));
        } else {
          pending.resolve(object(message.result));
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    reader.on("close", () => this.fail(new Error("RPC stream closed")));
    input.on("error", (error) => this.fail(error));
    output.on("error", (error) => this.fail(error));
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = ++this.sequence;
    return await new Promise<JsonObject>((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 40_000);
      this.pending.set(id, {
        reject: (error) => { clearTimeout(timer); reject(error); },
        resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
      });
      this.output.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
    });
  }
}

const argument = process.argv.indexOf("--runtime");
assert.ok(argument >= 0 && process.argv[argument + 1],
  "Usage: node scripts/repro-acp-core-lifetime.mts --runtime /path/to/dist-runtime [--case plain-eof|scope-cleanup]");
const caseIndex = process.argv.indexOf("--case");
const selectedCase = caseIndex < 0 ? "both" : process.argv[caseIndex + 1];
assert.ok(selectedCase === "both" || selectedCase === "plain-eof" || selectedCase === "scope-cleanup", "invalid --case");
assert.equal(process.platform, "linux", "this reproduction uses Linux systemd scopes");
const installed = resolve(process.argv[argument + 1]!);
const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
const base = await mkdtemp(join(tmpdir(), "piz-acp-lifetime-"));
const runtime = join(base, "runtime");
await mkdir(runtime);
for (const name of ["zcode.cjs", "zcode-attach.cjs", "provider"]) {
  await cp(join(installed, name), join(runtime, name), { recursive: true });
}
await symlink(join(installed, "node_modules"), join(runtime, "node_modules"));
const buildId = (await readFile(join(installed, "PROMOTED_FROM"), "utf8")).trim();
const node = process.execPath;
const path = `${dirname(node)}:/usr/bin:/bin`;
const managerEnv = { PATH: path, XDG_RUNTIME_DIR: runtimeDir };
const events: JsonObject[] = [];
function record(event: string, fields: JsonObject = {}): void {
  const entry = { at: new Date().toISOString(), event, ...fields };
  events.push(entry);
  console.log(JSON.stringify(entry));
}

async function command(file: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolveCommand, reject) => {
    const child = spawn(file, args, { env: managerEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolveCommand(stdout.trim())
      : reject(new Error(`${file} exited ${code}: ${stderr.trim()}`)));
  });
}

async function until<T>(label: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await delay(50);
  }
  throw new Error(`timed out: ${label}`);
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

async function scenario(scoped: boolean): Promise<void> {
  const name = scoped ? "scope-cleanup" : "plain-eof";
  const dir = join(base, name);
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  const trace = join(dir, "core-signals.log");
  await mkdir(home, { recursive: true });
  await mkdir(workspace);
  const shim = join(dir, "core");
  await writeFile(shim, `#!/bin/sh\nexec /usr/bin/strace -ff -qq -e trace=none -e signal=SIGTERM,SIGHUP,SIGINT -o ${quote(trace)} ${quote(node)} ${quote(join(runtime, "zcode.cjs"))} "$@"\n`);
  await chmod(shim, 0o755);
  const env = {
    ...managerEnv,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    ZCODE_DATA_BASE_DIR: home,
    ZCODE_SERVER_BIN: shim,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(runtime, "provider", "zcode-builtin.json"),
  };
  const clients: ProbeClient[] = [];
  const scopes: string[] = [];
  const pids = new Set<number>();
  const socketsDir = join(home, ".zcode", "v2", "sockets");
  const coreInfo = async (): Promise<{ pid: number; socket: string } | undefined> => {
    const names = await readdir(socketsDir).catch((): string[] => []);
    const pidFile = names.find((entry) => entry.endsWith(".pid"));
    if (!pidFile) return undefined;
    const text = await readFile(join(socketsDir, pidFile), "utf8").catch(() => "");
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 1) return undefined;
    pids.add(pid);
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    const parent = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]);
    if (parent > 1) {
      const commandLine = await readFile(`/proc/${parent}/cmdline`, "utf8").catch(() => "");
      if (commandLine.includes(trace)) pids.add(parent);
    }
    return { pid, socket: join(socketsDir, pidFile.replace(/\.pid$/, "")) };
  };

  const startClient = async (): Promise<ProbeClient> => {
    const scope = scoped ? `piz-repro-${randomUUID()}.scope` : undefined;
    const args = ["--user", "--map-current-user", "--net", node, join(runtime, "zcode-attach.cjs"), "acp"];
    const child = scope
      ? spawn("/usr/bin/systemd-run", [
        "--user", "--scope", "--quiet", `--unit=${scope}`,
        "--property=TimeoutStopSec=3s", "--property=Delegate=yes", "--", "/usr/bin/unshare", ...args,
      ], { env, cwd: workspace, stdio: "pipe" })
      : spawn("/usr/bin/unshare", args, { env, cwd: workspace, stdio: "pipe" });
    if (scope) scopes.push(scope);
    const exited = new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
    const client = { child, diagnostics: () => diagnostics, exited, rpc: new JsonLines(child.stdout, child.stdin), scope };
    clients.push(client);
    child.on("error", (error) => record("client-spawn-error", { name, error: error.message }));
    try {
      await client.rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    } catch (error) {
      await writeFile(join(dir, `client-${clients.length}.stderr`), diagnostics);
      throw error;
    }
    return client;
  };

  const newSession = async (client: ProbeClient): Promise<string> => {
    const result = await client.rpc.request("session/new", { cwd: workspace, mcpServers: [] });
    assert.equal(typeof result.sessionId, "string");
    return result.sessionId as string;
  };

  try {
    const original = await startClient();
    const originalSession = await newSession(original);
    const firstCore = await until("first core PID", coreInfo);
    const replacement = await startClient();
    const replacementSession = await newSession(replacement);
    const sharedCore = await until("shared core PID", coreInfo);
    assert.equal(sharedCore.pid, firstCore.pid, "clients must reuse the same core");
    const cgroup = (await readFile(`/proc/${firstCore.pid}/cgroup`, "utf8")).trim();
    const replacementScope = replacement.scope
      ? await command("/usr/bin/systemctl", ["--user", "show", "--property=ControlGroup", "--value", replacement.scope])
      : undefined;
    if (original.scope) assert.ok(cgroup.includes(original.scope), "core belongs to original client's scope");
    if (replacementScope) assert.ok(!cgroup.includes(replacement.scope!), "core is not owned by replacement scope");
    record("replacement-created", { name, originalSession, replacementSession, corePid: firstCore.pid, coreCgroup: cgroup, replacementScope });

    original.child.stdin.end();
    if (original.scope) {
      // T3 在旧 runtime scope 收口时调用同一 systemctl stop；只停本实验创建的 scope。
      await command("/usr/bin/systemctl", ["--user", "stop", original.scope]);
      await original.exited;
      const nextCore = await until("replacement core PID", async () => {
        const info = await coreInfo();
        return info && info.pid !== firstCore.pid ? info : undefined;
      });
      record("core-restarted", { name, oldPid: firstCore.pid, newPid: nextCore.pid });
      const signals = await readFile(`${trace}.${firstCore.pid}`, "utf8");
      const termination = signals.split("\n").find((line) => line.includes("SIGTERM"));
      // scope stop 同时终止 tracer，信号落盘可能输掉竞争；不能把空 trace 当成没发信号。
      record("core-signal", { name, corePid: firstCore.pid, termination: termination ?? null });
      await until("replacement transport recovery attempted", async () =>
        replacement.diagnostics().includes("attach resubscribe failed") ? true : undefined);
      record("draft-recovery-failed", { name, replacementSession });
      const result = await replacement.rpc.request("session/prompt", {
        sessionId: replacementSession,
        prompt: [{ type: "text", text: "isolated edit reproduction; network is disabled" }],
      }).then(
        () => { throw new Error("missing draft unexpectedly accepted a prompt"); },
        (error: unknown) => error instanceof Error ? error : new Error(String(error)),
      );
      assert.match(result.message, /proto\.sessionNotFound/);
      record("failure-reproduced", { name, promptError: result.message });
    } else {
      assert.equal(await original.exited, 0);
      await access(`/proc/${firstCore.pid}`);
      const result = await replacement.rpc.request("session/prompt", {
        sessionId: replacementSession,
        prompt: [{ type: "text", text: "/goal" }],
      });
      assert.equal(result.stopReason, "end_turn");
      record("control-survived", { name, corePid: firstCore.pid, stopReason: result.stopReason });
    }
  } finally {
    await coreInfo();
    for (const client of clients) client.child.stdin.end();
    for (const scope of scopes) {
      await command("/usr/bin/systemctl", ["--user", "stop", scope]).catch((error: unknown) => {
        if (error instanceof Error && /Unit .* not loaded/.test(error.message)) return;
        record("scope-cleanup-warning", { scope, error: String(error) });
      });
    }
    for (const pid of pids) {
      // core 会改 process.title，不能靠 argv 识别；只终止本实验私有 cwd 中的登记 PID。
      const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => "");
      if (cwd === workspace) {
        try { process.kill(pid, "SIGTERM"); } catch { /* 已退出的实验进程。 */ }
      }
    }
    for (const [index, client] of clients.entries()) {
      await Promise.race([client.exited, delay(3000).then(() => { client.child.kill("SIGTERM"); })]);
      await writeFile(join(dir, `client-${index + 1}.stderr`), client.diagnostics());
    }
    await until("test core processes exit", async () => {
      const live = await Promise.all([...pids].map(async (pid) =>
        (await readlink(`/proc/${pid}/cwd`).catch(() => "")) === workspace));
      return live.some(Boolean) ? undefined : true;
    });
  }
}

record("started", { base, buildId, runtime, node, network: "each client/core uses an empty network namespace" });
try {
  if (selectedCase !== "scope-cleanup") await scenario(false);
  if (selectedCase !== "plain-eof") await scenario(true);
  record("complete", { selectedCase });
} catch (error) {
  record("failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await writeFile(join(base, "result.json"), `${JSON.stringify(events, null, 2)}\n`);
  console.error(`Evidence retained at ${base}`);
}
