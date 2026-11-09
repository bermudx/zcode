/* oxlint-disable max-lines -- self-contained acceptance driver: generated
 * shim/worker sources are inline so one reviewed file owns the whole run. */
// Isolated live acceptance driver for the single shared core (issue #10).
//
// Proves on the REAL service manager that one `piz-core-<hash>` transient
// systemd --user service serves ACP workers (each inside its own scope unit,
// matching T3's retirement order), a terminal attach client, and workspaces
// A+B — and that retiring the original client scope leaves the core and every
// replacement session usable. Runs THIS worktree's changed sources
// (app-server-spawn.ts, zcode-protocol-entrypoint.ts, packages/shared
// appServerInfoSchema) under tsx with a private module-alias config; unchanged
// @zcode/* dependencies resolve through the existing node_modules links
// (SOURCE integration, not a built-candidate verification). No installs,
// builds, model calls, or network access: the core service runs under
// PrivateNetwork/PrivateUsers.
//
// Operator command (from repo root):
//   mise exec -- node --import tsx scripts/verify-single-core.mts
//
// Everything it needs lives under a private mkdtemp root (mode 0700) at
// /tmp/piz-single-core-live-*/ — generated shims/configs/logs/result.json are
// left as evidence. Exit 0 only when every assertion passes and cleanup
// succeeds.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

// ---------------------------------------------------------------------------
// Constants / paths
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKTREE = dirname(SCRIPT_DIR);
const EXPECTED_COMMIT_PREFIX = "99d0b843";
const SOURCE_VERSION = "source-single-core-test";
const REQUIRED_SYSTEMD_MAJOR = 254;
const STDERR_BUFFER_CAP = 512 * 1024;

const SOURCE_APP_SERVER_SPAWN = join(
  WORKTREE,
  "apps/zcode-cli/packages/cli/src/app-server-spawn.ts",
);
const SOURCE_BOOTSTRAP_ENTRYPOINT = join(
  WORKTREE,
  "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts",
);
const SOURCE_SHARED_CONTRACT = join(
  WORKTREE,
  "packages/shared/src/app-server-attach/contract.ts",
);
const SOURCE_CLI_MAIN = join(WORKTREE, "apps/zcode-cli/packages/cli/src/main.ts");

// ---------------------------------------------------------------------------
// Result ledger + shared run state (teardown needs these at module scope)
// ---------------------------------------------------------------------------

type AssertionRecord = {
  detail?: string;
  fatal: boolean;
  id: string;
  ok: boolean;
};

type PhaseRecord = {
  detail?: string;
  finishedAt: string;
  name: string;
  startedAt: string;
  status: "ok" | "failed" | "skipped";
};

type CommandRecord = {
  argv: string[];
  exitCode: number | null;
  finishedAt: string;
  signal: string | null;
  startedAt: string;
};

const assertions: AssertionRecord[] = [];
const phases: PhaseRecord[] = [];
const commands: CommandRecord[] = [];
const notes: string[] = [];

const iso = () => new Date().toISOString();
const errMsg = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

let driverLogPath = "";
const say = (line: string) => {
  const stamped = `[${iso()}] ${line}`;
  process.stdout.write(`${stamped}\n`);
  if (driverLogPath) appendFileSync(driverLogPath, `${stamped}\n`);
};

function check(id: string, ok: boolean, detail?: string, options?: { fatal?: boolean }) {
  const fatal = options?.fatal ?? true;
  assertions.push({ detail, fatal, id, ok });
  say(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
  if (!ok && fatal) throw new Error(`assertion failed: ${id}: ${detail ?? ""}`);
}

function note(line: string) {
  notes.push(line);
  say(`NOTE ${line}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function runTracked(
  file: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const startedAt = iso();
  return new Promise((resolve) => {
    execFile(file, argv, { env, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      commands.push({
        argv: [file, ...argv],
        exitCode: code,
        finishedAt: iso(),
        signal: null,
        startedAt,
      });
      resolve({ code, stderr: String(stderr), stdout: String(stdout) });
    });
  });
}

interface PidState {
  cgroup: string;
  cmdline: string;
  cwd: string;
  netInterfaces: string[];
  netNs: string;
}

const readProc = (pid: number): PidState | undefined => {
  if (pid <= 0) return undefined;
  try {
    return {
      cgroup: readFileSync(`/proc/${pid}/cgroup`, "utf8").trim(),
      cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim(),
      cwd: readlinkSync(`/proc/${pid}/cwd`),
      netInterfaces: readFileSync(`/proc/${pid}/net/dev`, "utf8")
        .split("\n")
        .slice(2)
        .map((line) => line.trim().split(":")[0] ?? "")
        .filter((name) => name.length > 0),
      netNs: readlinkSync(`/proc/${pid}/ns/net`),
    };
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// ACP JSON-RPC wire over a worker's stdio pipes
// ---------------------------------------------------------------------------

class AcpWire {
  private buffer = "";
  private nextId = 0;
  private readonly notifications: Array<{ method: string; params: unknown }> = [];
  private readonly pending = new Map<
    string,
    {
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly strayStdoutLines: string[] = [];
  readonly updates: Array<{ sessionId: string; update: Record<string, unknown> }> = [];

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stdin?.on("error", () => {
      /* EPIPE after worker death — writes simply stop reaching it */
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.strayStdoutLines.push(line.slice(0, 400));
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>) {
    const { id, method, params } = message as {
      id?: number | string;
      method?: string;
      params?: unknown;
    };
    if (method !== undefined && id !== undefined) {
      // Agent→client request: this test client implements none.
      this.child.stdin?.write(
        `${JSON.stringify({
          error: { code: -32601, message: `verify client does not implement ${method}` },
          id,
          jsonrpc: "2.0",
        })}\n`,
      );
      this.notifications.push({ method: `agent-request:${method}`, params });
      return;
    }
    if (method !== undefined) {
      this.notifications.push({ method, params });
      if (method === "session/update") {
        const p = (params ?? {}) as Record<string, unknown>;
        this.updates.push({
          sessionId: String(p.sessionId ?? ""),
          update: (p.update ?? {}) as Record<string, unknown>,
        });
      }
      return;
    }
    if (id !== undefined) {
      const entry = this.pending.get(String(id));
      if (!entry) return;
      this.pending.delete(String(id));
      clearTimeout(entry.timer);
      const error = message.error as { code?: number; message?: string } | undefined;
      if (error) {
        entry.reject(
          new Error(`acp ${error.code ?? -32000}: ${error.message ?? "request failed"}`),
        );
      } else {
        entry.resolve(message.result);
      }
    }
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = `v${++this.nextId}`;
    this.child.stdin?.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`acp request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timer });
    });
  }

  agentMessageChunks(sessionId: string): Array<Record<string, unknown>> {
    return this.updates
      .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
      .map((u) => u.update);
  }

  sawAvailableCommands(sessionId: string): boolean {
    return this.updates.some(
      (u) => u.sessionId === sessionId && u.update.sessionUpdate === "available_commands_update",
    );
  }
}

// ---------------------------------------------------------------------------
// Scoped worker process record
// ---------------------------------------------------------------------------

