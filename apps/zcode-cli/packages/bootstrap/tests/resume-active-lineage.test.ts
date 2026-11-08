// `session/resume` 活跃 record 快路径的血缘校验回归（3.17.2 sync）：
// 上游 3.17.2 起在 lifecycle 恢复路径以 validateSessionActivationWorkspace
// 校验显式 workspace 的会话血缘（ready 实例不豁免）；fork 的快路径先于
// initialize 返回，若不自行校验就会成为该校验的旁路——错误 workspace 的
// resume 会收养别人的活跃实例并写入 compactContextWindow cap。
// 回归：不匹配 → project.session-lineage-invalid 且不写 cap；匹配/缺省 → 直通。
import { describe, expect, it, vi } from "vitest";
import { activateSessionForResume } from "../src/zcode-protocol/server-operations.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";
import type { SessionId } from "@zcode/contracts";

const SESSION_ID = "sess_active_lineage" as SessionId;
const WORKSPACE = {
  workspacePath: "/workspace/lineage",
  workspaceKey: "/workspace/lineage",
  workspaceIdentity: "ws-identity-a",
};

function makeHarness() {
  const setCap = vi.fn();
  const record = {
    workspace: { ...WORKSPACE },
    app: { runtime: { setCompactContextWindowCap: setCap } },
  } as unknown as ZCodeProtocolSessionRecord;
  const context = {
    sessions: new Map([[SESSION_ID, record]]),
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, record, setCap };
}

describe("activateSessionForResume 活跃 record 快路径", () => {
  it("workspace 不匹配时拒绝且不写 compactContextWindow cap", async () => {
    const { context, setCap } = makeHarness();
    await expect(
      activateSessionForResume(context, {
        sessionId: SESSION_ID,
        workspace: { ...WORKSPACE, workspacePath: "/other", workspaceKey: "/other" },
        compactContextWindow: 262000,
      }),
    ).rejects.toThrow("project.session-lineage-invalid");
    expect(setCap).not.toHaveBeenCalled();
  });

  it("仅 workspaceIdentity 不同同样拒绝（key 相同不代表血缘相同）", async () => {
    const { context, setCap } = makeHarness();
    await expect(
      activateSessionForResume(context, {
        sessionId: SESSION_ID,
        workspace: { ...WORKSPACE, workspaceIdentity: "ws-identity-b" },
        compactContextWindow: 262000,
      }),
    ).rejects.toThrow("project.session-lineage-invalid");
    expect(setCap).not.toHaveBeenCalled();
  });

  it("workspace 匹配时直通并应用 cap", async () => {
    const { context, setCap } = makeHarness();
    const activated = await activateSessionForResume(context, {
      sessionId: SESSION_ID,
      workspace: WORKSPACE,
      compactContextWindow: 262000,
    });
    expect(activated.record).toBeDefined();
    expect(setCap).toHaveBeenCalledWith(262000);
  });

  it("workspace 缺省（旧协议）保持直通", async () => {
    const { context, setCap } = makeHarness();
    await activateSessionForResume(context, {
      sessionId: SESSION_ID,
      compactContextWindow: 262000,
    });
    expect(setCap).toHaveBeenCalledWith(262000);
  });
});
