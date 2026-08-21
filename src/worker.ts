import { realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { InboundJob, StateStore } from "./state/store.js";
import { threadKey } from "./domain/message.js";
import { CodexRunnerError, type CodexRunner, type CodexTurnResult } from "./codex/runner.js";
import { finalEnvelopeSchema, type FinalEnvelope } from "./codex/protocol.js";
import { isTransientSendblueError } from "./sendblue/client.js";
import { downloadInboundMedia } from "./media.js";
import type { Logger } from "./log.js";

export type AcceptedSend = { messageHandle?: string; status?: string };

export type MessagingPort = {
  markRead(input: { number: string; fromNumber: string }): Promise<unknown>;
  setTyping(input: {
    number: string;
    fromNumber: string;
    state: "start" | "stop";
    maxDurationMs?: number;
  }): Promise<unknown>;
  sendDirect(input: {
    number: string;
    fromNumber: string;
    content?: string;
    mediaUrl?: string;
  }): Promise<AcceptedSend>;
  sendReaction(input: {
    fromNumber: string;
    messageHandle: string;
    reaction: string;
    partIndex?: number;
  }): Promise<unknown>;
  sendCarousel(input: {
    number: string;
    fromNumber: string;
    mediaUrls: string[];
  }): Promise<AcceptedSend>;
  uploadFile(path: string): Promise<{ mediaUrl: string }>;
};

export type AgentWorkerOptions = {
  store: StateStore;
  codex: Pick<CodexRunner, "run"> & Partial<Pick<CodexRunner, "operatorInstructionsDigest">>;
  messaging: MessagingPort;
  sendblueNumber: string;
  mediaRoot: string;
  typingRefreshMs: number;
  logger: Logger;
  now?: () => number;
  fallbackText?: string;
  requestRestart?: () => void;
  routineCliPath?: string;
  /** Absolute node binary for the routine commands shown to Codex; bare "node" is not on launchd's PATH for nvm/volta installs. */
  nodePath?: string;
  stateDatabasePath?: string;
  /** Static facts reported by /status. */
  status?: () => { mode: string; model: string };
  /** Directories Codex may send local files from. Defaults to the media root only. */
  outboundMediaRoots?: readonly string[];
};

async function confinedPath(candidate: string, roots: readonly string[]): Promise<string> {
  const resolved = await realpath(candidate);
  const allowed = await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)));
  for (const root of allowed) {
    if (!root) continue;
    const rel = relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolved;
  }
  throw new Error("Codex selected a local file outside the allowed media directories");
}

export type ControlCommand = "/clear" | "/new" | "/restart" | "/help" | "/status";
const CONTROL_COMMANDS: ReadonlySet<string> = new Set<ControlCommand>(["/clear", "/new", "/restart", "/help", "/status"]);

/**
 * Only an exact, bare command counts. "/Users/you/foo.ts is broken" is a
 * message for Codex, not a command.
 */
export function controlCommandFor(content: string): ControlCommand | undefined {
  const command = content.trim().toLowerCase();
  return CONTROL_COMMANDS.has(command) ? command as ControlCommand : undefined;
}

export type AbortReason = "cancelled" | "shutdown";

export const MAX_DELIVERY_ATTEMPTS = 6;
export const LAST_TURN_OK_KEY = "daemon.last_turn_ok_at";

/** 30s, 1m, 2m, 4m, 8m: a Sendblue outage of ~15 minutes is absorbed without losing the reply. */
export function deliveryBackoffMs(attemptCount: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attemptCount - 1), 8 * 60_000);
}

