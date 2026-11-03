#!/usr/bin/env node
// fork-typecheck — the piz typecheck gate: CLI workspace + root shared surface.
//
// Root `pnpm typecheck` also compiles the desktop app (main/host/e2e/
// remote-main), ui, web, e2e-report, dev-docs and zcode-cua — products piz
// does not ship. This gate runs the CLI-workspace turbo typecheck (35
// packages) plus `tsc -b` over the root packages the CLI core imports
// (@zcode/shared incl. testing fixtures, rpc, provider, provider-node,
// model-option-map). Root typecheck remains the sync-branch gate; see
// docs/fork/verification.md "Lean fork gates".
//
// Usage (from anywhere, under pinned tools):
//   mise exec -- pnpm typecheck:piz [--dry-run]
// Exit: 0 = all steps passed, 1 = a step failed, 2 = script error.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SHARED_SURFACE = [
  "packages/shared/tsconfig.testing.json",
  "packages/rpc",
  "packages/provider",
  "packages/provider-node",
  "packages/shared",
  "packages/model-option-map",
];

export function parseArgs(argv) {
  const opts = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

export function plan(root) {
  const turbo = join(root, "node_modules/.bin/turbo");
  const tsc = join(root, "node_modules/.bin/tsc");
  return [
    { label: "CLI workspace (turbo run typecheck)", cmd: turbo, args: ["run", "typecheck"], cwd: join(root, "apps/zcode-cli") },
    { label: "root shared surface (tsc -b)", cmd: tsc, args: ["-b", ...SHARED_SURFACE], cwd: root },
  ];
}

function runStep(step) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(step.cmd, step.args, { cwd: step.cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => resolvePromise(code ?? (signal ? 128 : 1)));
  });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      console.log("Usage: pnpm typecheck:piz [--dry-run] — CLI workspace + root shared surface; see docs/fork/verification.md.");
      return 0;
    }
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const steps = plan(root);
    for (const step of steps) {
      if (!existsSync(step.cmd)) {
        console.error(`[fork-typecheck] missing ${step.cmd} — install pinned deps first (mise exec -- pnpm install).`);
        return 2;
      }
      console.log(`[fork-typecheck] ${step.label}: ${step.cmd} ${step.args.join(" ")} (cwd ${step.cwd})`);
    }
    if (opts.dryRun) return 0;
    for (const step of steps) {
      process.stdout.write(`▶ ${step.label} …\n`);
      const code = await runStep(step);
      if (code !== 0) {
        console.error(`[fork-typecheck] FAILED: ${step.label} (exit ${code})`);
        return 1;
      }
    }
    console.log("[fork-typecheck] all steps passed (CLI workspace + shared surface; not the root desktop typecheck).");
    return 0;
  } catch (error) {
    console.error(`[fork-typecheck] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
