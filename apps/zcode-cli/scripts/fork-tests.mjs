#!/usr/bin/env node
// fork-tests — run the CLI-workspace tests a piz branch can actually affect.
//
// Default (patch/* branches): turbo picks every package changed since the
// base plus its dependents; inside vitest packages, vitest's own --changed
// import-graph selection narrows to test files that reach a changed file.
// node:test packages (cli, tui, tui-pi, …) have no per-file selection and run
// their whole package script. The always-run focused set (signing, socket
// listener) runs regardless.
//
// --full (sync/* branches, full promote tier): every package's test script.
//
// Both modes: zcode/herdr session env is stripped, TMPDIR points at a tmpfs
// when one exists (SQLite-heavy tests fsync per write; 65k-row fixtures go
// from ~26 min under load on btrfs to seconds), failing vitest files get one
// solo rerun, one file at a time (pass on rerun = FLAKY, reported, not fatal),
// and failures are classified against docs/fork/known-test-failures.txt.
//
// A selected run is NOT a full-suite result, and root-workspace changes
// (outside apps/zcode-cli) are reported as not covered — never as passed.
//
// Usage (from repo root or apps/zcode-cli, under pinned tools):
//   mise exec -- node apps/zcode-cli/scripts/fork-tests.mjs [options]
//     --base <ref>        selection base (default: merge-base of main and HEAD)
//     --full              run every package, no selection
//     --promote-gate      pre-promote: pick the tier from the diff since the last
//                         promotion (docs/fork/verification.md "Promotion gate")
//     --exclude-plugins   with --full (pre-promote): skip plugin-package test
//                         tasks the no-plugin core does not load; printed, and
//                         still run by plain --full on sync branches
//     --package <name>    restrict to these packages (repeatable)
//     --max-workers <n>   pass --maxWorkers to vitest first pass
//     --no-retry          skip the isolated rerun of failing vitest files
//     --no-tmpfs          keep the inherited TMPDIR
//     --known <path>      known-failures file (default docs/fork/known-test-failures.txt)
//     --dry-run           print the plan, run nothing
// Exit: 0 = no new failures, 1 = new failures / package crash, 2 = script error.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Ambient piz/zcode/herdr session env leaks into spawned-core and reporter
// paths and dooms fake-core harnesses (docs/fork/verification.md).
export const STRIPPED_ENV = [
  "ZCODE_SERVER_BIN",
  "ZCODE_WORKSPACE_IDENTITY",
  "ZCODE_ATTACH_CORE",
  "ZCODE_RUNTIME_ENV",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_BIN_PATH",
];

// Signing is mandatory for every candidate; the socket listener is the core
// reuse contract. Run them even when selection would skip them.
export const ALWAYS_RUN = [
  { pkg: "@zcode/adapters", files: ["tests/client-request-signing.test.ts"] },
  { pkg: "@zcode/bootstrap", files: ["tests/socket-listener.test.ts"] },
];

// node:test files a package script omits but the fork gate needs; run with the
// package whenever it is selected (verification.md: cli script lacks resume-target).
export const EXTRA_NODE_TESTS = {
  "@zcode/cli": ["tests/attach-resume-target.test.ts"],
};

// Plugin packages the no-plugin shared core does not load (docs/fork/
// verification.md "Lean fork gates" C). --exclude-plugins drops their test
// tasks on pre-promote runs only; plain --full (sync branches) keeps them.
// Bootstrap's bundled-plugin seeding tests are NOT here — seeding still runs
// at startup — and @zcode/node-repl-host is a built-in host, not a plugin.
export const PLUGIN_PACKAGES = [
  "@zcode/android-emulator-plugin",
  "@zcode/ios-simulator-plugin",
  "@zcode/browser-use-plugin",
  "@zcode/office-runtime",
  "@zcode/zcode-site-plugin",
  "@zcode/plugin-creator-plugin",
  "@zcode/zcode-cua-plugin",
];

