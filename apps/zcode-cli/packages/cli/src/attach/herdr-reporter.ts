// herdr 生命周期上报（attach 客户端侧）：docs/design/v2/tui-attach-shared-core.md
// 「Herdr 生命周期上报」节。状态所有权留在会话事件流；reporter 只做
// 事件→herdr 状态的翻译与转发，任何上报失败都必须收敛（不污染协议
// stdout，诊断走 onError→stderr）。仅 zcode-attach 专用入口（attach-main）启用；
// monolith `zcode attach`/`tui --shared-core` 的进程名是 zcode，不启。
import { execFile } from "node:child_process";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";

const HERDR_AGENT = "piz";
const HERDR_SOURCE = "piz";
const HERDR_RESUME_BIN = "piz";
const REPORT_TIMEOUT_MS = 2_000;
// seq = epoch-ms × 1000 + 计数器：herdr 丢弃非递增 seq（per source），
// 同毫秒帧靠尾段保序。
const SEQ_TICKS_PER_MS = 1_000;
// herdr 把自定义 source 当永不过期的状态权威：单条 working 上报丢失会让
// 整个回合错报 idle/done，故失败必须有界重试 + 心跳重申兜底。
const SEND_ATTEMPTS = 3;
const RETRY_BACKOFF_MS: readonly number[] = [250, 1_500];
const HEARTBEAT_MS = 30_000;

type HerdrAgentState = "idle" | "working" | "blocked";

/** herdr 激活所需的 env 面（全部必需；缺任一体即不激活）。 */
export interface AttachHerdrReporterEnv {
  HERDR_ENV?: string;
  HERDR_PANE_ID?: string;
  HERDR_BIN_PATH?: string;
}

/** 外部进程调用边界：参数数组不经 shell；默认实现走 execFile。 */
export type HerdrExec = (bin: string, args: readonly string[]) => Promise<void>;

/** reporter 需要的会话句柄最小面；AttachSessionHandle 结构化满足。 */
interface HerdrBoundSession {
  readonly sessionId: string;
  addSink(sink: (event: SessionEvent) => void): () => void;
}

/** 可靠性参数（测试注入面）：单条尝试次数、退避序列、心跳周期。 */
export interface HerdrReporterRetryOptions {
  attempts: number;
  backoffMs: readonly number[];
  heartbeatMs: number;
}

const unrefDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 退避等待不得拖住进程退出。
    timer.unref?.();
  });

const defaultExec: HerdrExec = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: REPORT_TIMEOUT_MS, windowsHide: true },
      (error) => (error ? reject(error) : resolve()));
  });

export class AttachHerdrReporter {
  private readonly paneId: string;
  private readonly herdrBin: string;
  private readonly exec: HerdrExec;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly retry: HerdrReporterRetryOptions;
  private lastSeq = 0;
  private unsubscribe: (() => void) | undefined;
  private boundSessionId: string | undefined;
  private turnActive = false;
  private lastReportedState: HerdrAgentState = "idle";
  private readonly pendingSends = new Set<Promise<void>>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(options: {
    paneId: string;
    herdrBin: string;
    exec: HerdrExec;
    onError?: (error: unknown) => void;
    retry?: Partial<HerdrReporterRetryOptions>;
  }) {
    this.paneId = options.paneId;
    this.herdrBin = options.herdrBin;
    this.exec = options.exec;
    this.onError = options.onError;
    this.retry = {
      attempts: options.retry?.attempts ?? SEND_ATTEMPTS,
      backoffMs: options.retry?.backoffMs ?? RETRY_BACKOFF_MS,
      heartbeatMs: options.retry?.heartbeatMs ?? HEARTBEAT_MS,
    };
    this.heartbeat = setInterval(() => this.onHeartbeat(), this.retry.heartbeatMs);
    this.heartbeat.unref?.();
  }

  /** 绑定/换绑当前会话句柄：由 AttachRuntime.onSessionBound 驱动，
   *  覆盖初始 attach、/new、/resume、/fork 与断线重连的换句柄。 */
  bind(session: HerdrBoundSession): void {
    this.unsubscribe?.();
    this.turnActive = false;
    this.boundSessionId = session.sessionId;
    this.unsubscribe = session.addSink(this.onEvent);
    this.report("idle");
  }

