import type { SessionEvent } from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeSessionEventsResultSchema,
  zcodeSessionMessagesResultSchema,
  zcodeSessionSubscribeResultSchema,
  type ZCodeSessionRawEvent,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import type { TuiSubagentTranscriptSnapshot, TuiSubmitPromptResult } from "@zcode/tui";
import type { AttachClient } from "./attach-client.js";
import { projectAttachTranscriptMessages } from "./attach-projection.js";

function reviveRawEvent(raw: ZCodeSessionRawEvent): SessionEvent {
  return { ...raw, timestamp: new Date(raw.timestamp) } as unknown as SessionEvent;
}

/** core owns event order; this handle only tracks delivery and the replay cursor. */
export class AttachSessionHistory {
  private lastSeq = 0;
  /** undefined=实时；null=断线；数组=当前补放请求在途。 */
  private rawRecoveryEvents: ZCodeSessionRawEvent[] | null | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly clientOf: () => AttachClient,
    private readonly dispatch: (event: SessionEvent) => void,
    private readonly adoptSnapshot: (snapshot: ZCodeSessionStateSnapshot) => void,
  ) {}

  get eventSeq(): number {
    return this.lastSeq;
  }

  /** raw wire event → revive timestamp → 分发。 */
  ingestRawEvent(raw: ZCodeSessionRawEvent): void {
    if (typeof raw.sequenceNumber === "number" && raw.sequenceNumber > this.lastSeq) {
      this.lastSeq = raw.sequenceNumber;
    }
    this.dispatch(reviveRawEvent(raw));
  }

  receiveLiveRawEvent(raw: ZCodeSessionRawEvent): void {
    if (this.rawRecoveryEvents !== undefined) {
      this.rawRecoveryEvents?.push(raw);
    } else {
      this.ingestRawEvent(raw);
    }
  }

  pauseRawDelivery(): void {
    this.rawRecoveryEvents = null;
  }

  get needsRawRecovery(): boolean {
    return this.rawRecoveryEvents !== undefined;
  }

  /** subscribe/续订：raw 格式 afterSeq 用 SessionEvent.sequenceNumber。 */
  async subscribe(afterSeq?: number, includeSnapshot = false): Promise<void> {
    const result = zcodeSessionSubscribeResultSchema.parse(
      await this.clientOf().request(zcodeProtocolMethods.sessionSubscribe, {
        afterSeq,
        deliveryKind: "desktop-continuous",
        eventFormat: "raw",
        includeSnapshot,
        sessionId: this.sessionId,
      }),
    );
    if (result.snapshot) this.adoptSnapshot(result.snapshot);
    if (result.eventSeq > this.lastSeq) this.lastSeq = result.eventSeq;
    for (const raw of result.rawEvents ?? []) this.ingestRawEvent(raw);
  }

  /** 中间页之后 core 仍暂停实时流；最后一页回包和实时事件可能在同一个 socket chunk。 */
  async resubscribe(client: AttachClient): Promise<void> {
    const pending: ZCodeSessionRawEvent[] = [];
    this.rawRecoveryEvents = pending;
    try {
      for (;;) {
        const afterSeq = this.lastSeq;
        const page = zcodeSessionSubscribeResultSchema.parse(
          await client.request(zcodeProtocolMethods.sessionSubscribe, {
            afterSeq,
            boundedRawReplay: true,
            deliveryKind: "desktop-continuous",
            eventFormat: "raw",
            includeSnapshot: false,
            sessionId: this.sessionId,
          }),
        );
        if (this.rawRecoveryEvents !== pending) throw new Error("Raw replay connection changed");
        const events = page.rawEvents ?? [];
        let lastSeq = afterSeq;
        for (const event of events) {
          if (
            event.sessionId !== this.sessionId ||
            event.sequenceNumber <= lastSeq ||
            event.sequenceNumber > page.eventSeq
          ) {
            throw new Error("Raw replay events are out of order or outside the page cursor");
          }
          lastSeq = event.sequenceNumber;
        }
        if (
          page.sessionId !== this.sessionId ||
          (page.rawReplayHasMore && (lastSeq === afterSeq || lastSeq !== page.eventSeq))
        ) {
          throw new Error("Raw replay page has an invalid continuation cursor");
        }
        for (const event of events) this.ingestRawEvent(event);
        this.lastSeq = page.eventSeq;
        if (!page.rawReplayHasMore) {
          this.rawRecoveryEvents = undefined;
          for (const event of pending) {
            if (event.sequenceNumber === 0 || event.sequenceNumber > page.eventSeq) {
              this.ingestRawEvent(event);
            }
          }
          return;
        }
        pending.length = 0;
      }
    } finally {
      if (this.rawRecoveryEvents === pending) this.pauseRawDelivery();
    }
  }

  async readSubagentTranscript(
    childSessionId: string,
  ): Promise<TuiSubagentTranscriptSnapshot> {
    // 子会话 record 由父 session 的同一 core 承载；直接用 childSessionId 读
    // messages + raw events，客户端拼 TuiSubagentTranscriptSnapshot。
    const [messagesResult, eventsResult] = await Promise.all([
      this.clientOf().request(zcodeProtocolMethods.sessionMessages, {
        sessionId: childSessionId,
      }),
      this.clientOf().request(zcodeProtocolMethods.sessionEvents, {
        eventFormat: "raw",
        sessionId: childSessionId,
      }),
    ]);
    const messages = zcodeSessionMessagesResultSchema.parse(messagesResult).messages;
    const rawEvents =
      zcodeSessionEventsResultSchema.parse(eventsResult).rawEvents ?? [];
    const events = rawEvents.map(reviveRawEvent);
    return {
      events,
      messages: messages.map((message) => ({
        content: "",
        id: message.info.messageId,
        parts: message.parts as never,
        role: (message.info.role === "user" ? "user" : "agent") as "user" | "agent",
      })),
      replayMessageIds: [],
      sequenceNumber: rawEvents.at(-1)?.sequenceNumber ?? 0,
      sessionId: childSessionId,
    };
  }

  async loadSessionTranscript(): Promise<
    NonNullable<TuiSubmitPromptResult["restoredMessages"]>
  > {
    const result = zcodeSessionMessagesResultSchema.parse(
      await this.clientOf().request(zcodeProtocolMethods.sessionMessages, {
        sessionId: this.sessionId,
      }),
    );
    return projectAttachTranscriptMessages(result.messages);
  }
}
