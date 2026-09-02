import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage } from "../src/domain/message.js";
import { IngestionService } from "../src/ingest.js";
import type { Logger } from "../src/log.js";
import { Reconciler } from "../src/reconcile.js";
import { StateStore } from "../src/state/store.js";

const directories: string[] = [];
const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function store(): StateStore {
  const path = mkdtempSync(join(tmpdir(), "codex-sms-ingest-"));
  directories.push(path);
  return new StateStore(join(path, "state.sqlite"));
}

function message(handle: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    handle,
    fromNumber: "+15550000002",
    toNumber: "+15550000001",
    sendblueNumber: "+15550000001",
    content: "hello",
    service: "iMessage",
    groupId: "",
    participants: [],
    dateSent: 10_000,
    raw: { date_updated: "1970-01-01T00:00:11.000Z" },
    ...overrides,
  };
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("IngestionService", () => {
  it("durably queues allowed text/media and deduplicates webhook retries", () => {
    const state = store();
    const ingestion = new IngestionService({
      store: state,
      sendblueNumber: "+15550000001",
      allowedPhones: new Set(["+15550000002"]),
      activeAfter: 5_000,
      logger,
      now: () => 20_000,
    });

    expect(ingestion.ingest(message("one"), "webhook")).toBe("queued");
    expect(ingestion.ingest(message("one"), "webhook")).toBe("duplicate");
    expect(ingestion.ingest(message("media", { content: "", mediaUrl: "https://storage.sendblue.co/file" }), "webhook")).toBe("queued");
    state.close();
  });

  it("ignores wrong lines, unauthorized senders, empty events, and pre-activation reconciliation", () => {
    const state = store();
    const ingestion = new IngestionService({
      store: state,
      sendblueNumber: "+15550000001",
      allowedPhones: new Set(["+15550000002"]),
      activeAfter: 5_000,
      logger,
    });

    expect(ingestion.ingest(message("line", { sendblueNumber: "+15559999999" }), "webhook")).toBe("ignored");
    expect(ingestion.ingest(message("sender", { fromNumber: "+15559999999" }), "webhook")).toBe("ignored");
    expect(ingestion.ingest(message("group", { groupId: "group-1" }), "webhook")).toBe("ignored");
    expect(ingestion.ingest(message("empty", { content: "" }), "webhook")).toBe("ignored");
    expect(ingestion.ingest(message("old", { dateSent: 1_000 }), "reconcile")).toBe("ignored");
    expect(state.claimNext(50_000)).toBeUndefined();
    state.close();
  });
});

describe("IngestionService control commands", () => {
  it("completes bare control commands out of band and leaves everything else for the worker", () => {
    const state = store();
    const onControl = vi.fn();
    const ingestion = new IngestionService({
      store: state,
      sendblueNumber: "+15550000001",
      allowedPhones: new Set(["+15550000002"]),
      activeAfter: 5_000,
      logger,
      now: () => 20_000,
      onControl,
    });

    expect(ingestion.ingest(message("busy"), "webhook")).toBe("queued");
    state.claimNext(20_000);
    expect(ingestion.ingest(message("restart", { content: "/restart" }), "webhook")).toBe("queued");
    expect(ingestion.ingest(message("restart", { content: "/restart" }), "webhook")).toBe("duplicate");
    expect(ingestion.ingest(message("path", { content: "/Users/ali/notes.md" }), "webhook")).toBe("queued");

    expect(onControl).toHaveBeenCalledOnce();
    expect(onControl.mock.calls[0]?.[0]).toMatchObject({ message: { handle: "restart" } });
    expect(state.getJobByHandle("restart")?.state).toBe("done");
    expect(state.getJobByHandle("path")?.state).toBe("pending");
    state.close();
  });
});

