import type { InboundMessage } from "../domain/message.js";

export class SendblueNormalizationError extends Error {
  readonly code = "INVALID_SENDBLUE_MESSAGE" as const;
  readonly field: string;

  constructor(field: string) {
    super(`Invalid Sendblue message: field ${field} is missing or malformed`);
    this.name = "SendblueNormalizationError";
    this.field = field;
  }

  toJSON(): { name: string; code: string; field: string; message: string } {
    return {
      name: this.name,
      code: this.code,
      field: this.field,
      message: this.message,
    };
  }
}

function asObject(value: unknown, field = "payload"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SendblueNormalizationError(field);
  }
  return value as Record<string, unknown>;
}

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SendblueNormalizationError(field);
  }
  return value;
}

function optionalString(
  payload: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = payload[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new SendblueNormalizationError(field);
  return value;
}

function timestamp(payload: Record<string, unknown>): number {
  const value =
    optionalString(payload, "date_sent") ??
    optionalString(payload, "date_created") ??
    optionalString(payload, "date_updated");
  if (value === undefined) throw new SendblueNormalizationError("date_sent");

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new SendblueNormalizationError("date_sent");
  return parsed;
}

function replyHandle(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const reply = asObject(value, "reply_to");
  const handle = requiredString(reply, "message_handle");
  const partIndex = reply.part_index;
  if (
    partIndex !== undefined &&
    (!Number.isInteger(partIndex) || (partIndex as number) < 0)
  ) {
    throw new SendblueNormalizationError("reply_to.part_index");
  }
  return handle;
}

function validateThreadOrigin(value: unknown): void {
  if (value === undefined || value === null) return;
  const origin = asObject(value, "thread_originator");
  requiredString(origin, "message_handle");
  optionalString(origin, "part");
}

function normalizeMessage(value: unknown): InboundMessage {
  const payload = asObject(value);
  const handle = requiredString(payload, "message_handle");
  const fromNumber = requiredString(payload, "from_number");
  const sendblueNumber = requiredString(payload, "sendblue_number");

  // Receive webhooks use `to_number`; V2 outbound rows can expose their
  // recipient as `number`. Falling back to the confirmed line keeps the local
  // shape total for inbound rows where the redundant recipient is omitted.
  const toNumber =
    optionalString(payload, "to_number") ??
    optionalString(payload, "number") ??
    sendblueNumber;

  const content = payload.content;
  if (content !== undefined && content !== null && typeof content !== "string") {
    throw new SendblueNormalizationError("content");
  }

  const participants = payload.participants;
  if (
    participants !== undefined &&
    (!Array.isArray(participants) ||
      participants.some((participant) => typeof participant !== "string"))
  ) {
    throw new SendblueNormalizationError("participants");
  }

  // The domain has only the immediate-parent handle. The complete confirmed
  // reply object and thread_originator remain losslessly available in
  // rawPayload rather than inventing unsupported domain fields.
  const replyTo = replyHandle(payload.reply_to);
  validateThreadOrigin(payload.thread_originator);

  const mediaUrl = optionalString(payload, "media_url");
  return {
    handle,
    fromNumber,
    toNumber,
    sendblueNumber,
    content: typeof content === "string" ? content : "",
    ...(mediaUrl === undefined ? {} : { mediaUrl }),
    service: optionalString(payload, "service") ?? "",
    groupId: optionalString(payload, "group_id") ?? "",
    participants: participants === undefined ? [] : [...participants] as string[],
    dateSent: timestamp(payload),
    ...(replyTo === undefined ? {} : { replyTo }),
    raw: payload,
  };
}

/** Normalize an account receive-webhook payload into the daemon domain. */
export function normalizeReceiveWebhook(value: unknown): InboundMessage {
  return normalizeMessage(value);
}

/** Normalize one object returned by GET /api/v2/messages. */
export function normalizeV2Message(value: unknown): InboundMessage {
  return normalizeMessage(value);
}

