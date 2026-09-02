import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { stableNodePath } from "../service.js";

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_REASONING_EFFORT: ModelReasoningEffort = "medium";
export const DEFAULT_CODEX_TIMEOUT_MS = 30 * 60_000;
/**
 * How long to wait for the SDK to settle after its turn was aborted. The SDK only
 * SIGTERMs the Codex binary and then reads stdout to EOF, so a grandchild holding the
 * pipe can keep the promise pending indefinitely; past this grace the runner gives up
 * on it and reports the timeout or cancellation itself.
 */
export const DEFAULT_ABORT_GRACE_MS = 15_000;
export const EXEC_LAUNCHER_NAME = "codex-exec";

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

  constructor(code: CodexRunnerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
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
  /** Grace for the SDK to settle after an abort before the runner reports the failure itself. */
  abortGraceMs?: number;
  /**
   * Directory for the executable that the SDK spawns instead of the raw Codex binary. It
   * wraps `codex exec` in the supervising shim (see exec-shim.ts). Defaults to a
   * per-user temp directory; the daemon points it at the state directory.
   */
  execLauncherDir?: string;
  parentEnv?: NodeJS.ProcessEnv;
  createClient?: (options: CodexOptions) => CodexLike;
};

/** Path of the supervising shim next to this module (dist/codex/exec-shim.js in production). */
export function execShimPath(): string {
  return fileURLToPath(new URL("./exec-shim.js", import.meta.url));
}

/**
 * Write (or refresh) the tiny launcher the SDK executes. The SDK spawns `codexPathOverride`
 * directly, so it must be an executable file; a shell script that execs Node on the shim
 * keeps the compiled shim itself free of permission bits.
 */
export async function ensureExecLauncher(
  directory: string,
  options: { nodePath?: string; shimPath?: string } = {},
): Promise<string> {
  // Prefer the Homebrew opt symlink over the versioned Cellar path, which vanishes on upgrade.
  const nodePath = options.nodePath ?? await stableNodePath();
  const shimPath = options.shimPath ?? execShimPath();
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const content = `#!/bin/sh\nexec ${quote(nodePath)} ${quote(shimPath)} "$@"\n`;
  const path = join(directory, EXEC_LAUNCHER_NAME);
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing !== content) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o700 });
  }
  await chmod(path, 0o700);
  return path;
}

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
  readonly abortGraceMs: number;
  readonly execLauncherDir: string;
  readonly operatorName: string;
  readonly #parentEnv: NodeJS.ProcessEnv;
  readonly #createClient: (options: CodexOptions) => CodexLike;

  constructor(options: CodexRunnerOptions = {}) {
    this.workspace = nonEmpty(options.workspace ?? join(homedir(), ".local", "share", "codex-sms-agent", "workspace"), "workspace");
    this.model = nonEmpty(options.model ?? DEFAULT_CODEX_MODEL, "model");
    this.reasoningEffort = options.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS, "timeoutMs");
    this.abortGraceMs = positiveInteger(options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS, "abortGraceMs");
    this.execLauncherDir = nonEmpty(
      options.execLauncherDir ?? join(tmpdir(), `codex-sms-agent-${process.getuid?.() ?? "user"}`),
      "execLauncherDir",
    );
    this.operatorName = options.operatorName?.trim() || DEFAULT_OPERATOR_NAME;
    this.#parentEnv = options.parentEnv ?? process.env;
    this.#createClient = options.createClient ?? ((clientOptions) => new Codex(clientOptions));
  }

  /**
   * Digest of the operator-owned part of AGENTS.md (everything outside the
   * managed block). Lets the host notice when a turn rewrote its own standing
   * instructions.
   */
  async operatorInstructionsDigest(): Promise<string> {
    const content = await readFile(join(this.workspace, "AGENTS.md"), "utf8").catch(() => "");
    const operatorPart = content.replace(/<!-- codex-sms-agent:managed:start -->[\s\S]*?<!-- codex-sms-agent:managed:end -->/, "").trim();
    return createHash("sha256").update(operatorPart).digest("hex");
  }

  /** Create the workspace and its AGENTS.md so operators can customize it before the first turn. */
  async prepareWorkspace(): Promise<string> {
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    await syncWorkspaceInstructions(this.workspace, this.operatorName);
    return join(this.workspace, "AGENTS.md");
  }

  async run(request: CodexTurnRequest): Promise<CodexTurnResult> {
    const prompt = nonEmpty(request.prompt, "prompt");
    await this.prepareWorkspace();

    const codexPathOverride = await ensureExecLauncher(this.execLauncherDir);
    const client = this.#createClient({
      codexPathOverride,
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

    // After an abort the SDK is expected to settle promptly. If it does not (the Codex
    // process tree is still holding stdout open), stop waiting and report the abort
    // ourselves; the dangling promise is observed so it can never become an unhandled
    // rejection when it finally settles.
    let graceTimer: NodeJS.Timeout | undefined;
    const abortGrace = new Promise<never>((_resolve, reject) => {
      const arm = () => {
        graceTimer = setTimeout(
          () => reject(new CodexRunnerError("aborted", `Codex did not release the turn within ${this.abortGraceMs}ms of being cancelled`)),
          this.abortGraceMs,
        );
        graceTimer.unref?.();
      };
      if (abortController.signal.aborted) arm();
      else abortController.signal.addEventListener("abort", arm, { once: true });
    });
    abortGrace.catch(() => undefined);
    const settle = (turn: Promise<RunResult>): Promise<RunResult> => {
      turn.catch(() => undefined);
      return Promise.race([turn, abortGrace]);
    };

    let threadReset = false;
    try {
      if (abortController.signal.aborted) throw new CodexRunnerError("aborted", "Codex turn was cancelled before it started");
      let thread: ThreadLike;
      let turn: RunResult;
      if (request.threadId && isCodexThreadId(request.threadId)) {
        thread = client.resumeThread(request.threadId, threadOptions);
        try {
          turn = await settle(thread.run(input, runOptions));
        } catch (error) {
          if (!isStaleThreadError(error) || abortController.signal.aborted) throw error;
          threadReset = true;
          thread = client.startThread(threadOptions);
          turn = await settle(thread.run(input, runOptions));
        }
      } else {
        thread = client.startThread(threadOptions);
        turn = await settle(thread.run(input, runOptions));
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
      if (timedOut) {
        const released = error instanceof CodexRunnerError && error.code === "aborted" ? " (Codex was still running when the runner gave up waiting)" : "";
        throw new CodexRunnerError("timeout", `Codex exceeded its ${this.timeoutMs}ms timeout${released}`);
      }
      if (error instanceof CodexRunnerError) throw error;
      if (abortController.signal.aborted) {
        throw new CodexRunnerError("aborted", "Codex turn was cancelled");
      }
      // Carry the SDK's own reason forward. Without it a failure says only that the turn
      // did not finish, which is unactionable; the logger scrubs the text before writing.
      const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
      throw new CodexRunnerError(
        "execution_failed",
        `Codex could not complete the turn${reason}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
      external?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export function createCodexRunner(options: CodexRunnerOptions = {}): CodexRunner {
  return new CodexRunner(options);
}
