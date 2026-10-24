// 子代理目录：`store.state.subagents` 的唯一 owner。React 端
// `useSubagents`（packages/tui/src/app-subagents.ts）的目录部分移植——
// dirty + in-flight 去重循环、epoch（reset/dispose 递增）与父会话守卫；
// 转写下钻（open/transcript）不在本模块范围。

import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { changesSubagentDirectory, type TuiOptions } from "@zcode/tui/internals";
import type { AppStore } from "./store.js";

export class SubagentDirectory {
  private generation = 0;
  private inflight: Promise<void> | undefined;
  private dirty = false;

  constructor(
    private readonly store: AppStore,
    private readonly options: Pick<TuiOptions, "readSubagents" | "getMainSessionId">,
  ) {}

  /**
   * 与 useSubagents.onEvent 同规约：目录事件触发 refresh；ToolCallResult
   * 只认主会话（subagent 工具镜像已由 changesSubagentDirectory 剥离，剩下
   * 的是父会话与兄弟子会话的真实结果——兄弟会话的细粒度结果不刷新目录）。
   */
  handleEvent(event: SessionEvent): void {
    if (!changesSubagentDirectory(event)) return;
    if (
      event.type === SessionEventType.ToolCallResult &&
      event.sessionId !== this.options.getMainSessionId?.()
    ) {
      return;
    }
    this.refresh();
  }

  refresh(): void {
    const readSubagents = this.options.readSubagents;
    if (!readSubagents) return;
    this.dirty = true;
    if (this.inflight) return;
    const epoch = this.generation;
    const parentId = this.options.getMainSessionId?.();
    this.inflight = (async () => {
      while (this.dirty && epoch === this.generation) {
        this.dirty = false;
        try {
          const snapshot = await readSubagents();
          // epoch 守卫挡 reset/dispose；父会话守卫挡 attach 端会话切换后
          // 才落地的旧目录。
          if (epoch !== this.generation || parentId !== this.options.getMainSessionId?.())
            return;
          this.store.set("subagents", snapshot);
          this.store.set("subagentsError", undefined);
        } catch (cause) {
          if (epoch === this.generation) this.store.set("subagentsError", String(cause));
        }
      }
    })().finally(() => {
      if (epoch !== this.generation) return;
      this.inflight = undefined;
      // 循环退出后到 finally 之间仍可能被判脏：保住最后这次刷新请求。
      if (this.dirty) this.refresh();
    });
  }

  /** 会话投影重置：清空目录并让在途快照失效，随后立即拉新会话目录。 */
  reset(): void {
    this.generation += 1;
    this.inflight = undefined;
    this.dirty = false;
    this.store.set("subagents", undefined);
    this.store.set("subagentsError", undefined);
    this.refresh();
  }

  dispose(): void {
    this.generation += 1;
  }
}
