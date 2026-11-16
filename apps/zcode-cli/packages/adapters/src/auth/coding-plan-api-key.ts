import { AsyncLocalStorage } from "node:async_hooks";
import {
  isHttpClientPortError,
  type HttpClientPort,
  type HttpClientRunOptions,
  type TraceContext,
} from "@zcode/contracts";
import {
  ProjectAccessTokenClient,
  ProjectAccessTokenError,
  ProjectAccessTokenHttpStatusError,
  ProjectAccessTokenTransientError,
  projectAccessTokenRetryAfterMs,
  resolveBigModelApiOrigin,
  type ProjectAccessTokenMaterial,
} from "@zcode/shared";

const PROJECT_TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const ZAI_API_HOST = "https://api.z.ai";
// 仅这些成功码允许解析 Z.AI 登录响应中的业务 Token。
const ZAI_LOGIN_SUCCESS_CODES = new Set<unknown>([0, 200, "0", "200"]);
const ZAI_ENVELOPE_CODE_MAX_LENGTH = 64;
const ZAI_ENVELOPE_MSG_MAX_LENGTH = 200;
// 控制字符经具名常量插值进 new RegExp（与 terminal-input-filter 同一做法），
// 避开 no-control-regex 对字面量区间的告警。
const ENVELOPE_CTRL_LOW = "\x00";
const ENVELOPE_CTRL_HIGH = "\x1f";
const ENVELOPE_CTRL_DEL = "\x7f";
const ZAI_ENVELOPE_CONTROL_CHARS = new RegExp(
  `[${ENVELOPE_CTRL_LOW}-${ENVELOPE_CTRL_HIGH}${ENVELOPE_CTRL_DEL}]+`,
  "g",
);
export type CodingPlanFamily = "bigmodel" | "zai";
export interface CodingPlanApiKeyResolverOptions {
  httpClient: HttpClientPort;
  trace?: TraceContext;
  locationStore?: {
    load(key: string): Promise<string | null>;
    save(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  observe?(event: {
    family: string;
    stage: "resolve";
    code: string;
    /** 仅 project_token_login_failed：HTTP 状态与 z.ai envelope 字段，绝不含 Token/响应体。 */
    httpStatus?: number;
    zaiCode?: string;
    zaiMessage?: string;
  }): void;
}
export interface ResolveCodingPlanApiKeyInput {
  accessToken: string;
  family: CodingPlanFamily;
  accountIdentity?: string;
  rejectedProjectTokenFingerprint?: string;
  trace?: TraceContext;
}
export interface CodingPlanApiKeyResolver {
  exchangeZaiBusinessToken(accessToken: string): Promise<string>;
  resolve(input: ResolveCodingPlanApiKeyInput, options?: HttpClientRunOptions): Promise<string>;
  resolveMaterial(
    input: ResolveCodingPlanApiKeyInput,
    options?: HttpClientRunOptions,
  ): Promise<ProjectAccessTokenMaterial>;
  clear(): void;
}
/** `/api/auth/z/login` 换证失败时 z.ai 的结构化原因；不含 Token、请求头或响应体。 */
export interface ZaiLoginFailureReason {
  readonly httpStatus?: number;
  readonly code?: string;
  readonly msg?: string;
}

export class CodingPlanApiKeyError extends Error {
  readonly loginFailure?: ZaiLoginFailureReason;

  constructor(message: string, loginFailure?: ZaiLoginFailureReason) {
    super(message);
    this.name = "CodingPlanApiKeyError";
    this.loginFailure = loginFailure;
  }
}

/** Z.AI 登录交换内部的结构化失败：附着 envelope 原因，不含敏感响应数据。 */
class ZaiBusinessLoginError extends Error {
  constructor(readonly reason: ZaiLoginFailureReason) {
    super("project_token_login_failed");
    this.name = "ZaiBusinessLoginError";
  }
}

/** CLI 进程内 Coding Plan 项目令牌解析器及 Z.AI 登录令牌交换入口。 */
export function createCodingPlanApiKeyResolver(
  options: CodingPlanApiKeyResolverOptions,
): CodingPlanApiKeyResolver {
  const execution = new AsyncLocalStorage<{
    context?: HttpClientRunOptions["context"];
    trace?: TraceContext;
  }>();
  const request = async (url: string, init: RequestInit, capture?: "zai-login") => {
    const response = await options.httpClient
      .request(
        {
          url,
          method: init.method === "POST" ? "POST" : "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          ...(typeof init.body === "string" ? { body: new TextEncoder().encode(init.body) } : {}),
          maxResponseBytes: 64 * 1024,
          timeoutMs: PROJECT_TOKEN_REQUEST_TIMEOUT_MS,
          trace: execution.getStore()?.trace ?? options.trace,
        },
        { context: execution.getStore()?.context },
      )
      .catch((error: unknown) => {
        if (isHttpClientPortError(error) && error.code === "network_error")
          throw new ProjectAccessTokenTransientError({ kind: "network" });
        if (isHttpClientPortError(error) && error.code === "timeout")
          throw new ProjectAccessTokenTransientError({ kind: "timeout" });
        throw error;
      });
    if (response.status === 404) return { code: 404 };
    if (response.status === 429 || (response.status >= 500 && response.status < 600))
      throw new ProjectAccessTokenTransientError({
        kind: "http",
        status: response.status,
        ...(response.status === 429
          ? {
              retryAfterMs: projectAccessTokenRetryAfterMs(
                new Headers(response.headers).get("retry-after"),
              ),
            }
          : {}),
      });
    // Bug 原因（ZCT-2111046389485834240）：非临时状态与 2xx 非 JSON 过去都落成
    // project_token_request_failed，无法区分鉴权拒绝与响应损坏。只保留状态码/固定码，不带响应体。
    // 换证入口例外（issue #50）：登录拒绝需要 z.ai envelope 的 code/msg 诊断，只取这两个字段。
    if (response.status < 200 || response.status >= 300) {
      if (capture === "zai-login")
        throw new ZaiBusinessLoginError({
          httpStatus: response.status,
          ...readZaiLoginEnvelope(response.body),
        });
      throw new ProjectAccessTokenHttpStatusError(response.status);
    }
    try {
      return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
    } catch {
      throw new ProjectAccessTokenError("project_token_invalid_response");
    }
  };
  const client = new ProjectAccessTokenClient({
    request,
    observe: options.observe,
    locationStore: options.locationStore,
  });
  let generation = 0;
  const exchangeZaiBusinessToken = async (accessToken: string): Promise<string> => {
    const oauth = accessToken.trim();
    if (!oauth) throw new CodingPlanApiKeyError("project_token_login_required");
    const capturedGeneration = generation;
    const businessToken = await request(
      `${ZAI_API_HOST}/api/auth/z/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: oauth }),
      },
      "zai-login",
    )
      .then((raw) => {
        // Bug 原因（issue #50）：业务令牌解析失败会丢弃 z.ai 的 code/msg。
        // 在边界先判失败形态并保留 envelope 字段；绝不携带 Token 或响应正文。
        const failure = readZaiLoginRejection(raw);
        if (failure) throw new ZaiBusinessLoginError(failure);
        const token = readZaiLoginToken(raw);
        if (!token) throw new ZaiBusinessLoginError({});
        return token;
      })
      .catch((error: unknown) => {
        // Bug 原因（issue #50）：失败原因曾被丢弃，日志与用户提示都看不到
        // z.ai 的 code/msg；只传播结构化字段，绝不记录 token/请求体。
        const reason = readZaiLoginFailure(error);
        options.observe?.({
          family: "zai",
          stage: "resolve",
          code: "project_token_login_failed",
          ...(reason?.httpStatus !== undefined ? { httpStatus: reason.httpStatus } : {}),
          ...(reason?.code !== undefined ? { zaiCode: reason.code } : {}),
          ...(reason?.msg !== undefined ? { zaiMessage: reason.msg } : {}),
        });
        throw new CodingPlanApiKeyError("project_token_login_failed", reason);
      });
    if (generation !== capturedGeneration)
      throw new CodingPlanApiKeyError("project_token_scope_invalidated");
    return businessToken;
  };
  const resolveMaterial = async (
    input: ResolveCodingPlanApiKeyInput,
  ): Promise<ProjectAccessTokenMaterial> => {
    const loginToken = input.accessToken.trim();
    if (!loginToken) throw new CodingPlanApiKeyError("project_token_login_required");
    const capturedGeneration = generation;
    const result = await client.resolve({
      origin: input.family === "zai" ? ZAI_API_HOST : resolveBigModelApiOrigin(process.env),
      family: input.family,
      loginToken,
      accountId: input.accountIdentity ?? input.family,
      personalProjectSelection: "default",
      rejectedProjectTokenFingerprint: input.rejectedProjectTokenFingerprint,
    });
    if (generation !== capturedGeneration)
      throw new CodingPlanApiKeyError("project_token_scope_invalidated");
    return result;
  };
  const resolveForCaller = (
    input: ResolveCodingPlanApiKeyInput,
    runOptions?: HttpClientRunOptions,
  ) =>
    waitForProjectToken(
      () =>
        execution.run(
          {
            // 单飞属于鉴权 owner，不继承会话 signal 或 context.abortSignal；只保留观测上下文。
            context: runOptions?.context
              ? { trace: runOptions.context.trace, logger: runOptions.context.logger }
              : undefined,
            trace: input.trace ?? runOptions?.context?.trace,
          },
          () => resolveMaterial(input),
        ),
      runOptions?.signal,
    );
  return {
    exchangeZaiBusinessToken,
    resolveMaterial: resolveForCaller,
    async resolve(input, runOptions) {
      const value = await resolveForCaller(input, runOptions);
      return value.token;
    },
    clear() {
      generation++;
      client.clear();
    },
  };
}

/** 只读 envelope 的 code/msg；非成功 code 或缺 Token 即视为登录交换失败。 */
function readZaiLoginRejection(raw: unknown): ZaiLoginFailureReason | undefined {
  if (!raw || typeof raw !== "object") return {};
  const response = raw as {
    code?: unknown;
    msg?: unknown;
    data?: { access_token?: unknown; accessToken?: unknown };
  };
  const code = readZaiEnvelopeCode(response.code);
  const msg = readZaiEnvelopeMsg(response.msg);
  const reason = {
    ...(code !== undefined ? { code } : {}),
    ...(msg !== undefined ? { msg } : {}),
  };
  if (response.code != null && !ZAI_LOGIN_SUCCESS_CODES.has(response.code)) return reason;
  if (!readZaiLoginToken(raw)) return reason;
  return undefined;
}

function readZaiLoginToken(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const response = raw as { data?: { access_token?: unknown; accessToken?: unknown } };
  const token =
    (typeof response.data?.access_token === "string" && response.data.access_token.trim()) ||
    (typeof response.data?.accessToken === "string" && response.data.accessToken.trim());
  return token || undefined;
}

/** envelope code 允许数字或字符串；统一成有限长字符串，异常形态不进日志或异常。 */
function readZaiEnvelopeCode(code: unknown): string | undefined {
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  if (typeof code !== "string") return undefined;
  const trimmed = code.trim();
  return trimmed ? trimmed.slice(0, ZAI_ENVELOPE_CODE_MAX_LENGTH) : undefined;
}

/** msg 只保留单行有限长度文本；控制字符会截断或注入终端/日志行。 */
function readZaiEnvelopeMsg(msg: unknown): string | undefined {
  if (typeof msg !== "string") return undefined;
  const sanitized = msg.replace(ZAI_ENVELOPE_CONTROL_CHARS, " ").trim();
  return sanitized ? sanitized.slice(0, ZAI_ENVELOPE_MSG_MAX_LENGTH) : undefined;
}

/** 换证失败的诊断只认结构化原因：HTTP 状态与 envelope code/msg，绝不回读响应体或 Token。 */
function readZaiLoginFailure(error: unknown): ZaiLoginFailureReason | undefined {
  if (error instanceof ZaiBusinessLoginError) return error.reason;
  if (error instanceof ProjectAccessTokenHttpStatusError)
    return error.failure.kind === "http" ? { httpStatus: error.failure.status } : undefined;
  if (error instanceof ProjectAccessTokenTransientError)
    return error.failure?.kind === "http" ? { httpStatus: error.failure.status } : undefined;
  return undefined;
}

/** 只从失败响应体提取 z.ai envelope 的 code/msg；解析失败返回空，不把正文带进异常或日志。 */
function readZaiLoginEnvelope(body: Uint8Array): { code?: string; msg?: string } {
  try {
    const raw = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const record = raw as { code?: unknown; msg?: unknown };
    return {
      code: readZaiEnvelopeCode(record.code),
      msg: readZaiEnvelopeMsg(record.msg),
    };
  } catch {
    return {};
  }
}

/** 仅取消当前调用方的等待；底层 Promise 始终有拒绝处理器，不误伤共享换证。 */
async function waitForProjectToken<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return run();
  signal.throwIfAborted();
  const value = await new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
  });
  signal.throwIfAborted();
  return value;
}
