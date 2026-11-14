// ACP 的本地 slash 命令层：/goal 与 /dwf 不进模型——ACP 客户端没有 command-center，
// 不拦截就会按 P005 把原文喂给模型，goal 状态机与 workflow journal 永远不参与。
// 这里按 TUI command-center 同一套 core 语义做解析与分发，dwf 文案/裁定直接复用
// handlers/dwf.ts，不在第二处再写一份。不持有连接：core 事实全部经 AttachSessionHandle。
import { randomUUID } from "node:crypto";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES,
  type ZCodeSessionGoalAction,
} from "@zcode/shared";
import type { AttachSessionHandle } from "../attach/attach-session.js";
import {
  configureApiKeyViaAttachProtocol,
  loginViaAttachProtocol,
  logoutViaAttachProtocol,
  type ThinAuthRequest,
  type ThinBrowserOpenResult,
} from "../attach/attach-auth.js";
import {
  formatLoginResult,
  formatProviderSetupResult,
  loginFailureResponse,
  parseApiKeyLoginArgs,
} from "../command-center/login-flow.js";
import { buildManualSkillPrompt } from "../command-center/slash-commands.js";
import { splitArgs } from "../command-center/utils.js";
import type { SkillCatalogEntry } from "../skill-suggestions.js";
import {
  DWF_LIST_LIMIT,
  DWF_USAGE,
  describeResumeRejection,
  formatRunLine,
  formatRunList,
  resolveDwfCancelTarget,
} from "../command-center/handlers/dwf.js";

export type AcpLocalCommand =
  | { args: string; kind: "dwf" }
  | { args: string; kind: "goal" }
  | { args: string; kind: "login" }
  | { args: string; kind: "logout" };

/** /dwf 消费的 handle 读面：命令层只依赖这三个成员，不持有整个 AttachSessionHandle。 */
type DwfHandle = Pick<
  AttachSessionHandle,
  "cancelBackgroundTask" | "listDynamicWorkflowRuns" | "resumeWorkflowRun"
>;

/** TUI parseSlashCommand 同款词边界：命令词（含 /target 别名）+ 空格 + args；只认本地路由的名字。 */
export function parseLocalSlashCommand(text: string): AcpLocalCommand | null {
  if (!text.startsWith("/")) return null;
  const trimmed = text.trim();
  const commandEnd = trimmed.search(/\s/);
  const name = (
    commandEnd === -1 ? trimmed.slice(1) : trimmed.slice(1, commandEnd)
  ).toLowerCase();
  if (
    name !== "goal" &&
    name !== "target" &&
    name !== "dwf" &&
    name !== "login" &&
    name !== "logout"
  )
    return null;
  const args = commandEnd === -1 ? "" : trimmed.slice(commandEnd + 1).trim();
  const kind =
    name === "dwf" ? "dwf" : name === "login" ? "login" : name === "logout" ? "logout" : "goal";
  return { args, kind };
}

/** /goal 文本 → `session/goal` action 面；set-over-existing 的 replace 收敛由 core 裁定。 */
export function goalActionFromArgs(args: string): {
  action: ZCodeSessionGoalAction;
  objective?: string;
} {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { action: "show" };
  const [first] = splitArgs(trimmed);
  const commandEnd = trimmed.search(/\s/);
  const rest = commandEnd === -1 ? "" : trimmed.slice(commandEnd + 1).trim();
  if (first === "pause" || first === "resume" || first === "clear") {
    return { action: first };
  }
  if (first === "replace") {
    return rest.length === 0
      ? { action: "replace" }
      : { action: "replace", objective: rest };
  }
  return { action: "set", objective: trimmed };
}

export interface AcpGoalCommandResult {
  response: string;
  startedTurn: boolean;
}

/** inputId 由调用方先生成：settlement 订阅必须先于 session/goal 发出（见下）。 */
export function newGoalInputId(): string {
  return `acp-goal-${randomUUID()}`;
}

export async function runGoalCommand(
  handle: Pick<AttachSessionHandle, "goalCommand">,
  args: string,
  inputId: string,
): Promise<AcpGoalCommandResult> {
  const { action, objective } = goalActionFromArgs(args);
  const result = await handle.goalCommand({
    action,
    ...(objective === undefined ? {} : { objective }),
    inputId,
  });
  return {
    response: goalResponseText(action, result.response),
    startedTurn: result.startedTurn === true,
  };
}

