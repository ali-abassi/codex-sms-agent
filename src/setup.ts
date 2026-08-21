import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { input, password, select } from "@inquirer/prompts";
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT } from "./codex/runner.js";
import { E164_PATTERN } from "./domain/phone.js";

export type SetupConfig = {
  sendblueApiKey: string;
  sendblueApiSecret: string;
  sendblueNumber: string;
  allowedPhones: string[];
  webhookSecret: string;
  mode: "shadow" | "active";
  codexModel?: string;
  codexReasoningEffort?: string;
  operatorName?: string;
  workspace: string;
  publicUrl?: string;
};

const e164 = E164_PATTERN;

function expandHome(path: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
}

export async function writeSetupConfig(path: string, config: SetupConfig): Promise<void> {
  const target = expandHome(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw Object.assign(new Error(`Config already exists at ${target}`), { code: "EEXIST" });
    }
    throw error;
  }
  await chmod(target, 0o600);
}

export async function runSetupWizard(options: {
  configPath?: string;
  output?: Pick<NodeJS.WriteStream, "write">;
} = {}): Promise<string> {
  const output = options.output ?? process.stdout;
  const configPath = options.configPath ?? "~/.config/codex-sms-agent/config.json";
  output.write("Codex SMS Agent setup\n\n");
  output.write("Need your Sendblue keys? Grab them from the dashboard, or run:\n");
  output.write("  sendblue login, then sendblue show-keys and sendblue lines\n\n");

  const sendblueApiKey = await password({ message: "Sendblue API key", mask: "*" });
  const sendblueApiSecret = await password({ message: "Sendblue API secret", mask: "*" });
  const sendblueNumber = await input({
    message: "Sendblue line (E.164)",
    validate: (value) => e164.test(value.trim()) || "Use E.164, for example +15551234567",
  });
  const allowed = await input({
    message: "Trusted controller phone(s), comma-separated E.164",
    validate: (value) => {
      const phones = value.split(",").map((phone) => phone.trim()).filter(Boolean);
      return phones.length > 0 && phones.every((phone) => e164.test(phone)) || "Every phone must use E.164";
    },
  });
  const operatorName = await input({
    message: "Your first name (how the agent refers to you)",
    validate: (value) => value.trim().length > 0 || "Enter a name",
  });
  const workspace = await input({
    message: "Codex working directory",
    default: "~/.local/share/codex-sms-agent/workspace",
  });
  const publicUrl = await input({
    message: "Public HTTPS tunnel URL (optional until later)",
    validate: (value) => {
      if (!value.trim()) return true;
      try {
        return new URL(value).protocol === "https:" || "URL must use HTTPS";
      } catch {
        return "Enter a valid URL";
      }
    },
  });
  const mode = await select<"shadow" | "active">({
    message: "Startup mode",
    default: "shadow",
    choices: [
      { value: "shadow", name: "Shadow — ingest/dedupe only; send nothing (recommended first)" },
      { value: "active", name: "Active — Codex can execute and reply immediately" },
    ],
  });

  await writeSetupConfig(configPath, {
    sendblueApiKey: sendblueApiKey.trim(),
    sendblueApiSecret: sendblueApiSecret.trim(),
    sendblueNumber: sendblueNumber.trim(),
    allowedPhones: allowed.split(",").map((phone) => phone.trim()).filter(Boolean),
    webhookSecret: randomBytes(32).toString("hex"),
    mode,
    codexModel: DEFAULT_CODEX_MODEL,
    codexReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    operatorName: operatorName.trim(),
    workspace: workspace.trim(),
    ...(publicUrl.trim() ? { publicUrl: publicUrl.trim() } : {}),
  });
  output.write(`\nWrote private config: ${expandHome(configPath)}\n`);
  output.write("Next: codex login && codex-sms-agent doctor && codex-sms-agent start\n");
  return expandHome(configPath);
}
