import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { createLogger } from "../src/log.js";
import { launchAgentPlist, stableNodePath, systemdUserUnit } from "../src/service.js";
import { writeSetupConfig } from "../src/setup.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-sms-ops-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(root: string): AgentConfig {
  return {
    sendblueApiKey: "key",
    sendblueApiSecret: "secret",
    sendblueNumber: "+15550000001",
    allowedPhones: new Set(["+15550000002"]),
    webhookSecret: "0123456789abcdef",
    mode: "shadow",
    host: "127.0.0.1",
    port: 8787,
    workspace: join(root, "workspace"),
    stateDir: join(root, "state"),
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "medium",
    codexTimeoutMs: 300_000,
    operatorName: "Sam",
    typingRefreshMs: 25_000,
    pollIntervalMs: 60_000,
    maxConcurrency: 1,
  };
}

describe("private setup config", () => {
  it("writes a mode-0600 config and refuses to overwrite it", async () => {
    const root = await directory();
    const path = join(root, "config.json");
    const value = {
      sendblueApiKey: "key",
      sendblueApiSecret: "secret",
      sendblueNumber: "+15550000001",
      allowedPhones: ["+15550000002"],
      webhookSecret: "0123456789abcdef",
      mode: "shadow" as const,
      workspace: join(root, "workspace"),
    };
    await writeSetupConfig(path, value);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(value);
    await expect(writeSetupConfig(path, value)).rejects.toMatchObject({ code: "EEXIST" });
  });
});

describe("service templates", () => {
  it("generates restartable macOS and Linux user services without credentials", () => {
    const options = {
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/codex-sms-agent/dist/cli.js",
      configPath: "/Users/test/.config/codex-sms-agent/config.json",
    };
    const plist = launchAgentPlist({ ...options, logDirectory: "/Users/test/logs" });
    const unit = systemdUserUnit(options);

    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("dev.codex-sms-agent");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("NoNewPrivileges=true");
    for (const text of [plist, unit]) {
      expect(text).not.toContain("SENDBLUE_API_SECRET");
      expect(text).not.toContain("WEBHOOK_SECRET");
    }
  });
});

describe("stable node path", () => {
  it("swaps a versioned Homebrew Cellar binary for the opt symlink when it exists", async () => {
    const root = await directory();
    await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(join(root, "opt", "node", "bin"), { recursive: true })
      .then(() => writeFile(join(root, "opt", "node", "bin", "node"), "")));
    expect(await stableNodePath(join(root, "Cellar", "node", "26.7.0", "bin", "node"))).toBe(join(root, "opt", "node", "bin", "node"));
    expect(await stableNodePath(join(root, "Cellar", "node@22", "22.1.0", "bin", "node"))).toBe(join(root, "opt", "node", "bin", "node"));
    expect(await stableNodePath("/missing/Cellar/node/1.0.0/bin/node")).toBe("/missing/Cellar/node/1.0.0/bin/node");
    expect(await stableNodePath("/usr/local/bin/node")).toBe("/usr/local/bin/node");
  });
});

