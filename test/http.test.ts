import { afterEach, describe, expect, it, vi } from "vitest";
import { startHttpServer, type RunningHttpServer } from "../src/http/server.js";

const servers: RunningHttpServer[] = [];

async function server(overrides: Partial<Parameters<typeof startHttpServer>[0]> = {}) {
  const onWebhook = vi.fn(async () => "queued" as const);
  const running = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    webhookSecret: "0123456789abcdef",
    onWebhook,
    health: () => ({ queue: "ready" }),
    ...overrides,
  });
  servers.push(running);
  return { running, onWebhook, url: `http://127.0.0.1:${running.port}` };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
});

describe("local webhook server", () => {
  it("serves a secret-free health response", async () => {
    const test = await server();
    const response = await fetch(`${test.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, queue: "ready" });
  });

  it("authenticates with Sendblue's signing-secret header and durably acknowledges", async () => {
    const test = await server();
    const response = await fetch(`${test.url}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-signing-secret": "0123456789abcdef",
      },
      body: JSON.stringify({ message_handle: "message" }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, disposition: "queued" });
    expect(test.onWebhook).toHaveBeenCalledWith({ message_handle: "message" });
  });

  it("rejects missing or wrong secrets before parsing the body", async () => {
    const test = await server();
    for (const secret of [undefined, "wrong"]) {
      const response = await fetch(`${test.url}/webhook`, {
        method: "POST",
        headers: secret ? { "sb-signing-secret": secret } : {},
        body: "not-json",
      });
      expect(response.status).toBe(401);
    }
    expect(test.onWebhook).not.toHaveBeenCalled();
  });

  it("bounds request bodies and reports invalid JSON without leaking payloads", async () => {
    const test = await server({ maxBodyBytes: 16 });
    const headers = { "sb-signing-secret": "0123456789abcdef" };

    const tooLarge = await fetch(`${test.url}/webhook`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "a secret payload" }),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.text()).not.toContain("secret payload");

    const invalid = await fetch(`${test.url}/webhook`, {
      method: "POST",
      headers,
      body: "{bad",
    });
    expect(invalid.status).toBe(400);
  });

  it("returns duplicate and ignored dispositions as successful idempotent acknowledgements", async () => {
    for (const disposition of ["duplicate", "ignored"] as const) {
      const test = await server({ onWebhook: vi.fn(async () => disposition) });
      const response = await fetch(`${test.url}/webhook`, {
        method: "POST",
        headers: { "sb-signing-secret": "0123456789abcdef" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, disposition });
    }
  });

  it("keeps internal failures and payloads out of logs and responses", async () => {
    const errors: string[] = [];
    const test = await server({
      onWebhook: vi.fn(async () => { throw new Error("credential-sentinel"); }),
      logger: { error: (message) => errors.push(message) },
    });
    const response = await fetch(`${test.url}/webhook`, {
      method: "POST",
      headers: { "sb-signing-secret": "0123456789abcdef" },
      body: JSON.stringify({ content: "payload-sentinel" }),
    });

    expect(response.status).toBe(500);
    const observable = `${await response.text()}\n${errors.join("\n")}`;
    expect(observable).not.toContain("credential-sentinel");
    expect(observable).not.toContain("payload-sentinel");
  });
});
