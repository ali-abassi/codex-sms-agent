import type { InboundMessage } from "./domain/message.js";
import type { InboundJob, StateStore, EnqueueSource } from "./state/store.js";
import { controlCommandFor } from "./worker.js";
import { normalizeReceiveWebhook } from "./sendblue/normalize.js";
import type { Logger } from "./log.js";
import type { WebhookDisposition } from "./http/server.js";

export type IngestionOptions = {
  store: StateStore;
  sendblueNumber: string;
  allowedPhones: ReadonlySet<string>;
  activeAfter: number;
  logger: Logger;
  now?: () => number;
  /**
   * Invoked for bare control commands (/clear, /restart, ...). The job is
   * completed synchronously before this fires, so it never queues behind a
   * long Codex turn and the worker never sees it.
   */
  onControl?: (job: InboundJob) => void;
};

export class IngestionService {
  readonly #options: IngestionOptions;
  readonly #now: () => number;

  constructor(options: IngestionOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  ingestWebhook(payload: unknown): WebhookDisposition {
    const message = normalizeReceiveWebhook(payload);
    return this.ingest(message, "webhook");
  }

  ingest(message: InboundMessage, source: EnqueueSource): WebhookDisposition {
    if (
      message.sendblueNumber !== this.#options.sendblueNumber ||
      !this.#options.allowedPhones.has(message.fromNumber)
    ) {
      this.#options.logger.warn("message_ignored", {
        handle: message.handle,
        reason: "allowlist",
      });
      return "ignored";
    }
    if (message.groupId.trim().length > 0) {
      this.#options.logger.info("message_ignored", { handle: message.handle, reason: "group_chat" });
      return "ignored";
    }
    if (source === "reconcile" && message.dateSent < this.#options.activeAfter) {
      return "ignored";
    }
    if (!message.content.trim() && !message.mediaUrl) return "ignored";

    const now = this.#now();
    const result = this.#options.store.enqueue(message, source, now);
    // A duplicate from the poller is the overlap window working as designed, not news.
    // Keep webhook duplicates at info, since those can mean redelivery worth noticing.
    const duplicateLevel = source === "reconcile" ? "debug" : "info";
    this.#options.logger[result.inserted ? "info" : duplicateLevel](
      result.inserted ? "message_queued" : "message_duplicate",
      { handle: message.handle, source },
    );
    if (!result.inserted) return "duplicate";
    if (this.#options.onControl && controlCommandFor(message.content)) {
      if (this.#options.store.completePending(result.job.id, now)) this.#options.onControl(result.job);
    }
    return "queued";
  }
}