describe("doctor", () => {
  it("performs only status/read checks and reports a healthy offline-install surface", async () => {
    const root = await directory();
    const execute = vi.fn(async (_binary: string, args: string[]) => ({
      stdout: args[0] === "--version" ? "codex-cli 0.149.0\n" : "",
      stderr: args[0] === "login" ? "Logged in using ChatGPT\n" : "",
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      lines: [{ phone_number: "+15550000001" }],
    }), { status: 200 }));

    const checks = await runDoctor(config(root), {
      exec: execute,
      fetch: fetcher as typeof fetch,
      checkPort: vi.fn(async () => true),
    });

    expect(checks.every(({ ok }) => ok)).toBe(true);
    expect(execute.mock.calls.map((call) => call[1])).toEqual([["--version"], ["login", "status"]]);
    expect(execute.mock.calls.flat(2)).not.toContain("exec");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(checks).toContainEqual(expect.objectContaining({ name: "disk_space", ok: true }));
  });

  it("flags a nearly full volume before the queue database starts failing writes", async () => {
    const root = await directory();
    const checks = await runDoctor(config(root), {
      exec: vi.fn(async () => ({ stdout: "codex-cli 0.149.0\n", stderr: "" })),
      fetch: vi.fn(async () => new Response(JSON.stringify({ lines: [{ phone_number: "+15550000001" }] }), { status: 200 })) as unknown as typeof fetch,
      checkPort: vi.fn(async () => true),
      freeBytes: vi.fn(async () => 512 * 1024 * 1024),
    });

    expect(checks).toContainEqual(expect.objectContaining({
      name: "disk_space",
      ok: false,
      detail: expect.stringContaining("0.5 GiB free"),
    }));
  });

  it("passes the port check when this agent already holds the port", async () => {
    const root = await directory();
    const execute = vi.fn(async (_binary: string, args: string[]) => ({
      stdout: args[0] === "--version" ? "codex-cli 0.149.0\n" : "",
      stderr: args[0] === "login" ? "Logged in using ChatGPT\n" : "",
    }));
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ lines: [{ phone_number: "+15550000001" }] }), { status: 200 });
    });

    const checks = await runDoctor(config(root), {
      exec: execute,
      fetch: fetcher as unknown as typeof fetch,
      checkPort: vi.fn(async () => false),
    });

    const port = checks.find((check) => check.name === "listen_port");
    expect(port?.ok).toBe(true);
    expect(port?.detail).toContain("already running");
  });

  it("fails the port check when something else holds the port", async () => {
    const root = await directory();
    const execute = vi.fn(async (_binary: string, args: string[]) => ({
      stdout: args[0] === "--version" ? "codex-cli 0.149.0\n" : "",
      stderr: args[0] === "login" ? "Logged in using ChatGPT\n" : "",
    }));
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/health")) throw new Error("connection refused");
      return new Response(JSON.stringify({ lines: [{ phone_number: "+15550000001" }] }), { status: 200 });
    });

    const checks = await runDoctor(config(root), {
      exec: execute,
      fetch: fetcher as unknown as typeof fetch,
      checkPort: vi.fn(async () => false),
    });

    const port = checks.find((check) => check.name === "listen_port");
    expect(port?.ok).toBe(false);
    expect(port?.detail).toContain("already in use");
  });
});

describe("structured logger", () => {
  it("redacts content, tokens, and phone numbers", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line), now: () => new Date(0) });
    logger.error("failed", {
      content: "private message",
      apiKey: "private-key",
      phone: "+15550000002",
    });
    const line = lines[0]!;
    expect(line).toContain("+1***0002");
    expect(line).not.toContain("private message");
    expect(line).not.toContain("private-key");
  });

  it("keeps error messages so failures can be diagnosed", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line), now: () => new Date(0) });
    logger.error("failed", { error: new Error("Sendblue request POST /api/send-message failed with HTTP 429") });
    expect(lines[0]!).toContain("failed with HTTP 429");
  });

  it("scrubs credentials and phone numbers out of error messages", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line), now: () => new Date(0) });
    logger.error("failed", {
      error: new Error(
        "auth failed for +15550000002 with sk-live-abcdef0123456789 and "
        + "9f8e7d6c5b4a39281706f5e4d3c2b1a0 via Bearer eyJhbGciOiJIUzI1NiJ9",
      ),
    });
    const line = lines[0]!;
    expect(line).toContain("+1***0002");
    expect(line).not.toContain("sk-live-abcdef0123456789");
    expect(line).not.toContain("9f8e7d6c5b4a39281706f5e4d3c2b1a0");
    expect(line).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(line).toContain("auth failed");
  });

  it("keeps file paths intact so failures can be traced", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line), now: () => new Date(0) });
    logger.error("failed", { error: new Error("ENOENT: /Users/someone/Documents/Projects/acmeapi/workspace") });
    expect(lines[0]!).toContain("/Users/someone/Documents/Projects/acmeapi/workspace");
  });

  it("truncates long error messages", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line), now: () => new Date(0) });
    logger.error("failed", { error: new Error("x".repeat(1000)) });
    const parsed = JSON.parse(lines[0]!) as { error: { message: string } };
    expect(parsed.error.message.length).toBe(300);
    expect(parsed.error.message.endsWith("…")).toBe(true);
  });
});
