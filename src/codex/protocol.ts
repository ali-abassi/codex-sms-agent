import { isAbsolute } from "node:path";
import { z } from "zod";

export const MAX_FALLBACK_TEXT_CHARS = 1000;
export const MAX_CAPTION_CHARS = 1000;
export const MAX_CAROUSEL_ITEMS = 20;
export const MIN_CAROUSEL_ITEMS = 2;
export const MAX_TEXT_BUBBLES = 4;

/** JSON Schema sent to Codex; Zod remains the final host authority. */
export const FINAL_ENVELOPE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    bubbles: {
      type: "array",
      minItems: 1,
      maxItems: MAX_TEXT_BUBBLES,
      items: { type: "string", minLength: 1, maxLength: MAX_FALLBACK_TEXT_CHARS },
    },
    reaction: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["value", "messageHandle"],
          properties: {
            value: { type: "string", minLength: 1, maxLength: 32 },
            messageHandle: { type: ["string", "null"], minLength: 1, maxLength: 512 },
          },
        },
        { type: "null" },
      ],
    },
    media: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "localPath", "url", "caption"],
          properties: {
            kind: { type: "string", const: "local" },
            localPath: { type: "string", minLength: 1, maxLength: 4096, pattern: "^/" },
            url: { type: "null" },
            caption: { type: ["string", "null"], minLength: 1, maxLength: MAX_CAPTION_CHARS },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "localPath", "url", "caption"],
          properties: {
            kind: { type: "string", const: "https" },
            localPath: { type: "null" },
            url: { type: "string", minLength: 1, maxLength: 2048, pattern: "^https://" },
            caption: { type: ["string", "null"], minLength: 1, maxLength: MAX_CAPTION_CHARS },
          },
        },
        { type: "null" },
      ],
    },
    carousel: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["urls"],
          properties: {
            urls: {
              type: "array",
              minItems: MIN_CAROUSEL_ITEMS,
              maxItems: MAX_CAROUSEL_ITEMS,
              items: { type: "string", minLength: 1, maxLength: 2048, pattern: "^https://" },
            },
          },
        },
        { type: "null" },
      ],
    },
  },
  required: ["bubbles", "reaction", "media", "carousel"],
} as const;

const handleSchema = z.string().trim().min(1).max(512);
const textSchema = z.string().trim().min(1).max(MAX_FALLBACK_TEXT_CHARS);
const captionSchema = z.string().trim().min(1).max(MAX_CAPTION_CHARS);

export const httpsUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Expected a credential-free HTTPS URL");

const localMediaSchema = z
  .object({
    kind: z.literal("local"),
    localPath: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((value) => isAbsolute(value), "Expected an absolute local path"),
    caption: captionSchema.optional(),
  })
  .strict();

const httpsMediaSchema = z
  .object({
    kind: z.literal("https"),
    url: httpsUrlSchema,
    caption: captionSchema.optional(),
  })
  .strict();

export const finalEnvelopeSchema = z
  .object({
    bubbles: z.array(textSchema).min(1).max(MAX_TEXT_BUBBLES).optional(),
    // Accepted for graceful fallback and older saved sessions. New turns use bubbles.
    text: textSchema.optional(),
    reaction: z
      .object({
        value: z.string().trim().min(1).max(32),
        // Omission targets the current inbound message.
        messageHandle: handleSchema.optional(),
      })
      .strict()
      .optional(),
    media: z.union([localMediaSchema, httpsMediaSchema]).optional(),
    carousel: z
      .object({
        urls: z
          .array(httpsUrlSchema)
          .min(MIN_CAROUSEL_ITEMS)
          .max(MAX_CAROUSEL_ITEMS),
      })
      .strict()
      .optional(),
    replyTo: handleSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.bubbles && value.text) {
      context.addIssue({
        code: "custom",
        message: "Use bubbles or text, not both",
      });
    }
    if (!value.bubbles && !value.text && !value.reaction && !value.media && !value.carousel) {
      context.addIssue({
        code: "custom",
        message: "At least one host action is required",
      });
    }
    if (value.replyTo && !value.bubbles && !value.text && !value.media && !value.carousel) {
      context.addIssue({
        code: "custom",
        message: "replyTo requires a text, media, or carousel send",
        path: ["replyTo"],
      });
    }
  });

