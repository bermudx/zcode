// ACP 前端的纯映射层：core 的会话事实 → ACP v1 的 session/update、模式/模型
// 选项与 elicitation 表单；反向把 ACP 的用户动作翻回 core 的应答形状。
// 这里不持有连接、不读写文件，全部是可在单测里直接断言的数据变换。
import type {
  ContentBlock,
  ElicitationPropertySchema,
  ElicitationSchema,
  PermissionOption,
  PlanEntry,
  SessionConfigOption,
  SessionMode,
  SessionModeState,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { TuiPromptAttachment } from "@zcode/tui";
import { z } from "zod";
import {
  AskUserQuestionInputSchema,
  TodoWriteOutputSchema,
  type AskUserQuestion,
  type AskUserQuestionOption,
} from "@zcode/contracts/tools";

/** core 的协作模式里只有 plan 是 ACP 侧需要暴露的独立模式；其余都归 build。 */
export const ACP_PLAN_MODE = "plan";
export const ACP_BUILD_MODE = "build";
export const ACP_MODEL_CONFIG_ID = "model";
export const ACP_THOUGHT_LEVEL_CONFIG_ID = "thought_level";

export interface CoreModelRef {
  modelId: string;
  providerId: string;
}

export interface CoreThoughtLevelOption {
  value: string;
  label: string;
  description?: string;
}

export interface CoreModelOption {
  ref: CoreModelRef;
  label: string;
  description?: string;
  disabledReason?: string;
  reasoning?: {
    levels: readonly CoreThoughtLevelOption[];
    defaultLevel?: string;
  };
}

export interface CoreThoughtLevelSettings {
  enabled: boolean;
  current?: string;
  defaultLevel?: string;
  available: readonly CoreThoughtLevelOption[];
}

export interface CoreModelSettings {
  current?: CoreModelRef;
  available: readonly CoreModelOption[];
}

/** 与 core `@zcode/contracts` 的 PermissionBrokerResult 同形的本地最小面。 */
export type AcpPermissionResult =
  | { decision: "allow"; permissionUpdates?: unknown; reason?: string }
  | { decision: "deny"; reason?: string }
  | { decision: "modify"; modifiedInput?: unknown };

export interface CorePermissionOption {
  kind: string;
  label?: string;
  description?: string;
  response?: { permissionUpdates?: unknown };
}

export type CoreAskUserQuestionOption = AskUserQuestionOption;
export type CoreAskUserQuestion = Omit<AskUserQuestion, "multiSelect"> & {
  multiSelect?: boolean;
};

export function coreModeToAcpMode(mode: string | undefined): string {
  return mode === ACP_PLAN_MODE ? ACP_PLAN_MODE : ACP_BUILD_MODE;
}

export function buildModeState(mode: string | undefined): SessionModeState {
  const availableModes: SessionMode[] = [
    {
      description: "Explore and plan before changing files",
      id: ACP_PLAN_MODE,
      name: "Plan",
    },
    {
      description: "Make changes and run tools",
      id: ACP_BUILD_MODE,
      name: "Build",
    },
  ];
  return { availableModes, currentModeId: coreModeToAcpMode(mode) };
}

export function modelValue(selection: CoreModelRef | undefined): string | undefined {
  if (!selection?.providerId || !selection.modelId) return undefined;
  return `${selection.providerId}/${selection.modelId}`;
}

function enabledModels(settings: CoreModelSettings): CoreModelOption[] {
  return settings.available.filter((option) => !option.disabledReason);
}

/** ACP 的模型选择走通用 config option（category=model），T3 的模型选择器就吃这一项。 */
export function buildConfigOptions(
  settings: CoreModelSettings,
  thoughtLevel?: CoreThoughtLevelSettings,
): SessionConfigOption[] {
  const available = enabledModels(settings);
  const currentValue =
    modelValue(settings.current) ?? modelValue(available[0]?.ref) ?? "";
  if (available.length === 0) return [];
  const options: SessionConfigOption[] = [
    {
      category: "model",
      currentValue,
      description: "Model used for this session's turns",
      id: ACP_MODEL_CONFIG_ID,
      name: "Model",
      options: available.map((option) => ({
        description: option.description,
        name: option.label,
        value: modelValue(option.ref) ?? option.ref.modelId,
      })),
      type: "select",
    },
  ];
  const effort = thoughtLevelOption(settings, available, thoughtLevel);
  if (effort) options.push(effort);
  return options;
}

function thoughtLevelOption(
  settings: CoreModelSettings,
  available: readonly CoreModelOption[],
  thoughtLevel: CoreThoughtLevelSettings | undefined,
): SessionConfigOption | undefined {
  if (!thoughtLevel?.enabled || !settings.current) return undefined;
  const currentModel = available.find(
    (option) =>
      option.ref.providerId === settings.current?.providerId &&
      option.ref.modelId === settings.current?.modelId,
  );
  const levels = currentModel?.reasoning?.levels ?? [];
  if (levels.length === 0) return undefined;
  const supported = new Set(levels.map((level) => level.value));
  const currentValue =
    [thoughtLevel.current, thoughtLevel.defaultLevel, currentModel?.reasoning?.defaultLevel]
      .find((value): value is string => value !== undefined && supported.has(value)) ?? levels[0]!.value;
  return {
    category: "thought_level",
    currentValue,
    description: "Reasoning effort used for this session's turns",
    id: ACP_THOUGHT_LEVEL_CONFIG_ID,
    name: "Reasoning effort",
    options: levels.map((level) => ({
      description: level.description,
      name: level.label,
      value: level.value,
    })),
    type: "select",
  };
}

const PERMISSION_KIND_TO_ACP: Record<string, PermissionOption["kind"]> = {
  allow_always: "allow_always",
  allow_once: "allow_once",
  deny: "reject_once",
};

const DEFAULT_PERMISSION_NAMES: Record<string, string> = {
  allow_always: "Always allow in this project",
  allow_once: "Allow once",
  deny: "Deny",
};

/** core 的 option.response 是权威应答原文，optionId 只做往返索引。 */
export function permissionOptionsForCore(
  options: readonly CorePermissionOption[],
): Array<PermissionOption & { _coreIndex: number }> {
  return options.map((option, index) => ({
    _coreIndex: index,
    kind: PERMISSION_KIND_TO_ACP[option.kind] ?? "allow_once",
    name: option.label ?? DEFAULT_PERMISSION_NAMES[option.kind] ?? option.kind,
    optionId: `core-option-${index}`,
  }));
}

export function permissionResultForAcpOption(
  options: readonly CorePermissionOption[],
  optionId: string | undefined,
): AcpPermissionResult {
  if (optionId === undefined) {
    return { decision: "deny", reason: "Permission request was cancelled" };
  }
  const index = Number.parseInt(optionId.replace(/^core-option-/, ""), 10);
  const option = Number.isInteger(index) ? options[index] : undefined;
  if (!option) {
    return { decision: "deny", reason: `Unknown permission option: ${optionId}` };
  }
  if (option.kind === "deny") {
    return { decision: "deny", reason: "Denied by user" };
  }
  if (option.kind === "allow_always") {
    const permissionUpdates = option.response?.permissionUpdates;
    return permissionUpdates === undefined
      ? { decision: "allow" }
      : { decision: "allow", permissionUpdates };
  }
  return { decision: "allow" };
}

const INVALID_PROMPT_PARAMS = -32602;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(PROTOCOL_V4_LIMITS.attachmentMaxBytes / 3) * 4;
const imageBlockSchema = z.object({
  data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
});
const IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

export type AcpPromptInput = { text: string; attachments: TuiPromptAttachment[] };

/** ACP 整条输入先校验再交给现有附件上传；不读 URI、不在适配层保存图片文件。 */
export function promptBlocksToInput(blocks: readonly ContentBlock[]): AcpPromptInput {
  const parts: string[] = [];
  const attachments: TuiPromptAttachment[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "resource_link":
        parts.push(`@${resourceLinkPath(block.uri)}`);
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource && typeof resource.text === "string") {
          parts.push(resource.text);
        } else {
          parts.push(`@${resourceLinkPath(resource.uri)}`);
        }
        break;
      }
      case "image": {
        const parsed = imageBlockSchema.safeParse(block);
        if (!parsed.success) {
          throw new RequestError(
            INVALID_PROMPT_PARAMS,
            `Invalid ACP image: expected PNG, JPEG, GIF or WebP with nonempty base64 (max ${PROTOCOL_V4_LIMITS.attachmentMaxBytes} bytes)`,
          );
        }
        const { data, mimeType } = parsed.data;
        // Buffer.from 会容忍畸形 base64；必须回编码比对，不能悄悄截断/改写用户图片。
        const bytes = Buffer.from(data, "base64");
        if (bytes.byteLength > PROTOCOL_V4_LIMITS.attachmentMaxBytes || bytes.toString("base64") !== data) {
          throw new RequestError(INVALID_PROMPT_PARAMS, "Invalid ACP image: malformed base64 or image exceeds byte limit");
        }
        attachments.push({
          content: `data:${mimeType};base64,${data}`,
          path: `@acp-image-${attachments.length + 1}.${IMAGE_EXTENSIONS[mimeType]}`,
          type: "image",
        });
        break;
      }
      case "audio":
        throw new RequestError(
          INVALID_PROMPT_PARAMS,
          "piz acp does not accept audio content yet; send text or a file reference instead",
        );
      default:
        parts.push(JSON.stringify(block));
        break;
    }
  }
  return { attachments, text: parts.join("\n\n").trim() };
}

