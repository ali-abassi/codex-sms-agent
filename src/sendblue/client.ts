import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";

import type { InboundMessage } from "../domain/message.js";
import { normalizeV2Message } from "./normalize.js";
import { E164_PATTERN } from "../domain/phone.js";

export const SENDBLUE_API_BASE_URL = "https://api.sendblue.com";
export const SENDBLUE_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const SENDBLUE_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const E164 = E164_PATTERN;

export type SendblueErrorCode =
  | "VALIDATION_ERROR"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "ABORTED"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE";

export class SendblueError extends Error {
  readonly code: SendblueErrorCode;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly field?: string;

  constructor(
    message: string,
    details: {
      code: SendblueErrorCode;
      method?: string;
      path?: string;
      status?: number;
      field?: string;
    },
  ) {
    super(message);
    this.name = "SendblueError";
    this.code = details.code;
    this.method = details.method;
    this.path = details.path;
    this.status = details.status;
    this.field = details.field;
  }

  toJSON(): Record<string, string | number> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.method === undefined ? {} : { method: this.method }),
      ...(this.path === undefined ? {} : { path: this.path }),
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.field === undefined ? {} : { field: this.field }),
    };
  }
}

/** Errors worth retrying later: provider outages, rate limits, timeouts, network failures. */
export function isTransientSendblueError(error: unknown): boolean {
  if (!(error instanceof SendblueError)) return false;
  if (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT") return true;
  return error.code === "HTTP_ERROR" && (error.status === 429 || (error.status ?? 0) >= 500);
}

export class SendblueValidationError extends SendblueError {
  constructor(field: string, rule: string) {
    super(`Invalid Sendblue request: ${field} ${rule}`, {
      code: "VALIDATION_ERROR",
      field,
    });
    this.name = "SendblueValidationError";
  }
}

export class SendblueHttpError extends SendblueError {
  constructor(method: string, path: string, status: number) {
    super(`Sendblue request ${method} ${path} failed with HTTP ${status}`, {
      code: "HTTP_ERROR",
      method,
      path,
      status,
    });
    this.name = "SendblueHttpError";
  }
}

export class SendblueTimeoutError extends SendblueError {
  constructor(method: string, path: string) {
    super(`Sendblue request ${method} ${path} timed out`, {
      code: "TIMEOUT",
      method,
      path,
    });
    this.name = "SendblueTimeoutError";
  }
}

export class SendblueAbortError extends SendblueError {
  constructor(method: string, path: string) {
    super(`Sendblue request ${method} ${path} was aborted`, {
      code: "ABORTED",
      method,
      path,
    });
    this.name = "SendblueAbortError";
  }
}

export class SendblueNetworkError extends SendblueError {
  constructor(method: string, path: string) {
    super(`Sendblue request ${method} ${path} failed before a response`, {
      code: "NETWORK_ERROR",
      method,
      path,
    });
    this.name = "SendblueNetworkError";
  }
}

export class SendblueResponseError extends SendblueError {
  constructor(method: string, path: string, field = "body") {
    super(`Sendblue response for ${method} ${path} was malformed`, {
      code: "INVALID_RESPONSE",
      method,
      path,
      field,
    });
    this.name = "SendblueResponseError";
  }
}

export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ReplyReference = {
  messageHandle: string;
  partIndex?: number;
};

export type ListMessagesOptions = {
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "updatedAt" | "sentAt";
  orderDirection?: "asc" | "desc";
  status?: string;
  service?: "iMessage" | "SMS" | "RCS";
  isOutbound?: boolean;
  messageType?: "message" | "group";
  fromNumber?: string;
  toNumber?: string;
  number?: string;
  groupId?: string;
  sendblueNumber?: string;
  createdAtGte?: string;
  createdAtLte?: string;
  sentAtGte?: string;
  sentAtLte?: string;
  updatedAtGte?: string;
  updatedAtLte?: string;
  accountEmail?: string;
};

export type MessagePagination = {
  hasMore: boolean;
  limit: number;
  offset: number;
  total: number;
};

export type MessagePage = {
  status?: string;
  messages: InboundMessage[];
  pagination: MessagePagination;
};

export type SendMessageInput = {
  number: string;
  fromNumber?: string;
  content?: string;
  mediaUrl?: string;
  replyTo?: ReplyReference;
};

export type SendGroupMessageInput = {
  groupId: string;
  fromNumber?: string;
  content?: string;
  mediaUrl?: string;
  replyTo?: ReplyReference;
};

export type MarkReadInput = {
  number: string;
  fromNumber?: string;
};

export type TypingIndicatorInput = {
  number: string;
  fromNumber?: string;
  state: "start" | "stop";
  maxDurationMs?: number;
};

export type Reaction =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question"
  | `-${string}`
  | (string & {});

export type ReactionInput = {
  fromNumber?: string;
  messageHandle: string;
  reaction: Reaction;
  partIndex?: number;
};

export type CarouselInput = {
  number: string;
  fromNumber?: string;
  mediaUrls: string[];
  replyTo?: ReplyReference;
};

export type WebhookConfiguration = {
  url: string;
  secret?: string;
  sendblue_numbers?: string[];
};

export type ReceiveWebhook = string | WebhookConfiguration;
export type SendblueResponse = Readonly<Record<string, unknown>>;

export type SendblueClientOptions = {
  apiKeyId?: string;
  /** Compatibility alias for callers that name the key ID `apiKey`. */
  apiKey?: string;
  apiSecret: string;
  fromNumber?: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxUploadBytes?: number;
};

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SendblueValidationError(field, "must be a non-empty string");
  }
  return value;
}

