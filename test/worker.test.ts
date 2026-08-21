import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage } from "../src/domain/message.js";
import type { CodexRunner, CodexTurnResult } from "../src/codex/runner.js";
import type { Logger } from "../src/log.js";
import { StateStore } from "../src/state/store.js";
import { CodexRunnerError } from "../src/codex/runner.js";
import { AgentWorker, controlCommandFor, type MessagingPort } from "../src/worker.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "codex-sms-worker-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function message(handle: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    handle,
    fromNumber: "+15550000002",
    toNumber: "+15550000001",
    sendblueNumber: "+15550000001",
    content: "Please check the computer",
    service: "iMessage",
    groupId: "",
    participants: [],
    dateSent: Date.parse("2026-08-19T22:00:00Z"),
    raw: {},
    ...overrides,
  };
}

function codexResult(threadId: string, envelope: Record<string, unknown>): CodexTurnResult {
  return {
    output: JSON.stringify(envelope),
    envelope: { envelope, source: "json" } as CodexTurnResult["envelope"],
    threadId,
    model: "gpt-5.6-sol",
    steps: 1,
    toolCalls: [],
    threadReset: false,
  };
}

function messaging() {
  return {
    markRead: vi.fn(async () => ({})),
    setTyping: vi.fn(async () => ({})),
    sendDirect: vi.fn(async () => ({ messageHandle: "outbound", status: "QUEUED" })),
    sendGroup: vi.fn(async () => ({ messageHandle: "group-outbound", status: "QUEUED" })),
    sendReaction: vi.fn(async () => ({})),
    sendCarousel: vi.fn(async () => ({ messageHandle: "carousel", status: "QUEUED" })),
    uploadFile: vi.fn(async () => ({ mediaUrl: "https://storage.sendblue.co/uploaded.png" })),
  } satisfies MessagingPort;
}

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function harness(result: CodexTurnResult | Error, overrides: Partial<ConstructorParameters<typeof AgentWorker>[0]> = {}) {
  const root = temporaryDirectory();
  const store = new StateStore(join(root, "state.sqlite"));
  const sendblue = messaging();
  const run = vi.fn(async (_input: Parameters<CodexRunner["run"]>[0]) => {
    if (result instanceof Error) throw result;
    return result;
  });
  const worker = new AgentWorker({
    store,
    codex: { run },
    messaging: sendblue,
    sendblueNumber: "+15550000001",
    mediaRoot: root,
    typingRefreshMs: 10_000,
    logger,
    ...overrides,
  });
  return { root, store, sendblue, run, worker };
}

