import { z } from 'zod';

/**
 * Parsing of Meta's WhatsApp webhook envelope into flat events.
 *
 * The wire format nests three levels deep — `entry[] → changes[] → value` — and
 * a single request may batch several unrelated events, including messages from
 * different people. Everything is parsed permissively and unknown fields are
 * kept, because Meta adds message types without notice and an unrecognised one
 * must not cause us to drop the rest of the batch.
 *
 * Reference: WhatsApp Cloud API webhook payload documentation.
 */

/** A Click-to-WhatsApp ad referral, present on the first message from an ad. */
const referralSchema = z
  .object({
    source_url: z.string().optional(),
    source_id: z.string().optional(),
    source_type: z.string().optional(),
    headline: z.string().optional(),
    body: z.string().optional(),
    ctwa_clid: z.string().optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    /** Unix seconds, delivered as a string. */
    timestamp: z.string(),
    type: z.string(),

    text: z.object({ body: z.string() }).passthrough().optional(),

    image: z
      .object({
        id: z.string(),
        mime_type: z.string().optional(),
        caption: z.string().optional(),
      })
      .passthrough()
      .optional(),
    audio: z
      .object({
        id: z.string(),
        mime_type: z.string().optional(),
        voice: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    video: z
      .object({
        id: z.string(),
        mime_type: z.string().optional(),
        caption: z.string().optional(),
      })
      .passthrough()
      .optional(),
    document: z
      .object({
        id: z.string(),
        mime_type: z.string().optional(),
        filename: z.string().optional(),
      })
      .passthrough()
      .optional(),
    sticker: z
      .object({ id: z.string(), mime_type: z.string().optional() })
      .passthrough()
      .optional(),

    /** Reply to an interactive message (button or list selection). */
    interactive: z
      .object({
        type: z.string().optional(),
        button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
        list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      })
      .passthrough()
      .optional(),

    button: z
      .object({ text: z.string(), payload: z.string().optional() })
      .passthrough()
      .optional(),

    referral: referralSchema.optional(),
  })
  .passthrough();

const statusSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    timestamp: z.string(),
    recipient_id: z.string(),
    errors: z
      .array(
        z
          .object({ code: z.number().optional(), title: z.string().optional() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const contactProfileSchema = z
  .object({
    wa_id: z.string(),
    profile: z.object({ name: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const changeValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z
      .object({
        display_phone_number: z.string().optional(),
        phone_number_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    contacts: z.array(contactProfileSchema).optional(),
    messages: z.array(messageSchema).optional(),
    statuses: z.array(statusSchema).optional(),
  })
  .passthrough();

export const webhookEnvelopeSchema = z
  .object({
    object: z.string(),
    entry: z
      .array(
        z
          .object({
            id: z.string().optional(),
            changes: z
              .array(
                z
                  .object({
                    field: z.string().optional(),
                    value: changeValueSchema,
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

/** An inbound message, flattened out of the envelope. */
export interface InboundMessageEvent {
  kind: 'message';
  /** Meta's message id. The idempotency key for webhook retries. */
  providerMessageId: string;
  /** Sender's number, as Meta sends it: digits only, no plus. */
  from: string;
  /** Display name from the sender's WhatsApp profile, when present. */
  profileName?: string;
  timestamp: Date;
  messageType: string;
  /** Text body, interactive reply title, or media caption. */
  text?: string;
  media?: {
    /** Meta media id; the binary is fetched separately from the Graph API. */
    id: string;
    mimeType?: string;
    kind: 'image' | 'audio' | 'video' | 'document' | 'sticker';
  };
  referral?: {
    sourceUrl?: string;
    sourceId?: string;
    sourceType?: string;
    headline?: string;
    ctwaClid?: string;
  };
  phoneNumberId?: string;
}

/** A delivery status update for a message we sent. */
export interface StatusEvent {
  kind: 'status';
  providerMessageId: string;
  status: string;
  recipientId: string;
  timestamp: Date;
  errorTitle?: string;
}

export type WebhookEvent = InboundMessageEvent | StatusEvent;

/**
 * Flattens a webhook envelope into individual events.
 *
 * Never throws on unexpected shapes. Meta retries any non-2xx response, so a
 * parse failure on one malformed event would cause the whole batch — including
 * valid messages from real people — to be redelivered indefinitely. Anything
 * unparseable is skipped and the rest is returned.
 */
export function extractEvents(envelope: WebhookEnvelope): WebhookEvent[] {
  const events: WebhookEvent[] = [];

  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id;

      // Profile names arrive in a sibling array keyed by wa_id, not on the
      // message itself.
      const profileNames = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        if (contact.profile?.name) {
          profileNames.set(contact.wa_id, contact.profile.name);
        }
      }

      for (const message of value.messages ?? []) {
        const event = toMessageEvent(message, profileNames, phoneNumberId);
        if (event) events.push(event);
      }

      for (const status of value.statuses ?? []) {
        events.push({
          kind: 'status',
          providerMessageId: status.id,
          status: status.status,
          recipientId: status.recipient_id,
          timestamp: parseTimestamp(status.timestamp),
          ...(status.errors?.[0]?.title ? { errorTitle: status.errors[0].title } : {}),
        });
      }
    }
  }

  return events;
}

type RawMessage = z.infer<typeof messageSchema>;

function toMessageEvent(
  message: RawMessage,
  profileNames: Map<string, string>,
  phoneNumberId: string | undefined,
): InboundMessageEvent | undefined {
  if (!message.id || !message.from) return undefined;

  const media = extractMedia(message);
  const profileName = profileNames.get(message.from);
  const referral = message.referral;

  return {
    kind: 'message',
    providerMessageId: message.id,
    from: message.from,
    ...(profileName ? { profileName } : {}),
    timestamp: parseTimestamp(message.timestamp),
    messageType: message.type,
    ...(extractText(message) !== undefined ? { text: extractText(message)! } : {}),
    ...(media ? { media } : {}),
    ...(referral
      ? {
          referral: {
            ...(referral.source_url ? { sourceUrl: referral.source_url } : {}),
            ...(referral.source_id ? { sourceId: referral.source_id } : {}),
            ...(referral.source_type ? { sourceType: referral.source_type } : {}),
            ...(referral.headline ? { headline: referral.headline } : {}),
            ...(referral.ctwa_clid ? { ctwaClid: referral.ctwa_clid } : {}),
          },
        }
      : {}),
    ...(phoneNumberId ? { phoneNumberId } : {}),
  };
}

/**
 * Pulls out whatever the person actually "said".
 *
 * Interactive replies carry the button or list title, which is the text the
 * person saw and chose — that is what the conversation engine should reason
 * about, not the opaque payload id. Media captions count as text too.
 */
function extractText(message: RawMessage): string | undefined {
  return (
    message.text?.body ??
    message.interactive?.button_reply?.title ??
    message.interactive?.list_reply?.title ??
    message.button?.text ??
    message.image?.caption ??
    message.video?.caption
  );
}

function extractMedia(message: RawMessage): InboundMessageEvent['media'] {
  const candidates = [
    ['image', message.image],
    ['audio', message.audio],
    ['video', message.video],
    ['document', message.document],
    ['sticker', message.sticker],
  ] as const;

  for (const [kind, value] of candidates) {
    if (value?.id) {
      return {
        id: value.id,
        kind,
        ...('mime_type' in value && value.mime_type ? { mimeType: value.mime_type } : {}),
      };
    }
  }
  return undefined;
}

/** Meta sends Unix seconds as a string. Falls back to now if it is unusable. */
function parseTimestamp(value: string): Date {
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}
