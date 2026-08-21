import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./config.js";
import { createCodexRunner } from "./codex/runner.js";
import { startHttpServer, type RunningHttpServer } from "./http/server.js";
import { IngestionService } from "./ingest.js";
import type { Logger } from "./log.js";
import { Reconciler } from "./reconcile.js";
import { createSendblueClient } from "./sendblue/client.js";
import { createMessagingPort } from "./sendblue/port.js";
import { StateStore } from "./state/store.js";
import { AgentWorker } from "./worker.js";

const ACTIVE_AFTER_KEY = "daemon.active_after";
const WORKER_IDLE_MS = 250;
const SHUTDOWN_GRACE_MS = 15_000;

export type RunningDaemon = {
  server: RunningHttpServer;
  mode: "shadow" | "active";
  activeAfter: number;
  close(): Promise<void>;
};

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    timeout.unref?.();
  });
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
  const onFatal = hooks.onFatal ?? ((event: string) => {
    logger.error("daemon_fatal", { event });
    process.exit(1);
  });
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
    operatorName: config.operatorName,
  });
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
  });

  const controller = new AbortController();
  const workerTasks: Promise<void>[] = [];

  const server = await startHttpServer({
    host: config.host,
    port: config.port,
    webhookSecret: config.webhookSecret,
    onWebhook: async (payload) => {
      try {
        return ingestion.ingestWebhook(payload);
      } catch (error) {
        logger.warn("webhook_payload_ignored", { error });
        return "ignored";
      }
    },
    health: () => ({
      mode: config.mode,
      activeAfter: new Date(activeAfter).toISOString(),
      model: config.codexModel,
      uptimeSeconds: Math.floor(process.uptime()),
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
    } catch (error) {
      logger.error("routine_scheduler_failed", { error });
    }
  };
  enqueueRoutines();
  const routineTimer = setInterval(enqueueRoutines, 5_000);
  routineTimer.unref?.();

  await reconciler.run().catch(() => undefined);
  const reconcileTimer = setInterval(() => {
    void reconciler.run().catch(() => undefined);
  }, config.pollIntervalMs);
  reconcileTimer.unref?.();

  logger.info("daemon_started", {
    mode: config.mode,
    host: server.host,
    port: server.port,
    publicUrl: config.publicUrl,
    activeAfter: new Date(activeAfter).toISOString(),
  });

  let closed = false;
  return {
    server,
    mode: config.mode,
    activeAfter,
    close: async () => {
      if (closed) return;
      closed = true;
      controller.abort();
      clearInterval(routineTimer);
      clearInterval(reconcileTimer);
      await server.close();
      const aborted = worker.abortAll("shutdown");
      if (aborted > 0) logger.info("inflight_turns_aborted", { count: aborted });
      const settled = await withTimeout(Promise.allSettled(workerTasks), SHUTDOWN_GRACE_MS);
      if (settled === "timeout") logger.warn("shutdown_grace_exceeded", { graceMs: SHUTDOWN_GRACE_MS });
      store.close();
      logger.info("daemon_stopped");
    },
  };
}