/**
 * core 对 pause 的成功刻意回空串（协议 lane 不想要无意义气泡），但 ACP 客户端没有
 * 目标面板——不补一行，用户会看到命令被吞。与 TUI lane 的本地 handler 文案同款。
 */
function goalResponseText(action: ZCodeSessionGoalAction, response: string): string {
  return action === "pause" && response.length === 0 ? "Goal paused." : response;
}

export async function runDwfCommand(
  handle: DwfHandle,
  args: string,
): Promise<string> {
  const [action = "list", runId] = splitArgs(args);
  if (action === "list") {
    const runs = await handle.listDynamicWorkflowRuns({ limit: DWF_LIST_LIMIT });
    return formatRunList(runs);
  }
  if (action === "cancel") {
    return await runDwfCancel(handle, runId);
  }
  if (action === "resume") {
    // 与 TUI lane 不同，这里不做客户端 workflow-mode 门：engine 开关是 core 的事实
    // （fail-closed），v4 命令的拒绝就是给用户的真话。
    if (!runId) return DWF_USAGE;
    const result = await handle.resumeWorkflowRun({ workId: runId });
    return result.ok
      ? `Resumed dynamic workflow run ${result.runId}.`
      : `Cannot resume ${runId}: ${describeResumeRejection(result.reason)} (${result.reason})${result.message === undefined ? "" : `\n${result.message}`}`;
  }
  return DWF_USAGE;
}

async function runDwfCancel(
  handle: DwfHandle,
  runId: string | undefined,
): Promise<string> {
  let targetRunId = runId;
  if (!targetRunId) {
    const runs = await handle.listDynamicWorkflowRuns({ limit: DWF_LIST_LIMIT });
    const target = resolveDwfCancelTarget(runs);
    if (target.kind === "none") return "No in-flight dynamic workflow runs to cancel.";
    if (target.kind === "ambiguous") {
      return [
        "Multiple in-flight dynamic workflow runs; pass the run id to cancel one:",
        ...target.inFlight.map((run) => `- ${formatRunLine(run)}`),
        "",
        "Usage: /dwf cancel <runId>",
      ].join("\n");
    }
    targetRunId = target.runId;
  }
  // runId ≡ taskId：与 TUI lane 同一条 session/cancelBackgroundTask 路径。
  const result = await handle.cancelBackgroundTask(targetRunId);
  if (!result.cancelled) {
    const reason = result.reason ? `: ${result.reason}` : ".";
    return `Could not cancel ${targetRunId} (${result.status})${reason}`;
  }
  return `Cancelled dynamic workflow run ${targetRunId}.`;
}

export const ACP_LOGIN_USAGE =
  "Usage: /login [zai-coding-plan|bigmodel-coding-plan|zai-coding-plan-api-key <api-key>|bigmodel-coding-plan-api-key <api-key>]";

