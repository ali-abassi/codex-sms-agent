import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  Codex,
  type CodexOptions,
  type Input,
  type ModelReasoningEffort,
  type RunResult,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import { buildCodexTurnPrompt, codexAgentsInstructions, DEFAULT_OPERATOR_NAME } from "./prompt.js";
import {
  FINAL_ENVELOPE_OUTPUT_SCHEMA,
  parseFinalEnvelope,
  type ParsedFinalEnvelope,
} from "./protocol.js";

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_REASONING_EFFORT: ModelReasoningEffort = "medium";
export const DEFAULT_CODEX_TIMEOUT_MS = 2 * 60 * 60_000;

const MANAGED_INSTRUCTIONS_START = "<!-- codex-sms-agent:managed:start -->";
const MANAGED_INSTRUCTIONS_END = "<!-- codex-sms-agent:managed:end -->";

async function syncWorkspaceInstructions(workspace: string, operatorName: string): Promise<void> {
  const path = join(workspace, "AGENTS.md");
  const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const managed = `${MANAGED_INSTRUCTIONS_START}\n${codexAgentsInstructions(operatorName)}\n${MANAGED_INSTRUCTIONS_END}`;
  const managedPattern = /<!-- codex-sms-agent:managed:start -->[\s\S]*?<!-- codex-sms-agent:managed:end -->/;
  let remainder = existing.replace(managedPattern, "").trim();
  await writeFile(path, remainder ? `${managed}\n\n${remainder}\n` : `${managed}\n`, { mode: 0o600 });
}

export type CodexRunnerErrorCode =
  | "invalid_configuration"
  | "timeout"
  | "aborted"
  | "execution_failed"
  | "invalid_response";

export class CodexRunnerError extends Error {
  readonly code: CodexRunnerErrorCode;

  constructor(code: CodexRunnerErrorCode, message: string) {
    super(message);
    this.name = "CodexRunnerError";
    this.code = code;
  }
}

export type CodexToolCallMetadata = {
  name: "command" | "file_change" | "mcp" | "web_search";
  status: "in_progress" | "completed" | "failed";
};

export type CodexTurnResult = {
  output: string;
  envelope: ParsedFinalEnvelope;
  threadId: string;
  model: string;
  steps: number;
  toolCalls: CodexToolCallMetadata[];
  /** True when a persisted thread could not be resumed and a fresh one was started. */
  threadReset: boolean;
};

export type CodexTurnRequest = {
  prompt: string;
  threadId?: string;
  images?: readonly string[];
  environment?: Readonly<Record<`CODEX_SMS_${string}`, string>>;
  /** External cancellation (shutdown, /restart, /clear). Distinct from the runner timeout. */
  signal?: AbortSignal;
};

type ThreadLike = {
  readonly id: string | null;
  run(input: Input, options?: TurnOptions): Promise<RunResult>;
};

type CodexLike = {
  startThread(options?: ThreadOptions): ThreadLike;
  resumeThread(id: string, options?: ThreadOptions): ThreadLike;
};

export type CodexRunnerOptions = {
  workspace?: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  timeoutMs?: number;
  /** How the agent refers to the trusted sender in its instructions. */
  operatorName?: string;
  parentEnv?: NodeJS.ProcessEnv;
  createClient?: (options: CodexOptions) => CodexLike;
};

const HOST_ENV_ALLOWLIST = [
  "HOME",
  "CODEX_HOME",
  "TMPDIR",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "TERM",
  "COLORTERM",
] as const;

function nonEmpty(value: string, name: string): string {
  if (!value.trim()) throw new CodexRunnerError("invalid_configuration", `${name} must not be empty`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CodexRunnerError("invalid_configuration", `${name} must be a positive integer`);
  }
  return value;
}

function safePath(home: string, inherited = ""): string {
  return [...new Set([
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...inherited.split(delimiter),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter(Boolean))].join(delimiter);
}

export function buildCodexEnvironment(
  parentEnv: NodeJS.ProcessEnv = process.env,
  turnEnvironment: CodexTurnRequest["environment"] = {},
): Record<string, string> {
  const home = parentEnv.HOME || homedir();
  const environment: Record<string, string> = {
    HOME: home,
    PATH: safePath(home, parentEnv.PATH),
  };
  for (const name of HOST_ENV_ALLOWLIST) {
    const value = parentEnv[name];
    if (value && !value.includes("\0")) environment[name] = value;
  }
  for (const [name, value] of Object.entries(turnEnvironment)) {
    if (/^CODEX_SMS_[A-Z0-9_]+$/.test(name) && value.length <= 4096 && !value.includes("\0")) {
      environment[name] = value;
    }
  }
  return environment;
}

export function isCodexThreadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isStaleThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /no saved session|(?:thread|session|rollout)[^\n]{0,80}?(?:not found|does not exist|no longer exists|could not be (?:found|resumed|loaded)|failed to (?:resume|load))/i.test(message);
}

