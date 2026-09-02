import { execFile } from "node:child_process";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const SERVICE_LABEL = "dev.codex-sms-agent";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function launchAgentPlist(options: {
  nodePath: string;
  cliPath: string;
  configPath: string;
  logDirectory: string;
  workingDirectory: string;
}): string {
  const args = [options.nodePath, options.cliPath, "start", "--config", options.configPath];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `\n    <string>${xml(arg)}</string>`).join("")}\n  </array>
  <key>WorkingDirectory</key><string>${xml(options.workingDirectory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(options.logDirectory, "agent.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(options.logDirectory, "agent.error.log"))}</string>
</dict>
</plist>
`;
}

export function systemdUserUnit(options: {
  nodePath: string;
  cliPath: string;
  configPath: string;
  workingDirectory: string;
}): string {
  return `[Unit]
Description=Codex SMS Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${[options.nodePath, options.cliPath, "start", "--config", options.configPath].map(systemdQuote).join(" ")}
WorkingDirectory=${systemdQuote(options.workingDirectory)}
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

/**
 * Homebrew's real node binary lives under a versioned Cellar path that vanishes
 * on `brew upgrade node`; prefer the stable opt symlink so the service survives upgrades.
 */
export async function stableNodePath(execPath = process.execPath): Promise<string> {
  const cellar = execPath.match(/^(.*)\/Cellar\/node(?:@[^/]+)?\/[^/]+\/bin\/node$/);
  if (!cellar) return execPath;
  const candidate = join(cellar[1]!, "opt", "node", "bin", "node");
  try {
    await access(candidate);
    return candidate;
  } catch {
    return execPath;
  }
}

export async function installUserService(options: {
  cliPath: string;
  configPath: string;
  stateDir: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? await stableNodePath();
  const configPath = resolve(options.configPath);
  const logDirectory = join(options.stateDir, "logs");
  // Never the build output directory. `npm run build` deletes it, and a process whose
  // working directory has been unlinked cannot spawn anything: every child fails with
  // ENOENT until the service is restarted. The state directory is stable and is created
  // by the daemon itself.
  const workingDirectory = resolve(options.stateDir);
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  await mkdir(workingDirectory, { recursive: true, mode: 0o700 });

  if (platform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, launchAgentPlist({ nodePath, cliPath: options.cliPath, configPath, logDirectory, workingDirectory }), { mode: 0o600 });
    await chmod(path, 0o600);
    await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, path]).catch(() => undefined);
    await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, path]);
    return path;
  }

  if (platform === "linux") {
    const path = join(homedir(), ".config", "systemd", "user", "codex-sms-agent.service");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, systemdUserUnit({ nodePath, cliPath: options.cliPath, configPath, workingDirectory }), { mode: 0o600 });
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    await execFileAsync("systemctl", ["--user", "enable", "--now", "codex-sms-agent.service"]);
    return path;
  }

  throw new Error(`Service installation is unsupported on ${platform}`);
}

export async function uninstallUserService(platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, path]).catch(() => undefined);
    await rm(path, { force: true });
    return;
  }
  if (platform === "linux") {
    await execFileAsync("systemctl", ["--user", "disable", "--now", "codex-sms-agent.service"]).catch(() => undefined);
    await rm(join(homedir(), ".config", "systemd", "user", "codex-sms-agent.service"), { force: true });
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  throw new Error(`Service uninstallation is unsupported on ${platform}`);
}