interface WorkerProc {
  child: ChildProcess;
  command: CommandRecord;
  pid: number;
  role: string;
  sawDisconnected: boolean;
  sawSessionNotFound: boolean;
  stderrBuffer: string;
  unit: string;
  wire: AcpWire;
}

// ---------------------------------------------------------------------------
// Shared run state for teardown
// ---------------------------------------------------------------------------

interface Dirs {
  bin: string;
  configs: string;
  data: string;
  home: string;
  logs: string;
  shims: string;
  wsA: string;
  wsB: string;
  xdgCache: string;
  xdgConfig: string;
  xdgData: string;
}

let privateRoot = "";
let dirs: Dirs | undefined;
let managerEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
let serviceEnv: NodeJS.ProcessEnv = {};
let socketPath = "";
let serviceUnit = "";
let workers: WorkerProc[] = [];
let terminalRuntime:
  | { close(): Promise<void>; currentClient(): unknown }
  | undefined;
let resultExtra: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// Generated artifacts (written into the private root)
// ---------------------------------------------------------------------------

const ALIAS_LOADER = `// GENERATED by verify-single-core.mts — maps @zcode/shared specifiers to worktree source.
import { readFileSync } from "node:fs";
let map = {};
export async function initialize(data) {
  if (data?.configPath) {
    const config = JSON.parse(readFileSync(data.configPath, "utf8"));
    map = config.specifiers ?? {};
  }
}
export async function resolve(specifier, context, next) {
  const target = map[specifier];
  if (target) return { url: target, shortCircuit: true };
  return next(specifier, context);
}
`;

const CORE_SHIM = `// GENERATED by verify-single-core.mts — source-mode core executable shim.
// Wires ONLY the production app-server launch chain to real source entrypoints:
// console boundary → env sanitization → provider runtime prep → lifecycle →
// runZCodeProtocolAgent. No business logic replaced.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] !== "app-server") {
  process.stderr.write(\`core-shim: expected "app-server" argv, got \${JSON.stringify(args)}\\n\`);
  process.exit(2);
}
let socketPath = "";
let cwd = "";
let noPlugins = false;
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === "--socket") { socketPath = args[i + 1] ?? ""; i += 1; continue; }
  if (args[i] === "--cwd") { cwd = args[i + 1] ?? ""; i += 1; continue; }
  if (args[i] === "--no-plugins") { noPlugins = true; continue; }
}
if (!socketPath || !cwd) {
  process.stderr.write(\`core-shim: missing --socket/--cwd in \${JSON.stringify(args)}\\n\`);
  process.exit(2);
}
const worktree = process.env.PIZ_SCV_ROOT;
if (!worktree) {
  process.stderr.write("core-shim: PIZ_SCV_ROOT missing\\n");
  process.exit(2);
}

// Whitelisted nonsecret state only: presence booleans + safe paths, never env values.
const envNames = Object.keys(process.env);
writeFileSync(
  join(cwd, "core-source-report.json"),
  \`\${JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    cwdMatchesArg: process.cwd() === cwd,
    envPresence: {
      HOME: process.env.HOME ?? null,
      INVOCATION_ID: process.env.INVOCATION_ID !== undefined,
      PWD_IS_CWD: process.env.PWD === cwd,
      ZCODE_ATTACH_CORE: process.env.ZCODE_ATTACH_CORE !== undefined,
      ZCODE_DATA_BASE_DIR_IS_CWD: process.env.ZCODE_DATA_BASE_DIR === cwd,
      ZCODE_WORKSPACE_IDENTITY: process.env.ZCODE_WORKSPACE_IDENTITY !== undefined,
      herdrEnvNameCount: envNames.filter((name) => name.startsWith("HERDR_")).length,
      t3codeEnvNameCount: envNames.filter((name) => name.startsWith("T3CODE_")).length,
    },
    pid: process.pid,
  }, null, 1)}\\n\`,
);

const { installStderrConsoleBoundary } = await import(
  \`file://\${worktree}/apps/zcode-cli/packages/cli/src/protocol-console.ts\`
);
const { createProtocolProcessLifecycle } = await import(
  \`file://\${worktree}/apps/zcode-cli/packages/cli/src/protocol-lifecycle.ts\`
);
const { applyCliRuntimeEnvSanitization } = await import(
  \`file://\${worktree}/apps/zcode-cli/packages/cli/src/env.ts\`
);
const { prepareCliProviderRuntimeEnv } = await import(
  \`file://\${worktree}/apps/zcode-cli/packages/cli/src/provider-runtime-env.ts\`
);
const { runZCodeProtocolAgent } = await import(
  \`file://\${worktree}/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts\`
);

installStderrConsoleBoundary(process.stderr);
applyCliRuntimeEnvSanitization(process.env);
const lifecycle = createProtocolProcessLifecycle({ closeOnInputEnd: false });
Object.assign(
  process.env,
  await prepareCliProviderRuntimeEnv({
    argv: args,
    env: process.env,
    entrypoint: join(worktree, "apps/zcode-cli/packages/cli/src/main.ts"),
  }),
);
let code = 0;
try {
  await runZCodeProtocolAgent({
    cwd,
    env: process.env,
    input: lifecycle.input,
    lifecycle,
    noPlugins,
    output: process.stdout,
    socketPath,
    version: "source-single-core-test",
  });
} catch (error) {
  code = 1;
  process.stderr.write(
    \`core-shim: protocol agent failed: \${error instanceof Error ? error.message : String(error)}\\n\`,
  );
} finally {
  await lifecycle.complete(code);
}
`;

const ACP_WORKER = `// GENERATED by verify-single-core.mts — ACP worker on the REAL runAcpStdio
// entry (internally owns AcpCoreSessions + production ensureServer over stdio).
import { runAcpStdio, createAcpStderrLogger } from "file://__WORKTREE__/apps/zcode-cli/packages/cli/src/acp/acp-main.ts";

process.stderr.write(\`\${JSON.stringify({ type: "worker-ready", pid: process.pid })}\\n\`);
const exitCode = await runAcpStdio({
  env: process.env,
  logger: createAcpStderrLogger(process.stderr),
  stderr: process.stderr,
  stdin: process.stdin,
  stdout: process.stdout,
  version: "source-single-core-test",
});
process.exit(exitCode);
`;

// ---------------------------------------------------------------------------
// systemctl helpers
// ---------------------------------------------------------------------------

const systemctlShow = async (unit: string, props: string[]) => {
  const out = await runTracked(
    "/usr/bin/systemctl",
    ["--user", "show", unit, ...props.map((p) => `--property=${p}`)],
    managerEnv,
  );
  if (out.code !== 0) return undefined;
  return Object.fromEntries(
    out.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  ) as Record<string, string>;
};

const isActive = async (unit: string): Promise<string> =>
  (
    await runTracked("/usr/bin/systemctl", ["--user", "is-active", unit], managerEnv)
  ).stdout.trim();

const isStopped = (state: string): boolean =>
  state === "inactive" || state === "failed" || state === "unknown";

