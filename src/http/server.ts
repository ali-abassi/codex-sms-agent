import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type WebhookDisposition = "queued" | "duplicate" | "ignored";

export type HttpServerOptions = {
  host: string;
  port: number;
  webhookSecret: string;
  onWebhook(payload: unknown): Promise<WebhookDisposition>;
  health(): Record<string, unknown>;
  maxBodyBytes?: number;
  logger?: Pick<Console, "error">;
};

export type RunningHttpServer = {
  server: Server;
  host: string;
  port: number;
  close(): Promise<void>;
};

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw Object.assign(new Error("request_too_large"), { statusCode: 413 });
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw Object.assign(new Error("request_too_large"), { statusCode: 413 });
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_json"), { statusCode: 400 });
  }
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const logger = options.logger ?? console;
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true, ...options.health() });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      json(response, 404, { ok: false, error: "Not found" });
      return;
    }

    const signingSecret = request.headers["sb-signing-secret"];
    const provided = Array.isArray(signingSecret) ? signingSecret[0] : signingSecret;
    if (!secretMatches(provided, options.webhookSecret)) {
      json(response, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    try {
      const payload = await readJson(request, maxBodyBytes);
      const disposition = await options.onWebhook(payload);
      json(response, disposition === "queued" ? 202 : 200, { ok: true, disposition });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 400 || status === 413) {
        json(response, status, { ok: false, error: status === 413 ? "Payload too large" : "Invalid JSON" });
        return;
      }
      logger.error("Webhook ingestion failed");
      json(response, 500, { ok: false, error: "Internal error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not bind to a TCP port");
  return {
    server,
    host: options.host,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
