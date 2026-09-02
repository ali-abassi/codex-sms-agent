#!/usr/bin/env node
/**
 * Supervises one `codex exec` child on behalf of the Codex SDK.
 *
 * The SDK spawns the Codex binary with piped stdio and reads stdout until EOF. Two things
 * go wrong with that in a long-lived daemon:
 *
 *  1. On abort it sends SIGTERM to Codex alone. Whatever Codex was running (a shell tool
 *     call, a browser, a backgrounded command) keeps the stdout pipe open, so the SDK's
 *     turn never settles and the worker sits on the job for as long as that process lives.
 *  2. Even on a clean exit, a grandchild that inherited the pipe delays EOF, and with it
 *     the reply, until it exits.
 *
 * This shim sits between the two: it relays stdio, ends its own stdout the moment Codex
 * exits, and on SIGTERM/SIGINT/SIGHUP (or when its parent disappears) terminates the whole
 * Codex process tree, escalating to SIGKILL after a short grace. On macOS it also holds a
 * `caffeinate -i` assertion for the life of the child so a turn in flight keeps the
 * machine out of idle sleep.
 *
 * Self-contained on purpose: no local imports, so it runs straight from `src/` under
 * Node's type stripping in tests and from `dist/` in production.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

const KILL_GRACE_MS = positiveInteger(process.env.CODEX_SMS_EXEC_KILL_GRACE_MS, 5_000);
const DRAIN_QUIET_MS = 150;
const DRAIN_MAX_MS = 2_000;
const PARENT_POLL_MS = 1_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

type ResolvedBinary = { executablePath: string; pathDirs: string[] };

/** Mirror of the SDK's own lookup, which is skipped when `codexPathOverride` is set. */
function resolveCodexBinary(): ResolvedBinary {
  const override = process.env.CODEX_SMS_EXEC_BINARY;
  if (override) return { executablePath: override, pathDirs: [] };

  const targets: Record<string, Record<string, string>> = {
    linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
    android: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
    darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
    win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
  };
  const packages: Record<string, string> = {
    "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
    "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
    "x86_64-apple-darwin": "@openai/codex-darwin-x64",
    "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
    "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
    "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
  };
  const triple = targets[process.platform]?.[process.arch];
  const platformPackage = triple ? packages[triple] : undefined;
  if (!triple || !platformPackage) {
    throw new Error(`Unsupported platform: ${process.platform} (${process.arch})`);
  }
  const requireFromHere = createRequire(import.meta.url);
  const codexPackageJson = requireFromHere.resolve("@openai/codex/package.json");
  const platformPackageJson = createRequire(codexPackageJson).resolve(`${platformPackage}/package.json`);
  const packageRoot = join(dirname(platformPackageJson), "vendor", triple);
  const binary = process.platform === "win32" ? "codex.exe" : "codex";

  const modern = join(packageRoot, "bin", binary);
  if (isFile(modern) && isFile(join(packageRoot, "codex-package.json"))) {
    return { executablePath: modern, pathDirs: [join(packageRoot, "codex-path")].filter(isDirectory) };
  }
  const legacy = join(packageRoot, "codex", binary);
  if (isFile(legacy)) {
    return { executablePath: legacy, pathDirs: [join(packageRoot, "path")].filter(isDirectory) };
  }
  throw new Error(`Unable to locate the Codex CLI binary for ${triple}`);
}

/** Every live descendant of `root`, deepest first, from one `ps` snapshot. */
function descendantsOf(root: number): number[] {
  if (process.platform === "win32") return [];
  const snapshot = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (snapshot.status !== 0 || typeof snapshot.stdout !== "string") return [];
  const children = new Map<number, number[]>();
  for (const line of snapshot.stdout.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  const ordered: number[] = [];
  const visit = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      visit(child);
      ordered.push(child);
    }
  };
  visit(root);
  return ordered;
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  const targets = [...descendantsOf(pid), pid];
  for (const target of targets) {
    try {
      process.kill(target, signal);
    } catch {
      // Already gone.
    }
  }
}

function main(): void {
  const { executablePath, pathDirs } = resolveCodexBinary();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (pathDirs.length > 0) {
    const existing = (env.PATH ?? "").split(delimiter).filter((entry) => entry && !pathDirs.includes(entry));
    env.PATH = [...pathDirs, ...existing].join(delimiter);
  }

  const child = spawn(executablePath, process.argv.slice(2), { env, stdio: ["pipe", "pipe", "pipe"] });
  let exited = false;
  let terminating = false;
  let finished = false;

  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    // Pipe writes are asynchronous on macOS: let queued output reach the SDK before exiting.
    const hardExit = setTimeout(() => process.exit(code), 2_000);
    process.stdout.write("", () => {
      clearTimeout(hardExit);
      process.exit(code);
    });
  };

  child.once("error", (error) => {
    process.stderr.write(`codex exec could not start: ${error.message}\n`);
    finish(1);
  });

  // Keep the machine out of idle sleep while a turn is running. `-w` ties the assertion
  // to the child's lifetime, so there is nothing to clean up.
  if (
    process.platform === "darwin" && child.pid &&
    process.env.CODEX_SMS_EXEC_NO_CAFFEINATE !== "1" && existsSync("/usr/bin/caffeinate")
  ) {
    const holder = spawn("/usr/bin/caffeinate", ["-i", "-w", String(child.pid)], { stdio: "ignore", detached: true });
    holder.once("error", () => undefined);
    holder.unref();
  }

  process.stdin.on("error", () => undefined);
  child.stdin?.on("error", () => undefined);
  process.stdin.pipe(child.stdin!);

  let drainTimer: NodeJS.Timeout | undefined;
  let drainDeadline: NodeJS.Timeout | undefined;
  const scheduleDrain = () => {
    if (!exited) return;
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = setTimeout(() => finish(exitCode), DRAIN_QUIET_MS);
  };
  let exitCode = 0;

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    scheduleDrain();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  const terminate = (reason: string) => {
    if (terminating || exited) return;
    terminating = true;
    process.stderr.write(`codex exec terminated: ${reason}\n`);
    signalTree(child, "SIGTERM");
    const escalate = setTimeout(() => {
      if (!exited) signalTree(child, "SIGKILL");
      // Even if the child somehow survives, do not keep the SDK waiting.
      setTimeout(() => finish(1), 1_000).unref();
    }, KILL_GRACE_MS);
    escalate.unref();
  };

  child.once("exit", (code, signal) => {
    exited = true;
    exitCode = code ?? (signal ? 1 : 0);
    if (signal) process.stderr.write(`codex exec exited on ${signal}\n`);
    // Give already-buffered output a moment to arrive, then close regardless of any
    // grandchild that still holds the pipe.
    scheduleDrain();
    drainDeadline = setTimeout(() => finish(exitCode), DRAIN_MAX_MS);
    drainDeadline.unref();
  });

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => terminate(signal));
  }
  process.stdout.on("error", () => terminate("stdout closed"));

  const parent = process.ppid;
  const parentWatch = setInterval(() => {
    if (process.ppid !== parent) terminate("parent exited");
  }, PARENT_POLL_MS);
  parentWatch.unref();
}

main();