function isLoginAbort(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * ACP 的 /login：与 command-center 同一套参数语法，但 ACP 的 stdout 是 NDJSON
 * 协议通道，URL 与结果只能经 agent_message_chunk 下发（emitLoginAuthorizeMessage
 * 的 assistant_message 事件 ACP projector 会丢）。浏览器由本进程（client 侧）打开；
 * OAuth init/poll 与凭据落盘全在共享 core。
 */
export async function runLoginCommand(input: {
  args: string;
  openBrowser?: (url: string) => Promise<ThinBrowserOpenResult>;
  request: ThinAuthRequest;
  send: (text: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const args = input.args.trim();
  if (args === "zai-coding-plan" || args === "bigmodel-coding-plan") {
    const providerId = args.startsWith("bigmodel") ? "bigmodel" : "zai";
    const providerName = providerId === "bigmodel" ? "BigModel" : "Z.AI";
    try {
      const result = await loginViaAttachProtocol({
        abortSignal: input.signal,
        openBrowser: input.openBrowser,
        providerId,
        request: input.request,
        onAuthorizeUrl: async (data) => {
          input.send(
            [
              `Open this URL to sign in with ${providerName}:`,
              "",
              data.authorize_url,
              "",
              "After authorization, return here and I will finish the login automatically.",
            ].join("\n"),
          );
        },
      });
      input.send(
        providerId === "zai"
          ? formatLoginResult(result)
          : formatProviderSetupResult({
              configPath: result.configPath,
              model: result.model,
              providerId,
            }),
      );
    } catch (error) {
      if (isLoginAbort(error)) throw error;
      input.send(loginFailureResponse(error));
    }
    return;
  }
  const apiKeyCommand = parseApiKeyLoginArgs(args);
  if (apiKeyCommand) {
    // apiKey 只透传给协议请求：usage/usage-error 文案与日志都不得回显密钥。
    if (!apiKeyCommand.apiKey) {
      input.send(`Usage: /login ${apiKeyCommand.kind} <api-key>`);
      return;
    }
    try {
      const result = await configureApiKeyViaAttachProtocol({
        apiKey: apiKeyCommand.apiKey,
        providerId: apiKeyCommand.providerId,
        request: input.request,
      });
      input.send(formatProviderSetupResult(result));
    } catch (error) {
      if (isLoginAbort(error)) throw error;
      input.send(loginFailureResponse(error));
    }
    return;
  }
  input.send(ACP_LOGIN_USAGE);
}

export async function runLogoutCommand(input: {
  request: ThinAuthRequest;
  send: (text: string) => void;
}): Promise<void> {
  try {
    const result = await logoutViaAttachProtocol({ request: input.request });
    input.send(`Logged out from Coding Plan accounts. Credentials: ${result.credentialsPath}`);
  } catch (error) {
    if (isLoginAbort(error)) throw error;
    input.send(loginFailureResponse(error));
  }
}

/** core 目录投影：自定义 prompt 命令 + 可调用技能（裸名与 qualifiedName 并存，bundled 已滤）。 */
export interface AcpSlashCatalog {
  commands: Array<{ argumentHint?: string; description: string; name: string }>;
  skills: SkillCatalogEntry[];
}

/** 展示/规范名：qualifiedName 优先，与 toTuiSkillSuggestions、command-center 同口径。 */
const skillDisplayName = (skill: SkillCatalogEntry): string =>
  skill.qualifiedName ?? skill.name;

const LOCAL_COMMANDS = [
  { description: "Show, set, replace, pause, resume or clear the session goal", name: "goal" },
  { description: "List, cancel or resume dynamic workflow runs", name: "dwf" },
  {
    description: "Sign in to a Coding Plan (Z.AI or BigModel) in the shared core",
    input: { hint: "[zai-coding-plan|bigmodel-coding-plan|…-api-key <key>]" },
    name: "login",
  },
  { description: "Remove the shared Coding Plan credentials", name: "logout" },
  { description: "Load a skill for this turn", input: { hint: "<skill-name> [task]" }, name: "skill" },
];
const RESERVED_LOCAL_NAMES = new Set(["goal", "target", "dwf", "login", "logout", "skill"]);

/**
 * core 保留名（bootstrap slash-command-surface 的同一集合）：内置命令词表 +
 * aliases + composer 本地名 compress/plan。瘦包不能依赖 bootstrap，这里由
 * @zcode/shared 的内置词表派生同一口径；extras 若变需与 bootstrap 同步。
 */
const CORE_RESERVED_SLASH_NAMES = new Set(
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.flatMap((entry) => [
    entry.name,
    ...(entry.aliases ?? []),
  ]).concat(["compress", "plan"]),
);

/** 命令词归一化：小写 + 去多余 `/` 前缀，与 bootstrap normalizeZCodeSlashCommandName 同款。 */
const normalizeSlashName = (name: string): string =>
  name.trim().replace(/^\/+/, "").toLowerCase();

const isReservedSlashName = (name: string): boolean =>
  CORE_RESERVED_SLASH_NAMES.has(normalizeSlashName(name));

/**
 * 广播给客户端的命令面：本地路由命令 + core 展开的自定义命令 + 技能直达名。
 * 同名时先到先得（本地 > 自定义 > 技能），与 prompt 路由顺序一致——广告的每一行
 * 都必须落到它描述的那条执行路径上。core 保留名（init/workflow/…）一律剔除：
 * 目录行不能接管内置语义，与 command-reference-catalog 的过滤同一份判定。
 * 同名判定按归一化词（issue #19）：路由全程小写（parseLocalSlashCommand /
 * resolveSkillInvocation / core normalizeCommandName），按原始大小写去重会让
 * 同词异写的目录行各拿一条广告，而路由只认一个赢家——输家行指向不可达路径。
 */
export function slashCommandsUpdate(catalog?: AcpSlashCatalog): SessionUpdate {
  const taken = new Set(RESERVED_LOCAL_NAMES);
  const shadowed = (name: string) =>
    taken.has(normalizeSlashName(name)) || isReservedSlashName(name);
  const availableCommands: Array<{
    description: string;
    input?: { hint: string };
    name: string;
  }> = [...LOCAL_COMMANDS];
  for (const command of catalog?.commands ?? []) {
    if (shadowed(command.name)) continue;
    taken.add(normalizeSlashName(command.name));
    availableCommands.push({
      description: command.description,
      name: command.name,
      ...(command.argumentHint ? { input: { hint: command.argumentHint } } : {}),
    });
  }
  for (const skill of catalog?.skills ?? []) {
    const name = skillDisplayName(skill);
    if (shadowed(name)) continue;
    taken.add(normalizeSlashName(name));
    availableCommands.push({
      description: `Skill: ${skill.description}`,
      input: { hint: "[task]" },
      name,
    });
  }
  return { availableCommands, sessionUpdate: "available_commands_update" };
}

/**
 * `/skill` 系输入的本地裁定：`forward` 维持 P005 原文转发（未识别的 slash 文本）；
 * `message` 是不进模型的可见回执（裸 /skill 的技能列表 / 目录不可用）；`prompt`
 * 是改写成 TUI 同款手动技能提示——core 不认识 `/skill`（command-center 本地命令，
 * 又是 facade 保留名），原文转发会让命令词以普通文本到达模型（issue #15）。
 */
export type AcpSkillResolution =
  | { kind: "forward" }
  | { kind: "message"; text: string }
  | { kind: "prompt"; text: string };

const SKILL_COMMAND_WORD = "skill";

export function resolveSkillInvocation(
  text: string,
  catalog?: AcpSlashCatalog,
): AcpSkillResolution {
  if (!text.startsWith("/")) return { kind: "forward" };
  const trimmed = text.trim();
  const commandEnd = trimmed.search(/\s/);
  // 命令词小写归一化：/goal、/dwf 的本地路由与 TUI parseSlashCommand 同款。
  const name = (
    commandEnd === -1 ? trimmed.slice(1) : trimmed.slice(1, commandEnd)
  ).toLowerCase();
  const rest = commandEnd === -1 ? "" : trimmed.slice(commandEnd + 1).trim();
  const skills = catalog?.skills ?? [];
  if (name === SKILL_COMMAND_WORD) {
    const argEnd = rest.search(/\s/);
    const skillName = argEnd === -1 ? rest : rest.slice(0, argEnd);
    const task = argEnd === -1 ? "" : rest.slice(argEnd + 1);
    if (skillName.length === 0) {
      // TUI 同款：裸 /skill 列出可用技能，不给模型。
      return { kind: "message", text: formatAcpSkillList(catalog) };
    }
    // 恒改写（TUI 从不校验目录）：命中用展示名改写——既校正大小写兜底命中，
    // 也锁定 resolver 会选中的同一条目；未命中或目录缺席按原词改写，由 Skill
    // 工具 resolver 裁定。目录只是展示投影（bundled 被刻意过滤、会话冻结、
    // 展示名去重藏裸名），不是可解析全集——本地回执 Unknown 会把可解析名
    // 误报成未知（issue #27、#28）；真缺失由 resolver 的 Skill not found
    // 在轮内报出。
    const match = catalog ? findCatalogSkill(skills, skillName) : undefined;
    return {
      kind: "prompt",
      text: buildManualSkillPrompt(match ? skillDisplayName(match) : skillName, task),
    };
  }
  if (!catalog || skills.length === 0) return { kind: "forward" };
  // 直达名不接管 core 保留名（/init、/workflow 由 facade 内置展开，其余保留名维持
  // P005 原文转发），也不抢同名的自定义命令（facade 展开优先）。
  if (isReservedSlashName(name)) return { kind: "forward" };
  const match = findCatalogSkill(skills, name);
  if (!match) return { kind: "forward" };
  if (catalog.commands.some((command) => command.name.toLowerCase() === name)) {
    return { kind: "forward" };
  }
  return { kind: "prompt", text: buildManualSkillPrompt(skillDisplayName(match), rest) };
}

/**
 * 命中判定与 Skill 工具 resolver 同口径（issue #24）：name 或 qualifiedName
 * 精确命中、目录序首个胜出——同名歧义沿用 first-match，不另设错误路径；再按
 * 展示名小写兜底。改写用命中项的展示名，锁定 resolver 会选中的同一条目。
 */
function findCatalogSkill(
  skills: AcpSlashCatalog["skills"],
  input: string,
): AcpSlashCatalog["skills"][number] | undefined {
  const lowered = input.toLowerCase();
  return (
    skills.find((skill) => skill.name === input || skill.qualifiedName === input) ??
    skills.find(
      (skill) =>
        skill.name.toLowerCase() === lowered ||
        skill.qualifiedName?.toLowerCase() === lowered,
    )
  );
}

function formatAcpSkillList(catalog?: AcpSlashCatalog): string {
  if (!catalog) {
    return "The skill list is unavailable for this session. Invoke a skill by name: /skill <name> [task].";
  }
  const skills = catalog.skills;
  if (skills.length === 0) return "No skills found for this session.";
  return [
    `Available skills (${skills.length}):`,
    ...skills.map((skill) => {
      const displayName = skillDisplayName(skill);
      const alias = displayName !== skill.name ? ` (alias ${skill.name})` : "";
      return `- ${displayName}${alias}: ${skill.description}`;
    }),
    "",
    "Use /skill <name> [task] to load one.",
  ].join("\n");
}

export interface TurnSettlementWatch {
  /** "completed" = 第一轮收口（turn_end 或 no-turn 兜底）；"aborted" = signal 触发或 dispose。 */
  promise: Promise<"aborted" | "completed">;
  /** 未 settle 就放弃等待时调用，注销 sink 与计时器防泄漏。 */
  dispose(): void;
}

export interface TurnSettlementOptions {
  /**
   * no-turn 兜底：core 的 `startedTurn` 只是启动前置检查，续跑命令入队后仍可能
   * 直接空手而归（让位 pending 命令、目标已变、prepare boundary 抛错——这些路径
   * 不发任何 turn 事件）。超过此时长仍未见到 turn_started(ours) 就按已完成收口，
   * 不让 ACP prompt 永久挂起；真实 turn 启动只需亚秒到秒级，30s 极少误伤，
   * 误伤后果也只是提前返回 end_turn（该轮照常作为后台更新流给客户端）。
   */
  noTurnStartTimeoutMs?: number;
}

/**
 * 监听 goal 续跑第一轮的收口：turn_complete / turn_error 的 payload 都带 inputId，
 * 同一续跑循环的后续轮同 id（core 约定），但 prompt 请求只等第一轮——TUI 也不阻塞
 * 整个 goal 循环，后续轮作为普通 session/update 继续流给客户端。
 *
 * 必须在 session/goal 发出**之前**订阅：续跑轮可能在 op 回包之前就快速失败收口，
 * 事后订阅会把 ACP prompt 卡成永不返回。一旦见到 turn_started(ours)，其收口必然
 * 有 turn_complete/turn_error（cancelled 也是 complete），此后不再受兜底计时约束。
 */
export function watchTurnSettlement(
  handle: Pick<AttachSessionHandle, "addSink">,
  inputId: string,
  signal?: AbortSignal,
  options?: TurnSettlementOptions,
): TurnSettlementWatch {
  let resolve!: (outcome: "aborted" | "completed") => void;
  const promise = new Promise<"aborted" | "completed">((res) => {
    resolve = res;
  });
  const finish = (outcome: "aborted" | "completed"): void => {
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
    clearTimeout(noTurnTimer);
    resolve(outcome);
  };
  const onAbort = (): void => finish("aborted");
  const unsubscribe = handle.addSink((event) => {
    if (event.type === "turn_started") {
      const payload = event.payload as { inputId?: string } | undefined;
      if (payload?.inputId === inputId) clearTimeout(noTurnTimer);
      return;
    }
    if (event.type !== "turn_complete" && event.type !== "turn_error") return;
    const payload = event.payload as { inputId?: string } | undefined;
    if (payload?.inputId !== inputId) return;
    finish("completed");
  });
  const noTurnTimer = setTimeout(() => finish("completed"), options?.noTurnStartTimeoutMs ?? 30_000);
  // node 计时器不阻塞退出。
  (noTurnTimer as { unref?: () => void }).unref?.();
  if (signal) {
    if (signal.aborted) {
      finish("aborted");
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    promise,
    dispose: () => finish("aborted"),
  };
}
