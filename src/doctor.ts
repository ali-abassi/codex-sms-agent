import { execFile } from "node:child_process";
import { access, mkdir, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type { AgentConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

/** Below this the SQLite queue starts failing writes with "database or disk is full". */
export const MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;

async function defaultFreeBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

export type DoctorDependencies = {
  exec?: (binary: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>;
  fetch?: typeof globalThis.fetch;
  checkPort?: (host: string, port: number) => Promise<boolean>;
  /** Free bytes on the volume holding the state directory. */
  freeBytes?: (path: string) => Promise<number>;
};

async function defaultExec(binary: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(binary, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
    },
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function defaultCheckPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function containsExactString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, expected));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => containsExactString(item, expected));
  }
  return false;
}

export async function runDoctor(
  config: AgentConfig,
  dependencies: DoctorDependencies = {},
): Promise<DoctorCheck[]> {
  const execute = dependencies.exec ?? defaultExec;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const checkPort = dependencies.checkPort ?? defaultCheckPort;
  const checks: DoctorCheck[] = [];

  try {
    const version = await execute("codex", ["--version"]);
    checks.push({ name: "codex_cli", ok: true, detail: version.stdout.trim().split("\n", 1)[0] || "available" });
  } catch {
    checks.push({ name: "codex_cli", ok: false, detail: "Cannot execute codex" });
  }

  try {
    const status = await execute("codex", ["login", "status"]);
    const authenticated = /logged in using chatgpt/i.test(`${status.stdout}\n${status.stderr ?? ""}`);
    checks.push({
      name: "codex_auth",
      ok: authenticated,
      detail: authenticated ? "ChatGPT subscription authenticated" : "Codex is not logged in with ChatGPT",
    });
  } catch {
    checks.push({ name: "codex_auth", ok: false, detail: "Run codex login" });
  }

  try {
    const response = await fetcher("https://api.sendblue.com/api/lines", {
      headers: {
        "sb-api-key-id": config.sendblueApiKey,
        "sb-api-secret-key": config.sendblueApiSecret,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    const present = response.ok && containsExactString(payload, config.sendblueNumber);
    checks.push({
      name: "sendblue_line",
      ok: present,
      detail: present ? "credentials valid; configured line present" : `Sendblue returned HTTP ${response.status} or line was absent`,
    });
  } catch {
    checks.push({ name: "sendblue_line", ok: false, detail: "Could not reach Sendblue" });
  }

  try {
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    await access(config.stateDir);
    checks.push({ name: "state_directory", ok: true, detail: "writable" });
  } catch {
    checks.push({ name: "state_directory", ok: false, detail: "not writable" });
  }

  try {
    const free = await (dependencies.freeBytes ?? defaultFreeBytes)(config.stateDir);
    const gib = (free / 1024 ** 3).toFixed(1);
    checks.push({
      name: "disk_space",
      ok: free >= MIN_FREE_DISK_BYTES,
      detail: free >= MIN_FREE_DISK_BYTES
        ? `${gib} GiB free`
        : `${gib} GiB free; the queue database fails writes when the volume fills`,
    });
  } catch {
    checks.push({ name: "disk_space", ok: true, detail: "could not measure" });
  }

  const portAvailable = await checkPort(config.host, config.port);
  let portOk = portAvailable;
  let portDetail = portAvailable
    ? `${config.host}:${config.port} available`
    : `${config.host}:${config.port} already in use`;
  if (!portAvailable) {
    // The most common reason the port is taken is that this agent is already running.
    try {
      const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
      const authority = host.includes(":") ? `[${host}]` : host;
      const response = await fetcher(`http://${authority}:${config.port}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        portOk = true;
        portDetail = `${config.host}:${config.port} in use by this agent (already running)`;
      }
    } catch {
      // Something else holds the port; keep the failure.
    }
  }
  checks.push({ name: "listen_port", ok: portOk, detail: portDetail });

  if (config.publicUrl) {
    try {
      const response = await fetcher(new URL("/health", config.publicUrl), {
        signal: AbortSignal.timeout(10_000),
      });
      checks.push({
        name: "public_tunnel",
        ok: response.ok,
        detail: response.ok ? "public health endpoint reachable" : `HTTP ${response.status}`,
      });
    } catch {
      checks.push({ name: "public_tunnel", ok: false, detail: "public health endpoint unreachable" });
    }
  } else {
    checks.push({ name: "public_tunnel", ok: true, detail: "not configured; reconciliation polling remains available" });
  }

  checks.push({
    name: "mode",
    ok: true,
    detail: config.mode === "shadow" ? "shadow (no Codex or replies)" : "active (full local Codex access enabled)",
  });
  return checks;
}