const awaitNotActive = async (unit: string, timeoutMs = 15_000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await isActive(unit);
    if (isStopped(last)) return last;
    await sleep(300);
  }
  return last;
};

// Identity-checked stop: the unit's own reported MainPID must live in a cgroup
// carrying this exact unit name — never trust a caller-supplied or stale pid.
const stopUnitByName = async (unit: string, tag: string): Promise<void> => {
  const state = await systemctlShow(unit, ["MainPID", "ActiveState"]);
  if (state && isStopped(state.ActiveState ?? "")) {
    note(`${tag}: ${unit} not active (${state?.ActiveState ?? "unknown"}) — skip stop`);
    return;
  }
  const pid = Number(state?.MainPID ?? "0");
  const proc = readProc(pid);
  if (pid > 0 && proc && proc.cgroup.includes(unit)) {
    const stop = await runTracked(
      "/usr/bin/systemctl",
      ["--user", "stop", unit],
      managerEnv,
    );
    assertions.push({
      detail: stop.stderr.trim() || `stop exit=${stop.code}`,
      fatal: false,
      id: `teardown-stop:${tag}`,
      ok: stop.code === 0,
    });
  } else {
    assertions.push({
      detail: `MainPID=${pid} cgroup=${proc?.cgroup ?? "?"}`,
      fatal: false,
      id: `teardown-stop:${tag}`,
      ok: false,
    });
    note(`${tag}: ${unit} active but MainPID identity check failed — not stopping`);
  }
};

// ---------------------------------------------------------------------------
// Teardown — unconditional, idempotent, identity-checked
// ---------------------------------------------------------------------------

async function teardown() {
  // Stop any still-live test scopes, identity-checked via the unit's own
  // reported MainPID cgroup — not our stale pid record.
  for (const worker of workers) {
    try {
      await stopUnitByName(worker.unit, worker.role);
    } catch (error) {
      assertions.push({
        detail: errMsg(error),
        fatal: false,
        id: `teardown-scope:${worker.role}`,
        ok: false,
      });
    }
  }
  try {
    await terminalRuntime?.close();
  } catch {
    /* best effort */
  }
  // Stop the private core service only after proving the unit's main pid is our
  // source shim in our private cgroup — never a foreign/stale pid.
  try {
    const state = await systemctlShow(serviceUnit, ["MainPID", "ActiveState"]);
    const pid = Number(state?.MainPID ?? "0");
    if (state && !isStopped(state.ActiveState ?? "") && pid > 0) {
      const proc = readProc(pid);
      if (
        dirs &&
        proc &&
        proc.cgroup.includes(serviceUnit) &&
        proc.cmdline.includes(join(dirs.shims, "core-shim.mts")) &&
        proc.cwd === dirs.data
      ) {
        await runTracked("/usr/bin/systemctl", ["--user", "stop", serviceUnit], managerEnv);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && readProc(pid) !== undefined) await sleep(200);
      } else {
        note(`teardown: ${serviceUnit} active but identity check failed — left running`);
      }
    }
  } catch (error) {
    assertions.push({
      detail: errMsg(error),
      fatal: false,
      id: "teardown-service",
      ok: false,
    });
  }
  if (dirs) {
    try {
      const journal = await runTracked(
        "/usr/bin/journalctl",
        ["--user", "-u", serviceUnit, "--no-pager", "-n", "400", "-o", "short-monotonic"],
        managerEnv,
      );
      writeFileSync(join(dirs.logs, "core-journal.log"), journal.stdout);
    } catch {
      /* best effort */
    }
  }
}

