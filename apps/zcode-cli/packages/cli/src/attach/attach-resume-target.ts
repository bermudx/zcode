import { zcodeProtocolMethods } from "@zcode/shared";
import type { AttachClient } from "./attach-client.js";

/**
 * 解析 resume 目标（入口 -c/--resume 与 TUI 内 /resume <id> 共用同一裁决；
 * TUI 裸 /resume 由 commandCenter 的 session picker 承担，不走这里）：
 *   - 无 resume 意图 → undefined（调用方走 session/create，开新会话）
 *   - --resume <id>   → 完整 id；或本 workspace 内唯一匹配的 id 前缀
 *   - -c/--continue   → 本 workspace 最近一次会话
 *
 * “最近”按 updatedAt（退化 createdAt）显式取最大：server 的 session/list 返回
 * 顺序不保证（实测创建序/任意序混排），取末位会恢复到陈旧会话。
 *
 * 显式意图不静默降级：--resume 解析出多个候选、-c 列不出会话、或
 * session/list 本身失败，都直接抛错（stderr + exit 1），不再无声开新会话
 * ——操作者截断 id 恢复时曾因此进到空会话而毫无提示。
 */
interface ListedResumeSession {
  createdAt?: number;
  sessionId?: string;
  id?: string;
  updatedAt?: number;
}

const toListedResumeSessions = (listed: unknown): ListedResumeSession[] => {
  const wrapped = (listed ?? {}) as { sessions?: unknown };
  return Array.isArray(wrapped.sessions) ? (wrapped.sessions as ListedResumeSession[]) : [];
};

const listedResumeSessionId = (session: ListedResumeSession): string | undefined =>
  session.sessionId ?? session.id;

const listWorkspaceSessionsForResume = async (
  client: AttachClient,
  workspace: { workspacePath: string; workspaceIdentity?: string; workspaceKey: string },
): Promise<ListedResumeSession[]> => {
  const listed = await client.request(zcodeProtocolMethods.sessionList, { workspace });
  return toListedResumeSessions(listed);
};

/** “最近会话”裁决（入口 -c 与 resumeApp 的 continue 兜底共用；TUI 裸
 *  /resume 已改走 picker，不再猜最新）：按 updatedAt（退化 createdAt）
 *  显式取最大；空列表 / 首名无 id 抛显式错误，不静默降级。 */
export function pickMostRecentResumeSessionId(
  sessions: ListedResumeSession[],
  workspacePath: string,
): string {
  const byRecency = [...sessions].sort(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
  );
  const last = byRecency[0];
  const lastId = last === undefined ? undefined : listedResumeSessionId(last);
  if (lastId === undefined) {
    throw new Error(`No resumable session found for ${workspacePath}`);
  }
  return lastId;
}

export const resolveAttachResumeTarget = async ({
  client,
  continueSession,
  resumeSessionId,
  workspace,
}: {
  client: AttachClient;
  continueSession: boolean;
  resumeSessionId?: string;
  workspace: { workspacePath: string; workspaceIdentity?: string; workspaceKey: string };
}): Promise<string | undefined> => {
  if (!continueSession && !resumeSessionId) return undefined;
  if (resumeSessionId) {
    // --resume 支持本 workspace 内唯一匹配的 id 前缀（截断 id 是真实使用形
    // 态：sess_99f180d5 这样的短前缀曾被静默换成新会话）。列表失败不阻断：
    // 原样透传，由 session/resume 的错误浮出真相（可能是跨 workspace 完整 id）。
    const sessions = await listWorkspaceSessionsForResume(client, workspace).catch(
      () => undefined,
    );
    if (sessions !== undefined) {
      const ids = sessions
        .map(listedResumeSessionId)
        .filter((id): id is string => typeof id === "string");
      if (ids.includes(resumeSessionId)) return resumeSessionId;
      const prefixed = ids.filter((id) => id.startsWith(resumeSessionId));
      if (prefixed.length === 1) return prefixed[0];
      if (prefixed.length > 1) {
        throw new Error(
          `--resume "${resumeSessionId}" is ambiguous: matches ${prefixed.length} sessions (${prefixed
            .slice(0, 5)
            .join(", ")}${prefixed.length > 5 ? ", …" : ""}). Use a longer prefix or the full id.`,
        );
      }
    }
    return resumeSessionId;
  }
  // -c：显式继续意图。列表失败或空列表都报错，与主 CLI 的
  // “No resumable session found” 同语义，不再静默开新会话。
  const sessions = await listWorkspaceSessionsForResume(client, workspace).catch(
    (error: unknown) => {
      throw new Error(
        `--continue could not list sessions for ${workspace.workspacePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  );
  return pickMostRecentResumeSessionId(sessions, workspace.workspacePath);
};
