import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadInboundMedia } from "../src/media.js";

const directories: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-sms-media-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("downloadInboundMedia", () => {
  it("downloads a bounded Sendblue image to a traversal-safe private path", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
    }));

    const media = await downloadInboundMedia({
      url: "https://storage.sendblue.co/inbound/photo",
      handle: "../../unsafe handle",
      root: await root(),
      fetch: fetcher as typeof fetch,
    });

    expect(media.isImage).toBe(true);
    expect(media.bytes).toBe(3);
    expect(media.path).not.toContain("../");
    expect([...await readFile(media.path)]).toEqual([1, 2, 3]);
  });

  it.each([
    "http://storage.sendblue.co/file",
    "https://sendblue.co.evil.test/file",
    "https://user:password@storage.sendblue.co/file",
    "https://127.0.0.1/file",
  ])("rejects an untrusted or unsafe media URL: %s", async (url) => {
    await expect(downloadInboundMedia({
      url,
      handle: "message",
      root: await root(),
      fetch: vi.fn() as typeof fetch,
    })).rejects.toThrow("trusted Sendblue HTTPS URL");
  });

  it("validates every redirect destination", async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://localhost/private" },
    }));

    await expect(downloadInboundMedia({
      url: "https://storage.sendblue.co/redirect",
      handle: "message",
      root: await root(),
      fetch: fetcher as typeof fetch,
    })).rejects.toThrow("trusted Sendblue HTTPS URL");
  });

  it("rejects declared and streamed bodies above the byte limit", async () => {
    await expect(downloadInboundMedia({
      url: "https://storage.sendblue.co/large",
      handle: "declared",
      root: await root(),
      maxBytes: 2,
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-length": "3" },
      })) as typeof fetch,
    })).rejects.toThrow("2-byte limit");

    await expect(downloadInboundMedia({
      url: "https://storage.sendblue.co/chunked",
      handle: "streamed",
      root: await root(),
      maxBytes: 2,
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch,
    })).rejects.toThrow("2-byte limit");
  });

  it("surfaces HTTP failures without including the source URL", async () => {
    const secretUrl = "https://storage.sendblue.co/private-token";
    let message = "";
    try {
      await downloadInboundMedia({
        url: secretUrl,
        handle: "message",
        root: await root(),
        fetch: vi.fn(async () => new Response(null, { status: 403 })) as typeof fetch,
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("HTTP 403");
    expect(message).not.toContain("private-token");
  });
});
