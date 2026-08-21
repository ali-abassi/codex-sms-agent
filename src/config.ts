import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { z } from "zod";
import { E164_PATTERN } from "./domain/phone.js";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_TIMEOUT_MS,
} from "./codex/runner.js";
import { DEFAULT_OPERATOR_NAME } from "./codex/prompt.js";

const e164 = z.string().regex(E164_PATTERN, "must be an E.164 phone number");
const positiveMs = z.coerce.number().int().positive();
const reasoningEffort = z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const fileSchema = z.object({
  sendblueApiKey: z.string().min(1).optional(),
  sendblueApiSecret: z.string().min(1).optional(),
  sendblueNumber: e164.optional(),
  allowedPhones: z.union([z.array(e164), z.string()]).optional(),
  webhookSecret: z.string().min(16).optional(),
  mode: z.enum(["shadow", "active"]).optional(),
  host: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65_535).optional(),
  publicUrl: z.string().url().startsWith("https://").optional(),
  workspace: z.string().min(1).optional(),
  stateDir: z.string().min(1).optional(),
  codexModel: z.string().min(1).optional(),
  codexReasoningEffort: reasoningEffort.optional(),
  codexTimeoutMs: positiveMs.max(24 * 60 * 60_000).optional(),
  operatorName: z.string().trim().min(1).max(64).optional(),
  typingRefreshMs: positiveMs.max(5 * 60_000).optional(),
  pollIntervalMs: positiveMs.max(60 * 60_000).optional(),
  maxConcurrency: z.coerce.number().int().min(1).max(8).optional(),
}).strict();

type FileConfig = z.infer<typeof fileSchema>;

export type AgentConfig = {
  sendblueApiKey: string;
  sendblueApiSecret: string;
  sendblueNumber: string;
  allowedPhones: ReadonlySet<string>;
  webhookSecret: string;
  mode: "shadow" | "active";
  host: string;
  port: number;
  publicUrl?: string;
  workspace: string;
  stateDir: string;
  codexModel: string;
  codexReasoningEffort: ModelReasoningEffort;
  codexTimeoutMs: number;
  operatorName: string;
  typingRefreshMs: number;
  pollIntervalMs: number;
  maxConcurrency: number;
};

export type LoadConfigOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  scrubProcessEnv?: boolean;
};

export const SENSITIVE_ENV_NAMES = [
  "SENDBLUE_API_KEY",
  "SENDBLUE_API_SECRET",
  "WEBHOOK_SECRET",
  "CODEX_SMS_AGENT_SENDBLUE_API_KEY",
  "CODEX_SMS_AGENT_SENDBLUE_API_SECRET",
  "CODEX_SMS_AGENT_WEBHOOK_SECRET",
] as const;

function expandHome(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? resolve(homedir(), path.slice(2))
      : resolve(path);
}

function parseAllowedPhones(value: FileConfig["allowedPhones"]): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value)
    ? value
    : value.split(",").map((phone) => phone.trim()).filter(Boolean);
}

