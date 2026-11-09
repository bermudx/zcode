// ACP v1 前端的协议面：方法名、入站请求 schema、出站载荷类型。
//
// 为什么手写而不是直接用 @zed-industries/agent-client-protocol：npm 上最新
// 的 0.4.5 早于现行 v1 的 session/resume、session/close、elicitation/create、
// session/set_config_option / configOptions；它的 AgentSideConnection 只把
// `_` 前缀方法路由给扩展 handler，无法在同一条流上接管这些方法（两套
// dispatcher 拼接会破坏 id 关联与错误语义）。bundle 成本本身不是障碍
// （71.7kB min / 16.3kB gzip 实测），覆盖缺口才是。SDK 因此只作
// devDependency 做 conformance 回归，见 tests/acp-conformance.test.ts 与
// docs/design/v2/acp-frontend.md「SDK 评估」。
//
// 入站 schema 一律 loose：ACP 会加字段（_meta、positionEncodings…），严格模式
// 只会把合法的未来字段变成 -32602。出站载荷只写我们真正要发的字段，用
// 显式类型而不是 any，免得手滑多带内部状态（core 的 requestId 等）。
import { z } from "zod";

/** ACP v1（稳定）。v2 是 preview，不在本前端目标内。 */
export const ACP_PROTOCOL_VERSION = 1;

export const acpMethods = {
  // client → agent
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionResume: "session/resume",
  sessionClose: "session/close",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSetModel: "session/set_model",
  sessionSetConfigOption: "session/set_config_option",
  // agent → client
  sessionUpdate: "session/update",
  sessionRequestPermission: "session/request_permission",
  elicitationCreate: "elicitation/create",
} as const;

/** JSON-RPC 2.0 + ACP 保留错误码（只列本前端会发出的）。 */
export const acpErrorCodes = {
  invalidParams: -32602,
  invalidRequest: -32600,
  internal: -32603,
  methodNotFound: -32601,
  parseError: -32700,
  /** ACP: session/new 需要先完成认证。本前端不声明 authMethods，故不发。 */
  authRequired: -32000,
} as const;

export const acpStopReasons = {
  cancelled: "cancelled",
  endTurn: "end_turn",
  maxTokens: "max_tokens",
  refusal: "refusal",
} as const;
export type AcpStopReason = (typeof acpStopReasons)[keyof typeof acpStopReasons];

// ---------------------------------------------------------------------------
// 出站类型（最小面：只声明本前端会发的形状）
// ---------------------------------------------------------------------------

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; name: string; uri: string; mimeType?: string };

export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
};

export type AcpPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type AcpToolCall = {
  toolCallId: string;
  title: string;
  kind?: AcpToolKind;
  status?: AcpToolStatus;
  content?: Array<{ type: "content"; content: { type: "text"; text: string } }>;
  rawInput?: unknown;
  rawOutput?: unknown;
};

export type AcpToolCallUpdate = Partial<Omit<AcpToolCall, "toolCallId">> & {
  toolCallId: string;
};

export type AcpSessionUpdate =
  | {
      sessionUpdate: "user_message_chunk";
      messageId?: string;
      content: AcpContentBlock;
    }
  | {
      sessionUpdate: "agent_message_chunk";
      messageId?: string;
      content: AcpContentBlock;
    }
  | {
      sessionUpdate: "agent_thought_chunk";
      messageId?: string;
      content: AcpContentBlock;
    }
  | ({ sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCallUpdate)
  | {
      sessionUpdate: "plan";
      entries: Array<{
        content: string;
        priority: "high" | "medium" | "low";
        status: "pending" | "in_progress" | "completed";
      }>;
    }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | {
      sessionUpdate: "config_option_update";
      configOptions: AcpSessionConfigOption[];
    }
  | {
      sessionUpdate: "usage_update";
      used: number;
      size: number;
      cost?: { amount: number; currency: string } | null;
    };

export type AcpSessionConfigSelectOption = {
  value: string;
  name: string;
  description?: string;
};

export type AcpSessionConfigOption = {
  id: string;
  name: string;
  description?: string;
  /** v1 的 category 让编辑器把"模型"和"其它选项"分开摆放。 */
  category?: "model" | "thought_level" | "mode" | string;
  type: "select";
  currentValue: string;
  options: AcpSessionConfigSelectOption[];
  _meta?: Record<string, unknown>;
};

export type AcpSessionModeState = {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string }>;
};

