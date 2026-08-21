import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { threadKey, type InboundMessage } from "../src/domain/message.js";
import { StateStore } from "../src/state/store.js";

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
    expect(threadKey(message("group-thread", { groupId: " group-7 " }))).toBe("group-7");

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

  it("recovers stale processing work after restart", () => {
    const path = databasePath();
    const beforeRestart = new StateStore(path);
    beforeRestart.enqueue(message("interrupted"), "webhook", 50);
    expect(beforeRestart.claimNext(100)?.state).toBe("processing");
    beforeRestart.close();

    const afterRestart = new StateStore(path);
    try {
      expect(afterRestart.recoverStaleProcessing(99, 200)).toBe(0);
      expect(afterRestart.claimNext(200)).toBeUndefined();
      expect(afterRestart.recoverStaleProcessing(100, 201)).toBe(1);

      const recovered = afterRestart.claimNext(201)!;
      expect(recovered.message.handle).toBe("interrupted");
      expect(recovered.attemptCount).toBe(2);
    } finally {
      afterRestart.close();
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
