// "stop & quit" 的显式 stop 上达口：attach 退出时 socket 先行关闭会让
// fire-and-forget 的 session/stop 落不了线，所以必须发请求并等有界回执。
// stop 本身是尽力而为：client 已关闭、请求失败、ack 超时都不阻塞退出路径。
import { zcodeProtocolMethods } from "@zcode/shared";
import type { AttachClient } from "./attach-client.js";

/** sessionStop 回执等待上界：超时照常退出，退出不被停 turn 阻塞。 */
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
  await Promise.race([
    client.request(zcodeProtocolMethods.sessionStop, { sessionId }).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, STOP_ACTIVE_TURN_ACK_TIMEOUT_MS)),
  ]);
}
