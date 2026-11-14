// Disposable MCP stdio fixture for lifecycle tests (issue #31 / CMCP*).
// Newline-delimited JSON-RPC over stdio; fake credentials only.
// Env:
//   MCP_FIXTURE_PID_FILE — write own PID here so tests can assert child death.
//   MCP_FIXTURE_PID_DIR  — additionally write <dir>/<pid>.pid so identical
//                          configs spawning several children leave one record each.
//   MCP_FIXTURE_LABEL    — harmless generation label (e.g. "v1"/"v2") stamped in
//                          echo output; lets tests prove which connection answered.
//   MCP_FIXTURE_HOLD_INITIALIZE=1 — never answer initialize (blocked handshake).
//   MCP_FIXTURE_INITIALIZE_RELEASE_FILE — hold the initialize answer until this
//                          file exists (async poll); the held handshake can be
//                          released deterministically or killed mid-wait.
//   MCP_FIXTURE_HOLD_CALL=1 — never answer tools/call (barrier for detach tests).
//   MCP_FIXTURE_CALL_MARKER_FILE — write own PID here when a tools/call is
//                          RECEIVED, before the holdCall gate; lets tests await
//                          real call receipt instead of sleeping.
//   MCP_FIXTURE_FAIL_INITIALIZE=1 — answer initialize with an error result so
//                          the connection fails through the normal path.
//   MCP_FIXTURE_STDERR_TEXT   — write this exact text to stderr at startup
//                          (disposable sentinel tests only; never real values).
//   MCP_FIXTURE_VERSION_ENV — name of an env var whose fake value is appended to
//                          the label, so a credential-only config change yields
//                          an observable generation change (fake constants only).
// Tool results carry pid + label + echoed input only — env/credential values are
// never read into or echoed back from results.
import { mkdirSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

// SDK 2.0 auto/pin 协商会先派一个一次性 sibling 探针进程（同 env、只发
// server/discover 后被回收），会话子进程随后才启动。启动即落 pid 会让探针
// 先写同一文件，测试读到的是已回收的探针 pid；只有会话 transport 会收到
// initialize，pid 记录改在收到 initialize 时落盘，文件只指向会话子进程。
function recordPid() {
  if (process.env.MCP_FIXTURE_PID_FILE) {
    writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid));
  }
  if (process.env.MCP_FIXTURE_PID_DIR) {
    mkdirSync(process.env.MCP_FIXTURE_PID_DIR, { recursive: true });
    writeFileSync(join(process.env.MCP_FIXTURE_PID_DIR, `${process.pid}.pid`), String(process.pid));
  }
}
const holdInitialize = process.env.MCP_FIXTURE_HOLD_INITIALIZE === "1";
const initReleaseFile = process.env.MCP_FIXTURE_INITIALIZE_RELEASE_FILE;
const holdCall = process.env.MCP_FIXTURE_HOLD_CALL === "1";
const failInitialize = process.env.MCP_FIXTURE_FAIL_INITIALIZE === "1";
if (process.env.MCP_FIXTURE_STDERR_TEXT) {
  process.stderr.write(`${process.env.MCP_FIXTURE_STDERR_TEXT}\n`);
}
const baseLabel = process.env.MCP_FIXTURE_LABEL ?? "unlabeled";
const versionEnv = process.env.MCP_FIXTURE_VERSION_ENV;
// 版本只来自测试显式给的 fake env 值；真实 token 从不进 echo 输出。
const label = versionEnv ? `${baseLabel}-${process.env[versionEnv] ?? "unset"}` : baseLabel;

function respond(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue; // notifications need no response
    if (message.method === "initialize") {
      recordPid();
      if (holdInitialize) continue; // 握手永远不完成—— detach/close 必须中止它
      if (failInitialize) {
        respond({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "fixture init failure" },
        });
        continue;
      }
      const initResponse = {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture-echo", version: "0.0.1" },
        },
      };
      if (initReleaseFile) {
        // 释放文件闸门：文件出现前扣住握手（异步轮询，进程被杀即终止）。
        void (async () => {
          for (;;) {
            try {
              await access(initReleaseFile);
              break;
            } catch {
              await new Promise((r) => setTimeout(r, 15));
            }
          }
          respond(initResponse);
        })();
        continue;
      }
      respond(initResponse);
      continue;
    }
    if (message.method === "tools/list") {
      respond({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "fixture echo tool",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
              },
            },
          ],
        },
      });
      continue;
    }
    if (message.method === "tools/call") {
      // 收到即落标（在 holdCall 闸门之前）：测试用标记文件证明调用真实到达
      // 子进程，而不是靠 sleep 猜时序。
      if (process.env.MCP_FIXTURE_CALL_MARKER_FILE) {
        writeFileSync(process.env.MCP_FIXTURE_CALL_MARKER_FILE, String(process.pid));
      }
      if (holdCall) continue; // 工具调用被闸门挡住——detach 必须中止挂起调用
      respond({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: `echo[${label}@${process.pid}]:${message.params?.arguments?.text ?? ""}`,
            },
          ],
        },
      });
      continue;
    }
    if (message.method === "ping") {
      respond({ jsonrpc: "2.0", id: message.id, result: {} });
      continue;
    }
    respond({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "method not found" },
    });
  }
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
