import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { runAcpStdio } from "../src/acp/acp-main.js";

const INITIALIZE = `${JSON.stringify({
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: { protocolVersion: 1 },
})}\n`;
const TEST_TIMEOUT_MS = 5_000;

function captureOutput() {
  let text = "";
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString("utf8");
      callback();
    },
  });
  return { stdout, text: () => text };
}

function run(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) {
  let diagnostics = "";
  const result = runAcpStdio({
    env: {},
    stderr: { write: (chunk) => { diagnostics += chunk; } },
    stdin,
    stdout,
    version: "1.2.3",
  });
  return { diagnostics: () => diagnostics, result };
}

function assertListenersRemoved(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) {
  assert.equal(stdin.listenerCount("data"), 0);
  assert.equal(stdin.listenerCount("end"), 0);
  assert.equal(stdin.listenerCount("error"), 0);
  assert.equal(stdout.listenerCount("error"), 0);
}

test("acp stdio: ordinary empty EOF exits successfully without diagnostics", { timeout: TEST_TIMEOUT_MS }, async () => {
  const stdin = new PassThrough();
  const output = captureOutput();
  const running = run(stdin, output.stdout);
  stdin.end();
  assert.equal(await running.result, 0);
  assert.equal(running.diagnostics(), "");
  assert.equal(output.text(), "");
  assertListenersRemoved(stdin, output.stdout);
});

test("acp stdio: real NDJSON initialize then normal close keeps stdout protocol-only", { timeout: TEST_TIMEOUT_MS }, async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const running = run(stdin, stdout);
  const response = once(stdout, "data");
  stdin.write(INITIALIZE);
  const [chunk] = await response;
  const message = JSON.parse(chunk.toString("utf8")) as {
    id: number;
    jsonrpc: string;
    result: { protocolVersion: number; agentInfo: { name: string } };
  };
  assert.equal(message.id, 1);
  assert.equal(message.jsonrpc, "2.0");
  assert.equal(message.result.protocolVersion, 1);
  assert.equal(message.result.agentInfo.name, "piz");
  stdin.end();
  assert.equal(await running.result, 0);
  assert.equal(running.diagnostics(), "");
  assertListenersRemoved(stdin, stdout);
});

test("acp stdio: actual stdin open failure returns nonzero with source and OS diagnostic", { timeout: TEST_TIMEOUT_MS }, async () => {
  const stdin = createReadStream(join(tmpdir(), `piz-acp-missing-${randomUUID()}`));
  const output = captureOutput();
  const running = run(stdin, output.stdout);
  assert.equal(await running.result, 1);
  assert.match(running.diagnostics(), /^acp: stdin transport failed: .*ENOENT/);
  assert.equal(output.text(), "");
  assertListenersRemoved(stdin, output.stdout);
});

test("acp stdio: actual write to read-only file reports stdout error, not successful close", { timeout: TEST_TIMEOUT_MS }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "piz-acp-stdout-"));
  const file = join(directory, "read-only-output");
  await writeFile(file, "unchanged");
  const handle = await open(file, "r");
  const stdout = handle.createWriteStream({ autoClose: false });
  const stdin = new PassThrough();
  let ioError: Error | undefined;
  stdout.once("error", (error: Error) => { ioError = error; });
  try {
    const running = run(stdin, stdout);
    stdin.end(INITIALIZE);
    assert.equal(await running.result, 1);
    assert.ok(ioError, "Node emitted the real OS write error");
    assert.equal(running.diagnostics(), `acp: stdout transport failed: ${ioError.message}\n`);
    assertListenersRemoved(stdin, stdout);
  } finally {
    stdin.destroy();
    stdout.destroy();
    await handle.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("acp stdio: stdout error event while idle fails without waiting for stdin EOF", { timeout: TEST_TIMEOUT_MS }, async () => {
  const stdin = new PassThrough();
  const output = captureOutput();
  const running = run(stdin, output.stdout);
  output.stdout.destroy(new Error("idle output unavailable"));
  assert.equal(await running.result, 1);
  assert.equal(running.diagnostics(), "acp: stdout transport failed: idle output unavailable\n");
  assertListenersRemoved(stdin, output.stdout);
  stdin.destroy();
});

test("acp stdio: synchronous stdout write exception is diagnosed at the entry boundary", { timeout: TEST_TIMEOUT_MS }, async () => {
  const stdin = new PassThrough();
  const stdout = new Writable();
  stdout.write = () => { throw new Error("write threw synchronously"); };
  const running = run(stdin, stdout);
  stdin.write(INITIALIZE);
  assert.equal(await running.result, 1);
  assert.equal(running.diagnostics(), "acp: stdout transport failed: write threw synchronously\n");
  assertListenersRemoved(stdin, stdout);
  stdin.destroy();
  stdout.destroy();
});

for (const writeError of [undefined, new Error("late stdout failure")]) {
  test(`acp stdio: EOF waits for pending stdout callback (${writeError ? "failure" : "success"})`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const stdin = new PassThrough();
    const started = Promise.withResolvers<(error?: Error | null) => void>();
    const stdout = new Writable({
      write(_chunk, _encoding, callback) { started.resolve(callback); },
    });
    const running = run(stdin, stdout);
    let settled = false;
    void running.result.then(() => { settled = true; });
    stdin.end(INITIALIZE);
    const finishWrite = await started.promise;
    await setImmediate();
    assert.equal(settled, false, "EOF cannot hide an outstanding write failure");
    finishWrite(writeError);
    assert.equal(await running.result, writeError ? 1 : 0);
    assert.equal(running.diagnostics(), writeError ? `acp: stdout transport failed: ${writeError.message}\n` : "");
    assertListenersRemoved(stdin, stdout);
    stdout.destroy();
  });
}

test("acp stdio: malformed JSON remains an SDK parse-error response, not a silent fallback", { timeout: TEST_TIMEOUT_MS }, async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const running = run(stdin, stdout);
  const response = once(stdout, "data");
  stdin.write("not JSON\n");
  const [chunk] = await response;
  const message = JSON.parse(chunk.toString("utf8")) as { error: { code: number }; id: null };
  assert.equal(message.id, null);
  assert.equal(message.error.code, -32700);
  stdin.end();
  assert.equal(await running.result, 0);
  assert.equal(running.diagnostics(), "");
  assertListenersRemoved(stdin, stdout);
});
