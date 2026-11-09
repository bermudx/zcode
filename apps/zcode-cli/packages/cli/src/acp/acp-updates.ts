// core 的 SessionEvent → ACP `session/update` 投影。
//
// 只做"事实 → 线框"的单向映射，不持有会话状态：transcript、权限状态机、
// 回合结算都在 AttachSessionHandle / core。这里唯一保留的增量状态是
// "该消息已发出多少字符"，因为 core 的 assistant_message 事件是**全量**正文，
// 而 ACP 要的是增量 chunk；用后缀差而不是重发全文，避免编辑器里正文重复。
import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type {
  AcpSessionUpdate,
  AcpToolCall,
  AcpToolCallUpdate,
  AcpToolKind,
  AcpToolStatus,
} from "./acp-protocol.js";

const TURN_STARTED = SessionEventType.TurnStarted;
const TURN_END_TYPES = new Set<string>([
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
]);

/** core 工具名 → ACP ToolKind。未知工具给 "other"：编辑器至少能显示成通用块。 */
export function toolKindFor(toolName: string): AcpToolKind {
  const name = toolName.toLowerCase();
  if (name.startsWith("mcp__")) return "other";
  switch (name) {
    case "read":
    case "goalreadyread":
    case "goalread":
    case "todoread":
      return "read";
    case "edit":
    case "write":
    case "applypatch":
    case "multiedit":
      return "edit";
    case "glob":
    case "grep":
    case "websearch":
      return "search";
    case "webfetch":
    case "fetch":
      return "fetch";
    case "bash":
    case "workflow":
    case "croncreate":
    case "crondelete":
    case "cronlist":
    case "cronpause":
    case "cronpauseself":
    case "cronupdate":
      return "execute";
    case "todowrite":
    case "skill":
    case "askuserquestion":
    case "exitplanmode":
      return "think";
    default:
      return "other";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** 工具标题：参数里的一行摘要比裸工具名有信息量，但必须限长。 */
function toolTitle(toolName: string, input: unknown): string {
  const record = asRecord(input);
  const candidate =
    stringField(record, "command") ??
    stringField(record, "file_path") ??
    stringField(record, "path") ??
    stringField(record, "pattern") ??
    stringField(record, "description") ??
    stringField(record, "query");
  const trimmed = candidate?.trim();
  if (!trimmed) return toolName;
  const oneLine = trimmed.split("\n")[0] ?? trimmed;
  return `${toolName}: ${oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine}`;
}

function textContent(text: string): { type: "content"; content: { type: "text"; text: string } } {
  return { content: { text, type: "text" }, type: "content" };
}

/**
 * 单会话的 update 投影器。每次回合开始 reset()，避免把上一回合的已发长度
 * 当成这一回合的基线（同一 assistantMessageId 复用时会导致漏发）。
 */
export class AcpUpdateProjector {
  private readonly emit: (update: AcpSessionUpdate) => void;
  private messageIdFallback = "";
  private readonly emittedText = new Map<string, string>();
  private readonly emittedThought = new Map<string, string>();
  private readonly knownToolCalls = new Set<string>();

  constructor(emit: (update: AcpSessionUpdate) => void) {
    this.emit = emit;
  }

  reset(): void {
    this.messageIdFallback = "";
    this.emittedText.clear();
    this.emittedThought.clear();
    this.knownToolCalls.clear();
  }

  /** 返回 true 表示该事件已投影成 update（供会话侧判断是否有输出）。 */
  ingest(event: SessionEvent): boolean {
    const payload = asRecord(event.payload);
    if (event.type === TURN_STARTED) {
      this.messageIdFallback = `turn-${String(event.turnId ?? event.id)}`;
      return false;
    }
    if (TURN_END_TYPES.has(event.type)) return false;
    if (event.type === SessionEventType.ModelStreaming) {
      return this.ingestStreaming(event, payload);
    }
    if (event.type === SessionEventType.AssistantMessage) {
      return this.ingestAssistantMessage(event, payload);
    }
    if (event.type === SessionEventType.ToolCallScheduled) {
      return this.ingestToolScheduled(payload);
    }
    if (event.type === SessionEventType.ToolCallStarted) {
      return this.updateToolCall(payload, { status: "in_progress" });
    }
    if (event.type === SessionEventType.ToolCallProgress) {
      // 进度事件在 core 里很密（stdout 字节数等）；ACP 没有对应字段，
      // 只在工具还没进入 in_progress 时补一次状态，避免刷爆编辑器的日志。
      const toolCallId = stringField(payload, "toolCallId");
      if (!toolCallId) return false;
      return this.updateToolCall(payload, { status: "in_progress" });
    }
    if (event.type === SessionEventType.ToolCallResult) {
      const result = asRecord(payload.result);
      const content = stringField(result, "content");
      return this.updateToolCall(payload, {
        ...(content ? { content: [textContent(content)] } : {}),
        rawOutput: result,
        status: "completed",
      });
    }
    if (event.type === SessionEventType.ToolCallError) {
      const error = asRecord(payload.error);
      const message = stringField(error, "message") ?? "Tool call failed";
      return this.updateToolCall(payload, {
        content: [textContent(message)],
        status: "failed",
      });
    }
    return false;
  }

  private ingestStreaming(
    event: SessionEvent,
    payload: Record<string, unknown>,
  ): boolean {
    const kind = stringField(payload, "kind");
    const delta = stringField(payload, "delta") ?? "";
    const messageId =
      stringField(payload, "assistantMessageId") ??
      this.messageIdFallback ??
      `turn-${String(event.turnId ?? event.id)}`;
    if (kind === "reasoning_delta") {
      if (delta.length === 0) return false;
      this.emittedThought.set(messageId, `${this.emittedThought.get(messageId) ?? ""}${delta}`);
      this.emit({
        content: { text: delta, type: "text" },
        messageId,
        sessionUpdate: "agent_thought_chunk",
      });
      return true;
    }
    if (kind === "text_delta" || (kind === undefined && delta.length > 0)) {
      if (delta.length === 0) return false;
      this.emittedText.set(messageId, `${this.emittedText.get(messageId) ?? ""}${delta}`);
      this.emit({
        content: { text: delta, type: "text" },
        messageId,
        sessionUpdate: "agent_message_chunk",
      });
      return true;
    }
    // text_start/end、reasoning_start/end、tool_input_*、finish 不产生正文。
    return false;
  }

  /**
   * 非流式回退：provider 没给 delta 时，assistant_message 携带全量正文。
   * 只发"比已发部分多出来的后缀"，两路都到齐也不会重复。
   */
  private ingestAssistantMessage(
    event: SessionEvent,
    payload: Record<string, unknown>,
  ): boolean {
    const content = stringField(payload, "content");
    if (!content) return false;
    const messageId = this.messageIdFallback || `turn-${String(event.turnId ?? event.id)}`;
    const emitted = this.emittedText.get(messageId) ?? "";
    if (content === emitted) return false;
    const suffix = content.startsWith(emitted) ? content.slice(emitted.length) : content;
    this.emittedText.set(messageId, content);
    if (suffix.length === 0) return false;
    this.emit({
      content: { text: suffix, type: "text" },
      messageId,
      sessionUpdate: "agent_message_chunk",
    });
    return true;
  }

  private ingestToolScheduled(payload: Record<string, unknown>): boolean {
    const toolCallId = stringField(payload, "toolCallId");
    const toolName = stringField(payload, "toolName");
    if (!toolCallId || !toolName) return false;
    this.knownToolCalls.add(toolCallId);
    const update: AcpToolCall = {
      kind: toolKindFor(toolName),
      rawInput: payload.input,
      status: "pending",
      title: toolTitle(toolName, payload.input),
      toolCallId,
    };
    this.emit({ ...update, sessionUpdate: "tool_call" });
    return true;
  }

  private updateToolCall(
    payload: Record<string, unknown>,
    patch: Partial<Omit<AcpToolCallUpdate, "toolCallId">> & { status?: AcpToolStatus },
  ): boolean {
    const toolCallId = stringField(payload, "toolCallId");
    if (!toolCallId) return false;
    if (!this.knownToolCalls.has(toolCallId)) {
      // 没有 scheduled 事件（列表回放/乱序）时不能发孤立 update：ACP 要求
      // tool_call 先行。补一条最小 tool_call，状态直接取当前值。
      const toolName = stringField(payload, "toolName") ?? "tool";
      this.knownToolCalls.add(toolCallId);
      this.emit({
        kind: toolKindFor(toolName),
        status: patch.status ?? "pending",
        title: toolName,
        toolCallId,
        sessionUpdate: "tool_call",
      });
      if (patch.content === undefined && patch.rawOutput === undefined) return true;
    }
    const update: AcpToolCallUpdate = { toolCallId, ...patch };
    this.emit({ ...update, sessionUpdate: "tool_call_update" });
    return true;
  }
}

/** 回合结束后用 core 的权威上下文水位补一条 usage_update（used/size）。 */
export function buildUsageUpdate(snapshot: unknown): AcpSessionUpdate | undefined {
  const root = asRecord(snapshot);
  const runtimeUsage = asRecord(asRecord(root.runtime).contextUsage);
  const projection = asRecord(root.projection);
  const numeric = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const size = numeric(runtimeUsage.size) || numeric(projection.contextWindow);
  const used = numeric(runtimeUsage.used) || numeric(projection.contextUsed);
  if (size <= 0) return undefined;
  return { sessionUpdate: "usage_update", size, used };
}
