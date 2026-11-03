// node --test apps/zcode-cli/scripts/fork-tests.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, collectResults, parseArgs, parseKnownFailures, testKey } from "./fork-tests.mjs";

test("parseArgs: defaults, repeatable --package, exclusive --full/--base", () => {
  assert.deepEqual(parseArgs([]), { packages: [], retry: true, tmpfs: true, full: false, dryRun: false });
  const opts = parseArgs(["--package", "a", "--package", "b", "--no-retry", "--max-workers", "2"]);
  assert.deepEqual(opts.packages, ["a", "b"]);
  assert.equal(opts.retry, false);
  assert.equal(opts.maxWorkers, 2);
  assert.throws(() => parseArgs(["--full", "--base", "main"]), /exclusive/u);
  assert.throws(() => parseArgs(["--base"]), /needs a value/u);
  assert.throws(() => parseArgs(["--max-workers", "0"]), /positive integer/u);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/u);
});

test("parseKnownFailures: comments, blanks, separators inside test names, malformed lines", () => {
  const keys = parseKnownFailures(
    ["# header", "", "@zcode/a :: tests/x.test.ts :: suite > case :: with sep", "  @zcode/b :: t.ts :: c  "].join("\n"),
  );
  assert.ok(keys.has("@zcode/a :: tests/x.test.ts :: suite > case :: with sep"));
  assert.ok(keys.has("@zcode/b :: t.ts :: c"));
  assert.throws(() => parseKnownFailures("@zcode/a :: only-two"), /line 1/u);
});

test("collectResults: package-relative files, describe path, file-level collection errors", () => {
  const report = {
    testResults: [
      {
        name: "/repo/pkg/tests/a.test.ts",
        status: "failed",
        assertionResults: [
          { ancestorTitles: ["outer", "inner"], title: "t1", status: "failed" },
          { ancestorTitles: [], title: "t2", status: "passed" },
        ],
      },
      { name: "/repo/pkg/tests/broken.test.ts", status: "failed", assertionResults: [] },
    ],
  };
  const results = collectResults("@zcode/p", "/repo/pkg", report);
  assert.equal(results.get(testKey("@zcode/p", "tests/a.test.ts", "outer > inner > t1"))?.status, "failed");
  assert.equal(results.get(testKey("@zcode/p", "tests/a.test.ts", "t2"))?.status, "passed");
  assert.equal(results.get(testKey("@zcode/p", "tests/broken.test.ts", "(file)"))?.status, "failed");
  assert.equal(results.has(testKey("@zcode/p", "tests/a.test.ts", "(file)")), false);
});

test("classify: known vs new vs flaky vs stale", () => {
  const f = { file: "f", status: "failed" };
  const p = { file: "f", status: "passed" };
  const first = new Map([
    ["k-known", f],
    ["k-new", f],
    ["k-flaky", f],
    ["k-stale", p],
    ["k-ok", p],
  ]);
  const rerun = new Map([
    ["k-new", f],
    ["k-flaky", p],
  ]);
  const known = new Set(["k-known", "k-stale"]);
  assert.deepEqual(classify(first, rerun, known), {
    newFailures: ["k-new"],
    known: ["k-known"],
    flaky: ["k-flaky"],
    stale: ["k-stale"],
  });
  // No rerun available: a failure stays new, never silently flaky.
  assert.deepEqual(classify(new Map([["k", f]]), new Map(), new Set()).newFailures, ["k"]);
});
