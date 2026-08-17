import { desc, eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { messages } from '../schema.js';

export type Message = typeof messages.$inferSelect;

/**
 * Returns a conversation's most recent messages, oldest first.
 *
 * Bounded so a long-running conversation does not send an ever-growing history
 * to the model. Ordered ascending here so callers can map it straight into a
 * chronological transcript.
 */
export async function recentMessages(
  db: DbClient,
  conversationId: string,
  limit = 12,
): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    // Take the newest `limit`, then present them oldest-first.
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export interface InboundMessageInput {
  conversationId: string;
  /** Meta's message id — the idempotency key. */
  providerMessageId: string;
  body?: string | undefined;
  mediaType?: string | undefined;
  mediaUrl?: string | undefined;
  createdAt: Date;
}

export interface RecordResult {
  message: Message;
  /**
   * True when this exact provider message had already been stored.
   *
   * Callers must skip all downstream work when set — see
   * {@link recordInboundMessage}.
   */
  duplicate: boolean;
}

/**
 * Stores an inbound message, ignoring redeliveries of one already seen.
 *
 * Meta retries a webhook whenever it does not receive a prompt 2xx, and retries
 * are common under normal operation — a slow database, a deploy, a network
 * blip. Without deduplication the bot answers the same customer message twice,
 * and every LLM call is paid for twice.
 *
 * Deduplication relies on the unique index over `provider_message_id` rather
 * than a read-then-write, because Meta can deliver the same message
 * concurrently to two workers and a check-then-insert would let both through.
 *
 * @returns the stored message and whether it was already present. When
 * `duplicate` is true the caller must not generate a reply.
 */
export async function recordInboundMessage(
  db: DbClient,
  input: InboundMessageInput,
): Promise<RecordResult> {
  const [inserted] = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      direction: 'inbound',
      body: input.body ?? null,
      mediaType: input.mediaType ?? null,
      mediaUrl: input.mediaUrl ?? null,
      providerMessageId: input.providerMessageId,
      createdAt: input.createdAt,
    })
    .onConflictDoNothing({ target: messages.providerMessageId })
    .returning();

  if (inserted) {
    return { message: inserted, duplicate: false };
  }

  // onConflictDoNothing returns nothing on conflict, so the existing row is
  // fetched to give callers a consistent shape.
  const [existing] = await db
    .select()
    .from(messages)
    .where(eq(messages.providerMessageId, input.providerMessageId))
    .limit(1);

  return { message: existing!, duplicate: true };
}

/**
 * Updates delivery state for a message we sent.
 *
 * Status webhooks arrive out of order — `read` can land before `delivered` —
 * so terminal states are not overwritten by earlier ones.
 */
export async function updateDeliveryStatus(
  db: DbClient,
  providerMessageId: string,
  status: Message['deliveryStatus'],
  error?: string,
): Promise<void> {
  const [current] = await db
    .select({ deliveryStatus: messages.deliveryStatus })
    .from(messages)
    .where(eq(messages.providerMessageId, providerMessageId))
    .limit(1);

  if (!current) return;
  if (!shouldAdvance(current.deliveryStatus, status)) return;

  await db
    .update(messages)
    .set({ deliveryStatus: status, ...(error ? { error } : {}) })
    .where(eq(messages.providerMessageId, providerMessageId));
}

/** Delivery states, ordered. A status never moves backwards. */
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

function shouldAdvance(
  current: Message['deliveryStatus'],
  incoming: Message['deliveryStatus'],
): boolean {
  if (!incoming) return false;
  if (!current) return true;
  return (STATUS_RANK[incoming] ?? 0) > (STATUS_RANK[current] ?? 0);
}
