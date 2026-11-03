// "stop & quit" 的显式 stop 上达口：attach 退出时 socket 先行关闭会让
// fire-and-forget 的 v4 stop 落不了线，所以必须发请求并等有界回执。
// stop 本身是尽力而为：client 已关闭、请求失败、ack 超时都不阻塞退出路径。
// 走 v4/command stop（session/stop 对 v4 起的 turn 不持有 abort controller，
// 是空操作；v4 stop 经 runtime 前台执行收口，同时覆盖旧路径起的 turn）。
import type { AttachClient } from "./attach-client.js";
import { stopCommand } from "./attach-v4-command.js";

/** v4 stop 回执等待上界：超时照常退出，退出不被停 turn 阻塞。 */
const STOP_ACTIVE_TURN_ACK_TIMEOUT_MS = 1_500;

export async function requestSessionStopBestEffort(
  clientOf: () => AttachClient,
  sessionId: string,
): Promise<void> {
  let client: AttachClient;
  try {
    client = clientOf();
  } catch {
    return;
  }
  // unref：ack 先到时残留的定时器不能拖住退出——zcode-attach 靠事件循环
  // 排空退出（process.exitCode），ref 住的 timer 会让进程白挂到超时。
  await Promise.race([
    stopCommand(client, { sessionId }).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, STOP_ACTIVE_TURN_ACK_TIMEOUT_MS).unref()),
  ]);
}
