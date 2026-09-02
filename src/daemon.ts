import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./config.js";
import { createCodexRunner } from "./codex/runner.js";
import { startHttpServer, type RunningHttpServer } from "./http/server.js";
import { IngestionService } from "./ingest.js";
import { SendblueNormalizationError } from "./sendblue/normalize.js";
import type { Logger } from "./log.js";
import { Reconciler } from "./reconcile.js";
import { createSendblueClient } from "./sendblue/client.js";
import { createMessagingPort } from "./sendblue/port.js";
import { StateStore } from "./state/store.js";
import { AgentWorker } from "./worker.js";

const ACTIVE_AFTER_KEY = "daemon.active_after";
const WORKER_IDLE_MS = 250;
const SHUTDOWN_GRACE_MS = 15_000;
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60_000;
const JOB_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MEDIA_RETENTION_MS = 7 * 24 * 60 * 60_000;
const CLOCK_WATCH_INTERVAL_MS = 5_000;
const CWD_WATCH_INTERVAL_MS = 60_000;
/** A tick this late means the process was frozen: the machine slept, or the loop was blocked. */
const CLOCK_JUMP_THRESHOLD_MS = 60_000;

async function pruneDirectory(root: string, olderThan: number): Promise<number> {
  let removed = 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(root, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (info && info.mtimeMs < olderThan) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}

export type RunningDaemon = {
  server: RunningHttpServer;
  mode: "shadow" | "active";
  activeAfter: number;
  close(): Promise<void>;
};

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    timeout.unref?.();
  });
}

/**
 * True when this process's working directory has been unlinked. `npm run build` deletes
 * the build output directory, and if the service was started with that as its working
 * directory, the kernel leaves the process on a dangling inode: every spawn from then on
 * fails with ENOENT, so no Codex turn can run again until a restart. Node surfaces that
 * as `process.cwd()` throwing.
 */
export function workingDirectoryMissing(cwd: () => string = () => process.cwd()): boolean {
  try {
    cwd();
    return false;
  } catch {
    return true;
  }
}

export type DaemonHooks = {
  /** Called when the daemon can no longer make progress; defaults to exiting so the supervisor restarts it. */
  onFatal?: (event: string) => void;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve("timeout"); });
  });
}

