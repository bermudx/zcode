import { disposeNodeReplSession } from "../tool/handlers/node-repl.js";
import type { Logger } from "./deps.js";
import type { AgentRuntimeInternal } from "./internal.js";

/** constructor 期 client attachment 闸门落定结果；由调用方写回 runtime 字段。 */
export interface McpClientDetachGateResult {
  attached: boolean;
  reconnectNeeded: boolean;
  epochBump: number;
  unsubscribe?: () => void;
}

/**
 * client attachment 闸门（评审 R1）：factory 物化横跨 detach 的会话出生即
 * detached；信号后到的由订阅回调走现有 suspend 路径。
 */
export function installMcpClientDetachGate(
  signal: AbortSignal | undefined,
  runtime: AgentRuntimeInternal,
  logger: Logger | undefined,
): McpClientDetachGateResult {
  if (signal === undefined) return { attached: true, reconnectNeeded: false, epochBump: 0 };
  if (signal.aborted) return { attached: false, reconnectNeeded: true, epochBump: 1 };
  const onClientDetach = () => {
    runtime.mcpDetachUnsubscribe = undefined;
    void runtime.setMcpClientAttached(false).catch((error: unknown) => {
      logger?.warn("MCP detach suspend via attachment signal failed", {
        errorKind: error instanceof Error ? error.name : typeof error,
        event: "mcp.detach_suspend.failed",
        module: "core.runtime",
        status: "failed",
      });
    });
  };
  signal.addEventListener("abort", onClientDetach, { once: true });
  return {
    attached: true,
    reconnectNeeded: false,
    epochBump: 0,
    unsubscribe: () => signal.removeEventListener("abort", onClientDetach),
  };
}

/**
 * beginShutdown 里的 client MCP 闸门收尾。返回共享的 closedReason，调用方必须
 * 用同一个对象 abort shutdownController——在飞 connect 先收这条理由。
 */
export function closeMcpClientGate(runtime: AgentRuntimeInternal): Error {
  // client MCP 闸门同步落下：迟到的连接结果不得再向本 runtime 落地（issue #31）。
  runtime.mcpClosed = true;
  runtime.mcpClientAttached = false;
  // attachment 订阅只留退订函数；shutdown 时 owner 信号可能再也用不到。
  runtime.mcpDetachUnsubscribe?.();
  runtime.mcpDetachUnsubscribe = undefined;
  const closedReason = new Error("Session runtime closed");
  // 在飞的 client connect（startup/apply 可有多条登记记录）逐个 abort——close 等
  // residencyBlockingWork 收尾，不 abort 会让卡在握手的 connect 死等。
  for (const op of runtime.mcpInFlightConnects) op.controller.abort(closedReason);
  return closedReason;
}

/** closeBrowserSession 的资源收尾体；beginShutdown 已由调用方先执行。 */
export async function closeRuntimeBrowserSession(
  runtime: AgentRuntimeInternal,
): Promise<void> {
  disposeNodeReplSession(runtime.sessionId);
  try {
    await runtime.browserControlPort?.closeSession?.({
      sessionId: runtime.sessionId,
      traceContext: runtime.rootTraceContext,
    });
  } catch (error) {
    // 上层并行关闭各资源；这里必须传播失败，防止生命周期把未释放的浏览器视为安全。
    runtime.logger?.warn("Browser session cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "browser.session_cleanup.failed",
    });
    throw error;
  }
}
