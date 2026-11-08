// OSC 7501 程序状态上报（attach 客户端侧）：docs/design/v2/tui-attach-shared-core.md
// 「OSC 7501 程序状态上报」节。与 herdr-reporter 同一裁决：状态所有权留在
// 会话事件流与 interaction 路由，reporter 只做翻译——把生命周期翻译成终端
// 带内转义序列，经 TUI 同一 stdout 写出。协议见
// https://mitchellh.com/writing/program-status-osc7501：未知 OSC 会被良好
// 终端忽略，实现了消费的终端/复用器把状态渲染成通知/角标。
// 写 stdout 是顺序带内字节，不丢不乱序：无重试、无心跳；写失败一次性
// 禁用（诊断一次走 stderr，绝不影响 TUI 渲染）。仅 piz 专用入口且
// stdout 是 TTY 时由 attach-command 激活；monolith/管道零字节。
import { SessionEventType, type SessionEvent } from "@zcode/contracts";

const OSC_7501_PREFIX = "\x1b]7501;";
const OSC_7501_SUFFIX = "\x1b\\";
/** msg 单行上限：协议要求有界；160 字符足够工具名/错误摘要。 */
const MSG_MAX_CHARS = 160;

export type Osc7501State = "idle" | "working" | "done" | "blocked" | "error";
export type Osc7501BlockedKind = "permission" | "question" | "auth";

export interface Osc7501Record {
  state: Osc7501State;
  kind?: Osc7501BlockedKind;
  app?: string;
  msg?: string;
}

/** OSC 7501 序列化：state 必选，kind/app 明文，msg 截断后 base64
 *  （字母表不含 `:`，定界安全；协议不允许转义序列携带任意原文）。 */
export function formatOsc7501(record: Osc7501Record): string {
  const fields: string[] = [`state=${record.state}`];
  if (record.kind !== undefined) fields.push(`kind=${record.kind}`);
  if (record.app !== undefined) fields.push(`app=${record.app}`);
  if (record.msg !== undefined) {
    const bounded =
      record.msg.length > MSG_MAX_CHARS
        ? record.msg.slice(0, MSG_MAX_CHARS)
        : record.msg;
    fields.push(`msg=${Buffer.from(bounded, "utf8").toString("base64")}`);
  }
  return `${OSC_7501_PREFIX}${fields.join(":")}${OSC_7501_SUFFIX}`;
}

/** reporter 需要的会话句柄最小面；AttachSessionHandle 结构化满足。 */
interface OscBoundSession {
  readonly sessionId: string;
  addSink(sink: (event: SessionEvent) => void): () => void;
}

/** 终端写出面：默认由 attach-command 接 ctx.stdout（与 TUI 同一 fd）。 */
export type OscStatusWrite = (chunk: string) => void;

export class AttachOscStatusReporter {
  private readonly app: string;
  private readonly write: OscStatusWrite;
  private readonly onError: ((error: unknown) => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private turnActive = false;
  private lastState: Osc7501State | undefined;
  private lastKey: string | undefined;
  private disabled = false;

  constructor(options: {
    app: string;
    write: OscStatusWrite;
    onError?: (error: unknown) => void;
  }) {
    this.app = options.app;
    this.write = options.write;
    this.onError = options.onError;
  }

  /** 绑定/换绑当前会话句柄：与 herdr reporter 同一 onSessionBound 驱动，
   *  覆盖初始 attach、/new、/resume、/fork 与断线重连的换句柄。换绑是
   *  状态重置点：绕过 dedup 强制重发 idle（上一个 idle 可能已隔整个回合）。 */
  bind(session: OscBoundSession): void {
    this.unsubscribe?.();
    this.turnActive = false;
    this.unsubscribe = session.addSink(this.onEvent);
    this.lastKey = undefined;
    this.emit({ state: "idle" });
  }

  /** interaction 路由端口：面板真正渲染给用户期间 blocked；settle（应答
   *  送达或面板被撤）后回到回合态。晚到的 settle 不覆盖回合终态。 */
  interactionBlocked(kind: Osc7501BlockedKind, message?: string): void {
    this.emit({
      state: "blocked",
      kind,
      ...(message !== undefined && message !== "" ? { msg: message } : {}),
    });
  }

  interactionResolved(): void {
    if (this.lastState === "done" || this.lastState === "error") return;
    this.emit(this.turnActive ? { state: "working" } : { state: "idle" });
  }

  /** 收尾：进程退出前最后一次上报（绕过去重——拆屏后上下文已变），并退订。 */
  finish(state: Osc7501State, msg?: string): void {
    if (!this.disabled) {
      this.lastKey = undefined;
      this.emit({ state, ...(msg !== undefined ? { msg } : {}) });
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private readonly onEvent = (event: SessionEvent): void => {
    switch (event.type) {
      case SessionEventType.TurnStarted:
        this.turnActive = true;
        this.emit({ state: "working" });
        break;
      case SessionEventType.TurnComplete: {
        this.turnActive = false;
        // resultType 区分终态：cancelled 是用户主动中断（正常结束），
        // error_* 是回合内失败——协议的 done/error 各得其所。
        const resultType = (
          event.payload as { resultType?: unknown } | undefined
        )?.resultType;
        if (resultType === "cancelled") {
          this.emit({ state: "idle" });
        } else if (
          typeof resultType === "string" &&
          resultType.startsWith("error")
        ) {
          this.emit({ state: "error", msg: resultType });
        } else {
          this.emit({ state: "done" });
        }
        break;
      }
      case SessionEventType.TurnError: {
        this.turnActive = false;
        const message = (
          event.payload as { error?: { message?: unknown } } | undefined
        )?.error?.message;
        this.emit({
          state: "error",
          ...(typeof message === "string" && message ? { msg: message } : {}),
        });
        break;
      }
      default:
        break;
    }
  };

  /** 带内字节按 (state,kind,msg) 去重：不丢不乱序，重复上报没有意义。 */
  private emit(record: Osc7501Record): void {
    if (this.disabled) return;
    const key = `${record.state}|${record.kind ?? ""}|${record.msg ?? ""}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.lastState = record.state;
    try {
      this.write(formatOsc7501({ ...record, app: this.app }));
    } catch (error) {
      // 流销毁/EPIPE：一次性禁用并报一次，之后静默——状态角标不值得
      // 拖垮 TUI。
      this.disabled = true;
      this.onError?.(error);
    }
  }
}
