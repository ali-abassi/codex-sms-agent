import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DatabaseSync } from "node:sqlite";
import { threadKey, type InboundMessage } from "../src/domain/message.js";
import { DAY_MS, parseDays } from "../src/domain/schedule.js";
import { StateStore, routineStaleAfter } from "../src/state/store.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "sms-agent-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
}

function message(
  handle: string,
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    handle,
    fromNumber: "+15550000001",
    toNumber: "+15550000002",
    sendblueNumber: "+15550000002",
    content: `message ${handle}`,
    service: "iMessage",
    groupId: "",
    participants: ["+15550000001", "+15550000002"],
    dateSent: 50,
    raw: { message_handle: handle },
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("StateStore", () => {
  it("deduplicates provider handles and derives stable thread keys", () => {
    expect(threadKey(message("sender-thread"))).toBe("+15550000001");
    expect(threadKey(message("group-thread", { groupId: "group-7" }))).toBe("+15550000001");

    const store = new StateStore(databasePath());
    try {
      const first = store.enqueue(message("same-handle"), "webhook", 100);
      const duplicate = store.enqueue(
        message("same-handle", { content: "duplicate payload" }),
        "reconcile",
        200,
      );

      expect(first.inserted).toBe(true);
      expect(duplicate.inserted).toBe(false);
      expect(duplicate.job.id).toBe(first.job.id);
      expect(duplicate.job.message.content).toBe("message same-handle");
      expect(duplicate.job.source).toBe("webhook");
    } finally {
      store.close();
    }
  });

  it("claims the oldest eligible pending job", () => {
    const store = new StateStore(databasePath());
    try {
      store.enqueue(message("first"), "webhook", 100);
      store.enqueue(message("second", { fromNumber: "+15550000003" }), "reconcile", 101);

      expect(store.claimNext(500)?.message.handle).toBe("first");
      expect(store.claimNext(500)?.message.handle).toBe("second");
      expect(store.claimNext(500)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("serializes work per thread even across store connections", () => {
    const path = databasePath();
    const firstConnection = new StateStore(path);
    const secondConnection = new StateStore(path);
    try {
      firstConnection.enqueue(message("thread-a-1"), "webhook", 100);
      firstConnection.enqueue(message("thread-a-2"), "webhook", 101);
      firstConnection.enqueue(
        message("thread-b-1", { fromNumber: "+15550000009" }),
        "webhook",
        102,
      );

      const threadA = firstConnection.claimNext(200);
      const threadB = secondConnection.claimNext(200);
      expect(threadA?.message.handle).toBe("thread-a-1");
      expect(threadB?.message.handle).toBe("thread-b-1");
      expect(secondConnection.claimNext(200)).toBeUndefined();

      expect(secondConnection.markDone(threadB!.id, 201)).toBe(true);
      expect(secondConnection.claimNext(201)).toBeUndefined();
      expect(firstConnection.markDone(threadA!.id, 202)).toBe(true);
      expect(secondConnection.claimNext(202)?.message.handle).toBe("thread-a-2");
    } finally {
      secondConnection.close();
      firstConnection.close();
    }
  });

  it("honors retry availability and records terminal failure without error secrets", () => {
    const store = new StateStore(databasePath());
    try {
      store.enqueue(message("retry-me"), "webhook", 100);
      const firstAttempt = store.claimNext(100)!;

      expect(firstAttempt.attemptCount).toBe(1);
      expect(
        store.retry(firstAttempt.id, new Error("credential-sentinel"), 200, 110),
      ).toBe(true);
      expect(store.getJobByHandle("retry-me")?.errorSummary).toBe("name=Error");
      expect(store.claimNext(199)).toBeUndefined();

      const secondAttempt = store.claimNext(200)!;
      expect(secondAttempt.message.handle).toBe("retry-me");
      expect(secondAttempt.attemptCount).toBe(2);
      expect(secondAttempt.errorSummary).toBeUndefined();
      expect(
        store.markFailed(secondAttempt.id, new Error("credential-sentinel"), 210),
      ).toBe(true);

      const failed = store.getJobByHandle("retry-me")!;
      expect(failed.state).toBe("failed");
      expect(failed.finishedAt).toBe(210);
      expect(failed.errorSummary).toBe("name=Error");
      expect(JSON.stringify(failed)).not.toContain("credential-sentinel");
      expect(store.claimNext(1_000)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("persists Codex threads and reconciliation metadata across reopen", () => {
    const path = databasePath();
    const first = new StateStore(path);
    first.setCodexThreadId("thread-1", "session-1", 100);
    first.setMetadata("reconcile.watermark", "2026-08-19T22:00:00Z", 101);
    first.close();

    const reopened = new StateStore(path);
    try {
      expect(reopened.getCodexThreadId("thread-1")).toBe("session-1");
      expect(reopened.getMetadata("reconcile.watermark")).toBe(
        "2026-08-19T22:00:00Z",
      );
      expect(reopened.getCodexThreadId("missing")).toBeUndefined();
      expect(reopened.getMetadata("missing")).toBeUndefined();

      reopened.setCodexThreadId("thread-1", "session-2", 200);
      reopened.setMetadata("reconcile.watermark", "next-page", 201);
      expect(reopened.getCodexThreadId("thread-1")).toBe("session-2");
      expect(reopened.getMetadata("reconcile.watermark")).toBe("next-page");
      expect(reopened.clearCodexThreadId("thread-1")).toBe(true);
      expect(reopened.getCodexThreadId("thread-1")).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("turns due routines into durable jobs and advances their schedule", () => {
    const store = new StateStore(databasePath());
    try {
      const target = message("source", { content: "" });
      store.setThreadTarget("+15550000002", target, 999);
      const routine = store.createRoutineForThread("+15550000002", "check the build", 60_000, 1_000);
      expect(store.listRoutines("+15550000002")).toHaveLength(1);
      expect(store.enqueueDueRoutines(60_999)).toBe(0);
      expect(store.enqueueDueRoutines(61_000)).toBe(1);
      const job = store.claimNext(61_000)!;
      expect(job.message.handle).toBe(`routine:${routine.id}:61000`);
      expect(job.message.content).toContain("check the build");
      expect(store.listRoutines("+15550000002")[0]?.nextRunAt).toBe(121_000);
      expect(store.deleteRoutine("+15550000002", routine.id)).toBe(true);
      expect(store.listRoutines("+15550000002")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("folds a due routine slot into a run that is still open instead of stacking a second one", () => {
    const store = new StateStore(databasePath());
    try {
      store.setThreadTarget("+15550000002", message("source", { content: "" }), 999);
      const routine = store.createRoutineForThread("+15550000002", "check in", 60_000, 1_000);
      expect(store.enqueueDueRoutines(61_000)).toBe(1);
      const first = store.claimNext(61_000)!;
      expect(routineStaleAfter(first.message)).toBe(121_000);

      // The turn overruns into the next slot: nothing new is queued, the schedule moves on.
      expect(store.enqueueDueRoutines(121_500)).toBe(0);
      expect(store.takeRoutineSkips()).toEqual([{ routineId: routine.id, scheduledAt: 121_000, reason: "coalesced" }]);
      expect(store.takeRoutineSkips()).toEqual([]);

      // Once the run is finished the next slot queues normally.
      store.markDone(first.id, 122_000);
      expect(store.enqueueDueRoutines(181_000)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("skips a routine slot whose next slot has already come rather than running it late", () => {
    const store = new StateStore(databasePath());
    try {
      store.setThreadTarget("+15550000002", message("source", { content: "" }), 999);
      const routine = store.createRoutineForThread("+15550000002", "check in", 60_000, 1_000);
      // The machine slept through several slots; the first due slot is long past its interval.
      expect(store.enqueueDueRoutines(400_000)).toBe(0);
      expect(store.takeRoutineSkips()).toEqual([{ routineId: routine.id, scheduledAt: 61_000, reason: "missed" }]);
      expect(store.claimNext(400_000)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("recovers every interrupted processing row at startup regardless of age", () => {
    const path = databasePath();
    const before = new StateStore(path);
    before.enqueue(message("fresh"), "webhook", 50);
    before.enqueue(message("other", { fromNumber: "+15550000009" }), "webhook", 51);
    before.claimNext(1_000);
    before.claimNext(1_000);
    before.close();

    const after = new StateStore(path);
    try {
      expect(after.recoverAllProcessing(1_001)).toBe(2);
      expect(after.countJobs()).toEqual({ pending: 2, processing: 0, done: 0, failed: 0 });
      expect(after.claimNext(1_001)?.attemptCount).toBe(2);
      expect(after.recoverAllProcessing(1_002)).toBe(1);
    } finally {
      after.close();
    }
  });

  it("migrates a version-0 database in place and keeps its rows", () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE inbound_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider_handle TEXT NOT NULL UNIQUE, thread_key TEXT NOT NULL,
        message_json TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at REAL NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
        processing_started_at REAL, finished_at REAL, error_summary TEXT
      );
      CREATE TABLE routines (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_key TEXT NOT NULL, target_json TEXT NOT NULL, task TEXT NOT NULL,
        interval_ms INTEGER NOT NULL, next_run_at REAL NOT NULL, created_at REAL NOT NULL
      );
      INSERT INTO routines (thread_key, target_json, task, interval_ms, next_run_at, created_at)
      VALUES ('+15550000002', '${JSON.stringify(message("t", { content: "" }))}', 'old task', 3600000, 50, 10);
    `);
    legacy.close();

    const store = new StateStore(path);
    try {
      expect(store.schemaVersion()).toBe(1);
      const [routine] = store.listRoutines("+15550000002");
      expect(routine).toMatchObject({ task: "old task", intervalMs: 3_600_000, daysMask: 0b1111111 });
      expect(routine?.atMinute).toBeUndefined();
      expect(store.enqueueDueRoutines(100)).toBe(1);
      const job = store.claimNext(100)!;
      expect(job.envelopeJson).toBeUndefined();
      expect(store.saveEnvelope(job.id, '{"bubbles":["x"]}', 101)).toBe(true);
      expect(store.getJobByHandle(job.message.handle)?.envelopeJson).toBe('{"bubbles":["x"]}');
    } finally {
      store.close();
    }
  });

  it("creates clock-aligned routines and advances them per the schedule", () => {
    const store = new StateStore(databasePath());
    try {
      store.setThreadTarget("+15550000002", message("source", { content: "" }), 1);
      const monday7 = new Date(2026, 7, 24, 7, 0).getTime();
      const routine = store.createRoutineForThread("+15550000002", "standup notes", {
        intervalMs: DAY_MS,
        atMinute: 8 * 60,
        daysMask: parseDays("weekdays"),
      }, monday7);
      expect(new Date(routine.nextRunAt)).toEqual(new Date(2026, 7, 24, 8, 0));
      expect(store.enqueueDueRoutines(routine.nextRunAt + 1)).toBe(1);
      const [advanced] = store.listRoutines("+15550000002");
      expect(new Date(advanced!.nextRunAt)).toEqual(new Date(2026, 7, 25, 8, 0));
      expect(store.countRoutines()).toBe(1);
    } finally {
      store.close();
    }
  });

  it("prunes old finished jobs, keeps live ones, and clamps retry times under clock skew", () => {
    const store = new StateStore(databasePath());
    try {
      store.enqueue(message("old"), "webhook", 100);
      store.enqueue(message("new", { fromNumber: "+15550000003" }), "webhook", 101);
      store.enqueue(message("live", { fromNumber: "+15550000004" }), "webhook", 102);
      store.markDone(store.claimNext(200)!.id, 300);
      store.markDone(store.claimNext(200)!.id, 5_000);
      const live = store.claimNext(200)!;
      expect(store.retry(live.id, new Error("skew"), 150, 200)).toBe(true);
      expect(store.getJobByHandle("live")?.availableAt).toBe(201);

      expect(store.pruneFinishedJobs(1_000)).toBe(1);
      expect(store.getJobByHandle("old")).toBeUndefined();
      expect(store.getJobByHandle("new")?.state).toBe("done");
      store.checkpoint();
    } finally {
      store.close();
    }
  });

  it("completes a pending control job directly even while its thread is busy", () => {
    const store = new StateStore(databasePath());
    try {
      store.enqueue(message("busy"), "webhook", 100);
      const control = store.enqueue(message("control", { content: "/clear" }), "webhook", 101);
      expect(store.claimNext(200)?.message.handle).toBe("busy");
      expect(store.claimNext(200)).toBeUndefined();

      expect(store.completePending(control.job.id, 201)).toBe(true);
      expect(store.completePending(control.job.id, 202)).toBe(false);
      expect(store.getJobByHandle("control")).toMatchObject({ state: "done", attemptCount: 1, finishedAt: 201 });
      expect(store.countJobs()).toEqual({ pending: 0, processing: 1, done: 1, failed: 0 });
    } finally {
      store.close();
    }
  });
});