// Paths a promotion can change and still take the selected tier. An allowlist on
// purpose: anything unrecognised, including shared core code, gets the full tier.
const SELECTED_TIER_PATH = /^(?:apps\/zcode-cli\/packages\/(?:tui|tui-pi)\/|docs\/|FORK\.md$|AGENTS\.md$)/u;

export function promoteTier(changedFiles) {
  return changedFiles.every((file) => SELECTED_TIER_PATH.test(file)) ? "selected" : "full";
}

export function filterPluginTasks(tasks, excludePlugins) {
  if (!excludePlugins) return { kept: tasks, excluded: [] };
  const excluded = tasks.filter((task) => PLUGIN_PACKAGES.includes(task.pkg));
  return { kept: tasks.filter((task) => !PLUGIN_PACKAGES.includes(task.pkg)), excluded };
}

// node:test packages whose tests exec built artifacts. Missing = NOT RUN (exit 1),
// never a pass. Present-but-stale is the caller's job: rebuild after src changes.
export const REQUIRES_BUILD = {
  "@zcode/cli": ["dist/zcode.cjs"],
};
const BUILD_HINT =
  "cd apps/zcode-cli && mise exec -- ../../node_modules/.bin/turbo run build && mise exec -- pnpm --dir ../.. --filter @zcode/model-option-map build";

const TMPFS_MAGIC = 0x01021994;
const KNOWN_SEP = " :: ";

export function parseArgs(argv) {
  const opts = { packages: [], retry: true, tmpfs: true, full: false, dryRun: false, excludePlugins: false, promoteGate: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--base") opts.base = value();
    else if (arg === "--full") opts.full = true;
    else if (arg === "--promote-gate") opts.promoteGate = true;
    else if (arg === "--package") opts.packages.push(value());
    else if (arg === "--max-workers") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new Error("--max-workers needs a positive integer");
      opts.maxWorkers = n;
    } else if (arg === "--exclude-plugins") opts.excludePlugins = true;
    else if (arg === "--no-retry") opts.retry = false;
    else if (arg === "--no-tmpfs") opts.tmpfs = false;
    else if (arg === "--known") opts.known = value();
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.full && opts.base) throw new Error("--full and --base are exclusive");
  if (opts.full && opts.promoteGate) throw new Error("--full and --promote-gate are exclusive");
  return opts;
}

/** Known-failure keys: `<package> :: <file relative to package> :: <describe > … > title>`. */
export function parseKnownFailures(text) {
  const keys = new Set();
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(KNOWN_SEP);
    if (parts.length < 3 || parts.some((part) => !part.trim()))
      throw new Error(`known-failures line ${index + 1}: expected "pkg${KNOWN_SEP}file${KNOWN_SEP}test"`);
    keys.add([parts[0], parts[1], parts.slice(2).join(KNOWN_SEP)].join(KNOWN_SEP));
  }
  return keys;
}

export const testKey = (pkg, file, name) => [pkg, file, name].join(KNOWN_SEP);

/** Flatten a vitest JSON report into per-test results keyed like the known file. */
export function collectResults(pkg, pkgDir, report) {
  const results = new Map();
  for (const fileResult of report?.testResults ?? []) {
    const file = relative(pkgDir, fileResult.name).replaceAll("\\", "/");
    const assertions = fileResult.assertionResults ?? [];
    for (const test of assertions) {
      const name = [...(test.ancestorTitles ?? []), test.title].join(" > ");
      results.set(testKey(pkg, file, name), { file, status: test.status });
    }
    // Import/collection errors fail the file with no failed test inside it.
    if (fileResult.status === "failed" && !assertions.some((test) => test.status === "failed"))
      results.set(testKey(pkg, file, "(file)"), { file, status: "failed" });
  }
  return results;
}

/**
 * first: results of the main pass; rerun: results of the isolated rerun (may be empty).
 * Returns buckets of keys: newFailures, known, flaky, stale (known but now passing).
 */
