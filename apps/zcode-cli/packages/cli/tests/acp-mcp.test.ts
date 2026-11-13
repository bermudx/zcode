import assert from "node:assert/strict";
import test from "node:test";
import { AcpMcpMapError, mapAcpMcpServers } from "../src/acp/acp-mcp.js";

const CWD = "/session/workdir";

// issue #31 CMCP01/02：ACP client 声明在边界映射成共享协议形态——
// stdio/HTTP/SSE 字段与凭据原样保留，会话内默认 scope/isolation，重名拒绝，
// 非法定义报 sanitized invalid-params（不回显输入值）。

test("acp-mcp: undefined stays undefined, explicit [] stays an empty array", () => {
  assert.equal(mapAcpMcpServers(undefined, CWD), undefined);
  assert.deepEqual(mapAcpMcpServers([], CWD), []);
});

test("acp-mcp: stdio definition keeps command/args/env and stamps session scope", () => {
  const mapped = mapAcpMcpServers(
    [
      {
        name: "t3-tools",
        command: "node",
        args: ["server.js", "--flag"],
        env: [{ name: "FAKE_TOKEN", value: "fake-credential-sentinel-1" }],
      },
    ],
    CWD,
  );
  assert.equal(mapped?.length, 1);
  const server = mapped![0];
  assert.equal(server.name, "t3-tools");
  assert.equal("command" in server && server.command, "node");
  assert.deepEqual("command" in server ? server.args : undefined, ["server.js", "--flag"]);
  assert.deepEqual("command" in server ? server.env : undefined, [
    { name: "FAKE_TOKEN", value: "fake-credential-sentinel-1" },
  ]);
  // client 声明必须带显式 owning-client 出处与会话隔离（不是 file/workspace 出处），
  // stdio cwd 固定为会话 cwd。
  assert.equal(server.scope, "user");
  assert.equal(server.isolation, "session");
  assert.equal("cwd" in server && server.cwd, CWD);
});

test("acp-mcp: http and sse definitions keep url/headers", () => {
  const mapped = mapAcpMcpServers(
    [
      {
        name: "remote-http",
        type: "http",
        url: "http://127.0.0.1:9/mcp",
        headers: [{ name: "Authorization", value: "Bearer fake-credential-sentinel-2" }],
      },
      {
        name: "remote-sse",
        type: "sse",
        url: "http://127.0.0.1:9/sse",
        headers: [{ name: "x-api-key", value: "fake-credential-sentinel-3" }],
      },
    ],
    CWD,
  );
  assert.equal(mapped?.length, 2);
  assert.equal(mapped![0].name, "remote-http");
  assert.equal("type" in mapped![0] && mapped![0].type, "http");
  assert.equal("url" in mapped![0] && mapped![0].url, "http://127.0.0.1:9/mcp");
  assert.deepEqual("headers" in mapped![0] ? mapped![0].headers : undefined, [
    { name: "Authorization", value: "Bearer fake-credential-sentinel-2" },
  ]);
  assert.equal("type" in mapped![1] && mapped![1].type, "sse");
  assert.equal("url" in mapped![1] && mapped![1].url, "http://127.0.0.1:9/sse");
  assert.equal(mapped![0].scope, "user");
  assert.equal(mapped![0].isolation, "session");
});

test("acp-mcp: duplicate server names are rejected without echoing values", () => {
  assert.throws(
    () =>
      mapAcpMcpServers(
        [
          { name: "dup", command: "node", args: [], env: [] },
          { name: "dup", command: "deno", args: [], env: [] },
        ],
        CWD,
      ),
    (error: unknown) =>
      error instanceof AcpMcpMapError &&
      error.reason === "duplicate_name" &&
      error.message.includes("mcpServers[1]"),
  );
});

test("acp-mcp: malformed definitions fail sanitized (never echoes credential values)", () => {
  const sentinel = "fake-credential-sentinel-4";
  const badInputs = [
    { name: "x", command: "node", args: "nope", env: [{ name: "K", value: sentinel }] },
    { name: "", command: "node", args: [], env: [] },
    { name: "x", command: "", args: [], env: [] },
    { name: "x", type: "http", url: "", headers: [{ name: "Authorization", value: sentinel }] },
    { name: "x", type: "carrier-pigeon", url: "http://127.0.0.1", headers: [] },
  ];
  for (const bad of badInputs) {
    let thrown: unknown;
    try {
      mapAcpMcpServers([bad as never], CWD);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof AcpMcpMapError, `expected AcpMcpMapError for ${JSON.stringify(bad)}`);
    assert.equal((thrown as AcpMcpMapError).reason, "malformed_server");
    // 边界报错绝不能回显声明里的凭据/环境值（CMCP05 的报错侧约束）。
    assert.equal((thrown as Error).message.includes(sentinel), false);
  }
});

test("acp-mcp: entries missing both command and http/sse type are rejected", () => {
  assert.throws(
    () => mapAcpMcpServers([{ name: "nope" } as never], CWD),
    (error: unknown) => error instanceof AcpMcpMapError && error.reason === "malformed_server",
  );
});
