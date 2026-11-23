import { disposeNodeReplSession } from "../tool/handlers/node-repl.js";
import type { AgentRuntimeInternal } from "./internal.js";

/** constructor 期 client attachment 闸门落定结果；由调用方写回 runtime 字段。 */
export interface McpClientDetachGateResult {
  attached: boolean;
  reconnectNeeded: boolean;
  unsubscribe?: () => void;
}

/**
 * client attachment 闸门（评审 R1）：factory 物化横跨 detach 的会话出生即
 * detached；信号后到的由订阅回调走现有 suspend 路径。必须先于 McpSession 创建——
 * 出生即 detached 时先把配置源挂起，随后创建的 session 初始配置就是空集。
 */
export function installMcpClientDetachGate(
  signal: AbortSignal | undefined,
  runtime: AgentRuntimeInternal,
): McpClientDetachGateResult {
  if (signal === undefined) return { attached: true, reconnectNeeded: false };
  if (signal.aborted) {
    runtime.mcpClientSource?.update({ suspended: true });
    return { attached: false, reconnectNeeded: true };
  }
  const onClientDetach = () => {
    runtime.mcpDetachUnsubscribe = undefined;
    void runtime.setMcpClientAttached(false).catch((error: unknown) => {
      runtime.logger?.warn("MCP detach suspend via attachment signal failed", {
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
    unsubscribe: () => signal.removeEventListener("abort", onClientDetach),
  };
}

/**
 * beginShutdown 里的 client MCP 闸门收尾。在飞 connect 由 shutdownSignal 收口
 * （McpSession 的 connectOptions 持有它）；这里只落闸门并释放配置源。
 */
export function closeMcpClientGate(runtime: AgentRuntimeInternal): void {
  // client MCP 闸门同步落下：迟到的声明/连接结果不得再向本 runtime 落地（issue #31）。
  runtime.mcpClosed = true;
  runtime.mcpClientAttached = false;
  // attachment 订阅只留退订函数；shutdown 时 owner 信号可能再也用不到。
  runtime.mcpDetachUnsubscribe?.();
  runtime.mcpDetachUnsubscribe = undefined;
  // session.close() 只释放它拿到的 view；上游配置源（磁盘 / plugin）的 owner 是 runtime。
  runtime.mcpClientSource?.close();
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
