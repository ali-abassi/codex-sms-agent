import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SendblueClient,
  SendblueError,
  SendblueHttpError,
  SendblueNetworkError,
  SendblueTimeoutError,
  isTransientSendblueError,
  SendblueValidationError,
} from "../src/sendblue/client.js";
import {
  normalizeReceiveWebhook,
  SendblueNormalizationError,
} from "../src/sendblue/normalize.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type Call = { url: string; init?: RequestInit };

function response(body: unknown = { status: "OK" }, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harness(replies: Response[] = []) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return replies.shift() ?? response();
  });
  const client = new SendblueClient({
    apiKeyId: "private-key-id",
    apiSecret: "private-secret",
    fromNumber: "+15550000001",
    fetch: fetcher as typeof fetch,
  });
  return { client, calls, fetcher };
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body));
}

function inbound(overrides: Record<string, unknown> = {}) {
  return {
    message_handle: "message-1",
    from_number: "+15550000002",
    to_number: "+15550000001",
    sendblue_number: "+15550000001",
    content: "hello",
    media_url: "",
    service: "iMessage",
    group_id: "",
    participants: ["+15550000002", "+15550000001"],
    date_sent: "2026-08-19T22:00:00Z",
    ...overrides,
  };
}

describe("SendblueClient", () => {
  it("uses the official .com API, private headers, exact direct/group/reply bodies", async () => {
    const test = harness();
    await test.client.sendMessage({
      number: "+15550000002",
      content: "hello",
      mediaUrl: "https://example.test/image.png",
      replyTo: { messageHandle: "parent", partIndex: 1 },
    });
    await test.client.sendGroupMessage({
      groupId: "group-1",
      content: "group hello",
      replyTo: { messageHandle: "group-parent" },
    });

    expect(test.calls.map((call) => call.url)).toEqual([
      "https://api.sendblue.com/api/send-message",
      "https://api.sendblue.com/api/send-group-message",
    ]);
    expect(test.calls[0]?.init?.headers).toMatchObject({
      "sb-api-key-id": "private-key-id",
      "sb-api-secret-key": "private-secret",
      "Content-Type": "application/json",
    });
    expect(body(test.calls[0]!)).toEqual({
      number: "+15550000002",
      from_number: "+15550000001",
      content: "hello",
      media_url: "https://example.test/image.png",
      reply_to: { message_handle: "parent", part_index: 1 },
    });
    expect(body(test.calls[1]!)).toEqual({
      group_id: "group-1",
      from_number: "+15550000001",
      content: "group hello",
      reply_to: { message_handle: "group-parent" },
    });
  });

  it("maps history filters and normalizes messages/pagination", async () => {
    const test = harness([response({
      status: "OK",
      data: [inbound()],
      pagination: { hasMore: false, limit: 100, offset: 0, total: 1 },
    })]);
    const page = await test.client.listMessages({
      isOutbound: false,
      sendblueNumber: "+15550000001",
      updatedAtGte: "2026-08-19T21:00:00Z",
      orderBy: "updatedAt",
      orderDirection: "asc",
      limit: 100,
      offset: 0,
    });

    const url = new URL(test.calls[0]!.url);
    expect(url.pathname).toBe("/api/v2/messages");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      is_outbound: "false",
      sendblue_number: "+15550000001",
      updated_at_gte: "2026-08-19T21:00:00Z",
      order_by: "updatedAt",
      order_direction: "asc",
      limit: "100",
      offset: "0",
    });
    expect(page.messages[0]).toMatchObject({
      handle: "message-1",
      fromNumber: "+15550000002",
      sendblueNumber: "+15550000001",
      dateSent: Date.parse("2026-08-19T22:00:00Z"),
    });
    expect(page.pagination).toEqual({ hasMore: false, limit: 100, offset: 0, total: 1 });
  });

  it("uses exact read, typing, reaction, and carousel contracts", async () => {
    const test = harness();
    await test.client.markRead({ number: "+15550000002" });
    await test.client.sendTypingIndicator({
      number: "+15550000002",
      state: "start",
      maxDurationMs: 30_000,
    });
    await test.client.sendReaction({
      messageHandle: "message-1",
      reaction: "love",
      partIndex: 0,
    });
    await test.client.sendCarousel({
      number: "+15550000002",
      mediaUrls: ["https://example.test/1.png", "https://example.test/2.png"],
      replyTo: { messageHandle: "message-1" },
    });

    expect(test.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/mark-read",
      "/api/send-typing-indicator",
      "/api/send-reaction",
      "/api/send-carousel",
    ]);
    expect(body(test.calls[0]!)).toEqual({ number: "+15550000002", from_number: "+15550000001" });
    expect(body(test.calls[1]!)).toEqual({
      number: "+15550000002",
      from_number: "+15550000001",
      state: "start",
      max_duration_ms: 30_000,
    });
    expect(body(test.calls[2]!)).toEqual({
      from_number: "+15550000001",
      message_handle: "message-1",
      reaction: "love",
      part_index: 0,
    });
    expect(body(test.calls[3]!)).toEqual({
      number: "+15550000002",
      from_number: "+15550000001",
      media_urls: ["https://example.test/1.png", "https://example.test/2.png"],
      reply_to: { message_handle: "message-1" },
    });
  });

  it("validates carousel bounds and HTTPS URLs before network work", async () => {
    const test = harness();
    await expect(test.client.sendCarousel({
      number: "+15550000002",
      mediaUrls: ["https://example.test/one.png"],
    })).rejects.toBeInstanceOf(SendblueValidationError);
    await expect(test.client.sendCarousel({
      number: "+15550000002",
      mediaUrls: ["https://example.test/one.png", "http://example.test/two.png"],
    })).rejects.toBeInstanceOf(SendblueValidationError);
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it("uploads a bounded local file in the exact multipart file field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sendblue-upload-"));
    tempDirs.push(directory);
    const path = join(directory, "photo.png");
    await writeFile(path, new Uint8Array([1, 2, 3]));
    const test = harness([response({ media_url: "https://storage.sendblue.co/file.png" })]);

    const url = await test.client.uploadFile(path);

    expect(url).toBe("https://storage.sendblue.co/file.png");
    const form = test.calls[0]!.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(test.calls[0]?.init?.headers).not.toHaveProperty("Content-Type");
  });

  it("appends and deletes receive webhooks without using replacing PUT", async () => {
    const test = harness([
      response({ status: "OK", webhooks: { receive: ["https://example.test/webhook"] } }),
      response(),
      response(),
    ]);
    expect(await test.client.listReceiveWebhooks()).toEqual(["https://example.test/webhook"]);
    await test.client.createReceiveWebhook({
      url: "https://agent.example.test/webhook",
      secret: "webhook-secret",
      sendblue_numbers: ["+15550000001"],
    });
    await test.client.deleteReceiveWebhook("https://agent.example.test/webhook");

    expect(test.calls.map((call) => call.init?.method)).toEqual(["GET", "POST", "DELETE"]);
    expect(body(test.calls[1]!)).toEqual({
      webhooks: [{
        url: "https://agent.example.test/webhook",
        secret: "webhook-secret",
        sendblue_numbers: ["+15550000001"],
      }],
      type: "receive",
    });
    expect(body(test.calls[2]!)).toEqual({
      webhooks: ["https://agent.example.test/webhook"],
      type: "receive",
    });
  });

  it("names only the endpoint in errors, never the query string that carries the account number", async () => {
    const test = harness([response({ error: "down" }, 503)]);
    let observed = "";
    try {
      await test.client.listMessages({ sendblueNumber: "+15550000001", limit: 10 });
    } catch (error) {
      observed = JSON.stringify(error);
    }
    expect(observed).toContain("GET /api/v2/messages failed with HTTP 503");
    expect(observed).not.toContain("sendblue_number");
    expect(observed).not.toContain("15550000001");
    // The request itself still carried the filters.
    expect(String(test.fetcher.mock.calls[0]?.[0])).toContain("sendblue_number=%2B15550000001");
  });

  it("returns typed, secret-free HTTP and malformed-response errors", async () => {
    const test = harness([response({ private: "credential-sentinel" }, 401)]);
    let observed = "";
    try {
      await test.client.markRead({ number: "+15550000002" });
    } catch (error) {
      expect(error).toBeInstanceOf(SendblueError);
      observed = JSON.stringify(error);
    }
    expect(observed).toContain("HTTP 401");
    expect(observed).not.toContain("private-key-id");
    expect(observed).not.toContain("private-secret");
    expect(observed).not.toContain("credential-sentinel");
  });
});

