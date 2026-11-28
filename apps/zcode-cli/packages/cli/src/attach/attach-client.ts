// tui-attach 瘦客户端的 NDJSON socket 传输。
// 协议面与 bootstrap 侧 ZCodeProtocolNdjsonConnection 对称：行分隔 JSON，
// request/response 用递增 id 关联，notification 无 id，server 反向 request
// （带 id+method）交给 reverseHandler 应答。不做业务状态，只有传输与分发。
import { createConnection, type Socket } from "node:net";
import { ZCODE_ATTACH_MAX_LINE_CHARS, zcodeProtocolMessageSchema } from "@zcode/shared";

export type AttachProtocolRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

export type AttachNotificationHandler = (method: string, params: unknown) => void;

export type AttachClientLogger = {
  debug?: (message: string, context?: Record<string, unknown>) => void;
  warn?: (message: string, context?: Record<string, unknown>) => void;
};

export class AttachProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AttachProtocolError";
    this.code = code;
    this.data = data;
  }
}

export interface AttachClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: AttachNotificationHandler): () => void;
  /** server→client 反向请求（permission / runtimePreferences…）。只能注册一个 handler。 */
  setRequestHandler(handler: AttachProtocolRequestHandler | undefined): void;
  /** socket 关闭即 resolve（正常关闭 reason=undefined，异常带 error）。只 settle 一次。 */
  readonly closed: Promise<Error | undefined>;
  /** 幂等：销毁 socket、拒绝全部 pending、停止后续分发。 */
  close(): void;
}

const ATTACH_REQUEST_PREFIX = "attach";

export async function connectAttachClient(
  socketPath: string,
  options: { logger?: AttachClientLogger } = {},
): Promise<AttachClient> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const conn = createConnection(socketPath, () => {
      conn.removeListener("error", reject);
      resolve(conn);
    });
    conn.once("error", reject);
  });
  socket.setEncoding("utf8");

  let counter = 0;
  let closed = false;
  let buffer = "";
  let reverseHandler: AttachProtocolRequestHandler | undefined;
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const notificationHandlers = new Set<AttachNotificationHandler>();
  let resolveClosed: (reason: Error | undefined) => void;
  const closedPromise = new Promise<Error | undefined>((resolve) => {
    resolveClosed = resolve;
  });

  const failAllPending = (error: Error): void => {
    const inflight = [...pending.values()];
    pending.clear();
    for (const entry of inflight) entry.reject(error);
  };

  const finish = (reason?: Error): void => {
    if (closed) return;
    closed = true;
    failAllPending(reason ?? new Error("attach socket closed"));
    resolveClosed(reason);
  };

  const writeLine = (payload: Record<string, unknown>): void => {
    if (closed) return;
    socket.write(`${JSON.stringify(payload)}\n`);
  };

  const dispatchLine = (line: string): void => {
    if (line.trim().length === 0) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      options.logger?.warn?.("attach client dropped malformed line", {
        linePreview: line.slice(0, 120),
      });
      return;
    }
    const parsed = zcodeProtocolMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      options.logger?.warn?.("attach client dropped invalid protocol message");
      return;
    }
    const message = parsed.data as {
      id?: string | number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    // 带 id + method = server 反向请求，必须由本端应答。
    if (message.method !== undefined && message.id !== undefined) {
      const requestId = message.id;
      void (async () => {
        try {
          if (!reverseHandler) {
            throw new AttachProtocolError(-32601, `method not found: ${message.method}`);
          }
          const result = await reverseHandler(message.method!, message.params);
          writeLine({ id: requestId, result: result ?? {} });
        } catch (error) {
          writeLine({
            id: requestId,
            error: {
              code: error instanceof AttachProtocolError ? error.code : -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      })();
      return;
    }
    if (message.method !== undefined) {
      for (const handler of notificationHandlers) {
        try {
          handler(message.method, message.params);
        } catch (error) {
          options.logger?.warn?.("attach client notification handler failed", {
            error: error instanceof Error ? error.message : String(error),
            method: message.method,
          });
        }
      }
      return;
    }
    if (message.id !== undefined) {
      const entry = pending.get(String(message.id));
      if (!entry) return;
      pending.delete(String(message.id));
      if (message.error) {
        entry.reject(
          new AttachProtocolError(
            message.error.code ?? -32000,
            message.error.message ?? "protocol request failed",
            message.error.data,
          ),
        );
      } else {
        entry.resolve(message.result);
      }
    }
  };

  const failLineCap = (lineLength: number, newlineReceived: boolean): void => {
    const error = new Error(
      `attach protocol line exceeded ${ZCODE_ATTACH_MAX_LINE_CHARS}-char cap`,
    );
    options.logger?.warn?.("attach client line cap exceeded", {
      lineLength,
      newlineReceived,
    });
    finish(error);
    socket.destroy();
  };

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      if (newlineIndex > ZCODE_ATTACH_MAX_LINE_CHARS) {
        failLineCap(newlineIndex, true);
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      dispatchLine(line);
    }
    if (buffer.length > ZCODE_ATTACH_MAX_LINE_CHARS) {
      failLineCap(buffer.length, false);
    }
  });
  socket.on("error", (error: Error) => {
    options.logger?.warn?.("attach client socket error", { error: error.message });
    finish(error);
    socket.destroy();
  });
  socket.on("close", () => {
    finish();
  });

  return {
    closed: closedPromise,
    close: () => {
      if (closed) return;
      finish();
      socket.destroy();
    },
    notify: (method, params) => {
      writeLine({ method, params });
    },
    onNotification: (handler) => {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    request: <T>(method: string, params?: unknown) => {
      if (closed) return Promise.reject(new Error("attach socket closed"));
      const id = `${ATTACH_REQUEST_PREFIX}-${++counter}`;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        writeLine({ id, method, params });
      });
    },
    setRequestHandler: (handler) => {
      reverseHandler = handler;
    },
  };
}
