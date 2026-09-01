import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Database, DbClient } from '../db/client.js';
import { outbox } from '../db/schema.js';

/**
 * The transactional outbox.
 *
 * An event is written **in the same transaction as the state change it
 * describes**, which is the whole point: a conversation cannot advance without
 * its projection being queued, and a queued projection cannot exist for a
 * conversation that never advanced. No distributed transaction, no lost update,
 * and — the property that matters most here — **a Monday outage cannot interrupt
 * a live conversation**, because the conversation never waits on Monday.
 *
 * Delivery carries no payload beyond the aggregate id. The worker re-reads
 * current state from Postgres, so a delayed or repeated delivery projects the
 * truth rather than a stale snapshot.
 */

export type OutboxEventType = 'monday_lead_sync';

/**
 * Queues a projection for an aggregate.
 *
 * Takes a {@link DbClient} rather than a `Database` so it composes inside the
 * caller's transaction — passing the pool here instead would defeat the entire
 * mechanism.
 */
export async function enqueueOutboxEvent(
  tx: DbClient,
  aggregateId: string,
  eventType: OutboxEventType = 'monday_lead_sync',
): Promise<void> {
  await tx.insert(outbox).values({
    aggregateType: 'conversation',
    aggregateId,
    eventType,
    payload: {},
  });
}

export type OutboxRow = typeof outbox.$inferSelect;

/**
 * Claims a batch of due events.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes several workers safe: each claims rows
 * the others have not, instead of blocking behind them. The claim flips status
 * to `processing` so a crashed worker's rows are visibly stuck rather than
 * silently redelivered forever.
 */
export async function claimOutboxBatch(
  db: Database,
  limit: number,
  now: Date = new Date(),
): Promise<OutboxRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(and(eq(outbox.status, 'pending'), lte(outbox.nextAttemptAt, now)))
      .orderBy(asc(outbox.createdAt))
      .limit(limit)
      .for('update', { skipLocked: true });

    if (due.length === 0) return [];

    return tx
      .update(outbox)
      .set({ status: 'processing' })
      .where(
        inArray(
          outbox.id,
          due.map((row) => row.id),
        ),
      )
      .returning();
  });
}

/** Marks events delivered. */
export async function markDelivered(db: Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(outbox)
    .set({ status: 'delivered', deliveredAt: new Date() })
    .where(inArray(outbox.id, ids));
}

/**
 * Returns events to the queue with exponential backoff, or gives up.
 *
 * A permanently failing event is parked as `failed` rather than retried forever:
 * an event that cannot be delivered after several attempts will not start
 * working on the hundredth, and leaving it pending would starve the queue behind
 * it. It stays in the table for inspection.
 */
export async function markFailed(
  db: Database,
  ids: string[],
  error: string,
  maxAttempts: number,
  now: Date = new Date(),
): Promise<void> {
  if (ids.length === 0) return;

  // Backoff grows with the attempt count already recorded on the row, so rows
  // retried many times back off further without the caller tracking anything.
  await db
    .update(outbox)
    .set({
      attempts: sql`${outbox.attempts} + 1`,
      lastError: error.slice(0, 1000),
      status: sql`case when ${outbox.attempts} + 1 >= ${maxAttempts} then 'failed'::outbox_status else 'pending'::outbox_status end`,
      nextAttemptAt: sql`${now.toISOString()}::timestamptz + (interval '1 second' * least(3600, power(2, ${outbox.attempts} + 1) * 5))`,
    })
    .where(inArray(outbox.id, ids));
}
