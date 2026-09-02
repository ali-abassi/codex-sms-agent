import type { StateStore } from "./state/store.js";
import type { SendblueClient } from "./sendblue/client.js";
import type { IngestionService } from "./ingest.js";
import type { Logger } from "./log.js";

const WATERMARK_KEY = "reconcile.updated_at";
const OVERLAP_MS = 2 * 60_000;
const MAX_PAGES = 10;
/**
 * A poll that finds nothing logs at debug, which is off by default — so a healthy poller
 * is silent, and silence is indistinguishable from a dead one. Emit one info line every
 * this many quiet polls so liveness is visible in the log without flooding it.
 */
const QUIET_HEARTBEAT_POLLS = 30;

export type ReconcilerOptions = {
  store: StateStore;
  sendblue: Pick<SendblueClient, "listMessages">;
  ingestion: IngestionService;
  sendblueNumber: string;
  activeAfter: number;
  logger: Logger;
  now?: () => number;
};

function rawUpdatedAt(raw: unknown, fallback: number): number {
  if (typeof raw !== "object" || raw === null) return fallback;
  const value = (raw as Record<string, unknown>).date_updated;
  if (typeof value !== "string") return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

export type ReconcilerStatus = {
  /** Last poll that completed without throwing. */
  lastSuccessAt?: string;
  /** Consecutive failures since the last success. */
  consecutiveFailures: number;
  /** Polls in a row that found nothing; this is the normal idle state. */
  quietPolls: number;
};

export class Reconciler {
  readonly #options: ReconcilerOptions;
  readonly #now: () => number;
  #running = false;
  #consecutiveFailures = 0;
  #lastSuccessAt: number | undefined;
  #quietPolls = 0;

  constructor(options: ReconcilerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Liveness of the inbound poller, for /health. */
  status(): ReconcilerStatus {
    return {
      ...(this.#lastSuccessAt === undefined ? {} : { lastSuccessAt: new Date(this.#lastSuccessAt).toISOString() }),
      consecutiveFailures: this.#consecutiveFailures,
      quietPolls: this.#quietPolls,
    };
  }

  async run(): Promise<{ fetched: number; queued: number }> {
    if (this.#running) return { fetched: 0, queued: 0 };
    this.#running = true;
    try {
      const stored = this.#options.store.getMetadata(WATERMARK_KEY);
      const storedMs = stored ? Date.parse(stored) : Number.NaN;
      const start = Number.isFinite(storedMs)
        ? Math.max(this.#options.activeAfter, storedMs - OVERLAP_MS)
        : this.#options.activeAfter;
      let offset = 0;
      let fetched = 0;
      let queued = 0;
      let newest = start;

      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
        const page = await this.#options.sendblue.listMessages({
          isOutbound: false,
          sendblueNumber: this.#options.sendblueNumber,
          updatedAtGte: new Date(start).toISOString(),
          orderBy: "updatedAt",
          orderDirection: "asc",
          limit: 100,
          offset,
        });
        fetched += page.messages.length;
        for (const message of page.messages) {
          if (this.#options.ingestion.ingest(message, "reconcile") === "queued") queued += 1;
          // A provider row with a far-future timestamp must not skip later messages.
          newest = Math.min(this.#now(), Math.max(newest, rawUpdatedAt(message.raw, message.dateSent)));
        }
        if (!page.pagination.hasMore || page.messages.length === 0) break;
        offset += page.pagination.limit;
      }

      const committed = Math.max(newest, this.#now() - OVERLAP_MS);
      this.#options.store.setMetadata(WATERMARK_KEY, new Date(committed).toISOString(), this.#now());
      if (this.#consecutiveFailures > 0) {
        this.#options.logger.info("reconcile_recovered", { afterFailures: this.#consecutiveFailures });
        this.#consecutiveFailures = 0;
      }
      this.#lastSuccessAt = this.#now();
      const quiet = fetched === 0 && queued === 0;
      this.#quietPolls = quiet ? this.#quietPolls + 1 : 0;
      this.#options.logger[quiet ? "debug" : "info"]("reconcile_complete", { fetched, queued });
      // Periodic proof of life while idle. Without it, "no reconcile lines" reads as a dead
      // poller when it is in fact the normal state, and a genuinely dead one looks the same.
      if (quiet && this.#quietPolls % QUIET_HEARTBEAT_POLLS === 0) {
        this.#options.logger.info("reconcile_alive", { quietPolls: this.#quietPolls });
      }
      return { fetched, queued };
    } catch (error) {
      this.#consecutiveFailures += 1;
      // First failure is an error; repeats are coalesced to one line every 30 polls.
      const level = this.#consecutiveFailures === 1 ? "error"
        : this.#consecutiveFailures % 30 === 0 ? "warn" : "debug";
      this.#options.logger[level]("reconcile_failed", { error, consecutiveFailures: this.#consecutiveFailures });
      throw error;
    } finally {
      this.#running = false;
    }
  }
}