function promptFor(job: InboundJob, attachments: string[], routineCliPath?: string, nodePath = process.execPath): string {
  const message = job.message;
  const cli = `${JSON.stringify(nodePath)} ${JSON.stringify(routineCliPath)}`;
  const localControl = routineCliPath
    ? [
        "Local routine control for this exact SMS thread:",
        `${cli} routine add --every <interval> --task <task>`,
        `${cli} routine list`,
        `${cli} routine delete --id <id>`,
        `${cli} routine add --every 1d --at 08:00 --days weekdays --task <task>`,
        "Intervals use m, h, d, or w. --at HH:MM (24h, local time) and --days (mon,tue,... | weekdays | weekends) need a whole-day interval. Use these commands yourself when the request is naturally about recurring work; never ask for slash syntax.",
      ].join("\n")
    : undefined;
  return [
    "Handle this message from the trusted controller of this computer.",
    "Use bash/read/write and other available computer tools when needed.",
    "The host will execute only your validated final messaging envelope.",
    JSON.stringify({
      message: {
        handle: message.handle,
        content: message.content,
        service: message.service,
        receivedAt: new Date(message.dateSent).toISOString(),
      },
      attachments,
    }),
    localControl,
  ].filter(Boolean).join("\n\n");
}

export class AgentWorker {
  readonly #options: AgentWorkerOptions;
  readonly #now: () => number;
  readonly #inflight = new Map<string, AbortController>();

