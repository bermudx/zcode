// node --test scripts/test/fork-engineering-set.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { filterPathsBySet, parseArgs, parseEngineeringSet } from "../run-affected-engineering-tests.mjs";

const upstream = JSON.parse(readFileSync(new URL("../engineering-test-files.json", import.meta.url), "utf8"));
const manifest = readFileSync(new URL("../fork-engineering-test-files.json", import.meta.url), "utf8");

test("parseArgs: --set accepts piz/all only, absent means upstream default", async () => {
  assert.equal((await parseArgs(["--set", "piz"])).set, "piz");
  assert.equal((await parseArgs(["--set", "all"])).set, "all");
  assert.equal((await parseArgs([])).set, undefined);
  await assert.rejects(() => parseArgs(["--set", "desktop"]), /piz 或 all/u);
  await assert.rejects(() => parseArgs(["--set"]), /piz 或 all/u);
});

test("the shipped fork manifest is a valid subset of the upstream list", () => {
  const set = parseEngineeringSet(manifest, upstream);
  assert.equal(set.size, 7);
  assert.ok(set.has("packages/shared/src/request-security-edition/contract.test.ts"));
  assert.ok(set.has("packages/shared/src/app-server-attach/contract.test.ts"));
});

test("parseEngineeringSet: unknown, duplicate and empty manifests are errors", () => {
  assert.throws(() => parseEngineeringSet('["packages/nope.test.ts"]', upstream), /not in the upstream/u);
  const one = upstream[0];
  assert.throws(() => parseEngineeringSet(JSON.stringify([one, one]), upstream), /duplicate/u);
  assert.throws(() => parseEngineeringSet("[]", upstream), /empty/u);
});

test("filterPathsBySet keeps only manifest paths, preserving order", () => {
  const set = new Set(["b.test.ts", "a.test.ts"]);
  assert.deepEqual(filterPathsBySet(["a.test.ts", "c.test.ts", "b.test.ts"], set), ["a.test.ts", "b.test.ts"]);
  assert.deepEqual(filterPathsBySet(["c.test.ts"], set), []);
});