function resourceLinkPath(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
}

export function isAskUserQuestionInput(value: unknown): value is {
  questions: CoreAskUserQuestion[];
} {
  return AskUserQuestionInputSchema.safeParse(value).success;
}

/** AskUserQuestion → 表单 elicitation。单选走 string+enum；多选按“逗号分隔文本”收，
 *  因为表单 schema 的 array 字段在客户端侧渲染不稳定，主流程仍要能用。 */
export function buildQuestionForm(input: unknown): {
  message: string;
  questions: CoreAskUserQuestion[];
  requestedSchema: ElicitationSchema;
} {
  const parsed = AskUserQuestionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid AskUserQuestion input: ${parsed.error.message}`);
  }
  const { questions } = parsed.data;
  const properties: Record<string, ElicitationPropertySchema> = {};
  questions.forEach((question, index) => {
    const key = `q${index}`;
    const optionLines = question.options.map((option) =>
      [
        `${option.label}: ${option.description}`,
        ...(option.preview === undefined ? [] : [option.preview]),
      ].join("\n"),
    );
    if (question.multiSelect) {
      properties[key] = {
        description: [
          question.question,
          `Comma-separated values. Options: ${optionLines.join(" | ")}`,
        ].join("\n\n"),
        title: question.header,
        type: "string",
      } satisfies ElicitationPropertySchema;
      return;
    }
    properties[key] = {
      description: [question.question, ...optionLines].join("\n\n"),
      enum: question.options.map((option) => option.label),
      title: question.header,
      type: "string",
    } satisfies ElicitationPropertySchema;
  });
  const message =
    questions.length === 1
      ? questions[0]?.question ?? "The agent needs your input"
      : "The agent needs your input";
  return {
    message,
    questions,
    requestedSchema: {
      properties,
      required: questions.map((_, index) => `q${index}`),
      type: "object",
    },
  };
}

/** elicitation 的 content → core AskUserQuestion 的 answers（按题干回填）。 */
export function answersFromElicitationContent(
  questions: readonly CoreAskUserQuestion[],
  content: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const raw = content?.[`q${index}`];
    const answer = Array.isArray(raw)
      ? raw.map((item) => String(item)).join(", ")
      : typeof raw === "string"
        ? raw.trim()
        : typeof raw === "number" || typeof raw === "boolean"
          ? String(raw)
          : "";
    if (answer.length > 0) answers[question.question] = answer;
  });
  return answers;
}

export const PLAN_APPROVAL_DECISION_KEY = "decision";

/** ExitPlanMode → 批准/拒绝。Auto/Full 的自动批准只可能落在显式选项上，不会静默跳过。 */
export function buildPlanApprovalForm(reason: string): {
  message: string;
  requestedSchema: ElicitationSchema;
} {
  return {
    message: reason.length > 0 ? reason : "Approve this plan?",
    requestedSchema: {
      properties: {
        [PLAN_APPROVAL_DECISION_KEY]: {
          description: "Approve the plan to start implementing it, or reject to keep planning.",
          enum: ["approve", "reject"],
          title: "Plan approval",
          type: "string",
        },
      },
      required: [PLAN_APPROVAL_DECISION_KEY],
      type: "object",
    },
  };
}

export function planApprovalResult(
  content: Record<string, unknown> | null | undefined,
): AcpPermissionResult {
  const decision = content?.[PLAN_APPROVAL_DECISION_KEY];
  return decision === "approve"
    ? { decision: "allow" }
    : { decision: "deny", reason: "Plan rejected by user" };
}

const TOOL_KINDS: Record<string, ToolKind> = {
  Bash: "execute",
  Edit: "edit",
  Glob: "search",
  Grep: "search",
  MultiEdit: "edit",
  Read: "read",
  Task: "other",
  TodoWrite: "think",
  WebFetch: "fetch",
  WebSearch: "fetch",
  Write: "edit",
  NotebookEdit: "edit",
};

export function toolKindForName(toolName: string | undefined): ToolKind {
  return (toolName && TOOL_KINDS[toolName]) || "other";
}

/** tool result 的展示正文：有 content 优先，其次 output/text，最后有界 JSON。 */
export function summarizeToolResult(result: unknown, limit = 4_000): string | undefined {
  const text = readToolResultText(result);
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function readToolResultText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const joined = result
      .map((part) => readToolResultText(part))
      .filter((part): part is string => part !== undefined)
      .join("\n");
    return joined.length > 0 ? joined : undefined;
  }
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ["content", "output", "text", "stdout", "error"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (Array.isArray(value)) {
      const nested = readToolResultText(value);
      if (nested !== undefined) return nested;
    }
  }
  const json = JSON.stringify(result);
  return json === "{}" ? undefined : json;
}

export function textToolContent(text: string): ToolCallContent {
  return { content: { text, type: "text" }, type: "content" };
}

export interface SessionEventLike {
  payload?: unknown;
  turnId?: string;
  type: string;
}

type ProjectionState = {
  toolInputs: Map<string, unknown>;
  toolNames: Map<string, string>;
  lastPlanKey: string | undefined;
};

/**
 * 每个会话一份投影状态：tool input/tool name 在 scheduled 与 started 之间共享，
 * plan 去重避免同一条 todo 列表在每轮都重发。
 */
export class AcpEventProjector {
  private readonly state: ProjectionState = {
    lastPlanKey: undefined,
    toolInputs: new Map(),
    toolNames: new Map(),
  };

  /** SessionEvent → 0..n 条 session/update。未知事件静默跳过（不假装有内容）。 */
  project(event: SessionEventLike): SessionUpdate[] {
    const payload = isRecord(event.payload) ? event.payload : {};
    switch (event.type) {
      case "model_streaming":
        return this.projectStreaming(payload);
      case "tool_call_scheduled":
        return this.projectToolScheduled(payload);
      case "tool_call_started":
        return this.projectToolStarted(payload);
      case "tool_call_result":
        return this.projectToolResult(payload);
      case "tool_call_error":
        return this.projectToolError(payload);
      case "session_mode_changed": {
        const mode = typeof payload.mode === "string" ? payload.mode : undefined;
        return [{
          currentModeId: coreModeToAcpMode(payload.planEnabled === true ? "plan" : mode),
          sessionUpdate: "current_mode_update",
        }];
      }
      case "session_title_updated": {
        const title = typeof payload.title === "string" ? payload.title : undefined;
        return title ? [{ sessionUpdate: "session_info_update", title }] : [];
      }
      case "turn_error": {
        const error = isRecord(payload.error) ? payload.error : {};
        const message =
          typeof error.message === "string" ? error.message : "Turn failed";
        return [
          { description: message, sessionUpdate: "notice", severity: "error", title: "Turn failed" },
        ];
      }
      default:
        return [];
    }
  }

  private projectStreaming(payload: Record<string, unknown>): SessionUpdate[] {
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    if (delta.length === 0) return [];
    if (payload.kind === "text_delta") {
      return [
        {
          content: { text: delta, type: "text" },
          messageId:
            typeof payload.assistantMessageId === "string"
              ? payload.assistantMessageId
              : undefined,
          sessionUpdate: "agent_message_chunk",
        },
      ];
    }
    if (payload.kind === "reasoning_delta") {
      return [
        {
          content: { text: delta, type: "text" },
          messageId:
            typeof payload.assistantMessageId === "string"
              ? payload.assistantMessageId
              : undefined,
          sessionUpdate: "agent_thought_chunk",
        },
      ];
    }
    return [];
  }

  private projectToolScheduled(payload: Record<string, unknown>): SessionUpdate[] {
    const toolCallId = readId(payload.toolCallId);
    if (!toolCallId) return [];
    const toolName =
      typeof payload.toolName === "string" ? payload.toolName : undefined;
    this.state.toolNames.set(toolCallId, toolName ?? "");
    this.state.toolInputs.set(toolCallId, payload.input);
    return [
      this.toolCall(toolCallId, toolName, "pending", payload.input),
    ];
  }

  private projectToolStarted(payload: Record<string, unknown>): SessionUpdate[] {
    const toolCallId = readId(payload.toolCallId);
    if (!toolCallId) return [];
    const fromPayload =
      typeof payload.toolName === "string" ? payload.toolName : undefined;
    const toolName = fromPayload ?? (this.state.toolNames.get(toolCallId) || undefined);
    const update: ToolCallUpdate & { sessionUpdate: "tool_call_update" } = {
      kind: toolKindForName(toolName),
      rawInput: this.state.toolInputs.get(toolCallId),
      sessionUpdate: "tool_call_update",
      status: "in_progress",
      title: toolName ?? "Tool call",
      toolCallId,
    };
    return [update];
  }

  private projectToolResult(payload: Record<string, unknown>): SessionUpdate[] {
    const toolCallId = readId(payload.toolCallId);
    if (!toolCallId) return [];
    const text = summarizeToolResult(payload.result);
    const update: ToolCallUpdate & { sessionUpdate: "tool_call_update" } = {
      content: text === undefined ? undefined : [textToolContent(text)],
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolCallId,
    };
    // 只投影成功结果里的权威清单，不把 scheduled input 当成已提交状态。
    const result = payload.result;
    let todos: PlanEntry[] | undefined;
    if (this.state.toolNames.get(toolCallId) === "TodoWrite" &&
      isRecord(result) && result.success === true) {
      if (typeof result.content !== "string") {
        throw new Error("Successful TodoWrite result must contain JSON content");
      }
      // 成功的 TodoWrite 是结构化边界，坏 JSON/schema 必须上抛，不能伪装无更新。
      todos = TodoWriteOutputSchema.parse(JSON.parse(result.content)).todos;
    }
    this.state.toolInputs.delete(toolCallId);
    this.state.toolNames.delete(toolCallId);
    return [update, ...this.projectTodos(todos)];
  }

  private projectToolError(payload: Record<string, unknown>): SessionUpdate[] {
    const toolCallId = readId(payload.toolCallId);
    if (!toolCallId) return [];
    const error = isRecord(payload.error) ? payload.error : {};
    const message =
      typeof error.message === "string" ? error.message : "Tool call failed";
    this.state.toolInputs.delete(toolCallId);
    this.state.toolNames.delete(toolCallId);
    return [
      {
        content: [textToolContent(message)],
        sessionUpdate: "tool_call_update",
        status: "failed",
        toolCallId,
      },
    ];
  }

  private toolCall(
    toolCallId: string,
    toolName: string | undefined,
    status: ToolCallStatus,
    input: unknown,
  ): ToolCall & { sessionUpdate: "tool_call" } {
    return {
      kind: toolKindForName(toolName),
      rawInput: input,
      sessionUpdate: "tool_call",
      status,
      title: toolName ?? "Tool call",
      toolCallId,
    };
  }

  /** core 的 todo 列表 → ACP plan；内容未变时返回空数组。 */
  projectTodos(todos: readonly PlanEntry[] | undefined): SessionUpdate[] {
    if (!todos) return [];
    const key = JSON.stringify(todos.map(({ content, priority, status }) =>
      [content, priority, status],
    ));
    if (key === this.state.lastPlanKey) return [];
    this.state.lastPlanKey = key;
    return [{ entries: [...todos], sessionUpdate: "plan" }];
  }
}

function readId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