  /** 测试/收尾用：停心跳、退订事件并等待在途重试排空。 */
  async stop(): Promise<void> {
    clearInterval(this.heartbeat);
    this.unsubscribe?.();
    await this.settled();
  }

  /** 在途与重试中的上报全部完成的信号（测试断言用）。 */
  settled(): Promise<void> {
    return Promise.all([...this.pendingSends]).then(() => undefined);
  }

  private readonly onEvent = (event: SessionEvent): void => {
    switch (event.type) {
      case SessionEventType.TurnStarted:
        this.turnActive = true;
        this.report("working");
        break;
      case SessionEventType.TurnComplete:
      case SessionEventType.TurnError:
        this.turnActive = false;
        this.report("idle");
        break;
      case SessionEventType.PermissionRequested: {
        const payload = event.payload as { toolName?: unknown } | undefined;
        const tool = payload?.toolName;
        this.report("blocked", {
          message:
            typeof tool === "string" && tool ? `permission: ${tool}` : undefined,
        });
        break;
      }
      case SessionEventType.PermissionResolved:
      case SessionEventType.PermissionDenied:
        this.report(this.turnActive ? "working" : "idle");
        break;
      default:
        break;
    }
  };

  /** 心跳重申最近状态：彻底丢失的上报（重试全败/服务端丢弃）最多陈旧
   *  到下一跳。未绑定会话前不心跳——无 session ref 的 state 上报会清掉
   *  pane 的会话归属。 */
  private readonly onHeartbeat = (): void => {
    if (this.boundSessionId === undefined) return;
    this.report(this.lastReportedState);
  };

  private nextSeq(): string {
    const nowTicks = Date.now() * SEQ_TICKS_PER_MS;
    this.lastSeq = Math.max(nowTicks, this.lastSeq + 1);
    return String(this.lastSeq);
  }

  private report(
    state: HerdrAgentState,
    extras?: { message?: string },
  ): void {
    const args = [
      "pane", "report-agent", this.paneId,
      "--source", HERDR_SOURCE,
      "--agent", HERDR_AGENT,
      "--state", state,
      "--seq", this.nextSeq(),
    ];
    if (extras?.message) args.push("--message", extras.message);
    // herdr 语义：不带 session_ref 的 state 上报会清掉 pane 的会话归属——
    // 与官方 pi 集成一致，每次上报都重带 session-id + resume argv。
    const sessionId = this.boundSessionId;
    if (sessionId) {
      args.push("--agent-session-id", sessionId);
      args.push("--", HERDR_RESUME_BIN, "--resume", sessionId);
    }
    this.lastReportedState = state;
    void this.sendWithRetry(args);
  }

  /** 首次尝试同步发出（保持 bind/事件即发的契约），失败后按退避有界
   *  重试。重试晚到无碍：seq 在入队时分配，herdr 对同 source 非递增
   *  seq 直接丢弃，旧状态不会覆盖新状态。 */
  private sendWithRetry(args: readonly string[]): Promise<void> {
    const send = (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.exec(this.herdrBin, args);
          return;
        } catch (error) {
          if (attempt >= this.retry.attempts) {
            // 整条上报放弃时才报一次错误；逐尝试报只会制造噪声。
            this.onError?.(error);
            return;
          }
          const backoff = this.retry.backoffMs[
            Math.min(attempt - 1, this.retry.backoffMs.length - 1)
          ];
          await unrefDelay(backoff ?? RETRY_BACKOFF_MS[0]!);
        }
      }
    })();
    this.pendingSends.add(send);
    send.finally(() => this.pendingSends.delete(send));
    return send;
  }
}

/** herdr env 齐备才激活；缺 HERDR_PANE_ID/HERDR_BIN_PATH 视为非 herdr 环境。 */
export function createAttachHerdrReporter(options: {
  env: AttachHerdrReporterEnv;
  exec?: HerdrExec;
  onError?: (error: unknown) => void;
  retry?: Partial<HerdrReporterRetryOptions>;
}): AttachHerdrReporter | undefined {
  const { env } = options;
  if (env.HERDR_ENV !== "1") return undefined;
  const paneId = env.HERDR_PANE_ID?.trim();
  const herdrBin = env.HERDR_BIN_PATH?.trim();
  if (!paneId || !herdrBin) return undefined;
  return new AttachHerdrReporter({
    paneId,
    herdrBin,
    exec: options.exec ?? defaultExec,
    onError: options.onError,
    retry: options.retry,
  });
}