describe("Reconciler", () => {
  it("pages inbound history, queues allowed messages, and persists an overlap watermark", async () => {
    const state = store();
    const ingestion = new IngestionService({
      store: state,
      sendblueNumber: "+15550000001",
      allowedPhones: new Set(["+15550000002"]),
      activeAfter: 5_000,
      logger,
      now: () => 30_000,
    });
    const listMessages = vi.fn()
      .mockResolvedValueOnce({
        messages: [message("first")],
        pagination: { hasMore: true, limit: 1, offset: 0, total: 2 },
      })
      .mockResolvedValueOnce({
        messages: [message("second", { raw: { date_updated: "1970-01-01T00:00:12.000Z" } })],
        pagination: { hasMore: false, limit: 1, offset: 1, total: 2 },
      });
    const reconciler = new Reconciler({
      store: state,
      sendblue: { listMessages },
      ingestion,
      sendblueNumber: "+15550000001",
      activeAfter: 5_000,
      logger,
      now: () => 30_000,
    });

    expect(await reconciler.run()).toEqual({ fetched: 2, queued: 2 });
    expect(listMessages).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 0, isOutbound: false }));
    expect(listMessages).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 1 }));
    expect(state.getMetadata("reconcile.updated_at")).toBe("1970-01-01T00:00:12.000Z");
    state.close();
  });

  it("stays observable while idle: keeps polling, advances the watermark, and beats a heartbeat", async () => {
    // Regression guard for a false alarm on 2026-09-02: an idle poller logs at debug, so a
    // healthy poller is silent and looks identical to a dead one. The watermark and the
    // status must prove liveness even when nothing is fetched.
    const state = store();
    const ingestion = new IngestionService({
      store: state,
      sendblueNumber: "+15550000001",
      allowedPhones: new Set(["+15550000002"]),
      activeAfter: 5_000,
      logger,
    });
    type Page = { messages: InboundMessage[]; pagination: { hasMore: boolean; limit: number; offset: number; total: number } };
    const listMessages = vi.fn(async (): Promise<Page> => ({
      messages: [],
      pagination: { hasMore: false, limit: 100, offset: 0, total: 0 },
    }));
    let clock = 1_000_000;
    const reconciler = new Reconciler({
      store: state,
      sendblue: { listMessages },
      ingestion,
      sendblueNumber: "+15550000001",
      activeAfter: 5_000,
      logger,
      now: () => clock,
    });

    expect(reconciler.status()).toEqual({ consecutiveFailures: 0, quietPolls: 0 });

    const heartbeats = () => (logger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter(([event]) => event === "reconcile_alive").length;
    const before = heartbeats();

    for (let poll = 1; poll <= 30; poll += 1) {
      expect(await reconciler.run()).toEqual({ fetched: 0, queued: 0 });
      // Every idle poll still commits a fresh watermark, which is what proves it ran.
      expect(state.getMetadata("reconcile.updated_at")).toBe(new Date(clock - 120_000).toISOString());
      expect(reconciler.status()).toMatchObject({
        quietPolls: poll,
        consecutiveFailures: 0,
        lastSuccessAt: new Date(clock).toISOString(),
      });
      clock += 60_000;
    }

    expect(listMessages).toHaveBeenCalledTimes(30);
    // Silent by default, but exactly one proof-of-life line after the quiet run.
    expect(heartbeats() - before).toBe(1);

    // A real message resets the quiet streak and logs normally again.
    listMessages.mockResolvedValueOnce({
      messages: [message("live")],
      pagination: { hasMore: false, limit: 100, offset: 0, total: 1 },
    });
    expect(await reconciler.run()).toEqual({ fetched: 1, queued: 1 });
    expect(reconciler.status().quietPolls).toBe(0);
    state.close();
  });

  it("does not advance the watermark on provider failure", async () => {
    const state = store();
    state.setMetadata("reconcile.updated_at", "2026-08-19T22:00:00.000Z", 1);
    const ingestion = new IngestionService({
      store: state,
      sendblueNumber: "+15550000001",
      allowedPhones: new Set(["+15550000002"]),
      activeAfter: 5_000,
      logger,
    });
    const reconciler = new Reconciler({
      store: state,
      sendblue: { listMessages: vi.fn(async () => { throw new Error("offline"); }) },
      ingestion,
      sendblueNumber: "+15550000001",
      activeAfter: 5_000,
      logger,
    });

    await expect(reconciler.run()).rejects.toThrow("offline");
    expect(state.getMetadata("reconcile.updated_at")).toBe("2026-08-19T22:00:00.000Z");
    state.close();
  });
});
