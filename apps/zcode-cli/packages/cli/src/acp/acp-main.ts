// `piz acp` 的 stdio 入口：ACP v1 的 NDJSON 双工流，stdout 只承载协议帧。
// 与 attach 共用同一套 share-core 连接层，不启动 TUI，也不带 bootstrap。
import { setImmediate } from "node:timers/promises";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { createAcpAgentApp, type AcpAgentLogger } from "./acp-agent.js";
import { AcpCoreSessions } from "./acp-sessions.js";

export interface AcpRunOptions {
  env: NodeJS.ProcessEnv;
  logger?: AcpAgentLogger;
  stderr: { write(chunk: string): unknown };
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  version: string;
}

/** 把 node 的 stdio 包成 ACP SDK 需要的 NDJSON Stream。 */
export function createStdioAcpStream(options: {
  onTransportError(error: Error): void;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}): Stream & { drain(): Promise<void>; dispose(): Promise<void> } {
  let inputOpen = true;
  const pendingWrites = new Set<Promise<void>>();
  const drain = async () => {
    while (pendingWrites.size > 0) {
      await Promise.allSettled(pendingWrites);
    }
  };
  const reportError = (source: "stdin" | "stdout", error: unknown) => {
    options.onTransportError(
      new Error(`${source} transport failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      }),
    );
  };
  const onInputError = (error: Error) => reportError("stdin", error);
  const onOutputError = (error: Error) => reportError("stdout", error);
  // Node Writable 的失败会同时触发写回调和 error 事件；两条路径都必须接住，
  // 由入口统一裁决退出码，而不是让 EventEmitter 抛出未处理异常。
  options.stdin.on("error", onInputError);
  options.stdout.on("error", onOutputError);
  const output = new WritableStream<Uint8Array>({
    async write(chunk) {
      const pending = new Promise<void>((resolveWrite, rejectWrite) => {
        options.stdout.write(chunk, (error?: Error | null) => {
          if (error) rejectWrite(error);
          else resolveWrite();
        });
      });
      pendingWrites.add(pending);
      try {
        await pending;
      } catch (error) {
        // 此处只补传输上下文并通知入口；原错误继续交给 SDK 终止发送。
        reportError("stdout", error);
        throw error;
      } finally {
        pendingWrites.delete(pending);
      }
    },
  });
  let onData: (chunk: Buffer | string) => void;
  let onEnd: () => void;
  const stopInput = () => {
    inputOpen = false;
    options.stdin.off("data", onData);
    options.stdin.off("end", onEnd);
    options.stdin.pause();
  };
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      onData = (chunk) => {
        if (!inputOpen) return;
        controller.enqueue(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
        );
      };
      onEnd = () => {
        if (!inputOpen) return;
        stopInput();
        controller.close();
      };
      options.stdin.on("data", onData);
      options.stdin.on("end", onEnd);
    },
    cancel() {
      stopInput();
    },
  });
  const stream = ndJsonStream(output, input);
  const reader = stream.readable.getReader();
  // 在 SDK 吞掉读取异常前通知入口；解码/校验仍完全由 SDK 负责。
  let decodedOpen = true;
  const readable: Stream["readable"] = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!decodedOpen) return;
        if (done) {
          decodedOpen = false;
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (!decodedOpen) return;
        decodedOpen = false;
        // 解码器/底层读取错误仍须穿过入口，不依赖 SDK 的 closed 是否 reject。
        reportError("stdin", error);
        controller.error(error);
      }
    },
    cancel(reason) {
      decodedOpen = false;
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return {
    drain,
    readable,
    writable: stream.writable,
    async dispose() {
      stopInput();
      options.stdin.off("error", onInputError);
      // 正常 EOF 要等已发出的写回调；失败退出则不能被卡死的 stdout 拖住。
      // Node 还可能在回调后的 nextTick 发 error，至少保留监听到下一轮事件循环。
      const removeOutputListener = async () => {
        await setImmediate();
        options.stdout.off("error", onOutputError);
      };
      if (pendingWrites.size === 0) await removeOutputListener();
      else void drain().then(removeOutputListener);
    },
  };
}

/**
 * 运行一次 ACP 连接，直到客户端断开。返回值是进程退出码。
 */
export async function runAcpStdio(options: AcpRunOptions): Promise<number> {
  const sessions = new AcpCoreSessions({
    env: options.env,
    logger: options.logger,
  });
  const connectionFailure = Promise.withResolvers<Error>();
  let firstFailure: Error | undefined;
  const fail = (error: Error) => {
    firstFailure ??= error;
    connectionFailure.resolve(firstFailure);
  };
  const appOptions = {
    logger: options.logger,
    onConnectionError: fail,
    sessions,
    version: options.version,
  };
  const app = createAcpAgentApp(appOptions);
  const stream = createStdioAcpStream({
    onTransportError: fail,
    stdin: options.stdin,
    stdout: options.stdout,
  });
  const connection = app.connect(stream);
  try {
    // SDK 的 closed 在读写失败时也 resolve；入口独立观察原始 stdio 错误，
    // 先记录失败，再关闭连接，不能把传输故障当作正常 EOF。
    // 正常 close() 也会生成 Error，不能按 signal.reason 的类型/文本猜测失败。
    // agent 的显式致命错误走同一个独立失败通道。
    await Promise.race([connectionFailure.promise, connection.closed]);
    // EOF 可能先于最后一次 stdout 写回调，不能抢先报成功或卸掉 error 监听。
    if (!firstFailure) await Promise.race([connectionFailure.promise, stream.drain()]);
    if (firstFailure) throw firstFailure;
    return 0;
  } catch (error) {
    options.stderr.write(
      `acp: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    connection.close();
    try {
      await sessions.closeAll();
    } finally {
      await stream.dispose();
    }
  }
}

/** 诊断日志走 stderr；ACP 的 stdout 是严格的协议通道。 */
export function createAcpStderrLogger(
  stderr: { write(chunk: string): unknown },
): AcpAgentLogger {
  const write = (level: string, message: string, context?: Record<string, unknown>) => {
    const detail =
      context === undefined
        ? ""
        : ` ${JSON.stringify(context, (_key, value) =>
            value instanceof Error ? value.message : value,
          )}`;
    stderr.write(`acp ${level}: ${message}${detail}\n`);
  };
  return {
    debug: (message, context) => write("debug", message, context),
    warn: (message, context) => write("warn", message, context),
  };
}
