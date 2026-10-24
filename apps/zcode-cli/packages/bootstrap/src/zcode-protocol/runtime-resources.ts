import type { ZCodeApp } from "../app/types.js";
import type { ZCodeProtocolAgentDependencies } from "./server-types.js";

/** 持有 app 资源而非业务 session；临时 workspace app、尚未登记的 app 也归此 owner。 */
export class ProtocolRuntimeResources {
  private stopping = false;
  private readonly apps = new Set<ZCodeApp>();
  private closePromise?: Promise<void>;

  constructor(private readonly factory: ZCodeProtocolAgentDependencies["createZCodeApp"]) {}

  readonly create: ZCodeProtocolAgentDependencies["createZCodeApp"] = async (options) => {
    this.assertServing();
    const app = await this.factory(options);
    const originalClose = app.close?.bind(app);
    let closing: Promise<void> | undefined;
    app.close = () => {
      closing ??= Promise.resolve().then(async () => {
        try {
          await originalClose?.();
        } finally {
          this.apps.delete(app);
        }
      });
      return closing;
    };
    this.apps.add(app);
    if (this.stopping) {
      // create 在 EOF 前开始、EOF 后返回时不能重新成为可用 session，也不能遗失资源。
      await this.stopApp(app);
      this.assertServing();
    }
    return app;
  };

  assertServing(): void {
    if (this.stopping) throw new Error("ZCode Protocol runtime is stopping");
  }

  /**
   * session 被新连接收养时 app 归属随 record 转移：untrack 只是从本 owner 的
   * shutdown 清扫集中摘除（不关 app），再由收养方 adopt 进自己的资源集。
   * app.close 的包装修饰仍指向原 owner 的 apps.delete，幂等无副作用。
   */
  untrack(app: ZCodeApp): void {
    this.apps.delete(app);
  }

  adopt(app: ZCodeApp, onError?: (error: unknown) => void): void {
    // 收养方已在 shutdown：app 不能无人认领，直接停掉（与 create 的 stopping
    // 分支同语义）。stopApp 的拒绝经 onError 上抛，不形成 unhandled rejection。
    if (this.stopping) {
      void this.stopApp(app).catch((error) => onError?.(error));
      return;
    }
    this.apps.add(app);
  }

  close(): Promise<void> {
    this.stopping = true;
    this.closePromise ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.apps].map((app) => this.stopApp(app)));
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Protocol apps shutdown failed");
    });
    return this.closePromise;
  }

  private async stopApp(app: ZCodeApp): Promise<void> {
    try {
      app.runtime.beginShutdown();
      app.runtime.stopActiveForegroundExecution?.({ reason: "Protocol runtime stopping" });
    } finally {
      await app.close?.();
    }
  }
}