export function classify(first, rerun, known) {
  const out = { newFailures: [], known: [], flaky: [], stale: [] };
  for (const [key, result] of first) {
    if (result.status === "failed") {
      if (known.has(key)) out.known.push(key);
      else if (rerun.get(key)?.status === "passed") out.flaky.push(key);
      else out.newFailures.push(key);
    } else if (result.status === "passed" && known.has(key)) out.stale.push(key);
  }
  return out;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

// Tests must not see the operator's ~/.zcode: it slows them and they write to it.
function childEnv(tmp, home) {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV) delete env[key];
  if (tmp) env.TMPDIR = tmp;
  if (home) env.HOME = home;
  return env;
}

// Without these, whole classes of tests fail for reasons unrelated to the code.
export const REQUIRED_BUILD_ARTIFACTS = [
  "apps/zcode-cli/packages/contracts/dist/index.js",
  "apps/zcode-cli/packages/browser-use-plugin/scripts/browser-client.mjs",
  "packages/shared/dist/index.js",
];

export function missingBuildArtifacts(root) {
  return REQUIRED_BUILD_ARTIFACTS.filter((path) => !existsSync(join(root, path)));
}

function tmpfsDir() {
  try {
    if (statfsSync("/dev/shm").type !== TMPFS_MAGIC) return undefined;
  } catch {
    return undefined;
  }
  return mkdtempSync("/dev/shm/piz-fork-tests-");
}

function run(cmd, args, { cwd, env, log }) {
  return new Promise((resolvePromise, reject) => {
    const fd = openSync(log, "a");
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", fd, fd] });
    child.on("error", (error) => {
      closeSync(fd);
      reject(error);
    });
    child.on("close", (code, signal) => {
      closeSync(fd);
      resolvePromise(code ?? (signal ? 128 : 1));
    });
  });
}

