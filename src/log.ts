import { E164_PATTERN } from "./domain/phone.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

type LogSink = (line: string) => void;

const sensitiveKey = /(secret|token|credential|authorization|api.?key|payload|content|prompt|stdout|stderr)/i;
const e164 = E164_PATTERN;

function maskPhone(value: string): string {
  return `${value.slice(0, 2)}***${value.slice(-4)}`;
}

function safeValue(key: string, value: unknown, depth = 0): unknown {
  if (sensitiveKey.test(key)) return "[redacted]";
  if (depth > 3) return "[truncated]";
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code;
    return {
      name: value.name,
      ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    };
  }
  if (typeof value === "string") {
    if (e164.test(value)) return maskPhone(value);
    return value.length > 500 ? `${value.slice(0, 499)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(key, item, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).slice(0, 50).map(([childKey, child]) => [
        childKey,
        safeValue(childKey, child, depth + 1),
      ]),
    );
  }
  return value;
}

export function createLogger(options: {
  minimumLevel?: LogLevel;
  sink?: LogSink;
  now?: () => Date;
} = {}): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const minimum = order[options.minimumLevel ?? "info"];
  const sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const write = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (order[level] < minimum) return;
    const safeFields = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, safeValue(key, value)]),
    );
    sink(JSON.stringify({
      timestamp: now().toISOString(),
      level,
      event,
      ...safeFields,
    }));
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
