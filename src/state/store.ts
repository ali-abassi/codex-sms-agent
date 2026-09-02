import { DatabaseSync } from "node:sqlite";

import { threadKey, type InboundMessage } from "../domain/message.js";
import { ALL_DAYS, nextRunAfter, validateSchedule, type Schedule } from "../domain/schedule.js";

const SCHEMA_VERSION = 1;

export type JobState = "pending" | "processing" | "done" | "failed";
export type EnqueueSource = "webhook" | "reconcile";

export interface InboundJob {
  id: number;
  message: InboundMessage;
  threadKey: string;
  source: EnqueueSource;
  state: JobState;
  attemptCount: number;
  availableAt: number;
  createdAt: number;
  updatedAt: number;
  processingStartedAt?: number;
  finishedAt?: number;
  errorSummary?: string;
  /** Validated envelope from a completed Codex turn whose delivery is being retried. */
  envelopeJson?: string;
}

export interface EnqueueResult {
  inserted: boolean;
  job: InboundJob;
}

export interface Routine extends Schedule {
  id: number;
  threadKey: string;
  task: string;
  nextRunAt: number;
  createdAt: number;
}

export interface StateStoreOptions {
  busyTimeoutMs?: number;
}

export interface RoutineSkip {
  routineId: number;
  scheduledAt: number;
  /** `missed`: the next slot already came; `coalesced`: an earlier run is still open. */
  reason: "missed" | "coalesced";
}

/** Epoch ms after which a queued routine run is not worth executing, if the job carries one. */
export function routineStaleAfter(message: InboundMessage): number | undefined {
  const raw = message.raw;
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = (raw as Record<string, unknown>).staleAfter;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type Row = Record<string, unknown>;

function epoch(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative epoch millisecond value`);
  }
  return value;
}

function positiveId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("jobId must be a positive integer");
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

function safeToken(value: unknown, fallback: string): string {
  const text = String(value);
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(text) ? text : fallback;
}

function safeErrorSummary(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";

  const name = safeToken(error.name, "Error");
  const code = (error as Error & { code?: unknown }).code;
  if (code === undefined) return `name=${name}`;
  return `name=${name} code=${safeToken(code, "unknown")}`;
}

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid database value for ${key}`);
  return value;
}

function requiredNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`Invalid database value for ${key}`);
  }
  return Number(value);
}

function optionalNumber(row: Row, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`Invalid database value for ${key}`);
  }
  return Number(value);
}