function normalizeStructuredResponse(output: string): string {
  try {
    const candidate = JSON.parse(output) as Record<string, unknown>;
    if (Array.isArray(candidate.bubbles) && candidate.bubbles.length === 0) delete candidate.bubbles;
    for (const key of ["reaction", "media", "carousel"] as const) {
      if (candidate[key] === null) {
        delete candidate[key];
        continue;
      }
      if (candidate[key] && typeof candidate[key] === "object" && !Array.isArray(candidate[key])) {
        for (const [nestedKey, value] of Object.entries(candidate[key] as Record<string, unknown>)) {
          if (value === null) delete (candidate[key] as Record<string, unknown>)[nestedKey];
        }
      }
    }
    return JSON.stringify(candidate);
  } catch {
    return output;
  }
}

function metadataFor(turn: RunResult): CodexToolCallMetadata[] {
  return turn.items.flatMap((item): CodexToolCallMetadata[] => {
    if (item.type === "command_execution") {
      return [{ name: "command", status: item.status }];
    }
    if (item.type === "file_change") return [{ name: "file_change", status: item.status }];
    if (item.type === "mcp_tool_call") {
      return [{ name: "mcp", status: item.status }];
    }
    if (item.type === "web_search") return [{ name: "web_search", status: "completed" }];
    return [];
  });
}

export class CodexRunner {
  readonly workspace: string;
  readonly model: string;
  readonly reasoningEffort: ModelReasoningEffort;
  readonly timeoutMs: number;
  readonly operatorName: string;
  readonly #parentEnv: NodeJS.ProcessEnv;
  readonly #createClient: (options: CodexOptions) => CodexLike;

  constructor(options: CodexRunnerOptions = {}) {
    this.workspace = nonEmpty(options.workspace ?? join(homedir(), ".local", "share", "codex-sms-agent", "workspace"), "workspace");
    this.model = nonEmpty(options.model ?? DEFAULT_CODEX_MODEL, "model");
    this.reasoningEffort = options.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS, "timeoutMs");
    this.operatorName = options.operatorName?.trim() || DEFAULT_OPERATOR_NAME;
    this.#parentEnv = options.parentEnv ?? process.env;
    this.#createClient = options.createClient ?? ((clientOptions) => new Codex(clientOptions));
  }

  async run(request: CodexTurnRequest): Promise<CodexTurnResult> {
    const prompt = nonEmpty(request.prompt, "prompt");
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    await syncWorkspaceInstructions(this.workspace, this.operatorName);

    const client = this.#createClient({
      env: buildCodexEnvironment(this.#parentEnv, request.environment),
      config: {
        hide_agent_reasoning: true,
        show_raw_agent_reasoning: false,
        model_reasoning_summary: "none",
      },
    });
    const threadOptions: ThreadOptions = {
      model: this.model,
      modelReasoningEffort: this.reasoningEffort,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      webSearchMode: "live",
      workingDirectory: this.workspace,
      skipGitRepoCheck: true,
    };
    const input: Input = [
      { type: "text", text: buildCodexTurnPrompt(prompt) },
      ...(request.images ?? []).map((path) => ({ type: "local_image" as const, path })),
    ];
    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.timeoutMs);
    timeout.unref?.();
    const external = request.signal;
    const onExternalAbort = () => abortController.abort();
    if (external?.aborted) onExternalAbort();
    else external?.addEventListener("abort", onExternalAbort, { once: true });
    const runOptions = {
      outputSchema: FINAL_ENVELOPE_OUTPUT_SCHEMA,
      signal: abortController.signal,
    } satisfies TurnOptions;

    let threadReset = false;
    try {
      if (abortController.signal.aborted) throw new CodexRunnerError("aborted", "Codex turn was cancelled before it started");
      let thread: ThreadLike;
      let turn: RunResult;
      if (request.threadId && isCodexThreadId(request.threadId)) {
        thread = client.resumeThread(request.threadId, threadOptions);
        try {
          turn = await thread.run(input, runOptions);
        } catch (error) {
          if (!isStaleThreadError(error) || abortController.signal.aborted) throw error;
          threadReset = true;
          thread = client.startThread(threadOptions);
          turn = await thread.run(input, runOptions);
        }
      } else {
        thread = client.startThread(threadOptions);
        turn = await thread.run(input, runOptions);
      }

      if (!thread.id || !isCodexThreadId(thread.id)) {
        throw new CodexRunnerError("invalid_response", "Codex returned no valid thread ID");
      }
      const envelope = parseFinalEnvelope(normalizeStructuredResponse(turn.finalResponse));
      return {
        output: turn.finalResponse,
        envelope,
        threadId: thread.id,
        model: this.model,
        steps: turn.items.filter((item) => item.type !== "reasoning" && item.type !== "agent_message").length,
        toolCalls: metadataFor(turn),
        threadReset,
      };
    } catch (error) {
      if (error instanceof CodexRunnerError) throw error;
      if (timedOut) {
        throw new CodexRunnerError("timeout", `Codex exceeded its ${this.timeoutMs}ms timeout`);
      }
      if (abortController.signal.aborted) {
        throw new CodexRunnerError("aborted", "Codex turn was cancelled");
      }
      throw new CodexRunnerError("execution_failed", "Codex could not complete the turn");
    } finally {
      clearTimeout(timeout);
      external?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export function createCodexRunner(options: CodexRunnerOptions = {}): CodexRunner {
  return new CodexRunner(options);
}