function writeResult(verdict: "pass" | "fail" | "pending", extra: Record<string, unknown>) {
  if (!privateRoot) return;
  const result = {
    assertions,
    commands,
    finishedAt: iso(),
    notes,
    phases,
    verdict,
    ...resultExtra,
    ...extra,
  };
  writeFileSync(join(privateRoot, "result.json"), `${JSON.stringify(result, null, 1)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startedAt = iso();
  let currentPhase: PhaseRecord | undefined;
  const beginPhase = (name: string) => {
    currentPhase = { finishedAt: "", name, startedAt: iso(), status: "skipped" };
    phases.push(currentPhase);
    say(`=== ${name}`);
  };
  const endPhase = (status: "ok" | "failed", detail?: string) => {
    if (!currentPhase) return;
    currentPhase.status = status;
    currentPhase.detail = detail;
    currentPhase.finishedAt = iso();
    currentPhase = undefined;
  };

  // ----- private root ------------------------------------------------------
  privateRoot = mkdtempSync(join(tmpdir(), "piz-single-core-live-"));
  chmodSync(privateRoot, 0o700);
  mkdirSync(join(privateRoot, "logs"), { recursive: true });
  driverLogPath = join(privateRoot, "logs", "driver.log");
  say(`private root ${privateRoot}`);

  // ----- preflight ---------------------------------------------------------
  beginPhase("preflight");
  check("platform-linux", process.platform === "linux", process.platform);
  check("systemd-run-binary", existsSync("/usr/bin/systemd-run"));
  check("systemctl-binary", existsSync("/usr/bin/systemctl"));
  check("journalctl-binary", existsSync("/usr/bin/journalctl"));
  const uid = process.getuid?.() ?? 0;
  const xdgRuntime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  check("xdg-runtime-dir", existsSync(join(xdgRuntime, "bus")), xdgRuntime);
  managerEnv = { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: xdgRuntime };
  const versionOut = await runTracked("/usr/bin/systemctl", ["--version"], managerEnv);
  const systemdMajor = Number(versionOut.stdout.match(/systemd (\d+)/)?.[1] ?? "0");
  check("systemd>=254", systemdMajor >= REQUIRED_SYSTEMD_MAJOR, `systemd ${systemdMajor}`);
  const managerState = await runTracked(
    "/usr/bin/systemctl",
    ["--user", "is-system-running"],
    managerEnv,
  );
  check(
    "user-manager-reachable",
    /running|degraded|starting|maintenance/.test(managerState.stdout.trim()),
    managerState.stdout.trim() || managerState.stderr.trim(),
  );
  const nodePath = process.execPath;
  const nodeBinDir = dirname(nodePath);
  check("node-path-absolute", isAbsolute(nodePath), `${nodePath} (${process.version})`);
  const tsxUrl = import.meta.resolve("tsx");
  check("tsx-resolved", tsxUrl.startsWith("file:"), tsxUrl);
  const gitRev = await runTracked("git", ["-C", WORKTREE, "rev-parse", "HEAD"], managerEnv);
  const sourceCommit = gitRev.stdout.trim();
  check("source-commit", sourceCommit.length === 40, sourceCommit, { fatal: false });
  if (!sourceCommit.startsWith(EXPECTED_COMMIT_PREFIX)) {
    note(`source tree at ${sourceCommit}; handoff expected ${EXPECTED_COMMIT_PREFIX}*`);
  }
  for (const [label, path] of [
    ["app-server-spawn", SOURCE_APP_SERVER_SPAWN],
    ["bootstrap-entrypoint", SOURCE_BOOTSTRAP_ENTRYPOINT],
    ["shared-contract", SOURCE_SHARED_CONTRACT],
    ["cli-main", SOURCE_CLI_MAIN],
  ] as const) {
    check(`source-path:${label}`, existsSync(path), path);
  }
  resultExtra.sources = {
    appServerSpawn: SOURCE_APP_SERVER_SPAWN,
    bootstrapEntrypoint: SOURCE_BOOTSTRAP_ENTRYPOINT,
    cliMain: SOURCE_CLI_MAIN,
    sharedContract: SOURCE_SHARED_CONTRACT,
  };
  endPhase("ok");

  // ----- generated artifacts -----------------------------------------------
  beginPhase("generated-artifacts");
  dirs = {
    bin: join(privateRoot, "bin"),
    configs: join(privateRoot, "configs"),
    data: join(privateRoot, "data"),
    home: join(privateRoot, "home"),
    logs: join(privateRoot, "logs"),
    shims: join(privateRoot, "shims"),
    wsA: join(privateRoot, "ws", "a"),
    wsB: join(privateRoot, "ws", "b"),
    xdgCache: join(privateRoot, "xdg", "cache"),
    xdgConfig: join(privateRoot, "xdg", "config"),
    xdgData: join(privateRoot, "xdg", "data"),
  };
  const d = dirs;
  for (const dir of Object.values(d)) mkdirSync(dir, { recursive: true });
  check("root-mode-0700", (statSync(privateRoot).mode & 0o777) === 0o700, privateRoot);

  socketPath = join(d.data, ".zcode", "v2", "sockets", "core.sock");
  serviceUnit = `piz-core-${createHash("sha256")
    .update(socketPath)
    .digest("hex")
    .slice(0, 16)}.service`;

  const sharedPkg = JSON.parse(
    readFileSync(join(WORKTREE, "packages/shared/package.json"), "utf8"),
  ) as { exports?: Record<string, string> };
  const specifiers: Record<string, string> = {};
  for (const [key, target] of Object.entries(sharedPkg.exports ?? {})) {
    if (typeof target !== "string" || !target.startsWith("./")) continue;
    const specifier = key === "." ? "@zcode/shared" : `@zcode/shared/${key.slice(2)}`;
    specifiers[specifier] = pathToFileURL(join(WORKTREE, "packages/shared", target)).href;
  }
  const aliasConfigPath = join(d.configs, "source-aliases.json");
  writeFileSync(
    aliasConfigPath,
    `${JSON.stringify(
      {
        generated: iso(),
        note: "@zcode/shared specifiers → worktree source (from packages/shared exports map)",
        specifiers,
        worktree: WORKTREE,
      },
      null,
      1,
    )}\n`,
  );
  check(
    "alias-config-covers-shared-index",
    specifiers["@zcode/shared"] ===
      pathToFileURL(join(WORKTREE, "packages/shared/src/index.ts")).href,
    `${Object.keys(specifiers).length} specifiers`,
  );

  writeFileSync(join(d.shims, "alias-loader.mjs"), ALIAS_LOADER);
  const registerPath = join(d.shims, "alias-register.mjs");
  writeFileSync(
    registerPath,
    `import { register } from "node:module";\n` +
      `register(new URL("./alias-loader.mjs", import.meta.url), { data: { configPath: ${JSON.stringify(
        aliasConfigPath,
      )} } });\n`,
  );
  const registerUrl = pathToFileURL(registerPath).href;

  const systemdRunShim = join(d.bin, "systemd-run");
  writeFileSync(
    systemdRunShim,
    `#!/bin/sh\n` +
      `# GENERATED by verify-single-core.mts — scope launches pass through untouched;\n` +
      `# transient services get PrivateNetwork/PrivateUsers isolation appended.\n` +
      `for arg in "$@"; do\n` +
      `  if [ "$arg" = "--scope" ]; then\n` +
      `    exec /usr/bin/systemd-run "$@"\n` +
      `  fi\n` +
      `done\n` +
      `exec /usr/bin/systemd-run --property=PrivateNetwork=yes --property=PrivateUsers=yes "$@"\n`,
  );
  chmodSync(systemdRunShim, 0o755);

  const coreShimPath = join(d.shims, "core-shim.mts");
  writeFileSync(coreShimPath, CORE_SHIM);
  const acpWorkerPath = join(d.shims, "acp-worker.mts");
  writeFileSync(acpWorkerPath, ACP_WORKER.replaceAll("__WORKTREE__", WORKTREE));

  const zcodeShim = join(d.bin, "zcode");
  writeFileSync(
    zcodeShim,
    `#!/bin/sh\n` +
      `# GENERATED by verify-single-core.mts — source-mode core executable (ZCODE_SERVER_BIN).\n` +
      `exec ${JSON.stringify(nodePath)} --import ${JSON.stringify(tsxUrl)} ` +
      `--import ${JSON.stringify(registerUrl)} ${JSON.stringify(coreShimPath)} "$@"\n`,
  );
  chmodSync(zcodeShim, 0o755);

  serviceEnv = {
    CI: "1",
    HOME: d.home,
    PATH: `${d.bin}:${nodeBinDir}:/usr/bin:/bin`,
    PIZ_SCV_ROOT: WORKTREE,
    XDG_CACHE_HOME: d.xdgCache,
    XDG_CONFIG_HOME: d.xdgConfig,
    XDG_DATA_HOME: d.xdgData,
    XDG_RUNTIME_DIR: xdgRuntime,
    ZCODE_DATA_BASE_DIR: d.data,
    ZCODE_SERVER_BIN: zcodeShim,
  };
  writeFileSync(
    join(d.configs, "env-allowlist.json"),
    `${JSON.stringify(
      {
        managerEnvNames: Object.keys(managerEnv).sort(),
        note:
          "Only these names reach workers/core; no user credentials forwarded. " +
          "DBUS_SESSION_BUS_ADDRESS intentionally unset — user manager reached via $XDG_RUNTIME_DIR/bus.",
        serviceEnv,
      },
      null,
      1,
    )}\n`,
  );
  endPhase("ok");

  // ----- module alias + production source imports --------------------------
  beginPhase("source-imports");
  register(pathToFileURL(join(d.shims, "alias-loader.mjs")), {
    data: { configPath: aliasConfigPath },
  });
  const spawnModule = (await import(pathToFileURL(SOURCE_APP_SERVER_SPAWN).href)) as {
    ensureServer: (options: {
      dataBaseDir?: string;
      env?: NodeJS.ProcessEnv;
      log?: (line: string) => void;
    }) => Promise<{ socketPath: string; started: boolean }>;
  };
  // Same resolved URL the alias maps "@zcode/shared" to → same module instance
  // as the production code's internal imports.
  const sharedModule = (await import(
    pathToFileURL(join(WORKTREE, "packages/shared/src/index.ts")).href
  )) as {
    appServerInfoSchema: {
      parse: (value: unknown) => {
        scope: string;
        socketPath: string;
        startedAt: string;
        version: string;
      };
      shape: { scope: unknown };
    };
    resolveWorkspaceKey: (input: {
      workspaceIdentity?: string;
      workspacePath: string;
    }) => string;
    zcodeProtocolMethods: {
      sessionCreate: string;
      sessionList: string;
      sessionSubscribe: string;
    };
    zcodeSessionListResultSchema: {
      parse: (value: unknown) => {
        sessions: Array<{ sessionId?: string; workspace?: { workspacePath?: string } }>;
      };
    };
    zcodeSessionStateSnapshotSchema: {
      parse: (value: unknown) => {
        session: {
          sessionId: string;
          workspace: { workspaceKey: string; workspacePath: string };
        };
      };
    };
    zcodeSessionSubscribeResultSchema: {
      parse: (value: unknown) => {
        eventSeq: number;
        sessionId: string;
        snapshot?: {
          session: {
            sessionId: string;
            workspace: { workspaceKey: string; workspacePath: string };
          };
        };
      };
    };
  };
  const contractModule = (await import(pathToFileURL(SOURCE_SHARED_CONTRACT).href)) as {
    appServerInfoSchema: { parse: (value: unknown) => { scope: string } };
  };
  const attachClientModule = (await import(
    pathToFileURL(
      join(WORKTREE, "apps/zcode-cli/packages/cli/src/attach/attach-client.ts"),
    ).href
  )) as {
    connectAttachClient: (
      path: string,
      options?: { logger?: { warn?: (m: string, c?: Record<string, unknown>) => void } },
    ) => Promise<{
      close(): void;
      request<T = unknown>(method: string, params?: unknown): Promise<T>;
    }>;
  };
  const attachRuntimeModule = (await import(
    pathToFileURL(
      join(WORKTREE, "apps/zcode-cli/packages/cli/src/attach/attach-tui-options.ts"),
    ).href
  )) as {
    AttachRuntime: new (options: {
      connect?: (socketPath: string) => Promise<unknown>;
      ensureConnected?: () => Promise<{ socketPath: string }>;
      locale?: string;
      logger?: { warn?: (m: string, c?: Record<string, unknown>) => void };
      socketPath: string;
      workspace?: {
        workspaceIdentity?: string;
        workspaceKey: string;
        workspacePath: string;
      };
    }) => {
      close(): Promise<void>;
      connect(): Promise<unknown>;
      currentClient(): {
        close(): void;
        request<T = unknown>(method: string, params?: unknown): Promise<T>;
      };
      registerSession(handle: unknown): void;
    };
  };
  const attachSessionModule = (await import(
    pathToFileURL(
      join(WORKTREE, "apps/zcode-cli/packages/cli/src/attach/attach-session.ts"),
    ).href
  )) as {
    AttachSessionHandle: new (input: {
      client: () => { request<T = unknown>(m: string, p?: unknown): Promise<T> };
      sessionId: string;
      snapshot: unknown;
    }) => {
      sessionId: string;
      subscribe(afterSeq?: number, includeSnapshot?: boolean): Promise<void>;
    };
  };
  const { ensureServer } = spawnModule;
  const { AttachRuntime } = attachRuntimeModule;
  const { AttachSessionHandle } = attachSessionModule;
  const { connectAttachClient } = attachClientModule;
  const {
    appServerInfoSchema,
    resolveWorkspaceKey,
    zcodeProtocolMethods,
    zcodeSessionListResultSchema,
    zcodeSessionStateSnapshotSchema,
    zcodeSessionSubscribeResultSchema,
  } = sharedModule;

  const scopeDef = (
    appServerInfoSchema.shape.scope as { def?: { values?: string[] }; value?: string }
  );
  check(
    "new-schema-executing",
    JSON.stringify(scopeDef.def?.values ?? scopeDef.value ?? scopeDef) === '["user"]' ||
      JSON.stringify(scopeDef.def?.values ?? scopeDef.value ?? scopeDef) === '"user"',
    "appServerInfoSchema.scope literal 'user'",
  );
  check(
    "contract-source-schema",
    typeof contractModule.appServerInfoSchema.parse === "function",
    "contract.ts loaded from worktree source",
  );

  const spawnLog = (line: string) =>
    appendFileSync(join(d.logs, "ensure-server.log"), `[${iso()}] ${line}\n`);

  const refFor = (workspacePath: string) => ({
    workspaceKey: resolveWorkspaceKey({ workspacePath }),
    workspacePath,
  });
  const refA = refFor(d.wsA);
  const refB = refFor(d.wsB);
  endPhase("ok");

  // ----- worker scope launcher ----------------------------------------------
  const spawnAcpScope = async (role: string): Promise<WorkerProc> => {
    const unit = `piz-single-core-test-${role}-${randomUUID().slice(0, 8)}.scope`;
    const argv = [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${unit.replace(/\.scope$/, "")}`,
      "--",
      nodePath,
      "--import",
      tsxUrl,
      "--import",
      registerUrl,
      acpWorkerPath,
    ];
    const command: CommandRecord = {
      argv: [systemdRunShim, ...argv],
      exitCode: null,
      finishedAt: "",
      signal: null,
      startedAt: iso(),
    };
    commands.push(command);
    const child = spawn(
      systemdRunShim,
      argv,
      { env: serviceEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    const worker: WorkerProc = {
      child,
      command,
      pid: child.pid ?? -1,
      role,
      sawDisconnected: false,
      sawSessionNotFound: false,
      stderrBuffer: "",
      unit,
      wire: new AcpWire(child),
    };
    const stderrFile = join(d.logs, `worker-${role}.stderr.log`);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (chunk.includes("sessionNotFound")) worker.sawSessionNotFound = true;
      if (chunk.includes("attach client disconnected")) worker.sawDisconnected = true;
      if (worker.stderrBuffer.length < STDERR_BUFFER_CAP) {
        worker.stderrBuffer = (worker.stderrBuffer + chunk).slice(-STDERR_BUFFER_CAP);
      }
      appendFileSync(stderrFile, chunk);
    });
    child.once("exit", (code, signal) => {
      command.exitCode = code;
      command.finishedAt = iso();
      command.signal = signal;
    });
    workers.push(worker);

    const readyDeadline = Date.now() + 30_000;
    let reportedPid: number | undefined;
    while (Date.now() < readyDeadline) {
      const match = worker.stderrBuffer.match(/\{"type":"worker-ready","pid":(\d+)\}/);
      if (match) {
        reportedPid = Number(match[1]);
        break;
      }
      if (child.exitCode !== null) {
        throw new Error(
          `worker ${unit} exited before ready (code ${child.exitCode}): ${worker.stderrBuffer.slice(-800)}`,
        );
      }
      await sleep(50);
    }
    check(`${role}-worker-ready`, reportedPid !== undefined, `pid ${reportedPid ?? "?"}`);
    worker.pid = reportedPid ?? child.pid ?? -1;
    if (child.pid !== undefined && child.pid !== worker.pid) {
      note(`${role}: spawned child pid ${child.pid} != reported worker pid ${worker.pid}`);
    }
    const proc = readProc(worker.pid);
    check(`${role}-in-scope-cgroup`, proc !== undefined && proc.cgroup.includes(unit), proc?.cgroup);
    return worker;
  };

  const acpInit = async (worker: WorkerProc) => {
    const init = (await worker.wire.request(
      "initialize",
      {
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "piz-single-core-verify", version: "source" },
        protocolVersion: 1,
      },
      120_000,
    )) as { protocolVersion?: number };
    check(`${worker.role}-initialize`, init.protocolVersion === 1, JSON.stringify(init));
  };

  const acpNewSession = async (worker: WorkerProc, cwd: string, tag: string) => {
    const result = (await worker.wire.request(
      "session/new",
      { cwd, mcpServers: [] },
      120_000,
    )) as { sessionId?: string };
    const sessionId = String(result.sessionId ?? "");
    check(`${tag}-session-created`, sessionId.length > 0, sessionId);
    const deadline = Date.now() + 15_000;
    while (!worker.wire.sawAvailableCommands(sessionId) && Date.now() < deadline) {
      await sleep(100);
    }
    check(
      `${tag}-available-commands`,
      worker.wire.sawAvailableCommands(sessionId),
      "local slash commands advertised",
    );
    return sessionId;
  };

  const stopScope = async (worker: WorkerProc, tag: string) => {
    const proc = readProc(worker.pid);
    check(
      `${tag}-pre-stop-identity`,
      proc !== undefined && proc.cgroup.includes(worker.unit),
      proc?.cgroup,
    );
    const stop = await runTracked(
      "/usr/bin/systemctl",
      ["--user", "stop", worker.unit],
      managerEnv,
    );
    check(`${tag}-stop-command`, stop.code === 0, stop.stderr.trim());
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && readProc(worker.pid) !== undefined) await sleep(100);
    check(`${tag}-process-dead`, readProc(worker.pid) === undefined);
  };

  // ----- phase: original ACP worker X ---------------------------------------
  beginPhase("original-acp-worker-X");
  const workerX = await spawnAcpScope("original");
  await acpInit(workerX);
  const xA = await acpNewSession(workerX, d.wsA, "xA");
  endPhase("ok");

  // ----- phase: replacement ACP worker Y (before X retires) -----------------
  beginPhase("replacement-acp-worker-Y");
  const workerY = await spawnAcpScope("replacement");
  await acpInit(workerY);
  const yA = await acpNewSession(workerY, d.wsA, "yA");
  const yB = await acpNewSession(workerY, d.wsB, "yB");
  check("acp-session-ids-distinct", new Set([xA, yA, yB]).size === 3, `${xA} / ${yA} / ${yB}`);
  const laneSockets = [workerX, workerY].flatMap((w) =>
    [...w.stderrBuffer.matchAll(/"socketPath":"([^"]+)"/g)].map((m) => m[1]),
  );
  check(
    "acp-lanes-converge-core-sock",
    laneSockets.length >= 3 && laneSockets.every((s) => s === socketPath),
    JSON.stringify(laneSockets),
  );
  endPhase("ok");

  // ----- phase: terminal client + list isolation ----------------------------
  beginPhase("terminal-client");
  const ensured = await ensureServer({ env: serviceEnv, log: spawnLog });
  check(
    "terminal-ensureServer-socket",
    ensured.socketPath === socketPath,
    `${ensured.socketPath} started=${ensured.started}`,
  );
  check(
    "terminal-ensureServer-reused",
    ensured.started === false,
    "existing core reused, not respawned",
  );

  type AttachClient = {
    close(): void;
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
  };
  const runtime = new AttachRuntime({
    connect: (path) =>
      connectAttachClient(path, {
        logger: { warn: (m, c) => spawnLog(`attach warn: ${m} ${JSON.stringify(c ?? {})}`) },
      }) as Promise<AttachClient>,
    ensureConnected: async () => await ensureServer({ env: serviceEnv, log: spawnLog }),
    locale: "en-US",
    logger: { warn: (m, c) => spawnLog(`runtime warn: ${m} ${JSON.stringify(c ?? {})}`) },
    socketPath: ensured.socketPath,
    workspace: refB,
  });
  terminalRuntime = runtime as { close(): Promise<void>; currentClient(): unknown };
  await runtime.connect();
  const client = runtime.currentClient();
  const snapA = zcodeSessionStateSnapshotSchema.parse(
    await client.request(zcodeProtocolMethods.sessionCreate, {
      persistence: "immediate",
      workspace: refA,
    }),
  );
  const snapB = zcodeSessionStateSnapshotSchema.parse(
    await client.request(zcodeProtocolMethods.sessionCreate, {
      persistence: "immediate",
      workspace: refB,
    }),
  );
  const tA = snapA.session.sessionId;
  const tB = snapB.session.sessionId;
  check(
    "terminal-sessionA-workspace",
    snapA.session.workspace.workspacePath === refA.workspacePath &&
      snapA.session.workspace.workspaceKey === refA.workspaceKey,
    JSON.stringify(snapA.session.workspace),
  );
  check(
    "terminal-sessionB-workspace",
    snapB.session.workspace.workspacePath === refB.workspacePath &&
      snapB.session.workspace.workspaceKey === refB.workspaceKey,
    JSON.stringify(snapB.session.workspace),
  );
  const handleB = new AttachSessionHandle({
    client: () => client,
    sessionId: tB,
    snapshot: snapB,
  });
  runtime.registerSession(handleB);
  try {
    await handleB.subscribe(undefined, false);
    check("terminal-subscribe-roundtrip", true, `session/subscribe ok for ${tB}`);
  } catch (error) {
    check("terminal-subscribe-roundtrip", false, errMsg(error));
  }

  const listSessionsFor = async (ref: typeof refA) => {
    const listed = zcodeSessionListResultSchema.parse(
      await client.request(zcodeProtocolMethods.sessionList, { workspace: ref }),
    );
    return listed.sessions.map((s) => String(s.sessionId));
  };
  const idsA = await listSessionsFor(refA);
  const idsB = await listSessionsFor(refB);
  check("session-list-workspaceA-isolated", idsA.length === 1 && idsA[0] === tA, JSON.stringify(idsA));
  check("session-list-workspaceB-isolated", idsB.length === 1 && idsB[0] === tB, JSON.stringify(idsB));
  const draftIds = new Set([xA, yA, yB]);
  check(
    "deferred-drafts-absent-from-lists",
    [...idsA, ...idsB].every((id) => !draftIds.has(id)),
    "no ACP deferred drafts listed",
  );
  endPhase("ok");

  // ----- phase: service/cgroup introspection ---------------------------------
  beginPhase("service-introspection");
  const showService = () =>
    systemctlShow(serviceUnit, [
      "MainPID",
      "ControlGroup",
      "ActiveState",
      "PrivateNetwork",
      "PrivateUsers",
      "InvocationID",
      "ExecMainStatus",
    ]);
  const serviceState = await showService();
  const corePid = Number(serviceState?.MainPID ?? "0");
  check("service-active", serviceState?.ActiveState === "active", JSON.stringify(serviceState));
  check("service-private-network", serviceState?.PrivateNetwork === "yes");
  check("service-private-users", serviceState?.PrivateUsers === "yes");
  check("core-mainpid", corePid > 0, `MainPID=${corePid}`);
  const coreProc = readProc(corePid);
  check("core-proc-readable", coreProc !== undefined);
  const scopeMarkers = workers.map((w) => w.unit);
  check(
    "core-cgroup-service-not-scope",
    coreProc !== undefined &&
      coreProc.cgroup.includes(serviceUnit) &&
      !scopeMarkers.some((m) => coreProc.cgroup.includes(m)),
    coreProc?.cgroup,
  );
  const parentNetNs = readProc(process.pid)?.netNs;
  check(
    "core-netns-isolated",
    coreProc !== undefined && parentNetNs !== undefined && coreProc.netNs !== parentNetNs,
    `core ${coreProc?.netNs} vs parent ${parentNetNs}`,
  );
  check(
    "core-netns-loopback-only",
    coreProc !== undefined && coreProc.netInterfaces.every((n) => n === "lo"),
    `interfaces: ${coreProc?.netInterfaces.join(",") || "(none)"}`,
  );
  check(
    "workers-share-parent-netns",
    workers.every((w) => readProc(w.pid)?.netNs === parentNetNs),
  );

  const pidFile = readFileSync(`${socketPath}.pid`, "utf8").trim();
  check("self-registered-pid-equals-mainpid", Number(pidFile) === corePid, pidFile);
  let info: { scope?: string; socketPath?: string; version?: string } = {};
  try {
    info = appServerInfoSchema.parse(JSON.parse(readFileSync(`${socketPath}.info`, "utf8")));
    check("info-schema-new-shape", true, JSON.stringify(info));
  } catch (error) {
    check("info-schema-new-shape", false, errMsg(error));
  }
  check("info-scope-user", info.scope === "user", `scope=${info.scope}`);
  check("info-socketpath", info.socketPath === socketPath, `${info.socketPath}`);
  check(
    "info-source-version",
    info.version === SOURCE_VERSION,
    `version=${info.version} (proves changed bootstrap self-registration executed)`,
  );
  const socketDirEntries = readdirSync(dirname(socketPath));
  check(
    "sockets-dir-single-core",
    socketDirEntries.filter((f) => f.endsWith(".sock")).join(",") === "core.sock",
    socketDirEntries.join(","),
  );
  check(
    "no-workspace-hash-sockets",
    !socketDirEntries.some((f) => /^core-[0-9a-f]{16}\.sock$/.test(f)),
    socketDirEntries.join(","),
  );
  const coreReportPath = join(d.data, "core-source-report.json");
  check("core-report-exists", existsSync(coreReportPath), coreReportPath);
  const coreReport = JSON.parse(readFileSync(coreReportPath, "utf8")) as {
    cwd: string;
    cwdMatchesArg: boolean;
    envPresence: Record<string, unknown>;
  };
  check(
    "core-cwd-neutral-dataroot",
    coreReport.cwd === d.data && coreReport.cwdMatchesArg,
    coreReport.cwd,
  );
  check(
    "core-env-no-workspace-identity",
    coreReport.envPresence.ZCODE_WORKSPACE_IDENTITY === false,
  );
  check(
    "core-env-no-client-ownership",
    coreReport.envPresence.herdrEnvNameCount === 0 &&
      coreReport.envPresence.t3codeEnvNameCount === 0,
    JSON.stringify(coreReport.envPresence),
  );
  check(
    "core-env-dataroot",
    coreReport.envPresence.ZCODE_DATA_BASE_DIR_IS_CWD === true &&
      coreReport.envPresence.PWD_IS_CWD === true &&
      coreReport.envPresence.ZCODE_ATTACH_CORE === true,
  );
  endPhase("ok");

  // ----- phase: retire original scope X ---------------------------------------
  beginPhase("retire-original-scope-X");
  await stopScope(workerX, "scopeX");
  const xActive = await isActive(workerX.unit);
  note(`scope X is-active after stop: ${xActive}`);

  const serviceAfterX = (await showService()) ?? {};
  check(
    "core-survives-scope-retirement",
    serviceAfterX.MainPID === String(corePid) &&
      serviceAfterX.ActiveState === "active" &&
      serviceAfterX.InvocationID === serviceState?.InvocationID,
    `MainPID ${corePid}→${serviceAfterX.MainPID} state=${serviceAfterX.ActiveState}`,
  );
  const coreProcAfter = readProc(corePid);
  check("core-cgroup-unchanged", coreProcAfter?.cgroup === coreProc?.cgroup, coreProcAfter?.cgroup);
  endPhase("ok");

  // ----- phase: replacement still usable --------------------------------------
  beginPhase("replacement-usable");
  const promptGoal = async (worker: WorkerProc, sessionId: string, tag: string) => {
    const foreignBefore = worker.wire.updates.filter(
      (u) => u.sessionId !== sessionId && u.update.sessionUpdate === "agent_message_chunk",
    ).length;
    const response = (await worker.wire.request(
      "session/prompt",
      { prompt: [{ text: "/goal", type: "text" }], sessionId },
      60_000,
    )) as { stopReason?: string };
    check(`${tag}-goal-end-turn`, response.stopReason === "end_turn", JSON.stringify(response));
    const chunks = worker.wire.agentMessageChunks(sessionId);
    check(
      `${tag}-goal-agent-chunk`,
      chunks.length >= 1 &&
        chunks.some((c) => {
          const content = c.content as { text?: string } | undefined;
          return typeof content?.text === "string" && content.text.length > 0;
        }),
      `${chunks.length} chunk(s)`,
    );
    const foreignAfter = worker.wire.updates.filter(
      (u) => u.sessionId !== sessionId && u.update.sessionUpdate === "agent_message_chunk",
    ).length;
    check(`${tag}-no-cross-session-chunk`, foreignAfter === foreignBefore);
  };
  await promptGoal(workerY, yA, "yA");
  await promptGoal(workerY, yB, "yB");
  check(
    "no-stray-stdout-or-sessionNotFound",
    workerY.wire.strayStdoutLines.length === 0 &&
      !workerY.sawSessionNotFound &&
      !workerY.sawDisconnected &&
      !workerX.sawSessionNotFound,
  );

  try {
    const subscribeRoundtrip = zcodeSessionSubscribeResultSchema.parse(
      await client.request(zcodeProtocolMethods.sessionSubscribe, {
        deliveryKind: "desktop-continuous",
        eventFormat: "raw",
        includeSnapshot: true,
        sessionId: tB,
      }),
    );
    check(
      "terminal-subscribe-after-X-death",
      subscribeRoundtrip.sessionId === tB && subscribeRoundtrip.eventSeq >= 0,
      `eventSeq=${subscribeRoundtrip.eventSeq}`,
    );
  } catch (error) {
    check("terminal-subscribe-after-X-death", false, errMsg(error));
  }
  const listBAfter = await listSessionsFor(refB);
  check(
    "session-list-stable-after-X-death",
    listBAfter.length === 1 && listBAfter[0] === tB,
    JSON.stringify(listBAfter),
  );

  // Adopt the original worker's orphaned deferred session: proves it stayed
  // resident on the shared core, bound to workspace A.
  let adoptedX: { sessionId?: string; workspace?: { workspaceKey?: string; workspacePath?: string } } =
    {};
  const adoptDeadline = Date.now() + 20_000;
  let adoptError: unknown;
  for (;;) {
    try {
      const res = zcodeSessionSubscribeResultSchema.parse(
        await client.request(zcodeProtocolMethods.sessionSubscribe, {
          deliveryKind: "desktop-continuous",
          eventFormat: "raw",
          includeSnapshot: true,
          sessionId: xA,
        }),
      );
      adoptedX = res.snapshot?.session ?? {};
      break;
    } catch (error) {
      adoptError = error;
      if (Date.now() > adoptDeadline) break;
      await sleep(500);
    }
  }
  check(
    "adopted-xA-workspace-binding",
    adoptedX.sessionId === xA && adoptedX.workspace?.workspacePath === refA.workspacePath,
    adoptedX.sessionId ? JSON.stringify(adoptedX.workspace ?? {}) : errMsg(adoptError),
  );
  endPhase("ok");

  // ----- phase: third client reuses same core ----------------------------------
  beginPhase("third-client-Z");
  const workerZ = await spawnAcpScope("third");
  await acpInit(workerZ);
  const zA = await acpNewSession(workerZ, d.wsA, "zA");
  const serviceAfterZ = (await showService()) ?? {};
  check(
    "third-client-same-core-pid",
    serviceAfterZ.MainPID === String(corePid) && serviceAfterZ.ActiveState === "active",
    `MainPID=${serviceAfterZ.MainPID}`,
  );
  endPhase("ok");

  // ----- phase: stop remaining scopes + adopt Y sessions -----------------------
  beginPhase("stop-Y-Z-adopt");
  await stopScope(workerZ, "scopeZ");
  await stopScope(workerY, "scopeY");

  const adoptSession = async (sessionId: string, expected: string, tag: string) => {
    try {
      const res = zcodeSessionSubscribeResultSchema.parse(
        await client.request(zcodeProtocolMethods.sessionSubscribe, {
          deliveryKind: "desktop-continuous",
          eventFormat: "raw",
          includeSnapshot: true,
          sessionId,
        }),
      );
      const ws = res.snapshot?.session?.workspace;
      check(
        `${tag}-adopted-workspace-binding`,
        res.snapshot?.session?.sessionId === sessionId &&
          ws?.workspacePath === expected &&
          ws?.workspaceKey === expected,
        JSON.stringify(ws ?? {}),
      );
    } catch (error) {
      check(`${tag}-adopted-workspace-binding`, false, errMsg(error));
    }
  };
  await adoptSession(yA, refA.workspacePath, "yA");
  await adoptSession(yB, refB.workspacePath, "yB");
  await runtime.close();
  endPhase("ok");

  // ----- phase: stop service + verify teardown --------------------------------
  beginPhase("cleanup-service");
  const serviceBeforeStop = (await showService()) ?? {};
  const corePidForStop = Number(serviceBeforeStop.MainPID ?? corePid);
  const coreProcIdentity = readProc(corePidForStop);
  check(
    "core-stop-identity",
    corePidForStop === corePid &&
      coreProcIdentity !== undefined &&
      coreProcIdentity.cgroup.includes(serviceUnit) &&
      coreProcIdentity.cmdline.includes("core-shim.mts") &&
      coreProcIdentity.cwd === d.data,
    `pid=${corePidForStop} cwd=${coreProcIdentity?.cwd} cmdline=${coreProcIdentity?.cmdline.slice(0, 140)}`,
  );
  const stopCore = await runTracked(
    "/usr/bin/systemctl",
    ["--user", "stop", serviceUnit],
    managerEnv,
  );
  check("core-stop-command", stopCore.code === 0, stopCore.stderr.trim());
  const coreExitDeadline = Date.now() + 30_000;
  while (Date.now() < coreExitDeadline && readProc(corePid) !== undefined) await sleep(200);
  check("core-process-exited", readProc(corePid) === undefined);
  const socketGoneDeadline = Date.now() + 10_000;
  while (Date.now() < socketGoneDeadline && existsSync(socketPath)) await sleep(200);
  check("core-socket-removed", !existsSync(socketPath), socketPath);
  for (const unit of [...workers.map((w) => w.unit), serviceUnit]) {
    const status = await awaitNotActive(unit);
    check(`unit-inactive:${unit}`, isStopped(status), status, { fatal: false });
  }
  endPhase("ok");

  resultExtra = {
    ...resultExtra,
    core: {
      cgroup: coreProc?.cgroup,
      invocationId: serviceState?.InvocationID,
      pid: corePid,
    },
    limits: [
      "SOURCE integration: production launcher/bootstrap/shared-schema executed from worktree source under tsx; unchanged @zcode/* deps resolved from installed node_modules. Not a built-candidate verification.",
      "Isolated process-order reproduction, not a real T3 UI edit.",
      "No model endpoint exercised; no signing/metering/quota claim.",
    ],
    serviceUnit,
    sessionIds: { tA, tB, xA, yA, yB, zA },
    socketPath,
    sourceCommit,
    units: { service: serviceUnit, x: workerX.unit, y: workerY.unit, z: workerZ.unit },
    workerPids: { x: workerX.pid, y: workerY.pid, z: workerZ.pid },
    workspaces: { a: d.wsA, b: d.wsB },
  };
  writeResult("pending", { startedAt });
}

// ---------------------------------------------------------------------------
// Top-level driver
// ---------------------------------------------------------------------------

let failure: string | undefined;
try {
  await main();
} catch (error) {
  failure = errMsg(error);
  assertions.push({ detail: failure, fatal: true, id: "run-aborted", ok: false });
  const open = phases[phases.length - 1];
  if (open && open.finishedAt === "") {
    open.status = "failed";
    open.detail = failure;
    open.finishedAt = iso();
  }
  say(`RUN ABORTED: ${failure}`);
}

// Unconditional teardown: never leave test scopes or the private core running.
try {
  await teardown();
} catch (error) {
  assertions.push({ detail: errMsg(error), fatal: false, id: "teardown-fatal", ok: false });
}

// Sweep: every recorded unit must be down for cleanup to count as complete.
if (serviceUnit) {
  for (const unit of [...workers.map((w) => w.unit), serviceUnit]) {
    try {
      const status = await awaitNotActive(unit);
      assertions.push({
        detail: status || "(empty)",
        fatal: false,
        id: `final-sweep:${unit}`,
        ok: isStopped(status),
      });
    } catch (error) {
      assertions.push({ detail: errMsg(error), fatal: false, id: `final-sweep:${unit}`, ok: false });
    }
  }
}

// Rewrite result.json with teardown/sweep assertions included.
const verdict =
  failure === undefined &&
  assertions.every((a) => a.ok) &&
  phases.every((p) => p.status === "ok");
writeResult(verdict ? "pass" : "fail", { failure });
const code = verdict ? 0 : 1;
say(`verdict: ${verdict ? "PASS" : "FAIL"} (result: ${join(privateRoot || tmpdir(), "result.json")})`);
process.exit(code);