export type AcpMeta = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 入站 schema（client → agent）
// ---------------------------------------------------------------------------

export const acpInitializeParamsSchema = z
  .object({
    protocolVersion: z.number().int().nonnegative(),
    clientCapabilities: z
      .object({
        elicitation: z
          .object({ form: z.unknown().nullish(), url: z.unknown().nullish() })
          .loose()
          .nullish(),
        fs: z.unknown().nullish(),
        terminal: z.boolean().nullish(),
      })
      .loose()
      .nullish(),
    clientInfo: z.object({ name: z.string(), version: z.string().optional() }).loose().nullish(),
  })
  .loose();
export type AcpInitializeParams = z.infer<typeof acpInitializeParamsSchema>;

const sessionSetupCommon = {
  cwd: z.string().min(1),
  /** ACP v1 必填；本前端不连 MCP，只是必须接受这个字段。 */
  mcpServers: z.array(z.unknown()).nullish(),
  additionalDirectories: z.array(z.string()).nullish(),
};

export const acpSessionNewParamsSchema = z.object(sessionSetupCommon).loose();
export type AcpSessionNewParams = z.infer<typeof acpSessionNewParamsSchema>;

export const acpSessionResumeParamsSchema = z
  .object({ sessionId: z.string().min(1), ...sessionSetupCommon })
  .loose();
export type AcpSessionResumeParams = z.infer<typeof acpSessionResumeParamsSchema>;

export const acpSessionCloseParamsSchema = z
  .object({ sessionId: z.string().min(1) })
  .loose();
export type AcpSessionCloseParams = z.infer<typeof acpSessionCloseParamsSchema>;

const acpContentBlockSchema = z
  .object({ type: z.string(), text: z.string().optional(), uri: z.string().optional() })
  .loose();

export const acpSessionPromptParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    prompt: z.array(acpContentBlockSchema).min(1),
  })
  .loose();
export type AcpSessionPromptParams = z.infer<typeof acpSessionPromptParamsSchema>;

export const acpSessionCancelParamsSchema = z
  .object({ sessionId: z.string().min(1) })
  .loose();
export type AcpSessionCancelParams = z.infer<typeof acpSessionCancelParamsSchema>;

export const acpSessionSetModeParamsSchema = z
  .object({ sessionId: z.string().min(1), modeId: z.string().min(1) })
  .loose();
export type AcpSessionSetModeParams = z.infer<typeof acpSessionSetModeParamsSchema>;

export const acpSessionSetModelParamsSchema = z
  .object({ sessionId: z.string().min(1), modelId: z.string().min(1) })
  .loose();
export type AcpSessionSetModelParams = z.infer<typeof acpSessionSetModelParamsSchema>;

export const acpSessionSetConfigOptionParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    configId: z.string().min(1),
    value: z.union([z.string(), z.boolean()]),
  })
  .loose();
export type AcpSessionSetConfigOptionParams = z.infer<
  typeof acpSessionSetConfigOptionParamsSchema
>;

/** client 对 session/request_permission 的应答（ACP v1 是双层：result.outcome.outcome）。 */
export const acpPermissionOutcomeSchema = z.union([
  z.object({ outcome: z.literal("cancelled") }).loose(),
  z.object({ outcome: z.literal("selected"), optionId: z.string() }).loose(),
]);

export const acpPermissionResponseSchema = z
  .object({ outcome: acpPermissionOutcomeSchema })
  .loose();
export type AcpPermissionResponse = z.infer<typeof acpPermissionResponseSchema>;

/** client 对 elicitation/create 的应答。 */
export const acpElicitationResultSchema = z
  .object({
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.unknown()).nullish(),
  })
  .loose();
export type AcpElicitationResult = z.infer<typeof acpElicitationResultSchema>;

/** elicitation form 的扁平 schema（v1 只允许原始类型与 enum）。 */
export type AcpElicitationProperty =
  | { type: "string"; title?: string; description?: string; enum?: string[] }
  | { type: "boolean"; title?: string; description?: string };

export type AcpElicitationCreateParams = {
  sessionId: string;
  mode: "form";
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, AcpElicitationProperty>;
    required?: string[];
  };
};

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
