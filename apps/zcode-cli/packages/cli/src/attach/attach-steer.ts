// attach busy 输入的双 lane 与 Alt+Up 撤回（pi-mono 对齐，见
// docs/design/v2/loop/turn-steering.md attach lane 节）：
// - steer：session/send delivery:"steer" 直驱 core steerTurn，真实事件驱动 UI；
// - follow-up：客户端本地 FIFO（core 的 session/send 只收单并发 prompt）；
// - 撤回：本地项就地摘除（合成 discarded 事件），core pendingInputs 项走
//   session/discardPendingInputs。
import {
  zcodeProtocolMethods,
  zcodeSessionDiscardPendingInputsResultSchema,
  zcodeSessionSendResultSchema,
} from "@zcode/shared";
import type { SessionEvent, TurnId } from "@zcode/contracts";
import type { TuiPromptInput, TuiSendInputResult } from "@zcode/tui";
import { AttachProtocolError, type AttachClient } from "./attach-client.js";

export type SendInputOptions = {
  abortSignal?: AbortSignal;
  delivery?: string;
  expectedTurnId?: TurnId;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  requestPermission?: (
    request: unknown,
    requestOptions?: unknown,
  ) => Promise<unknown>;
};

/** 本地 follow-up 队列项：settle 后 flushQueuedInputs 原样重放。 */
export type QueuedLocalInput = {
  input: TuiPromptInput;
  options?: SendInputOptions;
  pendingInputId: string;
  targetTurnId?: string;
};

/** steer/queue lane 需要的句柄能力；AttachSessionHandle 注入自己的私有件。 */
export type SteerQueueContext = {
  clientOf: () => AttachClient;
  emitSinkEvent: (type: string, payload: Record<string, unknown>) => void;
  /** 协议 inputId（与 submitPrompt 共用同一计数器）。 */
  nextInputId: () => string;
  /** 本地队列项 id 的计数器（`attach-input-queued-N`）。 */
  nextQueueCounter: () => number;
  queuedInputs: QueuedLocalInput[];
  sessionId: string;
};

/** 服务端 guard.steerRejected.{reason}：可回退 follow-up 队列的拒绝族。 */
function isSteerRejected(error: AttachProtocolError): boolean {
  const reasonCode = (error.data as { reasonCode?: unknown } | undefined)?.reasonCode;
  return typeof reasonCode === "string" && reasonCode.startsWith("guard.steerRejected.");
}

/**
 * steer lane：协议回执 steerQueued（core pendingInputId）即成；真实事件流
 * （常驻订阅 sink）负责 UI 队列区，不挂 per-call sink。guard.steerRejected.*
 * （含 no_active_turn settle 竞态）回退本地 follow-up 队列——flush 时序在
 * 客户端，服务端不擅自开新回合；其余错误（网络/协议）如实上抛，让上层恢复草稿。
 */
export async function steerActiveTurn(
  ctx: SteerQueueContext,
  text: string,
  options: SendInputOptions | undefined,
  activeTurnId: string | undefined,
): Promise<TuiSendInputResult> {
  const inputId = ctx.nextInputId();
  try {
    const result = zcodeSessionSendResultSchema.parse(
      await ctx.clientOf().request(zcodeProtocolMethods.sessionSend, {
        content: text,
        delivery: "steer",
        inputId,
        sessionId: ctx.sessionId,
      }),
    );
    if (!result.steerQueued) {
      // delivery:"steer" 的回执必带 steerQueued；缺失视为协议损坏，走上抛路径。
      throw new Error("steer ack missing steerQueued");
    }
    return {
      kind: "queued",
      pendingInputId: result.steerQueued.pendingInputId,
      queueLength: result.steerQueued.queueLength,
      turnId: result.steerQueued.turnId as TurnId,
    };
  } catch (error) {
    if (error instanceof AttachProtocolError && isSteerRejected(error)) {
      return queueFollowUpInput(ctx, text, options, text, activeTurnId);
    }
    throw error;
  }
}

/** follow-up lane：本地 FIFO + 合成 turn_steer_queued（delivery:"queue"）。 */
export function queueFollowUpInput(
  ctx: SteerQueueContext,
  input: TuiPromptInput,
  options: SendInputOptions | undefined,
  text: string,
  activeTurnId: string | undefined,
): TuiSendInputResult {
  const pendingInputId = `attach-input-queued-${ctx.nextQueueCounter()}`;
  ctx.queuedInputs.push({
    input,
    options,
    pendingInputId,
    targetTurnId: activeTurnId,
  });
  // 投影 queued 行立即进 UI 队列区（applyTurnSteerQueuedEvent 只读
  // pendingInputId/inputPreview，其余字段为对齐协议事件形状）。
  ctx.emitSinkEvent("turn_steer_queued", {
    delivery: "queue",
    input: text,
    inputPreview: text,
    inputSize: text.length,
    pendingInputId,
    queueLength: ctx.queuedInputs.length,
    ...(activeTurnId ? { targetTurnId: activeTurnId } : {}),
  });
  return {
    kind: "queued",
    pendingInputId,
    queueLength: ctx.queuedInputs.length,
    turnId: (activeTurnId ?? "") as TurnId,
  };
}

/**
 * follow-up 重放（settle 后 flush）的合成 turn_steer_drained payload：携带
 * drainedInputs 的 pendingInputId+text 子集——重放的新回合没有本地乐观 user
 * row，transcript 行与 steer lane 一样由 drained payload 补出（渲染合同见
 * turn-steering.md attach lane 节）。
 */
export function localFollowUpDrainedPayload(item: QueuedLocalInput): Record<string, unknown> {
  return {
    drainedInputs: [
      {
        pendingInputId: item.pendingInputId,
        text: typeof item.input === "string" ? item.input : item.input.text,
      },
    ],
    pendingInputIds: [item.pendingInputId],
    ...(item.targetTurnId ? { targetTurnId: item.targetTurnId } : {}),
  };
}

/**
 * Alt+Up 撤回（TuiRemoveQueuedInputs 端口）：本地队列项就地摘除并合成
 * turn_steer_discarded；其余 id（core pendingInputs 里的 steer 项）经
 * session/discardPendingInputs，由 core 发真实 discarded 事件。返回实际
 * 移除的 id——已被消费/未命中的项不撤，调用方按返回计数。
 */
export async function discardPendingInputs(
  ctx: SteerQueueContext,
  pendingInputIds: readonly string[],
): Promise<string[]> {
  const removed: string[] = [];
  const remoteIds: string[] = [];
  for (const pendingInputId of pendingInputIds) {
    const index = ctx.queuedInputs.findIndex(
      (item) => item.pendingInputId === pendingInputId,
    );
    if (index >= 0) {
      ctx.queuedInputs.splice(index, 1);
      removed.push(pendingInputId);
      ctx.emitSinkEvent("turn_steer_discarded", {
        pendingInputIds: [pendingInputId],
        reason: "user_removed",
      });
    } else {
      remoteIds.push(pendingInputId);
    }
  }
  if (remoteIds.length > 0) {
    try {
      const result = zcodeSessionDiscardPendingInputsResultSchema.parse(
        await ctx.clientOf().request(zcodeProtocolMethods.sessionDiscardPendingInputs, {
          pendingInputIds: remoteIds,
          sessionId: ctx.sessionId,
        }),
      );
      removed.push(...result.removed);
    } catch {
      // 撤回是尽力而为：失败时投影由真实事件自行纠正，已摘除的本地项保留。
    }
  }
  return removed;
}
