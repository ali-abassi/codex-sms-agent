import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Runs the real shim (straight from src/ under Node's type stripping) against fake Codex
 * binaries, because the failure it guards against is process-level: a grandchild that
 * inherits stdout keeps the SDK's read loop open long after Codex is gone.
 */
const SHIM = resolve("src/codex/exec-shim.ts");
const directories: string[] = [];
const children: ChildProcess[] = [];
const strayPids: number[] = [];

function fakeCodex(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-shim-"));
  directories.push(dir);
  const path = join(dir, "codex");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

type Finished = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; elapsedMs: number };

function runShim(binary: string, args: string[] = [], input = ""): { child: ChildProcess; done: Promise<Finished> } {
  const started = Date.now();
  const child = spawn(process.execPath, [SHIM, ...args], {
    env: {
      ...process.env,
      CODEX_SMS_EXEC_BINARY: binary,
      CODEX_SMS_EXEC_NO_CAFFEINATE: "1",
      CODEX_SMS_EXEC_KILL_GRACE_MS: "500",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin?.end(input);
  const done = new Promise<Finished>((resolveDone) => {
    child.once("exit", (code, signal) => resolveDone({ code, signal, stdout, stderr, elapsedMs: Date.now() - started }));
  });
  return { child, done };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

afterEach(() => {
  for (const child of children.splice(0)) if (child.pid && alive(child.pid)) child.kill("SIGKILL");
  for (const pid of strayPids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codex exec shim", () => {
  it("relays stdio, arguments, and the exit code", async () => {
    const binary = fakeCodex('read line; echo "args:$*"; echo "stdin:$line"; echo "err" >&2; exit 3');
    const result = await runShim(binary, ["exec", "--experimental-json"], "hello\n").done;

    expect(result.code).toBe(3);
    expect(result.stdout).toBe("args:exec --experimental-json\nstdin:hello\n");
    expect(result.stderr).toContain("err");
  });

  it("ends the stream when Codex exits even though a grandchild still holds stdout", async () => {
    // The background sleep inherits stdout; without the shim the SDK would wait for it.
    const binary = fakeCodex('echo \'{"type":"turn.completed"}\'; sleep 20 & echo "pid:$!"; exit 0');
    const result = await runShim(binary).done;

    const pid = Number(/pid:(\d+)/.exec(result.stdout)?.[1]);
    strayPids.push(pid);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('{"type":"turn.completed"}');
    expect(result.elapsedMs).toBeLessThan(5_000);
  }, 10_000);

  it("terminates the whole Codex process tree on SIGTERM and exits within the grace", async () => {
    const binary = fakeCodex('sleep 30 & echo "child:$!"; wait');
    const { child, done } = runShim(binary);
    let grandchild = 0;
    await new Promise<void>((resolveStart) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        const match = /child:(\d+)/.exec(chunk.toString());
        if (match) { grandchild = Number(match[1]); resolveStart(); }
      });
    });
    strayPids.push(grandchild);
    expect(alive(grandchild)).toBe(true);

    child.kill("SIGTERM");
    const result = await done;

    expect(result.elapsedMs).toBeLessThan(5_000);
    expect(result.stderr).toContain("terminated: SIGTERM");
    expect(await until(() => !alive(grandchild), 2_000)).toBe(true);
  }, 10_000);

  it("still ends the turn when Codex ignores SIGTERM", async () => {
    const binary = fakeCodex('trap "" TERM; echo ready; sleep 30');
    const { child, done } = runShim(binary);
    await new Promise<void>((resolveReady) => {
      child.stdout?.on("data", (chunk: Buffer) => { if (chunk.toString().includes("ready")) resolveReady(); });
    });

    child.kill("SIGTERM");
    const result = await done;

    // 500 ms grace, then SIGKILL; well under the sleep.
    expect(result.elapsedMs).toBeLessThan(5_000);
    expect(result.code).not.toBe(0);
  }, 10_000);
});