function optionalString(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid database value for ${key}`);
  return value;
}

function toJob(row: Row): InboundJob {
  return {
    id: requiredNumber(row, "id"),
    message: JSON.parse(requiredString(row, "message_json")) as InboundMessage,
    threadKey: requiredString(row, "thread_key"),
    source: requiredString(row, "source") as EnqueueSource,
    state: requiredString(row, "state") as JobState,
    attemptCount: requiredNumber(row, "attempt_count"),
    availableAt: requiredNumber(row, "available_at"),
    createdAt: requiredNumber(row, "created_at"),
    updatedAt: requiredNumber(row, "updated_at"),
    processingStartedAt: optionalNumber(row, "processing_started_at"),
    finishedAt: optionalNumber(row, "finished_at"),
    errorSummary: optionalString(row, "error_summary"),
    envelopeJson: optionalString(row, "envelope_json"),
  };
}

function toRoutine(row: Row): Routine {
  const atMinute = optionalNumber(row, "at_minute");
  return {
    id: requiredNumber(row, "id"),
    threadKey: requiredString(row, "thread_key"),
    task: requiredString(row, "task"),
    intervalMs: requiredNumber(row, "interval_ms"),
    ...(atMinute === undefined ? {} : { atMinute }),
    daysMask: optionalNumber(row, "days_mask") ?? ALL_DAYS,
    nextRunAt: requiredNumber(row, "next_run_at"),
    createdAt: requiredNumber(row, "created_at"),
  };
}

export class StateStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string, options: StateStoreOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new RangeError("busyTimeoutMs must be a non-negative integer");
    }

    this.#database = new DatabaseSync(path);
    try {
      this.#database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS inbound_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_handle TEXT NOT NULL UNIQUE,
          thread_key TEXT NOT NULL,
          message_json TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('webhook', 'reconcile')),
          state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'done', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          available_at REAL NOT NULL,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          processing_started_at REAL,
          finished_at REAL,
          error_summary TEXT
        );

        CREATE INDEX IF NOT EXISTS inbound_jobs_claim_order
          ON inbound_jobs(state, created_at, id);

        CREATE UNIQUE INDEX IF NOT EXISTS inbound_jobs_one_active_thread
          ON inbound_jobs(thread_key) WHERE state = 'processing';

        CREATE TABLE IF NOT EXISTS thread_sessions (
          thread_key TEXT PRIMARY KEY,
          codex_thread_id TEXT NOT NULL,
          updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS metadata (
          metadata_key TEXT PRIMARY KEY,
          metadata_value TEXT NOT NULL,
          updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS thread_targets (
          thread_key TEXT PRIMARY KEY,
          message_json TEXT NOT NULL,
          updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS routines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_key TEXT NOT NULL,
          target_json TEXT NOT NULL,
          task TEXT NOT NULL,
          interval_ms INTEGER NOT NULL CHECK (interval_ms >= 60000),
          next_run_at REAL NOT NULL,
          created_at REAL NOT NULL
        );

        CREATE INDEX IF NOT EXISTS routines_due
          ON routines(next_run_at);

      `);
      this.#migrate();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  #migrate(): void {
    const row = this.#database.prepare("PRAGMA user_version").get();
    let version = row ? requiredNumber(row, "user_version") : 0;
    const columns = (table: string) => this.#database.prepare(`PRAGMA table_info(${table})`).all().map((entry) => requiredString(entry, "name"));
    if (version < 1) {
      // Version 1: delivery retry cache and clock-aligned routines. Guarded so
      // databases created by this very constructor (already current) stay valid.
      if (!columns("inbound_jobs").includes("envelope_json")) {
        this.#database.exec("ALTER TABLE inbound_jobs ADD COLUMN envelope_json TEXT");
      }
      const routineColumns = columns("routines");
      if (!routineColumns.includes("at_minute")) this.#database.exec("ALTER TABLE routines ADD COLUMN at_minute INTEGER");
      if (!routineColumns.includes("days_mask")) {
        this.#database.exec(`ALTER TABLE routines ADD COLUMN days_mask INTEGER NOT NULL DEFAULT ${ALL_DAYS}`);
      }
      version = 1;
    }
    this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  schemaVersion(): number {
    const row = this.#database.prepare("PRAGMA user_version").get();
    return row ? requiredNumber(row, "user_version") : 0;
  }

  enqueue(message: InboundMessage, source: EnqueueSource, now: number): EnqueueResult {
    nonEmpty(message.handle, "message.handle");
    epoch(message.dateSent, "message.dateSent");
    epoch(now, "now");

    const serialized = JSON.stringify(message);
    if (serialized === undefined) throw new Error("Inbound message is not JSON serializable");

    const inserted = this.#database.prepare(`
      INSERT INTO inbound_jobs (
        provider_handle, thread_key, message_json, source, state, attempt_count,
        available_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(provider_handle) DO NOTHING
      RETURNING *
    `).get(
      message.handle,
      threadKey(message),
      serialized,
      source,
      now,
      now,
      now,
    );

    if (inserted !== undefined) return { inserted: true, job: toJob(inserted) };

    const existing = this.#database.prepare(
      "SELECT * FROM inbound_jobs WHERE provider_handle = ?",
    ).get(message.handle);
    if (existing === undefined) throw new Error("Enqueued message disappeared");
    return { inserted: false, job: toJob(existing) };
  }

  claimNext(now: number): InboundJob | undefined {
    epoch(now, "now");
    const row = this.#database.prepare(`
      WITH candidate AS (
        SELECT candidate.id
        FROM inbound_jobs AS candidate
        WHERE candidate.state = 'pending'
          AND candidate.available_at <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM inbound_jobs AS active
            WHERE active.thread_key = candidate.thread_key
              AND active.state = 'processing'
          )
        ORDER BY candidate.created_at, candidate.id
        LIMIT 1
      )
      UPDATE inbound_jobs
      SET state = 'processing',
          attempt_count = attempt_count + 1,
          processing_started_at = ?,
          updated_at = ?,
          finished_at = NULL,
          error_summary = NULL
      WHERE id = (SELECT id FROM candidate)
        AND state = 'pending'
      RETURNING *
    `).get(now, now, now);

    return row === undefined ? undefined : toJob(row);
  }

  markDone(jobId: number, now: number): boolean {
    const result = this.#database.prepare(`
      UPDATE inbound_jobs
      SET state = 'done', updated_at = ?, finished_at = ?, error_summary = NULL
      WHERE id = ? AND state = 'processing'
    `).run(epoch(now, "now"), now, positiveId(jobId));
    return Number(result.changes) === 1;
  }

  /** Persist a validated envelope so a delivery retry can skip the Codex turn. */
  saveEnvelope(jobId: number, envelopeJson: string, now: number): boolean {
    const result = this.#database.prepare(`
      UPDATE inbound_jobs SET envelope_json = ?, updated_at = ? WHERE id = ? AND state = 'processing'
    `).run(nonEmpty(envelopeJson, "envelopeJson"), epoch(now, "now"), positiveId(jobId));
    return Number(result.changes) === 1;
  }

  retry(jobId: number, error: unknown, availableAt: number, now: number): boolean {
    epoch(now, "now");
    epoch(availableAt, "availableAt");
    // Clock skew must never strand a processing row; clamp instead of throwing.
    if (availableAt <= now) availableAt = now + 1;

    const result = this.#database.prepare(`
      UPDATE inbound_jobs
      SET state = 'pending',
          available_at = ?,
          updated_at = ?,
          processing_started_at = NULL,
          finished_at = NULL,
          error_summary = ?
      WHERE id = ? AND state = 'processing'
    `).run(availableAt, now, safeErrorSummary(error), positiveId(jobId));
    return Number(result.changes) === 1;
  }

  markFailed(jobId: number, error: unknown, now: number): boolean {
    const result = this.#database.prepare(`
      UPDATE inbound_jobs
      SET state = 'failed', updated_at = ?, finished_at = ?, error_summary = ?
      WHERE id = ? AND state = 'processing'
    `).run(
      epoch(now, "now"),
      now,
      safeErrorSummary(error),
      positiveId(jobId),
    );
    return Number(result.changes) === 1;
  }

  /**
   * Re-queue every processing row. Safe only at daemon startup: exactly one
   * daemon owns a state directory, so no live worker can hold these rows.
   */
  recoverAllProcessing(now: number): number {
    epoch(now, "now");
    const result = this.#database.prepare(`
      UPDATE inbound_jobs
      SET state = 'pending',
          available_at = ?,
          updated_at = ?,
          processing_started_at = NULL,
          finished_at = NULL,
          error_summary = 'interrupted_processing_recovered'
      WHERE state = 'processing'
    `).run(now, now);
    return Number(result.changes);
  }

  /** Complete a job straight from pending, bypassing the per-thread claim lock (control commands). */
  completePending(jobId: number, now: number): boolean {
    const result = this.#database.prepare(`
      UPDATE inbound_jobs
      SET state = 'done', attempt_count = attempt_count + 1, updated_at = ?, finished_at = ?, error_summary = NULL
      WHERE id = ? AND state = 'pending'
    `).run(epoch(now, "now"), now, positiveId(jobId));
    return Number(result.changes) === 1;
  }

  countJobs(): Record<JobState, number> {
    const counts: Record<JobState, number> = { pending: 0, processing: 0, done: 0, failed: 0 };
    for (const row of this.#database.prepare("SELECT state, COUNT(*) AS total FROM inbound_jobs GROUP BY state").all()) {
      const state = requiredString(row, "state") as JobState;
      if (state in counts) counts[state] = requiredNumber(row, "total");
    }
    return counts;
  }

  getJobByHandle(handle: string): InboundJob | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM inbound_jobs WHERE provider_handle = ?",
    ).get(nonEmpty(handle, "handle"));
    return row === undefined ? undefined : toJob(row);
  }

  getCodexThreadId(thread: string): string | undefined {
    const row = this.#database.prepare(
      "SELECT codex_thread_id FROM thread_sessions WHERE thread_key = ?",
    ).get(nonEmpty(thread, "thread"));
    return row === undefined ? undefined : requiredString(row, "codex_thread_id");
  }

  setCodexThreadId(thread: string, threadId: string, now: number): void {
    this.#database.prepare(`
      INSERT INTO thread_sessions (thread_key, codex_thread_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(thread_key) DO UPDATE SET
        codex_thread_id = excluded.codex_thread_id,
        updated_at = excluded.updated_at
    `).run(
      nonEmpty(thread, "thread"),
      nonEmpty(threadId, "threadId"),
      epoch(now, "now"),
    );
  }

  getMetadata(key: string): string | undefined {
    const row = this.#database.prepare(
      "SELECT metadata_value FROM metadata WHERE metadata_key = ?",
    ).get(nonEmpty(key, "key"));
    return row === undefined ? undefined : requiredString(row, "metadata_value");
  }

  setMetadata(key: string, value: string, now: number): void {
    this.#database.prepare(`
      INSERT INTO metadata (metadata_key, metadata_value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(metadata_key) DO UPDATE SET
        metadata_value = excluded.metadata_value,
        updated_at = excluded.updated_at
    `).run(nonEmpty(key, "key"), value, epoch(now, "now"));
  }

  clearCodexThreadId(thread: string): boolean {
    const result = this.#database.prepare(
      "DELETE FROM thread_sessions WHERE thread_key = ?",
    ).run(nonEmpty(thread, "thread"));
    return Number(result.changes) === 1;
  }

  setThreadTarget(thread: string, message: InboundMessage, now: number): void {
    this.#database.prepare(`
      INSERT INTO thread_targets (thread_key, message_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(thread_key) DO UPDATE SET
        message_json = excluded.message_json,
        updated_at = excluded.updated_at
    `).run(nonEmpty(thread, "thread"), JSON.stringify(message), epoch(now, "now"));
  }

  getThreadTarget(thread: string): InboundMessage | undefined {
    const row = this.#database.prepare(
      "SELECT message_json FROM thread_targets WHERE thread_key = ?",
    ).get(nonEmpty(thread, "thread"));
    if (!row) return undefined;
    return JSON.parse(requiredString(row, "message_json")) as InboundMessage;
  }

  createRoutineForThread(
    thread: string,
    task: string,
    schedule: Schedule | number,
    now: number,
  ): Routine {
    const target = this.getThreadTarget(thread);
    if (!target) throw new Error("No messaging target is registered for this thread");
    return this.createRoutine(thread, target, task, schedule, now);
  }

  createRoutine(
    thread: string,
    target: InboundMessage,
    task: string,
    scheduleOrInterval: Schedule | number,
    now: number,
  ): Routine {
    const schedule = validateSchedule(typeof scheduleOrInterval === "number"
      ? { intervalMs: scheduleOrInterval, daysMask: ALL_DAYS }
      : scheduleOrInterval);
    const nextRunAt = nextRunAfter(epoch(now, "now"), schedule);
    const row = this.#database.prepare(`
      INSERT INTO routines (thread_key, target_json, task, interval_ms, at_minute, days_mask, next_run_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id, thread_key, task, interval_ms, at_minute, days_mask, next_run_at, created_at
    `).get(
      nonEmpty(thread, "thread"),
      JSON.stringify(target),
      nonEmpty(task, "task"),
      schedule.intervalMs,
      schedule.atMinute ?? null,
      schedule.daysMask,
      nextRunAt,
      now,
    );
    if (!row) throw new Error("Routine was not created");
    return toRoutine(row);
  }

  listRoutines(thread: string): Routine[] {
    return this.#database.prepare(`
      SELECT id, thread_key, task, interval_ms, at_minute, days_mask, next_run_at, created_at
      FROM routines WHERE thread_key = ? ORDER BY id
    `).all(nonEmpty(thread, "thread")).map(toRoutine);
  }

  countRoutines(): number {
    const row = this.#database.prepare("SELECT COUNT(*) AS total FROM routines").get();
    return row ? requiredNumber(row, "total") : 0;
  }

  deleteRoutine(thread: string, routineId: number): boolean {
    const result = this.#database.prepare(
      "DELETE FROM routines WHERE id = ? AND thread_key = ?",
    ).run(positiveId(routineId), nonEmpty(thread, "thread"));
    return Number(result.changes) === 1;
  }

  /** Routine slots the scheduler chose not to queue, drained by the daemon for logging. */
  #routineSkips: RoutineSkip[] = [];

  /** Drain the routine slots skipped by the last `enqueueDueRoutines` call. */
  takeRoutineSkips(): RoutineSkip[] {
    return this.#routineSkips.splice(0);
  }

  /** True when a run for this routine is still waiting or in flight. */
  hasOpenRoutineRun(routineId: number): boolean {
    const row = this.#database.prepare(`
      SELECT 1 FROM inbound_jobs
      WHERE provider_handle LIKE ? AND state IN ('pending', 'processing')
      LIMIT 1
    `).get(`routine:${positiveId(routineId)}:%`);
    return row !== undefined;
  }

  enqueueDueRoutines(now: number): number {
    epoch(now, "now");
    const rows = this.#database.prepare(
      "SELECT * FROM routines WHERE next_run_at <= ? ORDER BY next_run_at, id",
    ).all(now);
    let queued = 0;
    for (const row of rows) {
      const routine = toRoutine(row);
      const scheduledAt = routine.nextRunAt;
      const target = JSON.parse(requiredString(row, "target_json")) as InboundMessage;
      const nextRunAt = nextRunAfter(now, routine, scheduledAt);
      // Two ways a due slot is not worth a run. Its next slot has already come (the machine
      // slept through it): running now would deliver stale output moments before the fresh
      // one. Or its previous run is still queued or in flight (a turn overran): a second copy
      // behind it is a backlog of stale check-ins blocking real messages. Skip the slot and
      // only move the schedule forward.
      const skip: RoutineSkip["reason"] | undefined = scheduledAt + routine.intervalMs <= now
        ? "missed"
        : this.hasOpenRoutineRun(routine.id) ? "coalesced" : undefined;
      const message: InboundMessage = {
        ...target,
        handle: `routine:${routine.id}:${Math.trunc(scheduledAt)}`,
        content: `[Scheduled routine #${routine.id}] ${routine.task}`,
        mediaUrl: undefined,
        replyTo: undefined,
        dateSent: now,
        // The run is pointless once its next slot has come: the worker drops it then.
        raw: { routineId: routine.id, scheduledAt, staleAfter: Math.min(nextRunAt, scheduledAt + routine.intervalMs) },
      };
      this.#database.exec("BEGIN");
      try {
        if (skip) this.#routineSkips.push({ routineId: routine.id, scheduledAt, reason: skip });
        else if (this.enqueue(message, "reconcile", now).inserted) queued += 1;
        this.#database.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?")
          .run(nextRunAt, routine.id);
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    }
    return queued;
  }

  /** Drop finished jobs older than the retention window. Message content lives in these rows. */
  pruneFinishedJobs(finishedBefore: number): number {
    epoch(finishedBefore, "finishedBefore");
    const result = this.#database.prepare(`
      DELETE FROM inbound_jobs
      WHERE state IN ('done', 'failed') AND finished_at IS NOT NULL AND finished_at < ?
    `).run(finishedBefore);
    return Number(result.changes);
  }

  checkpoint(): void {
    this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