function e164(value: unknown, field: string): string {
  const text = nonEmpty(value, field);
  if (!E164.test(text)) {
    throw new SendblueValidationError(field, "must be an E.164 phone number");
  }
  return text;
}

function integerInRange(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new SendblueValidationError(field, `must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function timeout(value: number | undefined): number {
  return integerInRange(
    value ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    1,
    SENDBLUE_MAX_TIMEOUT_MS,
  );
}

function replyBody(reply: ReplyReference | undefined): Record<string, unknown> | undefined {
  if (reply === undefined) return undefined;
  const messageHandle = nonEmpty(reply.messageHandle, "replyTo.messageHandle");
  if (reply.partIndex !== undefined) {
    integerInRange(reply.partIndex, "replyTo.partIndex", 0, Number.MAX_SAFE_INTEGER);
  }
  return {
    message_handle: messageHandle,
    ...(reply.partIndex === undefined ? {} : { part_index: reply.partIndex }),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function responseObject(value: unknown, method: string, path: string): SendblueResponse {
  const parsed = object(value);
  if (parsed === undefined) throw new SendblueResponseError(method, path);
  return parsed;
}

function validateDate(value: string, field: string): string {
  nonEmpty(value, field);
  if (!Number.isFinite(Date.parse(value))) {
    throw new SendblueValidationError(field, "must be an ISO-8601 timestamp");
  }
  return value;
}

function validateWebhook(entry: ReceiveWebhook): ReceiveWebhook {
  if (typeof entry === "string") {
    nonEmpty(entry, "webhook.url");
    return entry;
  }
  if (object(entry) === undefined) {
    throw new SendblueValidationError("webhook", "must be a URL or configuration object");
  }
  nonEmpty(entry.url, "webhook.url");
  if (entry.secret !== undefined) nonEmpty(entry.secret, "webhook.secret");
  if (
    entry.sendblue_numbers !== undefined &&
    (!Array.isArray(entry.sendblue_numbers) ||
      entry.sendblue_numbers.some((number) => typeof number !== "string"))
  ) {
    throw new SendblueValidationError("webhook.sendblue_numbers", "must be a string array");
  }
  return entry;
}

export class SendblueClient {
  readonly #apiKeyId: string;
  readonly #apiSecret: string;
  readonly #fromNumber?: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxUploadBytes: number;

  constructor(options: SendblueClientOptions) {
    this.#apiKeyId = nonEmpty(options.apiKeyId ?? options.apiKey, "apiKeyId");
    this.#apiSecret = nonEmpty(options.apiSecret, "apiSecret");
    this.#fromNumber = options.fromNumber === undefined
      ? undefined
      : e164(options.fromNumber, "fromNumber");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = timeout(options.timeoutMs);
    this.#maxUploadBytes = integerInRange(
      options.maxUploadBytes ?? SENDBLUE_MAX_UPLOAD_BYTES,
      "maxUploadBytes",
      1,
      SENDBLUE_MAX_UPLOAD_BYTES,
    );

    const base = new URL(options.baseUrl ?? SENDBLUE_API_BASE_URL);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username !== "" ||
      base.password !== "" ||
      base.search !== "" ||
      base.hash !== ""
    ) {
      throw new SendblueValidationError("baseUrl", "must be an HTTP(S) origin without credentials or query data");
    }
    this.#baseUrl = base.origin;
  }

  #line(fromNumber: string | undefined): string {
    return e164(fromNumber ?? this.#fromNumber, "fromNumber");
  }

  async #request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: Record<string, unknown> | FormData | undefined,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = timeout(options.timeoutMs ?? this.#timeoutMs);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortReject: ((error: SendblueAbortError) => void) | undefined;

    const onAbort = (): void => {
      controller.abort();
      abortReject?.(new SendblueAbortError(method, path));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new SendblueTimeoutError(method, path));
      }, timeoutMs);
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortReject = reject;
      if (options.signal?.aborted) onAbort();
    });

    const headers: Record<string, string> = {
      "sb-api-key-id": this.#apiKeyId,
      "sb-api-secret-key": this.#apiSecret,
    };
    if (body !== undefined && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    const fetchPromise = this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      signal: controller.signal,
    });

    try {
      const response = await Promise.race([fetchPromise, timeoutPromise, abortPromise]);
      if (!response.ok) throw new SendblueHttpError(method, path, response.status);
      const text = await response.text();
      if (text.length === 0) return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new SendblueResponseError(method, path);
      }
    } catch (error) {
      if (error instanceof SendblueError) throw error;
      if (timedOut) throw new SendblueTimeoutError(method, path);
      if (options.signal?.aborted) throw new SendblueAbortError(method, path);
      throw new SendblueNetworkError(method, path);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async listMessages(
    filters: ListMessagesOptions = {},
    options: RequestOptions = {},
  ): Promise<MessagePage> {
    const query = new URLSearchParams();
    const append = (name: string, value: string | number | boolean | undefined): void => {
      if (value !== undefined) query.set(name, String(value));
    };

    if (filters.limit !== undefined) append("limit", integerInRange(filters.limit, "limit", 1, 100));
    if (filters.offset !== undefined) append("offset", integerInRange(filters.offset, "offset", 0, Number.MAX_SAFE_INTEGER));
    append("order_by", filters.orderBy);
    append("order_direction", filters.orderDirection);
    append("status", filters.status);
    append("service", filters.service);
    append("is_outbound", filters.isOutbound);
    append("message_type", filters.messageType);
    append("from_number", filters.fromNumber);
    append("to_number", filters.toNumber);
    append("number", filters.number);
    append("group_id", filters.groupId);
    append("sendblue_number", filters.sendblueNumber);
    append("created_at_gte", filters.createdAtGte === undefined ? undefined : validateDate(filters.createdAtGte, "createdAtGte"));
    append("created_at_lte", filters.createdAtLte === undefined ? undefined : validateDate(filters.createdAtLte, "createdAtLte"));
    append("sent_at_gte", filters.sentAtGte === undefined ? undefined : validateDate(filters.sentAtGte, "sentAtGte"));
    append("sent_at_lte", filters.sentAtLte === undefined ? undefined : validateDate(filters.sentAtLte, "sentAtLte"));
    append("updated_at_gte", filters.updatedAtGte === undefined ? undefined : validateDate(filters.updatedAtGte, "updatedAtGte"));
    append("updated_at_lte", filters.updatedAtLte === undefined ? undefined : validateDate(filters.updatedAtLte, "updatedAtLte"));
    append("account_email", filters.accountEmail);

    const path = `/api/v2/messages${query.size === 0 ? "" : `?${query.toString()}`}`;
    const raw = responseObject(await this.#request("GET", path, undefined, options), "GET", "/api/v2/messages");
    if (!Array.isArray(raw.data)) throw new SendblueResponseError("GET", "/api/v2/messages", "data");
    const pagination = object(raw.pagination);
    if (
      pagination === undefined ||
      typeof pagination.hasMore !== "boolean" ||
      !Number.isInteger(pagination.limit) ||
      !Number.isInteger(pagination.offset) ||
      !Number.isInteger(pagination.total)
    ) {
      throw new SendblueResponseError("GET", "/api/v2/messages", "pagination");
    }
    return {
      ...(typeof raw.status === "string" ? { status: raw.status } : {}),
      messages: raw.data.map(normalizeV2Message),
      pagination: {
        hasMore: pagination.hasMore,
        limit: pagination.limit as number,
        offset: pagination.offset as number,
        total: pagination.total as number,
      },
    };
  }

  async sendMessage(input: SendMessageInput, options: RequestOptions = {}): Promise<SendblueResponse> {
    const number = e164(input.number, "number");
    const fromNumber = this.#line(input.fromNumber);
    const hasContent = typeof input.content === "string" && input.content.length > 0;
    const hasMedia = typeof input.mediaUrl === "string" && input.mediaUrl.length > 0;
    if (!hasContent && !hasMedia) {
      throw new SendblueValidationError("content/mediaUrl", "requires at least one value");
    }
    // Official references disagree whether 18,996 characters is inclusive, so
    // this client intentionally leaves that account policy to the orchestrator.
    const replyTo = replyBody(input.replyTo);
    return responseObject(await this.#request("POST", "/api/send-message", {
      number,
      from_number: fromNumber,
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.mediaUrl === undefined ? {} : { media_url: input.mediaUrl }),
      ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    }, options), "POST", "/api/send-message");
  }

  async sendGroupMessage(input: SendGroupMessageInput, options: RequestOptions = {}): Promise<SendblueResponse> {
    const groupId = nonEmpty(input.groupId, "groupId");
    const fromNumber = this.#line(input.fromNumber);
    const hasContent = typeof input.content === "string" && input.content.length > 0;
    const hasMedia = typeof input.mediaUrl === "string" && input.mediaUrl.length > 0;
    if (!hasContent && !hasMedia) {
      throw new SendblueValidationError("content/mediaUrl", "requires at least one value");
    }
    // New-group `numbers`/`group_id` precedence is unconfirmed; this transport
    // deliberately supports only the requested existing-group path.
    const replyTo = replyBody(input.replyTo);
    return responseObject(await this.#request("POST", "/api/send-group-message", {
      group_id: groupId,
      from_number: fromNumber,
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.mediaUrl === undefined ? {} : { media_url: input.mediaUrl }),
      ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    }, options), "POST", "/api/send-group-message");
  }

  async markRead(input: MarkReadInput | string, options: RequestOptions = {}): Promise<SendblueResponse> {
    const normalized = typeof input === "string" ? { number: input } : input;
    return responseObject(await this.#request("POST", "/api/mark-read", {
      number: e164(normalized.number, "number"),
      from_number: this.#line(normalized.fromNumber),
    }, options), "POST", "/api/mark-read");
  }

  async sendTypingIndicator(input: TypingIndicatorInput, options: RequestOptions = {}): Promise<SendblueResponse> {
    if (input.maxDurationMs !== undefined) {
      integerInRange(input.maxDurationMs, "maxDurationMs", 1, 300_000);
    }
    return responseObject(await this.#request("POST", "/api/send-typing-indicator", {
      number: e164(input.number, "number"),
      from_number: this.#line(input.fromNumber),
      state: input.state,
      ...(input.maxDurationMs === undefined ? {} : { max_duration_ms: input.maxDurationMs }),
    }, options), "POST", "/api/send-typing-indicator");
  }

  setTyping(number: string, active: boolean, maxDurationMs?: number, options: RequestOptions = {}): Promise<SendblueResponse> {
    return this.sendTypingIndicator({
      number,
      state: active ? "start" : "stop",
      ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    }, options);
  }

  async sendReaction(input: ReactionInput, options: RequestOptions = {}): Promise<SendblueResponse> {
    const reaction = nonEmpty(input.reaction, "reaction");
    if (input.partIndex !== undefined) {
      integerInRange(input.partIndex, "partIndex", 0, Number.MAX_SAFE_INTEGER);
    }
    return responseObject(await this.#request("POST", "/api/send-reaction", {
      from_number: this.#line(input.fromNumber),
      message_handle: nonEmpty(input.messageHandle, "messageHandle"),
      reaction,
      ...(input.partIndex === undefined ? {} : { part_index: input.partIndex }),
    }, options), "POST", "/api/send-reaction");
  }

  async sendCarousel(input: CarouselInput, options: RequestOptions = {}): Promise<SendblueResponse> {
    if (!Array.isArray(input.mediaUrls) || input.mediaUrls.length < 2 || input.mediaUrls.length > 20) {
      throw new SendblueValidationError("mediaUrls", "must contain 2 to 20 HTTPS URLs");
    }
    for (const mediaUrl of input.mediaUrls) {
      let parsed: URL;
      try {
        parsed = new URL(mediaUrl);
      } catch {
        throw new SendblueValidationError("mediaUrls", "must contain 2 to 20 HTTPS URLs");
      }
      if (parsed.protocol !== "https:") {
        throw new SendblueValidationError("mediaUrls", "must contain 2 to 20 HTTPS URLs");
      }
    }
    const replyTo = replyBody(input.replyTo);
    return responseObject(await this.#request("POST", "/api/send-carousel", {
      number: e164(input.number, "number"),
      from_number: this.#line(input.fromNumber),
      media_urls: [...input.mediaUrls],
      ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    }, options), "POST", "/api/send-carousel");
  }

  async uploadFile(filePath: string, options: RequestOptions = {}): Promise<string> {
    nonEmpty(filePath, "filePath");
    const details = await stat(filePath);
    if (!details.isFile()) throw new SendblueValidationError("filePath", "must identify a regular file");
    if (details.size > this.#maxUploadBytes) {
      throw new SendblueValidationError("file", `must be at most ${this.#maxUploadBytes} bytes`);
    }
    const bytes = await readFile(filePath);
    if (bytes.byteLength > this.#maxUploadBytes) {
      throw new SendblueValidationError("file", `must be at most ${this.#maxUploadBytes} bytes`);
    }
    const form = new FormData();
    form.append("file", new Blob([bytes]), basename(filePath));
    const raw = responseObject(await this.#request("POST", "/api/upload-file", form, options), "POST", "/api/upload-file");
    return nonEmpty(raw.media_url, "response.media_url");
  }

  async listReceiveWebhooks(options: RequestOptions = {}): Promise<ReceiveWebhook[]> {
    const raw = responseObject(await this.#request("GET", "/api/account/webhooks", undefined, options), "GET", "/api/account/webhooks");
    const webhooks = object(raw.webhooks);
    if (webhooks === undefined || !Array.isArray(webhooks.receive)) {
      throw new SendblueResponseError("GET", "/api/account/webhooks", "webhooks.receive");
    }
    return webhooks.receive.map((entry) => validateWebhook(entry as ReceiveWebhook));
  }

  async createReceiveWebhook(webhook: ReceiveWebhook, options: RequestOptions = {}): Promise<SendblueResponse> {
    validateWebhook(webhook);
    return responseObject(await this.#request("POST", "/api/account/webhooks", {
      webhooks: [webhook],
      type: "receive",
    }, options), "POST", "/api/account/webhooks");
  }

  async deleteReceiveWebhook(url: string, options: RequestOptions = {}): Promise<SendblueResponse> {
    nonEmpty(url, "webhook.url");
    return responseObject(await this.#request("DELETE", "/api/account/webhooks", {
      webhooks: [url],
      type: "receive",
    }, options), "DELETE", "/api/account/webhooks");
  }
}

export function createSendblueClient(options: SendblueClientOptions): SendblueClient {
  return new SendblueClient(options);
}
