import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { z } from "zod";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_TIMEOUT_MS,
} from "./codex/runner.js";
import { DEFAULT_OPERATOR_NAME } from "./codex/prompt.js";

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "must be an E.164 phone number");
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

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AgentConfig> {
  const env = options.env ?? process.env;
  const configPath = expandHome(options.configPath ?? env.SMS_AGENT_CONFIG ?? "~/.config/codex-sms-agent/config.json");
  const file = await readConfigFile(configPath);
  const allowedPhones = parseAllowedPhones(first(env.ALLOWED_PHONES, file.allowedPhones));

  const candidate = {
    sendblueApiKey: first(env.SENDBLUE_API_KEY, file.sendblueApiKey),
    sendblueApiSecret: first(env.SENDBLUE_API_SECRET, file.sendblueApiSecret),
    sendblueNumber: first(env.SENDBLUE_NUMBER, file.sendblueNumber),
    allowedPhones,
    webhookSecret: first(env.WEBHOOK_SECRET, file.webhookSecret),
    mode: first(env.SMS_AGENT_MODE, file.mode, "shadow"),
    host: first(env.HOST, file.host, "127.0.0.1"),
    port: first<string | number>(env.PORT, file.port, 8787),
    publicUrl: first(env.PUBLIC_URL, file.publicUrl),
    workspace: expandHome(first(env.AGENT_WORKSPACE, file.workspace, "~/.local/share/codex-sms-agent/workspace")!),
    stateDir: expandHome(first(env.STATE_DIR, file.stateDir, "~/.local/share/codex-sms-agent")!),
    codexModel: first(env.CODEX_MODEL, file.codexModel, DEFAULT_CODEX_MODEL),
    codexReasoningEffort: first(env.CODEX_REASONING_EFFORT, file.codexReasoningEffort, DEFAULT_CODEX_REASONING_EFFORT),
    codexTimeoutMs: first<string | number>(env.CODEX_TIMEOUT_MS, file.codexTimeoutMs, DEFAULT_CODEX_TIMEOUT_MS),
    operatorName: first(env.OPERATOR_NAME, file.operatorName, DEFAULT_OPERATOR_NAME),
    typingRefreshMs: first<string | number>(env.TYPING_REFRESH_MS, file.typingRefreshMs, 25_000),
    pollIntervalMs: first<string | number>(env.POLL_INTERVAL_MS, file.pollIntervalMs, 60_000),
    maxConcurrency: first<string | number>(env.MAX_CONCURRENCY, file.maxConcurrency, 1),
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
