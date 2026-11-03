// attach 瘦客户端的 v4 命令发送面：把输入提交（sendText）与 stop 从旧 session/send、
// session/stop 迁到共享 core 的 v4/command。传输仍走同一条 AttachClient socket。
//
// 设计边界（见 docs/design/v2/tui-attach-shared-core.md「输入提交迁移到 v4」）：
// - commandId 由客户端生成且跨进程唯一（UUID）；core 的 CommandInbox 以
//   (sessionId, commandId) 持久去重，进程内计数器跨进程会撞（撞上即 duplicate 不执行）。
// - ACK 只证明 admission（accepted/duplicate），不证明 turn 已开始；turn 的开始/结束
//   仍由 raw 事件流关联（turn_started/turn_complete 按 inputId=commandId），不在这里等待。
// - 队列归属不变：Ctrl+Q follow-up 仍由 attach-steer 的客户端 FIFO 持有；core 只拥有
//   steer(guide) 的 pendingInputs 与 v4 admission 排队项。
// - 信封与回执都按 @zcode/shared/zcode-protocol-v4 的共享 zod schema 校验，客户端不私有
//   定义线上形状（避免与 core schema 漂移）。
import { randomUUID } from "node:crypto";
import {
  V4_METHODS,
  commandAckSchema,
  type CommandAck,
  type CommandPayloadMap,
  type CommandType,
} from "@zcode/shared/zcode-protocol-v4";
import type { AttachClient } from "./attach-client.js";

/** 本进程的 v4 clientId：信封遥测/归因用，不参与去重裁决。每进程一份，不落盘。 */
let cachedClientId: string | undefined;

export function attachV4ClientId(): string {
  cachedClientId ??= `attach-${randomUUID()}`;
  return cachedClientId;
}

/** 客户端生成 commandId：UUID 保证跨进程/重启不撞 core 的 (sessionId, commandId) 去重键。 */
export function newCommandId(): string {
  return `attach-cmd-${randomUUID()}`;
}

/**
 * core 为 v4 输入分配的队列项 id（与 bootstrap command-inbox 的
 * queueItemIdForCommand 同式）：core 以 intent.queueItemId 作 pendingInputId，
 * 客户端无需等回执即可确定 steer 项的 id（TUI 队列行幂等 upsert 的键）。
 */
export function queueItemIdForCommand(commandId: string): string {
  return `queue_${commandId}`;
}

// payload 类型直接取共享 CommandPayloadMap，客户端不再私有定义 sendText 字段集——
// 与 core schema 同源，协议新增字段自动可见，不会漂移。
export type V4SendTextPayload = CommandPayloadMap["sendText"];

/** ACK 失败族（rejected/stale/noop/failed）：抛带 reasonCode 的错误，调用方据此分流，不静默吞掉。 */
export class AttachV4CommandError extends Error {
  readonly reasonCode: string;
  readonly status: CommandAck["status"];
  constructor(ack: CommandAck) {
    super(ack.message ?? `v4 command ${ack.status}: ${ack.reasonCode ?? "unknown"}`);
    this.name = "AttachV4CommandError";
    this.reasonCode = ack.reasonCode ?? `fault.command.${ack.status}`;
    this.status = ack.status;
  }
}

/** 通用 v4/command 提交：payload 按 CommandType 关联共享 payload 类型；
 *  accepted/duplicate 视为成功，其余抛 AttachV4CommandError。 */
export async function sendV4Command<T extends CommandType>(
  client: AttachClient,
  envelope: {
    type: T;
    sessionId: string;
    commandId: string;
    payload: CommandPayloadMap[T];
  },
): Promise<CommandAck> {
  const raw = await client.request(V4_METHODS.command, {
    clientId: attachV4ClientId(),
    commandId: envelope.commandId,
    // 客户端时钟，仅遥测（timestampSchema = number）。
    issuedAt: Date.now(),
    payload: envelope.payload,
    sessionId: envelope.sessionId,
    type: envelope.type,
  });
  const ack = commandAckSchema.parse(raw);
  if (ack.status === "accepted" || ack.status === "duplicate") return ack;
  throw new AttachV4CommandError(ack);
}

/**
 * sendText：空闲提交（不带 requestedDelivery——缺省 startNow 语义仅指「开新回合」，
 * core 忙时 admission 自动转排队，不会抢占）与忙时 steer（requestedDelivery:"guide"）
 * 共用。heldQueueDisposition 恒带 keepQueueAndSend：仅在 held/choice 状态生效（非破坏性），
 * 避免 v4 stop 后遗留 guide 项时下一条输入被 heldQueueDispositionRequired 拒绝。
 */
export function sendTextCommand(
  client: AttachClient,
  input: {
    sessionId: string;
    commandId: string;
    payload: V4SendTextPayload;
  },
): Promise<CommandAck> {
  return sendV4Command(client, {
    commandId: input.commandId,
    payload: input.payload,
    sessionId: input.sessionId,
    type: "sendText",
  });
}

/** stop：请求 core 停止当前前台执行；对 idle 会话是 no-op ACK（accepted）。 */
export function stopCommand(
  client: AttachClient,
  input: { sessionId: string },
): Promise<CommandAck> {
  return sendV4Command(client, {
    commandId: newCommandId(),
    payload: {},
    sessionId: input.sessionId,
    type: "stop",
  });
}