describe("AgentWorker", () => {
  it("marks read, maintains typing, sends up to four normal bubbles, and persists the Codex thread", async () => {
    const test = harness(codexResult("session-1", { bubbles: ["yeah", "done."] }));
    test.store.enqueue(message("inbound-1"), "webhook", 1);

    expect(await test.worker.runOnce()).toBe(true);

    expect(test.sendblue.markRead).toHaveBeenCalledOnce();
    expect(test.sendblue.setTyping).toHaveBeenNthCalledWith(1, expect.objectContaining({ state: "start" }));
    expect(test.sendblue.setTyping).toHaveBeenLastCalledWith(expect.objectContaining({ state: "stop" }));
    expect(test.sendblue.sendDirect).toHaveBeenNthCalledWith(1, {
      number: "+15550000002",
      fromNumber: "+15550000001",
      content: "yeah",
    });
    expect(test.sendblue.sendDirect).toHaveBeenNthCalledWith(2, expect.objectContaining({ content: "done." }));
    expect(test.store.getCodexThreadId("+15550000002")).toBe("session-1");
    expect(test.store.getJobByHandle("inbound-1")?.state).toBe("done");
    test.store.close();
  });

  it("resumes the same Codex thread for later messages in a thread", async () => {
    const test = harness(codexResult("session-1", { text: "First" }));
    test.store.enqueue(message("first"), "webhook", 1);
    await test.worker.runOnce();
    test.store.enqueue(message("second"), "webhook", 2);
    test.run.mockResolvedValueOnce(codexResult("session-1", { text: "Second" }));

    await test.worker.runOnce();

    expect(test.run.mock.calls[1]?.[0]).toMatchObject({ threadId: "session-1" });
    test.store.close();
  });

  it("gives Codex thread-scoped routine controls for natural-language scheduling", async () => {
    const test = harness(codexResult("session-routine", { bubbles: ["set."] }), {
      routineCliPath: "/app/dist/cli.js",
      stateDatabasePath: "/state/agent.sqlite",
    });
    test.store.enqueue(message("natural-routine", { content: "check the build every two hours" }), "webhook", 1);

    await test.worker.runOnce();

    expect(test.run).toHaveBeenCalledWith(expect.objectContaining({
      environment: {
        CODEX_SMS_STATE_DB: "/state/agent.sqlite",
        CODEX_SMS_THREAD_KEY: "+15550000002",
      },
      prompt: expect.stringMatching(/node "\/app\/dist\/cli\.js" routine add --every <interval> --task <task>[\s\S]*routine delete --id <id>/),
    }));
    expect(test.store.getThreadTarget("+15550000002")?.fromNumber).toBe("+15550000002");
    test.store.close();
  });

  it("sends an explicit fallback and completes durably when Codex fails", async () => {
    const test = harness(new Error("private failure detail"));
    test.store.enqueue(message("failed-codex"), "webhook", 1);

    await test.worker.runOnce();

    expect(test.sendblue.sendDirect).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Hit a snag"),
    }));
    expect((test.sendblue.sendDirect as any).mock.calls[0][0]).not.toHaveProperty("replyTo");
    expect(test.store.getJobByHandle("failed-codex")?.state).toBe("done");
    test.store.close();
  });

  it("leaves a durable failed row if neither final nor fallback can reach Sendblue", async () => {
    const test = harness(new Error("Codex unavailable"));
    test.sendblue.sendDirect.mockRejectedValue(new Error("provider unavailable"));
    test.store.enqueue(message("dead-letter"), "webhook", 1);

    await test.worker.runOnce();

    expect(test.store.getJobByHandle("dead-letter")?.state).toBe("failed");
    test.store.close();
  });

  it("dispatches reactions, uploaded media, carousels, and text with host-bound targets", async () => {
    const test = harness(codexResult("session-rich", {
      reaction: { messageHandle: "rich", value: "love" },
      media: { kind: "local", localPath: "/tmp/image.png", caption: "image" },
      carousel: { urls: ["https://example.test/1.png", "https://example.test/2.png"] },
      text: "All sent.",
      replyTo: "rich",
    }));
    test.store.enqueue(message("rich"), "webhook", 1);

    await test.worker.runOnce();

    expect(test.sendblue.sendReaction).toHaveBeenCalledWith({
      fromNumber: "+15550000001",
      messageHandle: "rich",
      reaction: "love",
    });
    expect(test.sendblue.uploadFile).toHaveBeenCalledWith("/tmp/image.png");
    expect((test.sendblue.sendCarousel as any).mock.calls[0][0]).not.toHaveProperty("replyTo");
    expect(test.sendblue.sendDirect).toHaveBeenCalledTimes(2);
    test.store.close();
  });

  it("uses group reply transport and skips unsupported direct typing signals", async () => {
    const test = harness(codexResult("session-group", { text: "Group reply" }));
    test.store.enqueue(message("group", {
      groupId: "group-1",
      participants: ["+15550000002", "+15550000003"],
    }), "webhook", 1);

    await test.worker.runOnce();

    expect(test.sendblue.markRead).not.toHaveBeenCalled();
    expect(test.sendblue.setTyping).not.toHaveBeenCalled();
    expect(test.sendblue.sendGroup).toHaveBeenCalledWith(expect.objectContaining({
      groupId: "group-1",
      content: "Group reply",
    }));
    test.store.close();
  });

  it("rejects model-selected targets outside the triggering message and falls back", async () => {
    const test = harness(codexResult("session-bad", {
      reaction: { messageHandle: "other-message", value: "love" },
    }));
    test.store.enqueue(message("trigger"), "webhook", 1);

    await test.worker.runOnce();

    expect(test.sendblue.sendReaction).not.toHaveBeenCalled();
    expect(test.sendblue.sendDirect).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Hit a snag"),
    }));
    test.store.close();
  });

  it("handles /clear without calling Codex", async () => {
    const test = harness(codexResult("unused", { text: "unused" }));
    test.store.setCodexThreadId("+15550000002", "old-session", 1);
    test.store.enqueue(message("clear", { content: "/clear" }), "webhook", 2);

    await test.worker.runOnce();

    expect(test.run).not.toHaveBeenCalled();
    expect(test.store.getCodexThreadId("+15550000002")).toBeUndefined();
    expect(test.sendblue.sendDirect).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Fresh slate"),
    }));
    test.store.close();
  });


  it("passes slash-prefixed paths through to Codex and recognizes only bare commands", async () => {
    expect(controlCommandFor("/clear")).toBe("/clear");
    expect(controlCommandFor("  /Status ")).toBe("/status");
    expect(controlCommandFor("/Users/ali/app.ts is broken")).toBeUndefined();
    expect(controlCommandFor("/tmp")).toBeUndefined();
    expect(controlCommandFor("/clear the cache please")).toBeUndefined();

    const test = harness(codexResult("session-path", { bubbles: ["looking"] }));
    test.store.enqueue(message("path", { content: "/Users/ali/app.ts is broken" }), "webhook", 1);
    await test.worker.runOnce();
    expect(test.run).toHaveBeenCalledOnce();
    expect(test.sendblue.sendDirect).toHaveBeenCalledWith(expect.objectContaining({ content: "looking" }));
    test.store.close();
  });

  it("reports mode, model, in-flight work, and queue depth for /status", async () => {
    const test = harness(codexResult("unused", { text: "unused" }), {
      status: () => ({ mode: "active", model: "gpt-5.6-sol" }),
    });
    test.store.enqueue(message("older", { fromNumber: "+15550000009" }), "webhook", 1);
    test.store.enqueue(message("status", { content: "/status" }), "webhook", 2);
    test.store.claimNext(3); // "older" is now processing on another thread

    await test.worker.runOnce();

    expect(test.run).not.toHaveBeenCalled();
    expect(test.sendblue.sendDirect).toHaveBeenCalledWith(expect.objectContaining({
      content: "I’m up. Mode active, model gpt-5.6-sol. Idle right now, nothing queued.",
    }));
    test.store.close();
  });

  it("lets /clear cancel the in-flight Codex turn for that thread without a snag text", async () => {
    let abortSignal: AbortSignal | undefined;
    const test = harness(codexResult("unused", { text: "unused" }));
    test.run.mockImplementation((input) => new Promise((_resolve, reject) => {
      abortSignal = input.signal;
      input.signal?.addEventListener("abort", () => reject(new CodexRunnerError("aborted", "cancelled")), { once: true });
    }));
    test.store.enqueue(message("long-task"), "webhook", 1);
    const running = test.worker.runOnce();
    await vi.waitFor(() => expect(abortSignal).toBeDefined());

    const control = test.store.enqueue(message("clear", { content: "/clear" }), "webhook", 2);
    expect(test.store.completePending(control.job.id, 2)).toBe(true);
    await test.worker.handleControl(control.job);
    await running;

    expect(abortSignal?.aborted).toBe(true);
    expect(test.store.getJobByHandle("long-task")?.state).toBe("done");
    expect(test.sendblue.sendDirect).toHaveBeenCalledTimes(1);
    expect(test.sendblue.sendDirect).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Stopped what I was doing"),
    }));
    test.store.close();
  });

  it("re-queues an in-flight turn aborted by shutdown so the next daemon retries it", async () => {
    let abortSignal: AbortSignal | undefined;
    const test = harness(codexResult("unused", { text: "unused" }));
    test.run.mockImplementation((input) => new Promise((_resolve, reject) => {
      abortSignal = input.signal;
      input.signal?.addEventListener("abort", () => reject(new CodexRunnerError("aborted", "cancelled")), { once: true });
    }));
    test.store.enqueue(message("interrupted"), "webhook", 1);
    const running = test.worker.runOnce();
    await vi.waitFor(() => expect(abortSignal).toBeDefined());

    expect(test.worker.abortAll("shutdown")).toBe(1);
    await running;

    const job = test.store.getJobByHandle("interrupted")!;
    expect(job.state).toBe("pending");
    expect(job.errorSummary).toBe("name=CodexRunnerError code=aborted");
    expect(test.sendblue.sendDirect).not.toHaveBeenCalled();
    test.store.close();
  });

  it("does not send a snag text after a partially delivered reply", async () => {
    const test = harness(codexResult("session-partial", { bubbles: ["first", "second"] }));
    test.sendblue.sendDirect
      .mockResolvedValueOnce({ messageHandle: "one", status: "QUEUED" })
      .mockRejectedValueOnce(new Error("provider hiccup"));
    test.store.enqueue(message("partial"), "webhook", 1);

    await test.worker.runOnce();

    expect(test.sendblue.sendDirect).toHaveBeenCalledTimes(2);
    expect(test.store.getJobByHandle("partial")?.state).toBe("done");
    test.store.close();
  });
});
