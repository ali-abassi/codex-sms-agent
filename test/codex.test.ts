import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodexOptions,
  Input,
  RunResult,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CODEX_MODEL,
  CodexRunner,
  CodexRunnerError,
  buildCodexEnvironment,
} from "../src/codex/runner.js";
import {
  FINAL_ENVELOPE_OUTPUT_SCHEMA,
  parseFinalEnvelope,
} from "../src/codex/protocol.js";
import { codexAgentsInstructions } from "../src/codex/prompt.js";

const dirs: string[] = [];
const THREAD_A = "01a00000-0000-7000-8000-000000000001";
const THREAD_B = "01a00000-0000-7000-8000-000000000002";

function completed(finalResponse = '{"bubbles":["done"],"reaction":null,"media":null,"carousel":null}'): RunResult {
  return { items: [], finalResponse, usage: null };
}

function workspace(): string {
  const path = join(tmpdir(), `codex-runner-${Math.random().toString(16).slice(2)}`);
  dirs.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CodexRunner", () => {
  it("starts a Sol thread with full access, live search, structured output, images, and a sanitized environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runner-"));
    dirs.push(root);
    await writeFile(join(root, "AGENTS.md"), "# Project instructions\nkeep this\n");
    let clientOptions: CodexOptions | undefined;
    let threadOptions: ThreadOptions | undefined;
    let input: Input | undefined;
    let turnOptions: TurnOptions | undefined;
    const run = vi.fn(async (nextInput: Input, nextOptions?: TurnOptions) => {
      input = nextInput;
      turnOptions = nextOptions;
      return completed();
    });
    const runner = new CodexRunner({
      workspace: root,
      operatorName: "Sam",
      parentEnv: {
        HOME: "/Users/tester",
        PATH: "/custom/bin",
        CODEX_HOME: "/Users/tester/.codex",
        SENDBLUE_API_KEY: "never-pass-this",
        SENDBLUE_API_SECRET: "nor-this",
        OPENAI_API_KEY: "nor-this-either",
      },
      createClient: (options) => {
        clientOptions = options;
        return {
          startThread: (options) => {
            threadOptions = options;
            return { id: THREAD_A, run };
          },
          resumeThread: vi.fn(),
        };
      },
    });

    const result = await runner.run({
      prompt: "inspect this",
      images: ["/tmp/inbound.png"],
      environment: { CODEX_SMS_STATE_DB: "/tmp/state.sqlite" },
    });

    expect(result.threadId).toBe(THREAD_A);
    expect(result.model).toBe(DEFAULT_CODEX_MODEL);
    expect(result.envelope).toMatchObject({ source: "json", envelope: { bubbles: ["done"] } });
    expect(threadOptions).toMatchObject({
      model: DEFAULT_CODEX_MODEL,
      modelReasoningEffort: "medium",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      webSearchMode: "live",
      workingDirectory: root,
      skipGitRepoCheck: true,
    });
    expect(input).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "local_image", path: "/tmp/inbound.png" },
    ]);
    expect(turnOptions?.outputSchema).toBe(FINAL_ENVELOPE_OUTPUT_SCHEMA);
    expect(clientOptions?.apiKey).toBeUndefined();
    expect(clientOptions?.env).toMatchObject({
      HOME: "/Users/tester",
      CODEX_HOME: "/Users/tester/.codex",
      CODEX_SMS_STATE_DB: "/tmp/state.sqlite",
    });
    expect(clientOptions?.env?.PATH).toContain("/Users/tester/.local/bin");
    expect(clientOptions?.env?.PATH).toContain("/opt/homebrew/bin");
    expect(clientOptions?.env).not.toHaveProperty("SENDBLUE_API_KEY");
    expect(clientOptions?.env).not.toHaveProperty("SENDBLUE_API_SECRET");
    expect(clientOptions?.env).not.toHaveProperty("OPENAI_API_KEY");
    const workspaceInstructions = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(workspaceInstructions).toContain(codexAgentsInstructions("Sam"));
    expect(workspaceInstructions).toContain("Complete Sam's request on this computer");
    expect(workspaceInstructions).toContain("## Safety");
    expect(workspaceInstructions).not.toMatch(/delegate|browser-use|macctl/);
    expect(workspaceInstructions).toContain("# Project instructions\nkeep this");
  });

  it("prepares the workspace AGENTS.md before any turn runs", async () => {
    const root = workspace();
    const runner = new CodexRunner({ workspace: root, operatorName: "Sam", createClient: () => { throw new Error("unused"); } });
    const path = await runner.prepareWorkspace();
    expect(path).toBe(join(root, "AGENTS.md"));
    expect(await readFile(path, "utf8")).toContain("Complete Sam's request");
  });

  it("resumes an existing Codex thread", async () => {
    const resumeThread = vi.fn(() => ({ id: THREAD_A, run: vi.fn(async () => completed()) }));
    const startThread = vi.fn();
    const runner = new CodexRunner({
      workspace: workspace(),
      createClient: () => ({ resumeThread, startThread }),
    });

    await runner.run({ prompt: "continue", threadId: THREAD_A });

    expect(resumeThread).toHaveBeenCalledWith(THREAD_A, expect.any(Object));
    expect(startThread).not.toHaveBeenCalled();
  });

  it("falls back to one fresh thread when a persisted Codex thread is stale", async () => {
    const staleRun = vi.fn(async () => { throw new Error("No saved session found for thread"); });
    const freshRun = vi.fn(async () => completed());
    const startThread = vi.fn(() => ({ id: THREAD_B, run: freshRun }));
    const runner = new CodexRunner({
      workspace: workspace(),
      createClient: () => ({
        resumeThread: () => ({ id: THREAD_A, run: staleRun }),
        startThread,
      }),
    });

    const result = await runner.run({ prompt: "continue", threadId: THREAD_A });

    expect(staleRun).toHaveBeenCalledOnce();
    expect(startThread).toHaveBeenCalledOnce();
    expect(freshRun).toHaveBeenCalledOnce();
    expect(result.threadId).toBe(THREAD_B);
  });

  it("treats a legacy non-Codex session ID as stale without attempting resume", async () => {
    const resumeThread = vi.fn();
    const startThread = vi.fn(() => ({ id: THREAD_B, run: vi.fn(async () => completed()) }));
    const runner = new CodexRunner({
      workspace: workspace(),
      createClient: () => ({ resumeThread, startThread }),
    });

    expect((await runner.run({ prompt: "migrate", threadId: "1780000000000-old-fx-session" })).threadId).toBe(THREAD_B);
    expect(resumeThread).not.toHaveBeenCalled();
    expect(startThread).toHaveBeenCalledOnce();
  });

  it("aborts the SDK turn at the configured timeout", async () => {
    const run = vi.fn((_input: Input, options?: TurnOptions) => new Promise<RunResult>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const runner = new CodexRunner({
      workspace: workspace(),
      timeoutMs: 10,
      createClient: () => ({
        startThread: () => ({ id: THREAD_A, run }),
        resumeThread: vi.fn(),
      }),
    });

    await expect(runner.run({ prompt: "wait" })).rejects.toMatchObject({ code: "timeout" } satisfies Partial<CodexRunnerError>);
    expect(run.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("reports an external cancellation as aborted, not timeout, and flags fresh-thread fallbacks", async () => {
    const run = vi.fn((_input: Input, options?: TurnOptions) => new Promise<RunResult>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const runner = new CodexRunner({
      workspace: workspace(),
      createClient: () => ({ startThread: () => ({ id: THREAD_A, run }), resumeThread: vi.fn() }),
    });
    const external = new AbortController();
    const pending = runner.run({ prompt: "wait", signal: external.signal });
    external.abort("cancelled");
    await expect(pending).rejects.toMatchObject({ code: "aborted" } satisfies Partial<CodexRunnerError>);

    const resetRunner = new CodexRunner({
      workspace: workspace(),
      createClient: () => ({
        resumeThread: () => ({ id: THREAD_A, run: vi.fn(async () => { throw new Error("session not found"); }) }),
        startThread: () => ({ id: THREAD_B, run: vi.fn(async () => completed()) }),
      }),
    });
    expect((await resetRunner.run({ prompt: "x", threadId: THREAD_A })).threadReset).toBe(true);
  });

  it("does not treat unrelated session errors as a stale thread", async () => {
    const startThread = vi.fn();
    const runner = new CodexRunner({
      workspace: workspace(),
      createClient: () => ({
        resumeThread: () => ({ id: THREAD_A, run: vi.fn(async () => { throw new Error("session token invalid"); }) }),
        startThread,
      }),
    });
    await expect(runner.run({ prompt: "x", threadId: THREAD_A })).rejects.toMatchObject({ code: "execution_failed" });
    expect(startThread).not.toHaveBeenCalled();
  });

  it("exposes only safe tool metadata, excluding reasoning and command content", async () => {
    const turn: RunResult = {
      finalResponse: '{"bubbles":["done"]}',
      usage: null,
      items: [
        { id: "r", type: "reasoning", text: "private reasoning" },
        { id: "c", type: "command_execution", command: "secret command", aggregated_output: "secret output", exit_code: 0, status: "completed" },
        { id: "w", type: "web_search", query: "private query" },
      ],
    };
    const runner = new CodexRunner({
      workspace: workspace(),
      createClient: () => ({
        startThread: () => ({ id: THREAD_A, run: async () => turn }),
        resumeThread: vi.fn(),
      }),
    });

    const result = await runner.run({ prompt: "research" });
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toEqual([
      { name: "command", status: "completed" },
      { name: "web_search", status: "completed" },
    ]);
    expect(JSON.stringify(result.toolCalls)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private reasoning");
  });
});

describe("final action envelope", () => {
  it("uses the strict nullable-action SDK shape and cannot request threaded replies", () => {
    expect(FINAL_ENVELOPE_OUTPUT_SCHEMA.required).toEqual(["bubbles", "reaction", "media", "carousel"]);
    expect(FINAL_ENVELOPE_OUTPUT_SCHEMA.properties.bubbles.minItems).toBe(1);
    expect(FINAL_ENVELOPE_OUTPUT_SCHEMA.properties).not.toHaveProperty("text");
    expect(FINAL_ENVELOPE_OUTPUT_SCHEMA.properties).not.toHaveProperty("replyTo");
  });

  it("validates structured bubbles and repairs smart quotes and empty bubbles", () => {
    expect(parseFinalEnvelope('{“bubbles”:[“first”,“”,“second”]}').envelope).toEqual({ bubbles: ["first", "second"] });
  });

  it("accepts the SDK's null-filled shape and the legacy text field, and digests operator instructions", async () => {
    expect(parseFinalEnvelope('{"bubbles":["hi"],"reaction":null,"media":null,"carousel":null}').envelope).toEqual({ bubbles: ["hi"] });
    expect(parseFinalEnvelope('{"bubbles":["hi"],"reaction":{"value":"love","messageHandle":null},"media":null,"carousel":null}').envelope)
      .toEqual({ bubbles: ["hi"], reaction: { value: "love" } });
    expect(parseFinalEnvelope('{"text":"legacy"}').envelope).toEqual({ bubbles: ["legacy"] });

    const root = workspace();
    const runner = new CodexRunner({ workspace: root, createClient: () => { throw new Error("unused"); } });
    await runner.prepareWorkspace();
    const clean = await runner.operatorInstructionsDigest();
    await writeFile(join(root, "AGENTS.md"), `${await readFile(join(root, "AGENTS.md"), "utf8")}\n# mine\n`);
    expect(await runner.operatorInstructionsDigest()).not.toBe(clean);
  });

  it("strips canned openers but keeps the answer behind them", () => {
    expect(parseFinalEnvelope('{"bubbles":["Okay, here\'s what I found: the build is green."]}').envelope)
      .toEqual({ bubbles: ["The build is green."] });
    expect(parseFinalEnvelope('{"bubbles":["Sure, here\'s the plan"]}').envelope)
      .toEqual({ bubbles: ["Sure, here's the plan"] });
  });

  it("keeps plain-text fallback while rejecting unsafe action envelopes", () => {
    expect(parseFinalEnvelope("plain reply").envelope).toEqual({ bubbles: ["plain reply"] });
    expect(parseFinalEnvelope('{"media":{"kind":"local","localPath":"relative.png"}}')).toMatchObject({
      source: "fallback",
      reason: "invalid_actions",
    });
  });
});

describe("buildCodexEnvironment", () => {
  it("passes only the explicit host allowlist and CODEX_SMS turn variables", () => {
    expect(buildCodexEnvironment(
      { HOME: "/home/test", PATH: "/tools", SECRET_TOKEN: "no", SENDBLUE_API_KEY: "no" },
      { CODEX_SMS_THREAD_KEY: "thread" },
    )).toMatchObject({ HOME: "/home/test", CODEX_SMS_THREAD_KEY: "thread" });
    expect(buildCodexEnvironment({ HOME: "/home/test", SECRET_TOKEN: "no" })).not.toHaveProperty("SECRET_TOKEN");
  });
});