describe("Sendblue transient classification", () => {
  it("classifies outages, rate limits, and timeouts as transient", () => {
    expect(isTransientSendblueError(new SendblueNetworkError("POST", "/x"))).toBe(true);
    expect(isTransientSendblueError(new SendblueTimeoutError("POST", "/x"))).toBe(true);
    expect(isTransientSendblueError(new SendblueHttpError("POST", "/x", 503))).toBe(true);
    expect(isTransientSendblueError(new SendblueHttpError("POST", "/x", 429))).toBe(true);
    expect(isTransientSendblueError(new SendblueHttpError("POST", "/x", 401))).toBe(false);
    expect(isTransientSendblueError(new Error("anything else"))).toBe(false);
  });
});

describe("Sendblue message normalization", () => {
  it("preserves provider identity, groups, replies, media, and raw payload", () => {
    const normalized = normalizeReceiveWebhook(inbound({
      group_id: "group-1",
      media_url: "https://storage.sendblue.co/photo.png",
      reply_to: { message_handle: "parent", part_index: 0 },
      thread_originator: { message_handle: "root", part: "p:0" },
    }));
    expect(normalized).toMatchObject({
      handle: "message-1",
      groupId: "group-1",
      mediaUrl: "https://storage.sendblue.co/photo.png",
      replyTo: "parent",
      raw: expect.objectContaining({ thread_originator: { message_handle: "root", part: "p:0" } }),
    });
  });

  it.each([
    ["handle", { message_handle: undefined }],
    ["sender", { from_number: undefined }],
    ["line", { sendblue_number: undefined }],
  ])("rejects a missing %s", (_label, override) => {
    expect(() => normalizeReceiveWebhook(inbound(override))).toThrow(SendblueNormalizationError);
  });
});
