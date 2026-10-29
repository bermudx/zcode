// attach 侧的 wire/快照 → TUI 展示投影：transcript 复原与页脚种子共用
// 「core 事实 → 客户端一次性展示态」的纯映射，不持业务状态。
import type { ZCodeSessionStateSnapshot } from "@zcode/shared";
import type {
  TuiRestoredTranscriptPart,
  TuiSubmitPromptResult,
} from "@zcode/tui";

/** wire part（zcodeMessagePartSchema）→ TuiRestoredTranscriptPart。
 * 与 bootstrap projectSessionTranscript 同语义；瘦客户端不引 bootstrap barrel。 */
function projectWirePart(part: unknown): TuiRestoredTranscriptPart | undefined {
  const record = part as Record<string, unknown> | undefined;
  if (record?.type === "text" && typeof record.text === "string") {
    return record.ignored === true ? undefined : { text: record.text, type: "text" };
  }
  if (record?.type === "reasoning" && typeof record.text === "string") {
    return { text: record.text, type: "thought" };
  }
  if (record?.type === "tool" && typeof record.tool === "string") {
    const state = (record.state ?? {}) as Record<string, unknown>;
    const base = {
      input: (state.input ?? {}) as Record<string, unknown>,
      ...(typeof state.title === "string" ? { title: state.title } : {}),
      toolCallId:
        (typeof record.callId === "string" && record.callId) ||
        (typeof record.callID === "string" ? record.callID : ""),
      toolName: record.tool,
      type: "tool" as const,
    };
    if (state.status === "completed") {
      return {
        ...base,
        ...(typeof state.output === "string" ? { output: state.output } : {}),
        status: "completed",
      };
    }
    if (state.status === "error") {
      return {
        ...base,
        ...(typeof state.error === "string" ? { error: state.error } : {}),
        status: "failed",
      };
    }
    return { ...base, status: "running" };
  }
  return undefined;
}

/** 快照/存储里的 wire messages → TuiSubmitPromptResult.restoredMessages。 */
export function projectAttachTranscriptMessages(
  messages: ReadonlyArray<{
    info?: { messageId?: string; role?: string };
    parts?: unknown[];
  }>,
): NonNullable<TuiSubmitPromptResult["restoredMessages"]> {
  return messages.map((message) => {
    const parts = (message.parts ?? [])
      .map(projectWirePart)
      .filter((part): part is TuiRestoredTranscriptPart => part !== undefined);
    return {
      content: "",
      ...(message.info?.messageId ? { id: message.info.messageId } : {}),
      ...(parts.length > 0 ? { parts } : {}),
      role: (message.info?.role === "user" ? "user" : "agent") as
        | "user"
        | "agent",
    };
  });
}

/**
 * 会话绑定时的一次性展示种子：快照 runtime.contextUsage / projection 给出
 * ctx 水位与窗口、runtime.usageTotals 给出 session 级累计用量（接入前
 * 流量）。live 事件从绑定点开始增量，种子把"接入前"部分补齐——pi 直接
 * 扫 session history，这是 attach 客户端的等价物。eventStore 是运行期
 * 内存账本，core 重启后冷恢复的 session 只含物化后事件（与
 * projection.contextUsed 同口径）。
 *
 * 已知边界：常驻 sink 在 registerSession 时即挂上（onSessionBound），
 * subscribe 往返期间的 live 事件既被 sink 折叠、又落在快照折叠里——
 * 单次换绑最多双计一个请求的计数；彻底消重需要快照带 asOfSeq 水位
 * （subscribe 已回 eventSeq），交给 live 折叠跳过 ≤ 水位的事件。
 */
export function projectSessionSnapshotSeed(
  snapshot: ZCodeSessionStateSnapshot,
): Pick<TuiSubmitPromptResult, "projection" | "usageTotals"> {
  const contextUsage = snapshot.runtime.contextUsage;
  const projection =
    contextUsage !== undefined
      ? {
          contextWindow: contextUsage.size,
          ...(contextUsage.used > 0 ? { contextUsed: contextUsage.used } : {}),
        }
      : {
          ...(snapshot.projection.contextWindow > 0
            ? { contextWindow: snapshot.projection.contextWindow }
            : {}),
          ...(snapshot.projection.contextUsed > 0
            ? { contextUsed: snapshot.projection.contextUsed }
            : {}),
        };
  return {
    ...(Object.keys(projection).length > 0 ? { projection } : {}),
    ...(snapshot.runtime.usageTotals
      ? { usageTotals: snapshot.runtime.usageTotals }
      : {}),
  };
}
