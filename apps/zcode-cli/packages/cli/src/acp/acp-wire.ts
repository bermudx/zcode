// ACP 的 stdio 传输：NDJSON + JSON-RPC 2.0。
//
// 与 attach-client.ts（socket 方向）对称，但有两点不同：
// 1. 本端是 **agent 侧**，既收 client 请求，也要发请求（permission /
//    elicitation）并等应答；两向 id 空间必须分开（出站 id 用 `acp-N`），
//    否则 client 的 id 与自己发的 id 会撞车。
// 2. stdout 是协议独占通道：任何一行非 JSON 输出都会让编辑器解析失败。
//    诊断一律走注入的 stderr logger。
//
// 分发不串行化：session/prompt 可能跑几分钟，期间 session/cancel 与
// session/close 必须能被处理。每个入站请求独立跑，互不 await。
import type { Readable, Writable } from "node:stream";
import { acpErrorCodes } from "./acp-protocol.js";

/** 单行上限：core 半写/坏流时残留 buffer 会随行膨胀，超限即显式失败。 */
const ACP_MAX_LINE_CHARS = 8 * 1024 * 1024;

export type AcpRequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type AcpNotificationHandler = (method: string, params: unknown) => void;

export type AcpWireLogger = {
  warn: (message: string, context?: Record<string, unknown>) => void;
};

export class AcpWireError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpWireError";
    this.code = code;
    this.data = data;
  }
}

export interface AcpWire {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
  setRequestHandler(handler: AcpRequestHandler | undefined): void;
  setNotificationHandler(handler: AcpNotificationHandler | undefined): void;
  /** stdin EOF / 致命传输错误即 resolve（reason 只在异常时给出）。 */
  readonly closed: Promise<Error | undefined>;
  close(): void;
}

const REQUEST_PREFIX = "acp";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export function createAcpWire(options: {
  input: Readable;
  output: Writable;
  logger?: AcpWireLogger;
}): AcpWire {
  const { input, output, logger } = options;
  let counter = 0;
  let closed = false;
  let buffer = "";
  let requestHandler: AcpRequestHandler | undefined;
  let notificationHandler: AcpNotificationHandler | undefined;
  const pending = new Map<string, Pending>();
  let resolveClosed: (reason: Error | undefined) => void;
  const closedPromise = new Promise<Error | undefined>((resolve) => {
    resolveClosed = resolve;
  });

  const finish = (reason?: Error): void => {
    if (closed) return;
    closed = true;
    const inflight = [...pending.values()];
    pending.clear();
    for (const entry of inflight) {
      entry.reject(reason ?? new Error("ACP transport closed"));
    }
    resolveClosed(reason);
  };

  const writeFrame = (payload: Record<string, unknown>): void => {
    if (closed) return;
    output.write(`${JSON.stringify(payload)}\n`);
  };

  const handleResponse = (id: string | number, message: Record<string, unknown>): void => {
    const entry = pending.get(String(id));
    if (!entry) return;
    pending.delete(String(id));
    const error = message.error as
      | { code?: number; message?: string; data?: unknown }
      | undefined;
    if (error) {
      entry.reject(
        new AcpWireError(
          typeof error.code === "number" ? error.code : acpErrorCodes.internal,
          typeof error.message === "string" ? error.message : "ACP request failed",
          error.data,
        ),
      );
      return;
    }
    entry.resolve(message.result);
  };

  const dispatchRequest = (id: string | number, method: string, params: unknown): void => {
    void (async () => {
      try {
        if (!requestHandler) {
          throw new AcpWireError(
            acpErrorCodes.methodNotFound,
            `method not found: ${method}`,
          );
        }
        const result = await requestHandler(method, params);
        writeFrame({ jsonrpc: "2.0", id, result: result ?? {} });
      } catch (error) {
        if (error instanceof AcpWireError) {
          writeFrame({
            error: {
              code: error.code,
              ...(error.data === undefined ? {} : { data: error.data }),
              message: error.message,
            },
            id,
            jsonrpc: "2.0",
          });
          return;
        }
        // 未分类异常只回不透明错误：编辑器会把 message 直接展示给用户，
        // 内部细节（路径、堆栈、上游 payload）走 stderr 诊断。
        logger?.warn("acp request handler failed", {
          detail: error instanceof Error ? error.message : String(error),
          method,
        });
        writeFrame({
          error: { code: acpErrorCodes.internal, message: "Internal error" },
          id,
          jsonrpc: "2.0",
        });
      }
    })();
  };

  const dispatchLine = (line: string): void => {
    if (line.trim().length === 0) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      logger?.warn("acp dropped malformed line", { linePreview: line.slice(0, 120) });
      return;
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      logger?.warn("acp dropped non-object frame");
      return;
    }
    const message = decoded as {
      id?: string | number;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (typeof message.method === "string") {
      if (message.id === undefined) {
        // notification（session/cancel 等）：不回应答。
        try {
          notificationHandler?.(message.method, message.params);
        } catch (error) {
          logger?.warn("acp notification handler failed", {
            error: error instanceof Error ? error.message : String(error),
            method: message.method,
          });
        }
        return;
      }
      dispatchRequest(message.id, message.method, message.params);
      return;
    }
    if (message.id !== undefined) handleResponse(message.id, message);
  };

  const failLineCap = (): void => {
    const error = new Error(
      `ACP frame exceeded ${ACP_MAX_LINE_CHARS}-char cap (peer never sent a newline)`,
    );
    logger?.warn("acp line cap exceeded", { bufferLength: buffer.length });
    finish(error);
    input.destroy();
  };

  input.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      if (index > ACP_MAX_LINE_CHARS) {
        failLineCap();
        return;
      }
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      dispatchLine(line);
    }
    if (buffer.length > ACP_MAX_LINE_CHARS) failLineCap();
  });
  input.on("end", () => finish());
  input.on("close", () => finish());
  input.on("error", (error: Error) => {
    logger?.warn("acp stdin error", { error: error.message });
    finish(error);
  });

  return {
    close: () => {
      if (closed) return;
      finish();
    },
    closed: closedPromise,
    notify: (method, params) => writeFrame({ jsonrpc: "2.0", method, params }),
    request: <T>(method: string, params: unknown) => {
      if (closed) return Promise.reject(new Error("ACP transport closed"));
      const id = `${REQUEST_PREFIX}-${++counter}`;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { reject, resolve: (value) => resolve(value as T) });
        writeFrame({ jsonrpc: "2.0", id, method, params });
      });
    },
    setNotificationHandler: (handler) => {
      notificationHandler = handler;
    },
    setRequestHandler: (handler) => {
      requestHandler = handler;
    },
  };
}
