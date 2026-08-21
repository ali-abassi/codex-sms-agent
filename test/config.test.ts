import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, redactedConfig } from "../src/config.js";

const tempDirs: string[] = [];

async function configFile(overrides: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-sms-config-"));
  tempDirs.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify({
    sendblueApiKey: "key",
    sendblueApiSecret: "secret",
    sendblueNumber: "+15551234567",
    allowedPhones: ["+15557654321"],
    webhookSecret: "0123456789abcdef",
    workspace: join(directory, "workspace"),
    stateDir: join(directory, "state"),
    ...overrides,
  }));
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  it("loads a private config file and applies safe defaults", async () => {
    const config = await loadConfig({
      configPath: await configFile(),
      env: {},
    });

    expect([...config.allowedPhones]).toEqual(["+15557654321"]);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.codexModel).toBe("gpt-5.6-sol");
    expect(config.codexReasoningEffort).toBe("medium");
    expect(config.maxConcurrency).toBe(1);
  });

  it("lets environment values override file values and parses phone lists", async () => {
    const config = await loadConfig({
      configPath: await configFile(),
      env: {
        ALLOWED_PHONES: "+15550000001, +15550000002",
        PORT: "9999",
        CODEX_MODEL: "gpt-5.3-codex",
        CODEX_REASONING_EFFORT: "minimal",
      },
    });

    expect([...config.allowedPhones]).toEqual(["+15550000001", "+15550000002"]);
    expect(config.port).toBe(9999);
    expect(config.codexModel).toBe("gpt-5.3-codex");
    expect(config.codexReasoningEffort).toBe("minimal");
  });

  it("rejects malformed phone numbers and short webhook secrets", async () => {
    await expect(loadConfig({
      configPath: await configFile({
        allowedPhones: ["555-not-e164"],
        webhookSecret: "short",
      }),
      env: {},
    })).rejects.toThrow("Invalid config file");
  });

  it("removes sensitive credentials from the live process environment after loading", async () => {
    const original = {
      SENDBLUE_API_KEY: process.env.SENDBLUE_API_KEY,
      SENDBLUE_API_SECRET: process.env.SENDBLUE_API_SECRET,
      WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    };
    process.env.SENDBLUE_API_KEY = "env-key";
    process.env.SENDBLUE_API_SECRET = "env-secret";
    process.env.WEBHOOK_SECRET = "0123456789abcdef";

    try {
      await loadConfig({ configPath: await configFile() });
      expect(process.env.SENDBLUE_API_KEY).toBeUndefined();
      expect(process.env.SENDBLUE_API_SECRET).toBeUndefined();
      expect(process.env.WEBHOOK_SECRET).toBeUndefined();
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("never exposes credentials in the redacted summary", async () => {
    const config = await loadConfig({
      configPath: await configFile(),
      env: {},
    });

    const text = JSON.stringify(redactedConfig(config));
    expect(text).not.toContain("key");
    expect(text).not.toContain("secret");
    expect(text).toContain("gpt-5.6-sol");
  });
});
