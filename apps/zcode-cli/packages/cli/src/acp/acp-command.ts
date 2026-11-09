// `zcode-attach acp`（= `piz acp`）入口：把 stdio 上的 ACP 会话接到共享 core。
//
// 生命周期：
// - stdin EOF / 传输致命错误 → 关闭全部连接（detach），退出码 0。core 侧的
//   会话照常存活，编辑器重开时用 session/resume 接着聊（与 attach 一致）。
// - 不在这里注册信号处理：编辑器杀进程即断开，socket 关闭本身就是 detach。
import type { Readable, Writable } from "node:stream";
import { acpMethods } from "./acp-protocol.js";
import { createAcpWire, type AcpWireLogger } from "./acp-wire.js";
import { AcpCorePool, type AcpCoreDeps } from "./acp-core.js";
import { AcpAgent } from "./acp-agent.js";

export type AcpCommandDeps = {
  env: NodeJS.ProcessEnv;
  version: string;
  stdin: Readable;
  stdout: Writable;
  stderr: { write(chunk: string): unknown };
  /** 测试注入点：指向真实 unix socket 的假 core。 */
  ensureCore?: AcpCoreDeps["ensureCore"];
  connect?: AcpCoreDeps["connect"];
};

/**
 * 诊断行按**消息**做 ≥60s 节流：ACP 客户端把 stderr 当日志看，同一条反复刷
 * 没有信息增量；但按全局时间戳节流会让"被忽略的 MCP server"这类不同诊断
 * 被上一条挤掉（实测：initialize 的 elicitation 提示压掉了 MCP 提示），
 * 那才是真正的静默降级。
 */
function createThrottledLogger(stderr: { write(chunk: string): unknown }): AcpWireLogger & {
  warn: (message: string, context?: Record<string, unknown>) => void;
} {
  const lastWrittenByMessage = new Map<string, number>();
  return {
    warn: (message, context) => {
      const now = Date.now();
      const key = `${message}|${context === undefined ? "" : JSON.stringify(context)}`;
      const last = lastWrittenByMessage.get(message) ?? 0;
      if (now - last < 60_000) return;
      lastWrittenByMessage.set(message, now);
      const detail = context === undefined ? "" : ` ${key.slice(key.indexOf("|") + 1)}`;
      stderr.write(`acp: ${message}${detail}\n`);
    },
  };
}

export async function runAcpCommand(deps: AcpCommandDeps): Promise<number> {
  const logger = createThrottledLogger(deps.stderr);
  const wire = createAcpWire({ input: deps.stdin, logger, output: deps.stdout });
  const core = new AcpCorePool({
    connect: deps.connect,
    ensureCore: deps.ensureCore,
    env: deps.env,
    logger,
    version: deps.version,
  });
  core.bindClientTransport({
    notifyUpdate: (sessionId, update) =>
      wire.notify(acpMethods.sessionUpdate, { sessionId, update }),
    request: (method, params) => wire.request(method, params),
  });
  const agent = new AcpAgent({
    clientInfo: { name: "piz", version: deps.version },
    core,
    logger,
  });
  wire.setRequestHandler(agent.handleRequest);
  wire.setNotificationHandler(agent.handleNotification);

  const reason = await wire.closed;
  await core.disposeAll().catch(() => undefined);
  if (reason) {
    deps.stderr.write(`acp: transport closed: ${reason.message}\n`);
    return 1;
  }
  return 0;
}