function turboTestTasks(cliRoot, env, filter) {
  const args = ["run", "test", "--dry=json", ...(filter ? [`--filter=${filter}`] : [])];
  const out = execFileSync(join(cliRoot, "../../node_modules/.bin/turbo"), args, {
    cwd: cliRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  return parsed.tasks
    .filter((task) => task.task === "test" && task.command && task.command !== "<NONEXISTENT>")
    .map((task) => ({
      pkg: task.package,
      dir: join(cliRoot, task.directory),
      command: task.command,
      vitest: /\bvitest\b/u.test(task.command),
    }));
}

function readReport(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml)$/u;

export async function main(argv = process.argv.slice(2)) {
  let tmp;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      const lines = readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
      const head = lines.slice(0, lines.findIndex((line) => !line.startsWith("//")));
      console.log(head.map((line) => line.replace(/^\/\/ ?/u, "")).join("\n"));
      return 0;
    }
    const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    const cliRoot = join(repoRoot, "apps/zcode-cli");
    if (opts.promoteGate) {
      const stamp = join(cliRoot, "packages/cli/dist-runtime/PROMOTED_FROM");
      if (!opts.base && !existsSync(stamp))
        throw new Error(`--promote-gate needs --base <last promoted sha>: ${stamp} does not exist yet`);
      opts.base ??= readFileSync(stamp, "utf8").trim();
      const tier = promoteTier(git(repoRoot, ["diff", "--name-only", opts.base, "HEAD"]).split("\n").filter(Boolean));
      console.log(`[fork-tests] promote gate: ${tier} tier (changes since ${opts.base.slice(0, 10)})`);
      if (tier === "full") {
        opts.full = true;
        opts.excludePlugins = true;
        opts.base = undefined;
      }
    }
    const base = opts.full ? undefined : (opts.base ?? git(repoRoot, ["merge-base", "main", "HEAD"]));
    const knownPath = resolve(repoRoot, opts.known ?? "docs/fork/known-test-failures.txt");
    const known = existsSync(knownPath) ? parseKnownFailures(readFileSync(knownPath, "utf8")) : new Set();

    tmp = opts.tmpfs && !opts.dryRun ? tmpfsDir() : undefined;
    const runDir = mkdtempSync(join(tmpdir(), "piz-fork-tests-run-"));
    const home = join(runDir, "home");
    mkdirSync(home);
    const env = childEnv(tmp, home);
    if (opts.full && !opts.dryRun) {
      const missing = missingBuildArtifacts(repoRoot);
      if (missing.length) {
        throw new Error(`build first, tests would fail on missing artifacts: ${missing.join(", ")} (docs/fork/verification.md "Promotion gate")`);
      }
    }

    let tasks = turboTestTasks(cliRoot, env, base ? `...[${base}]` : undefined);
    const all = base ? turboTestTasks(cliRoot, env) : tasks;
    if (opts.packages.length) tasks = tasks.filter((task) => opts.packages.includes(task.pkg));
    // Plugin tier: excluded packages are listed in the plan below, never
    // silently skipped; plain --full on sync branches still runs them.
    const pluginTier = filterPluginTasks(tasks, opts.excludePlugins);
    tasks = pluginTier.kept;
    const always = opts.full
      ? []
      : ALWAYS_RUN.filter((entry) => !opts.packages.length || opts.packages.includes(entry.pkg))
          .map((entry) => ({ ...entry, task: all.find((task) => task.pkg === entry.pkg) }))
          .filter((entry) => entry.task);

    const changed = base
      ? [
          ...git(repoRoot, ["diff", "--name-only", base]).split("\n"),
          ...git(repoRoot, ["ls-files", "--others", "--exclude-standard"]).split("\n"),
        ].filter(Boolean)
      : [];
    const uncovered = changed.filter((file) => !file.startsWith("apps/zcode-cli/") && CODE_FILE.test(file));

    console.log(
      `[fork-tests] mode=${opts.full ? "full" : `selected (base ${base.slice(0, 10)})`}${opts.excludePlugins ? " (plugin tier excluded)" : ""} packages=${tasks.length} known=${known.size} TMPDIR=${tmp ?? "(inherited)"}`,
    );
    for (const task of pluginTier.excluded)
      console.log(`  ${task.pkg}: EXCLUDED (plugin package; run plain --full on sync branches to cover it)`);
    for (const task of tasks)
      console.log(`  ${task.pkg}: ${task.vitest ? (opts.full ? "vitest, all files" : "vitest, --changed") : "package script (no per-file selection)"}`);
    for (const entry of always) console.log(`  ${entry.pkg}: always-run ${entry.files.join(" ")}`);
    if (uncovered.length)
      console.log(`  NOT COVERED (root workspace, run separately): ${uncovered.join(" ")}`);
    if (opts.dryRun) return 0;

    const summary = { newFailures: [], known: [], flaky: [], stale: [], crashed: [], notRun: [], ran: 0 };
    const ranFiles = new Set();
    // files: run exactly these files (package script filters would OR with them and
    // widen the run to the whole tests dir); otherwise the package's own script.
    const vitestPass = async (task, label, { files, args = [] }) => {
      const slug = `${task.pkg.replace(/[^\w.-]+/gu, "_")}-${label}`;
      const json = join(runDir, `${slug}.json`);
      const log = join(runDir, `${slug}.log`);
      const reporters = ["--reporter=default", "--reporter=json", `--outputFile.json=${json}`];
      const code = files
        ? await run("pnpm", ["exec", "vitest", "run", ...files, ...args, ...reporters], {
            cwd: task.dir,
            env,
            log,
          })
        : await run("pnpm", ["run", "test", "--run", "--passWithNoTests", ...args, ...reporters], {
            cwd: task.dir,
            env,
            log,
          });
      return { code, report: readReport(json), log };
    };

    const handleVitest = async (task, label, selection) => {
      process.stdout.write(`▶ ${task.pkg} [${label}] … `);
      const started = Date.now();
      const first = await vitestPass(task, label, selection);
      if (!first.report) {
        console.log(`CRASH (exit ${first.code}, no report) — ${first.log}`);
        summary.crashed.push(`${task.pkg} [${label}]`);
        return;
      }
      const results = collectResults(task.pkg, task.dir, first.report);
      summary.ran += results.size;
      for (const result of results.values()) ranFiles.add(`${task.pkg}${KNOWN_SEP}${result.file}`);
      let rerun = new Map();
      const failingFiles = [
        ...new Set(
          [...results]
            .filter(([key, r]) => r.status === "failed" && !known.has(key))
            .map(([, r]) => r.file),
        ),
      ];
      // Rerun each failing file alone: batching them (even at --maxWorkers=2) kept
      // protocol-unbound-resume timing out under load while it passed 11/11 solo.
      if (opts.retry)
        for (const [index, file] of failingFiles.entries()) {
          const second = await vitestPass(task, `${label}-rerun-${index}`, { files: [file], args: ["--maxWorkers=1"] });
          if (second.report) for (const [key, value] of collectResults(task.pkg, task.dir, second.report)) rerun.set(key, value);
        }
      const buckets = classify(results, rerun, known);
      for (const key of Object.keys(buckets)) summary[key].push(...buckets[key]);
      console.log(
        `${results.size} tests, ${buckets.newFailures.length} new, ${buckets.known.length} known, ${buckets.flaky.length} flaky (${Math.round((Date.now() - started) / 1000)}s) — ${first.log}`,
      );
    };

    for (const task of tasks) {
      const workers = opts.maxWorkers ? [`--maxWorkers=${opts.maxWorkers}`] : [];
      if (task.vitest)
        await handleVitest(task, opts.full ? "full" : "selected", { args: [...(base ? ["--changed", base] : []), ...workers] });
      else {
        const missing = (REQUIRES_BUILD[task.pkg] ?? []).filter((file) => !existsSync(join(task.dir, file)));
        if (missing.length) {
          console.log(`▶ ${task.pkg} NOT RUN — missing ${missing.join(" ")}; build first (${BUILD_HINT})`);
          summary.notRun.push(`${task.pkg} (missing ${missing.join(" ")})`);
          continue;
        }
        process.stdout.write(`▶ ${task.pkg} [package script] … `);
        const log = join(runDir, `${task.pkg.replace(/[^\w.-]+/gu, "_")}.log`);
        let code = await run("pnpm", ["run", "test"], { cwd: task.dir, env, log });
        const extra = EXTRA_NODE_TESTS[task.pkg] ?? [];
        if (extra.length) {
          const extraCode = await run(
            "pnpm",
            ["exec", "node", "--disable-warning=DEP0205", "--import", "tsx", "--test", ...extra],
            { cwd: task.dir, env, log },
          );
          if (code === 0) code = extraCode;
        }
        console.log(`${code === 0 ? "pass" : `FAIL (exit ${code})`}${extra.length ? ` (+${extra.join(" ")})` : ""} — ${log}`);
        if (code !== 0) summary.crashed.push(`${task.pkg} (package script exit ${code}; see log)`);
      }
    }
    for (const entry of always) {
      const files = entry.files.filter((file) => !ranFiles.has(`${entry.pkg}${KNOWN_SEP}${file}`));
      if (files.length) await handleVitest(entry.task, "always", { files });
    }

    const list = (title, keys) => {
      if (!keys.length) return;
      console.log(`\n${title} (${keys.length}):`);
      for (const key of keys) console.log(`  ${key}`);
    };
    list("NEW FAILURES", summary.newFailures);
    list("FAILED PACKAGES / CRASHES", summary.crashed);
    list("NOT RUN (precondition missing — not a pass)", summary.notRun);
    list("FLAKY (failed, passed on isolated rerun)", summary.flaky);
    list("KNOWN FAILURES (still failing)", summary.known);
    list(`STALE KNOWN ENTRIES (now passing — remove from ${relative(repoRoot, knownPath)})`, summary.stale);
    if (uncovered.length) console.log(`\nNOT COVERED: root workspace changes (${uncovered.length} files).`);
    console.log(
      `\n[fork-tests] ${summary.ran} vitest results${opts.full ? "" : " — selected run, not a full-suite result"}. logs: ${runDir}`,
    );
    return summary.newFailures.length || summary.crashed.length || summary.notRun.length ? 1 : 0;
  } catch (error) {
    console.error(`[fork-tests] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await main();