export type FinalEnvelope = z.infer<typeof finalEnvelopeSchema>;

export type ParsedFinalEnvelope = {
  envelope: FinalEnvelope;
  source: "json" | "fallback";
  reason?: "malformed_json" | "invalid_actions";
};

export function stripJsonCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return (match?.[1] ?? trimmed).trim();
}

function normalizeText(value: string): string {
  return value
    .replace(/\s*—\s*/g, ", ")
    .trim();
}

function boundPlainText(value: string): string {
  const normalized = normalizeText(value) || "I couldn't prepare a response. Please try again.";
  const characters = Array.from(normalized);
  if (characters.length <= MAX_FALLBACK_TEXT_CHARS) return normalized;
  return `${characters.slice(0, MAX_FALLBACK_TEXT_CHARS - 1).join("")}…`;
}

function repairJsonTypography(value: string): string {
  return value
    .replace(/([\[{,]\s*)[“”]/g, '$1"')
    .replace(/[“”](\s*:)/g, '"$1')
    .replace(/(:\s*)[“”]/g, '$1"')
    .replace(/[“”](\s*[,}\]])/g, '"$1');
}

const CANNED_PREAMBLE = /^(?:alright|okay|sure)[,.!]?\s+(?:here(?:'|’)s (?:what|the)|this is what)[^:.\n]*[:.]?\s*/i;

/** Drop a canned opener but keep the answer that follows it. */
function stripCannedPreamble(value: string): string {
  if (!CANNED_PREAMBLE.test(value)) return value;
  const stripped = value.replace(CANNED_PREAMBLE, "").trim();
  if (stripped.length === 0) return value;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function sanitizeCandidate(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
  const repaired = { ...(candidate as Record<string, unknown>) };
  if (Array.isArray(repaired.bubbles)) {
    const bubbles = repaired.bubbles
      .filter((bubble): bubble is string => typeof bubble === "string")
      .map(normalizeText)
      .map(stripCannedPreamble)
      .filter((bubble) => bubble.length > 0)
      .slice(0, MAX_TEXT_BUBBLES);
    if (bubbles.length > 0) repaired.bubbles = bubbles;
    else delete repaired.bubbles;
    if (repaired.bubbles) delete repaired.text;
  }
  if (typeof repaired.text === "string") repaired.text = normalizeText(repaired.text);
  return repaired;
}

/**
 * Converts model output into a safe host envelope. Invalid JSON or actions are
 * rendered only as bounded text; they are never returned as executable actions.
 */
export function parseFinalEnvelope(output: string): ParsedFinalEnvelope {
  const unfenced = stripJsonCodeFence(output);
  let candidate: unknown;

  try {
    candidate = JSON.parse(unfenced);
  } catch {
    try {
      candidate = JSON.parse(repairJsonTypography(unfenced));
    } catch {
      const fallback = unfenced.startsWith("{")
        ? "I couldn't format that response cleanly. Try me again."
        : boundPlainText(unfenced);
      return {
        envelope: { bubbles: [fallback] },
        source: "fallback",
        reason: "malformed_json",
      };
    }
  }

  candidate = sanitizeCandidate(candidate);
  const validated = finalEnvelopeSchema.safeParse(candidate);
  if (validated.success) {
    return { envelope: validated.data, source: "json" };
  }

  const fallback = typeof candidate === "string"
    ? boundPlainText(candidate)
    : "I couldn't format that response cleanly. Try me again.";
  return {
    envelope: { bubbles: [fallback] },
    source: "fallback",
    reason: "invalid_actions",
  };
}