export async function startDaemon(
  config: AgentConfig,
  logger: Logger,
  hooks: DaemonHooks = {},
): Promise<RunningDaemon> {
  let closed = false;
  const onFatal = (event: string) => {
    if (closed) return;
    if (hooks.onFatal) return hooks.onFatal(event);
    logger.error("daemon_fatal", { event });
    process.exit(1);
  };
  await Promise.all([
    mkdir(config.stateDir, { recursive: true, mode: 0o700 }),
    mkdir(config.workspace, { recursive: true, mode: 0o700 }),
    mkdir(join(config.stateDir, "media"), { recursive: true, mode: 0o700 }),
  ]);

  const now = Date.now();
  const stateDatabasePath = join(config.stateDir, "state.sqlite");
  const store = new StateStore(stateDatabasePath);
  const storedActiveAfter = store.getMetadata(ACTIVE_AFTER_KEY);
  const parsedActiveAfter = storedActiveAfter ? Date.parse(storedActiveAfter) : Number.NaN;
  const activeAfter = Number.isFinite(parsedActiveAfter) ? parsedActiveAfter : now;
  if (!storedActiveAfter) {
    store.setMetadata(ACTIVE_AFTER_KEY, new Date(activeAfter).toISOString(), now);
  }
  // Exactly one daemon owns this state directory, so any processing row left
  // over is from a previous process and must be re-queued regardless of age.
  const recovered = store.recoverAllProcessing(now);
  if (recovered > 0) logger.warn("stale_jobs_recovered", { count: recovered });

  const sendblue = createSendblueClient({
    apiKeyId: config.sendblueApiKey,
    apiSecret: config.sendblueApiSecret,
    fromNumber: config.sendblueNumber,
  });
  const ingestion = new IngestionService({
    store,
    sendblueNumber: config.sendblueNumber,
    allowedPhones: config.allowedPhones,
    activeAfter,
    logger,
    ...(config.mode === "active"
      ? { onControl: (job) => { void worker.handleControl(job); } }
      : {}),
  });
  const reconciler = new Reconciler({
    store,
    sendblue,
    ingestion,
    sendblueNumber: config.sendblueNumber,
    activeAfter,
    logger,
  });
  const codex = createCodexRunner({
    workspace: config.workspace,
    model: config.codexModel,
    reasoningEffort: config.codexReasoningEffort,
    timeoutMs: config.codexTimeoutMs,
    execLauncherDir: join(config.stateDir, "bin"),
    operatorName: config.operatorName,
  });
  const instructionsPath = await codex.prepareWorkspace();
  const messaging = createMessagingPort(sendblue);
  const worker = new AgentWorker({
    store,
    codex,
    messaging,
    sendblueNumber: config.sendblueNumber,
    mediaRoot: join(config.stateDir, "media"),
    typingRefreshMs: config.typingRefreshMs,
    logger,
    requestRestart: () => process.kill(process.pid, "SIGTERM"),
    routineCliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
    stateDatabasePath,
    status: () => ({ mode: config.mode, model: config.codexModel }),
    outboundMediaRoots: [config.workspace, join(config.stateDir, "media")],
  });

  const controller = new AbortController();
  const clock = { lastTick: Date.now(), jumps: 0, lastJumpAt: undefined as string | undefined, lastJumpMs: 0 };
  const workerTasks: Promise<void>[] = [];

  const server = await startHttpServer({
    host: config.host,
    port: config.port,
    webhookSecret: config.webhookSecret,
    onWebhook: async (payload) => {
      try {
        return ingestion.ingestWebhook(payload);
      } catch (error) {
        // Malformed payloads are acknowledged so Sendblue stops retrying; anything
        // else (e.g. SQLite failure) must surface as a 500 so delivery is retried.
        if (!(error instanceof SendblueNormalizationError)) throw error;
        logger.warn("webhook_payload_ignored", { error });
        return "ignored";
      }
    },
    health: () => ({
      mode: config.mode,
      activeAfter: new Date(activeAfter).toISOString(),
      model: config.codexModel,
      uptimeSeconds: Math.floor(process.uptime()),
      queue: store.countJobs(),
      inflightTurns: worker.inflightCount(),
      clockJumps: {
        count: clock.jumps,
        ...(clock.lastJumpAt ? { lastAt: clock.lastJumpAt, lastGapMs: clock.lastJumpMs } : {}),
      },
    }),
    logger: { error: (event) => logger.error(event) },
  });

  if (config.mode === "active") {
    for (let index = 0; index < config.maxConcurrency; index += 1) {
      workerTasks.push((async () => {
        while (!controller.signal.aborted) {
          const handled = await worker.runOnce();
          if (!handled) await delay(WORKER_IDLE_MS, controller.signal);
        }
      })().catch((error) => {
        logger.error("worker_loop_failed", { worker: index, error });
        controller.abort();
        onFatal("worker_loop_failed");
      }));
    }
  }

  const enqueueRoutines = () => {
    if (config.mode !== "active") return;
    try {
      const queued = store.enqueueDueRoutines(Date.now());
      if (queued > 0) logger.info("routines_queued", { count: queued });
      for (const skip of store.takeRoutineSkips()) {
        logger.warn("routine_slot_skipped", {
          routineId: skip.routineId,
          scheduledAt: new Date(skip.scheduledAt).toISOString(),
          reason: skip.reason,
        });
      }
    } catch (error) {
      logger.error("routine_scheduler_failed", { error });
    }
  };
  enqueueRoutines();
  const routineTimer = setInterval(enqueueRoutines, 5_000);
  routineTimer.unref?.();

  // Timers cannot fire while the machine sleeps, so a Codex turn that spans a sleep is
  // charged for the whole gap and its provider calls run into a network that is not back
  // yet. Recording the jump gives the failures that follow their real cause.
  // Cheap liveness probe for the failure above: one stat a minute, and a restart that
  // fixes it, rather than hours of every turn failing instantly.
  const cwdTimer = setInterval(() => {
    if (!workingDirectoryMissing()) return;
    logger.error("working_directory_missing", { restarting: true });
    onFatal("working_directory_missing");
  }, CWD_WATCH_INTERVAL_MS);
  cwdTimer.unref?.();

  const clockTimer = setInterval(() => {
    const now = Date.now();
    const gap = now - clock.lastTick - CLOCK_WATCH_INTERVAL_MS;
    clock.lastTick = now;
    if (gap < CLOCK_JUMP_THRESHOLD_MS) return;
    clock.jumps += 1;
    clock.lastJumpAt = new Date(now).toISOString();
    clock.lastJumpMs = gap;
    logger.warn("clock_jump_detected", { gapMs: gap, inflightTurns: worker.inflightCount() });
  }, CLOCK_WATCH_INTERVAL_MS);
  clockTimer.unref?.();

  const maintenance = async () => {
    try {
      const now = Date.now();
      const jobs = store.pruneFinishedJobs(now - JOB_RETENTION_MS);
      const media = await pruneDirectory(join(config.stateDir, "media", "inbound"), now - MEDIA_RETENTION_MS);
      store.checkpoint();
      if (jobs > 0 || media > 0) logger.info("maintenance_complete", { prunedJobs: jobs, prunedMedia: media });
    } catch (error) {
      logger.warn("maintenance_failed", { error });
    }
  };
  void maintenance();
  const maintenanceTimer = setInterval(() => { void maintenance(); }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();

  await reconciler.run().catch(() => undefined);
  const reconcileTimer = setInterval(() => {
    void reconciler.run().catch(() => undefined);
  }, config.pollIntervalMs);
  reconcileTimer.unref?.();

  logger.info("daemon_started", {
    mode: config.mode,
    instructions: instructionsPath,
    host: server.host,
    port: server.port,
    publicUrl: config.publicUrl,
    activeAfter: new Date(activeAfter).toISOString(),
  });

  return {
    server,
    mode: config.mode,
    activeAfter,
    close: async () => {
      if (closed) return;
      closed = true;
      controller.abort();
      clearInterval(routineTimer);
      clearInterval(clockTimer);
      clearInterval(cwdTimer);
      clearInterval(reconcileTimer);
      clearInterval(maintenanceTimer);
      await server.close();
      const aborted = worker.abortAll("shutdown");
      if (aborted > 0) logger.info("inflight_turns_aborted", { count: aborted });
      const settled = await withTimeout(Promise.allSettled(workerTasks), SHUTDOWN_GRACE_MS);
      if (settled === "timeout") {
        // A worker is still mid-turn; leave the database open for it rather than
        // crashing it on a closed handle. The supervisor's kill will finish the job.
        logger.warn("shutdown_grace_exceeded", { graceMs: SHUTDOWN_GRACE_MS });
      } else {
        store.close();
      }
      logger.info("daemon_stopped");
    },
  };
}