  constructor(options: AgentWorkerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async runOnce(): Promise<boolean> {
    const job = this.#options.store.claimNext(this.#now());
    if (!job) return false;
    await this.#process(job);
    return true;
  }

  /** Abort the in-flight Codex turn for one thread, if any. */
  abortThread(thread: string, reason: AbortReason): boolean {
    const controller = this.#inflight.get(thread);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  /** Abort every in-flight Codex turn (shutdown or /restart). */
  abortAll(reason: AbortReason): number {
    let count = 0;
    for (const controller of this.#inflight.values()) {
      controller.abort(reason);
      count += 1;
    }
    return count;
  }

  /**
   * Handle a control command out of band: the job has already been completed
   * from pending by ingestion, so this never waits behind a long Codex turn.
   */
  async handleControl(job: InboundJob): Promise<void> {
    const command = controlCommandFor(job.message.content);
    if (!command) return;
    try {
      const outcome = await this.#runControl(job, command);
      this.#options.logger.info("command_completed", { handle: job.message.handle, command });
      if (outcome === "restart") setTimeout(() => this.#options.requestRestart?.(), 250).unref?.();
    } catch (error) {
      this.#options.logger.error("command_failed", { handle: job.message.handle, command, error });
    }
  }

  async #reply(
    job: InboundJob,
    input: { content?: string; mediaUrl?: string },
  ): Promise<AcceptedSend> {
    const message = job.message;
    const payload = {
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.mediaUrl !== undefined ? { mediaUrl: input.mediaUrl } : {}),
    };
    return this.#options.messaging.sendDirect({
      number: message.fromNumber,
      fromNumber: this.#options.sendblueNumber,
      ...payload,
    });
  }

  async #runControl(job: InboundJob, command: ControlCommand): Promise<"handled" | "restart"> {
    const thread = threadKey(job.message);

    if (command === "/clear" || command === "/new") {
      const interrupted = this.abortThread(thread, "cancelled");
      this.#options.store.clearCodexThreadId(thread);
      await this.#reply(job, {
        content: interrupted
          ? "Stopped what I was doing and cleared the slate. What’s next?"
          : "Fresh slate. What are we doing next?",
      });
      return "handled";
    }
    if (command === "/restart") {
      // Re-queue in-flight work so it resumes after the restart; /clear is the "stop it" command.
      this.abortAll("shutdown");
      this.#options.store.clearCodexThreadId(thread);
      await this.#reply(job, { content: "Restarting now. I’ll be back in a few seconds with a clean context." });
      return "restart";
    }
    if (command === "/help") {
      await this.#reply(job, {
        content: "Commands: /clear for a fresh context (and to stop the current task), /restart to restart me, and /status to check I’m up. Just ask normally for everything else, including routines.",
      });
      return "handled";
    }
    const counts = this.#options.store.countJobs();
    const info = this.#options.status?.();
    const working = this.#inflight.size;
    const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
    const parts = [
      "I’m up.",
      info ? `Mode ${info.mode}, model ${info.model}.` : undefined,
      `${working > 0 ? `Working on ${plural(working, "thing")}` : "Idle"} right now, ${counts.pending > 0 ? plural(counts.pending, "message") : "nothing"} queued.`,
      counts.failed > 0 ? `${plural(counts.failed, "failed job")} on record.` : undefined,
    ];
    await this.#reply(job, { content: parts.filter(Boolean).join(" ") });
    return "handled";
  }

  async #dispatch(job: InboundJob, envelope: FinalEnvelope, progress: { accepted: number }): Promise<number> {
    const accept = () => { progress.accepted += 1; };

    if (envelope.reaction) {
      const target = envelope.reaction.messageHandle ?? job.message.handle;
      if (target !== job.message.handle) {
        throw new Error("Codex selected a reaction target outside the current message");
      }
      await this.#options.messaging.sendReaction({
        fromNumber: this.#options.sendblueNumber,
        messageHandle: job.message.handle,
        reaction: envelope.reaction.value,
      });
      accept();
    }

    if (envelope.media) {
      const mediaUrl = envelope.media.kind === "local"
        ? (await this.#options.messaging.uploadFile(
            await confinedPath(envelope.media.localPath, this.#options.outboundMediaRoots ?? [this.#options.mediaRoot]),
          )).mediaUrl
        : envelope.media.url;
      await this.#reply(job, {
        mediaUrl,
        content: envelope.media.caption,
      });
      accept();
    }

    if (envelope.carousel) {
      await this.#options.messaging.sendCarousel({
        number: job.message.fromNumber,
        fromNumber: this.#options.sendblueNumber,
        mediaUrls: envelope.carousel.urls,
      });
      accept();
    }

    for (const bubble of envelope.bubbles ?? []) {
      await this.#reply(job, { content: bubble });
      accept();
    }

    return progress.accepted;
  }

  async #process(job: InboundJob): Promise<void> {
    const { message } = job;
    const thread = threadKey(message);
    const progress = { accepted: 0 };
    let finalOutcome = false;
    let finished = false;
    let typingTimer: NodeJS.Timeout | undefined;
    const controller = new AbortController();

    const refreshTyping = async () => {
      if (finished) return;
      await this.#options.messaging.setTyping({
        number: message.fromNumber,
        fromNumber: this.#options.sendblueNumber,
        state: "start",
        maxDurationMs: Math.max(this.#options.typingRefreshMs * 2, 30_000),
      }).catch(() => undefined);
    };

    try {
      // Ingestion normally completes control commands out of band; this covers
      // rows that were already pending before that path existed.
      const command = controlCommandFor(message.content);
      if (command) {
        const outcome = await this.#runControl(job, command);
        this.#options.store.markDone(job.id, this.#now());
        this.#options.logger.info("command_completed", { handle: message.handle, command });
        if (outcome === "restart") setTimeout(() => this.#options.requestRestart?.(), 250).unref?.();
        return;
      }
      this.#inflight.set(thread, controller);

      await Promise.allSettled([
        this.#options.messaging.markRead({
          number: message.fromNumber,
          fromNumber: this.#options.sendblueNumber,
        }),
        refreshTyping(),
      ]);
      typingTimer = setInterval(refreshTyping, this.#options.typingRefreshMs);
      typingTimer.unref?.();

      const attachments: string[] = [];
      const images: string[] = [];
      if (message.mediaUrl) {
        try {
          const media = await downloadInboundMedia({
            url: message.mediaUrl,
            handle: message.handle,
            root: join(this.#options.mediaRoot, "inbound"),
          });
          attachments.push(media.path);
          if (media.isImage) images.push(media.path);
        } catch {
          attachments.push("[The inbound attachment could not be downloaded safely]");
        }
      }

      this.#options.store.setThreadTarget(
        thread,
        { ...message, content: "", mediaUrl: undefined, replyTo: undefined, raw: {} },
        this.#now(),
      );
      // A delivery retry replays the validated envelope instead of re-running Codex.
      if (job.envelopeJson) {
        const cached = finalEnvelopeSchema.safeParse(JSON.parse(job.envelopeJson));
        if (cached.success) {
          const accepted = await this.#dispatch(job, cached.data, progress);
          finalOutcome = accepted > 0;
          this.#options.store.markDone(job.id, this.#now());
          this.#options.logger.info("message_delivered_on_retry", { handle: message.handle, attempt: job.attemptCount });
          return;
        }
      }

      const priorThread = this.#options.store.getCodexThreadId(thread);
      const digestBefore = await this.#options.codex.operatorInstructionsDigest?.();
      let result: CodexTurnResult;
      result = await this.#options.codex.run({
        prompt: promptFor(job, attachments, this.#options.routineCliPath, this.#options.nodePath),
        ...(priorThread ? { threadId: priorThread } : {}),
        images,
        signal: controller.signal,
        ...(this.#options.stateDatabasePath
          ? { environment: {
              CODEX_SMS_STATE_DB: this.#options.stateDatabasePath,
              CODEX_SMS_THREAD_KEY: thread,
            } }
          : {}),
      });
      if (controller.signal.aborted) throw new CodexRunnerError("aborted", "Codex turn was cancelled");
      this.#options.store.setCodexThreadId(thread, result.threadId, this.#now());
      if (result.threadReset) this.#options.logger.warn("codex_thread_reset", { handle: message.handle, thread });
      this.#options.store.saveEnvelope(job.id, JSON.stringify(result.envelope.envelope), this.#now());
      this.#options.store.setMetadata(LAST_TURN_OK_KEY, new Date(this.#now()).toISOString(), this.#now());

      const accepted = await this.#dispatch(job, result.envelope.envelope, progress);
      finalOutcome = accepted > 0;
      if (!finalOutcome) throw new Error("Codex produced no visible messaging outcome");

      // Tripwire: a turn that rewrote its own standing instructions is reported, never silent.
      const digestAfter = await this.#options.codex.operatorInstructionsDigest?.();
      if (digestBefore !== undefined && digestAfter !== undefined && digestBefore !== digestAfter) {
        this.#options.logger.warn("operator_instructions_changed", { handle: message.handle, thread });
        await this.#reply(job, {
          content: "Heads up: my standing instructions file (AGENTS.md in my workspace) changed during that task. If you didn’t ask for that, take a look before I run again.",
        }).catch(() => undefined);
      }
      this.#options.store.markDone(job.id, this.#now());
      this.#options.logger.info("message_completed", {
        handle: message.handle,
        thread,
        steps: result.steps,
        toolCalls: result.toolCalls.length,
      });
    } catch (error) {
      if (error instanceof CodexRunnerError && error.code === "aborted") {
        const reason: AbortReason = controller.signal.reason === "shutdown" ? "shutdown" : "cancelled";
        if (reason === "shutdown") {
          // Re-queue so the restarted daemon picks the message up again.
          this.#options.store.retry(job.id, error, this.#now() + 1_000, this.#now());
        } else {
          this.#options.store.markDone(job.id, this.#now());
        }
        this.#options.logger.info("message_aborted", { handle: message.handle, reason });
        return;
      }
      // Provider trouble: keep the job and retry delivery later rather than texting a "snag".
      if (isTransientSendblueError(error) && job.attemptCount < MAX_DELIVERY_ATTEMPTS) {
        const delayMs = deliveryBackoffMs(job.attemptCount);
        this.#options.store.retry(job.id, error, this.#now() + delayMs, this.#now());
        this.#options.logger.warn("delivery_deferred", { handle: message.handle, attempt: job.attemptCount, retryInMs: delayMs });
        return;
      }
      // Something was already delivered; do not follow it with a "snag" text.
      if (progress.accepted > 0) finalOutcome = true;
      if (!finalOutcome) {
        try {
          await this.#reply(job, {
            content: this.#options.fallbackText ??
              "Hit a snag on that one. Try me again, and I’ll take another run at it.",
          });
          finalOutcome = true;
        } catch {
          // The durable failed row is the operator-visible outcome when the provider is unreachable.
        }
      }
      if (finalOutcome) this.#options.store.markDone(job.id, this.#now());
      else this.#options.store.markFailed(job.id, error, this.#now());
      this.#options.logger.error("message_failed", {
        handle: message.handle,
        error,
        fallbackAccepted: finalOutcome,
      });
    } finally {
      finished = true;
      if (this.#inflight.get(thread) === controller) this.#inflight.delete(thread);
      if (typingTimer) clearInterval(typingTimer);
      await this.#options.messaging.setTyping({
        number: message.fromNumber,
        fromNumber: this.#options.sendblueNumber,
        state: "stop",
      }).catch(() => undefined);
    }
  }
}
