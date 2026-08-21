#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, redactedConfig } from "./config.js";
import { startDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { createLogger } from "./log.js";
import { installUserService, uninstallUserService } from "./service.js";
import { runSetupWizard } from "./setup.js";
import { StateStore } from "./state/store.js";

const HELP = `Codex SMS Agent — text an autonomous Codex agent running on your computer

Usage:
  codex-sms-agent setup [--config PATH]
  codex-sms-agent doctor [--config PATH]
  codex-sms-agent start [--config PATH]
  codex-sms-agent config [--config PATH]
  codex-sms-agent tunnel [--config PATH]
  codex-sms-agent service install|uninstall [--config PATH]
  codex-sms-agent help

Security: active mode gives Codex full local access. Allowlist only contacts you fully trust.
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function configPath(args: string[]): string | undefined {
  return option(args, "--config");
}

async function start(args: string[]): Promise<void> {
  const config = await loadConfig({ configPath: configPath(args) });
  const logger = createLogger();
  const daemon = await startDaemon(config, logger);
  await new Promise<void>((resolveDone) => {
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      logger.info("shutdown_requested", { signal });
      void daemon.close().then(resolveDone, (error) => {
        logger.error("shutdown_failed", { error });
        resolveDone();
      });
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
}

async function doctor(args: string[]): Promise<void> {
  const config = await loadConfig({ configPath: configPath(args) });
  const checks = await runDoctor(config);
  const width = Math.max(...checks.map(({ name }) => name.length));
  for (const check of checks) {
    process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}\n`);
  }
  if (checks.some(({ ok }) => !ok)) process.exitCode = 1;
}

async function showConfig(args: string[]): Promise<void> {
  const config = await loadConfig({ configPath: configPath(args) });
  process.stdout.write(`${JSON.stringify(redactedConfig(config), null, 2)}\n`);
}

async function tunnel(args: string[]): Promise<void> {
  const config = await loadConfig({ configPath: configPath(args) });
  process.stdout.write(`Tailscale Funnel (recommended when already signed in):\n  tailscale funnel --bg ${config.port}\n\n`);
  process.stdout.write(`ngrok:\n  ngrok http ${config.port}\n\n`);
  process.stdout.write("After the tunnel is live, set publicUrl in the private config and register <publicUrl>/webhook as a signed Sendblue receive webhook.\n");
}

function routineInterval(value: string): number {
  const match = value.trim().match(/^(\d+)\s*([mhdw])$/i);
  if (!match) throw new Error("Routine interval must look like 30m, 2h, 1d, or 1w");
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === "m" ? 60_000
    : unit === "h" ? 3_600_000
      : unit === "d" ? 86_400_000
        : 604_800_000;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 60_000 || milliseconds > 365 * 86_400_000) {
    throw new Error("Routine interval must be between 1 minute and 365 days");
  }
  return milliseconds;
}

async function routine(args: string[]): Promise<void> {
  const databasePath = process.env.CODEX_SMS_STATE_DB;
  const thread = process.env.CODEX_SMS_THREAD_KEY;
  if (!databasePath || !thread) throw new Error("Routine control is available only inside an SMS agent turn");
  const action = args[1];
  const store = new StateStore(databasePath);
  try {
    if (action === "add") {
      const every = option(args, "--every");
      const task = option(args, "--task");
      if (!every || !task) throw new Error("routine add requires --every and --task");
      const created = store.createRoutineForThread(thread, task, routineInterval(every), Date.now());
      process.stdout.write(`${JSON.stringify({
        ok: true,
        routine: {
          id: created.id,
          task: created.task,
          intervalMs: created.intervalMs,
          nextRunAt: created.nextRunAt,
        },
      })}\n`);
      return;
    }
    if (action === "list") {
      const routines = store.listRoutines(thread).map(({ id, task, intervalMs, nextRunAt }) => ({
        id,
        task,
        intervalMs,
        nextRunAt,
      }));
      process.stdout.write(`${JSON.stringify({ ok: true, routines })}\n`);
      return;
    }
    if (action === "delete") {
      const id = Number(option(args, "--id"));
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("routine delete requires a positive --id");
      process.stdout.write(`${JSON.stringify({ ok: store.deleteRoutine(thread, id), id })}\n`);
      return;
    }
    throw new Error("routine requires add, list, or delete");
  } finally {
    store.close();
  }
}

async function service(args: string[]): Promise<void> {
  const action = args[1];
  if (action === "uninstall") {
    await uninstallUserService();
    process.stdout.write("Service removed.\n");
    return;
  }
  if (action !== "install") throw new Error("service requires install or uninstall");
  const path = configPath(args);
  const config = await loadConfig({ configPath: path });
  const cliPath = fileURLToPath(import.meta.url);
  const installed = await installUserService({
    cliPath,
    configPath: path
      ? resolve(path)
      : process.env.SMS_AGENT_CONFIG
        ? resolve(process.env.SMS_AGENT_CONFIG)
        : join(homedir(), ".config", "codex-sms-agent", "config.json"),
    stateDir: config.stateDir,
  });
  process.stdout.write(`Service installed: ${installed}\n`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? "help";
  switch (command) {
    case "setup":
      await runSetupWizard({ configPath: configPath(args) });
      break;
    case "doctor":
      await doctor(args);
      break;
    case "start":
      await start(args);
      break;
    case "config":
      await showConfig(args);
      break;
    case "tunnel":
      await tunnel(args);
      break;
    case "service":
      await service(args);
      break;
    case "routine":
      await routine(args);
      break;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`codex-sms-agent: ${message}\n`);
    process.exitCode = 1;
  });
}
