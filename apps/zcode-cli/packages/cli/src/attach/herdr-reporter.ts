// herdr 生命周期上报（attach 客户端侧）：docs/design/v2/tui-attach-shared-core.md
// 「Herdr 生命周期上报」节。状态所有权留在会话事件流；reporter 只做
// 事件→herdr 状态的翻译与转发，任何上报失败都必须静默（不污染协议 stdout，
// 诊断走 onError→stderr）。仅 zcode-attach 专用入口（attach-main）启用；
// monolith `zcode attach`/`tui --shared-core` 的进程名是 zcode，不启。
import { execFile } from "node:child_process";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";

const HERDR_AGENT = "piz";
const HERDR_SOURCE = "piz";
const HERDR_RESUME_BIN = "piz";
const REPORT_TIMEOUT_MS = 2_000;
// seq = epoch-ms × 1000 + 计数器：herdr 丢弃非递增 seq，同毫秒帧靠尾段保序。
const SEQ_TICKS_PER_MS = 1_000;

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
  private lastSeq = 0;
  private unsubscribe: (() => void) | undefined;
  private boundSessionId: string | undefined;
  private turnActive = false;

  constructor(options: {
    paneId: string;
    herdrBin: string;
    exec: HerdrExec;
    onError?: (error: unknown) => void;
  }) {
    this.paneId = options.paneId;
    this.herdrBin = options.herdrBin;
    this.exec = options.exec;
    this.onError = options.onError;
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
    void this.exec(this.herdrBin, args).catch((error) => this.onError?.(error));
  }
}

/** herdr env 齐备才激活；缺 HERDR_PANE_ID/HERDR_BIN_PATH 视为非 herdr 环境。 */
export function createAttachHerdrReporter(options: {
  env: AttachHerdrReporterEnv;
  exec?: HerdrExec;
  onError?: (error: unknown) => void;
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
  });
}
