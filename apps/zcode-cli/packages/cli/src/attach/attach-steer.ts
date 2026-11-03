// attach busy 输入的双 lane 与 Alt+Up 撤回（pi-mono 对齐，见
// docs/design/v2/loop/turn-steering.md attach lane 节）：
// - steer：v4 sendText requestedDelivery:"guide"——core 忙时注入 active turn
//   pendingInputs（真实 TurnSteerQueued/Drained 事件驱动 UI）；settle 竞态/不可
//   steer 时 core admission 自动转 deferred 队列或拒绝；idle 竞态则启动新回合，
//   客户端按 ACK delivery 跟踪，拒绝回退本地 follow-up 队列；
// - follow-up：客户端本地 FIFO（Ctrl+Q 语义：settle 后作为新回合重放）；
// - 撤回：本地项就地摘除（合成 discarded 事件），core pendingInputs 项走
//   session/discardPendingInputs。
import {
  zcodeProtocolMethods,
  zcodeSessionDiscardPendingInputsResultSchema,
} from "@zcode/shared";
import type { SessionEvent, TurnId } from "@zcode/contracts";
import type { TuiPromptInput, TuiSendInputResult } from "@zcode/tui";
import type { AttachClient } from "./attach-client.js";
import {
  AttachV4CommandError,
  queueItemIdForCommand,
  sendTextCommand,
} from "./attach-v4-command.js";

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
  /** 本地队列项 id 的计数器（`attach-input-queued-N`）。 */
  nextQueueCounter: () => number;
  queuedInputs: QueuedLocalInput[];
  sessionId: string;
};

/**
 * steer lane：v4 sendText requestedDelivery:"guide" 直驱 core admission——忙且
 * steerable 时注入 active turn pendingInputs；真实事件流（常驻订阅 sink）负责 UI
 * 队列区。调用方先登记 commandId 的 turn 等待器，ACK startNow 时返回 undefined，
 * 由调用方等真实 turn 完成；否则撤下临时等待器并返回 queued。ACK 失败族回退本地
 * follow-up 队列，其余错误（网络/协议 schema）如实上抛，让上层恢复草稿。
 */
export async function steerActiveTurn(
  ctx: SteerQueueContext,
  text: string,
  options: SendInputOptions | undefined,
  activeTurnId: string | undefined,
  commandId: string,
): Promise<TuiSendInputResult | undefined> {
  try {
    const ack = await sendTextCommand(ctx.clientOf(), {
      commandId,
      payload: {
        heldQueueDisposition: "keepQueueAndSend",
        requestedDelivery: "guide",
        text,
      },
      sessionId: ctx.sessionId,
    });
    if (ack.result?.type !== "inputAccepted" || ack.result.inputId !== commandId) {
      throw new Error("v4 guide ACK is missing its input admission result");
    }
    if (ack.result.delivery === "startNow") {
      // Bug 根因：guide 落在 idle 时会启动新回合，不能伪造永不 drained 的队列行。
      // started_turn 回包由 TUI 按正常提交插入 user 行，不在此重复投影。
      return undefined;
    }
  } catch (error) {
    if (error instanceof AttachV4CommandError) {
      return queueFollowUpInput(ctx, text, options, text, activeTurnId);
    }
    throw error;
  }
  return {
    kind: "queued",
    pendingInputId: queueItemIdForCommand(commandId),
    // ACK 不带队列长度；此处仅状态行首帧文案，真实计数由 TurnSteerQueued 事件投影修正。
    queueLength: 1,
    turnId: (activeTurnId ?? "") as TurnId,
  };
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
