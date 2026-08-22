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
/** E.164 numbers anywhere inside a string, not just as the whole value. */
const embeddedE164 = /\+[1-9]\d{7,14}/g;
/** Shapes that carry credentials: API keys, bearer tokens, long hex or base64 blobs. */
const secretShape = new RegExp([
  "\\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}",      // provider API keys
  "\\bBearer\\s+[A-Za-z0-9._-]{12,}",         // bearer tokens
  "\\beyJ[A-Za-z0-9._-]{16,}",                // bare JWTs
  "\\b[A-Fa-f0-9]{32,}\\b",                   // hex secrets, including our webhook secret
  "\\b[A-Za-z0-9+/]{20,}={1,2}",             // padded base64
].join("|"), "g");
const MAX_MESSAGE_LENGTH = 300;

function maskPhone(value: string): string {
  return `${value.slice(0, 2)}***${value.slice(-4)}`;
}

/**
 * Error messages are the only free text we keep, because without them a log says
 * where something broke but never why. Scrub anything credential-shaped first.
 */
function scrubMessage(value: string): string {
  const scrubbed = value
    .replace(embeddedE164, (match) => maskPhone(match))
    .replace(secretShape, "[redacted]");
  return scrubbed.length > MAX_MESSAGE_LENGTH
    ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : scrubbed;
}

function safeValue(key: string, value: unknown, depth = 0): unknown {
  if (sensitiveKey.test(key)) return "[redacted]";
  if (depth > 3) return "[truncated]";
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code;
    return {
      name: value.name,
      ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
      ...(value.message ? { message: scrubMessage(value.message) } : {}),
    };
  }
  if (typeof value === "string") {
    if (e164.test(value)) return maskPhone(value);
    const masked = value.replace(embeddedE164, (match) => maskPhone(match));
    return masked.length > 500 ? `${masked.slice(0, 499)}…` : masked;
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