async function readConfigFile(path: string): Promise<FileConfig> {
  try {
    return fileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Invalid config file at ${path}`, { cause: error });
  }
}

function first<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

/** Preferred names are CODEX_SMS_AGENT_*; the short legacy names still work. */
const ENV_ALIASES: Record<string, readonly string[]> = {
  CONFIG: ["SMS_AGENT_CONFIG"],
  SENDBLUE_API_KEY: ["SENDBLUE_API_KEY"],
  SENDBLUE_API_SECRET: ["SENDBLUE_API_SECRET"],
  SENDBLUE_NUMBER: ["SENDBLUE_NUMBER"],
  ALLOWED_PHONES: ["ALLOWED_PHONES"],
  WEBHOOK_SECRET: ["WEBHOOK_SECRET"],
  MODE: ["SMS_AGENT_MODE"],
  HOST: ["SMS_AGENT_HOST"],
  PORT: ["SMS_AGENT_PORT"],
  PUBLIC_URL: ["PUBLIC_URL"],
  WORKSPACE: ["AGENT_WORKSPACE"],
  STATE_DIR: ["STATE_DIR"],
  CODEX_MODEL: ["CODEX_MODEL"],
  CODEX_REASONING_EFFORT: ["CODEX_REASONING_EFFORT"],
  CODEX_TIMEOUT_MS: ["CODEX_TIMEOUT_MS"],
  OPERATOR_NAME: ["OPERATOR_NAME"],
  TYPING_REFRESH_MS: ["TYPING_REFRESH_MS"],
  POLL_INTERVAL_MS: ["POLL_INTERVAL_MS"],
  MAX_CONCURRENCY: ["MAX_CONCURRENCY"],
};

export const ENV_PREFIX = "CODEX_SMS_AGENT_";

function envValue(env: NodeJS.ProcessEnv, name: keyof typeof ENV_ALIASES): string | undefined {
  return first(env[`${ENV_PREFIX}${name}`], ...ENV_ALIASES[name]!.map((alias) => env[alias]));
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AgentConfig> {
  const env = options.env ?? process.env;
  const e = (name: keyof typeof ENV_ALIASES) => envValue(env, name);
  const configPath = expandHome(options.configPath ?? e("CONFIG") ?? "~/.config/codex-sms-agent/config.json");
  const file = await readConfigFile(configPath);
  const allowedPhones = parseAllowedPhones(first(e("ALLOWED_PHONES"), file.allowedPhones));

  const candidate = {
    sendblueApiKey: first(e("SENDBLUE_API_KEY"), file.sendblueApiKey),
    sendblueApiSecret: first(e("SENDBLUE_API_SECRET"), file.sendblueApiSecret),
    sendblueNumber: first(e("SENDBLUE_NUMBER"), file.sendblueNumber),
    allowedPhones,
    webhookSecret: first(e("WEBHOOK_SECRET"), file.webhookSecret),
    mode: first(e("MODE"), file.mode, "shadow"),
    host: first(e("HOST"), file.host, "127.0.0.1"),
    port: first<string | number>(e("PORT"), file.port, 8787),
    publicUrl: first(e("PUBLIC_URL"), file.publicUrl),
    workspace: expandHome(first(e("WORKSPACE"), file.workspace, "~/.local/share/codex-sms-agent/workspace")!),
    stateDir: expandHome(first(e("STATE_DIR"), file.stateDir, "~/.local/share/codex-sms-agent")!),
    codexModel: first(e("CODEX_MODEL"), file.codexModel, DEFAULT_CODEX_MODEL),
    codexReasoningEffort: first(e("CODEX_REASONING_EFFORT"), file.codexReasoningEffort, DEFAULT_CODEX_REASONING_EFFORT),
    codexTimeoutMs: first<string | number>(e("CODEX_TIMEOUT_MS"), file.codexTimeoutMs, DEFAULT_CODEX_TIMEOUT_MS),
    operatorName: first(e("OPERATOR_NAME"), file.operatorName, DEFAULT_OPERATOR_NAME),
    typingRefreshMs: first<string | number>(e("TYPING_REFRESH_MS"), file.typingRefreshMs, 25_000),
    pollIntervalMs: first<string | number>(e("POLL_INTERVAL_MS"), file.pollIntervalMs, 60_000),
    maxConcurrency: first<string | number>(e("MAX_CONCURRENCY"), file.maxConcurrency, 1),
  };

  const parsed = z.object({
    sendblueApiKey: z.string().min(1),
    sendblueApiSecret: z.string().min(1),
    sendblueNumber: e164,
    allowedPhones: z.array(e164).min(1),
    webhookSecret: z.string().min(16),
    mode: z.enum(["shadow", "active"]),
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65_535),
    publicUrl: z.string().url().startsWith("https://").optional(),
    workspace: z.string().min(1),
    stateDir: z.string().min(1),
    codexModel: z.string().min(1),
    codexReasoningEffort: reasoningEffort,
    codexTimeoutMs: positiveMs.max(24 * 60 * 60_000),
    operatorName: z.string().trim().min(1).max(64),
    typingRefreshMs: positiveMs.max(5 * 60_000),
    pollIntervalMs: positiveMs.max(60 * 60_000),
    maxConcurrency: z.coerce.number().int().min(1).max(8),
  }).parse(candidate);

  if (options.scrubProcessEnv !== false && env === process.env) {
    for (const name of SENSITIVE_ENV_NAMES) delete process.env[name];
  }
  return { ...parsed, allowedPhones: new Set(parsed.allowedPhones) };
}

export function redactedConfig(config: AgentConfig): Record<string, unknown> {
  return {
    sendblueNumber: config.sendblueNumber,
    allowedPhones: [...config.allowedPhones],
    mode: config.mode,
    host: config.host,
    port: config.port,
    publicUrl: config.publicUrl,
    workspace: config.workspace,
    stateDir: config.stateDir,
    codexModel: config.codexModel,
    codexReasoningEffort: config.codexReasoningEffort,
    codexTimeoutMs: config.codexTimeoutMs,
    operatorName: config.operatorName,
    typingRefreshMs: config.typingRefreshMs,
    pollIntervalMs: config.pollIntervalMs,
    maxConcurrency: config.maxConcurrency,
  };
}
