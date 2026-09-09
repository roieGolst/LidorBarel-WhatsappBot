import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { upsertContactByPhone, type Contact } from '../db/repositories/contacts.js';
import { findOrCreateConversation } from '../db/repositories/conversations.js';
import { conversations, outbox } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { MondayError, type MondayClient } from '../monday/client.js';
import { CALLBACK_ITEM_NAME } from '../appointments/exclusivityCallback.js';
import {
  ACTIVITY_COLUMNS,
  LEAD_STATUS,
  UNSUITABLE_GROUP_ID,
} from '../monday/leadMapping.js';
import { syncLead } from '../monday/syncLead.js';
import { claimOutboxBatch, enqueueOutboxEvent, markFailed } from './outbox.js';
import { startOutboxWorker } from './outboxWorker.js';

let db: Database;

beforeAll(async () => {
  db = await setupTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** Records what would have been sent to Monday, and can be made to fail. */
class FakeMonday {
  created: { name: string; values: Record<string, unknown> }[] = [];
  updates: { itemId: string; values: Record<string, unknown> }[] = [];
  moves: { itemId: string; groupId: string }[] = [];
  existing = new Set<string>();
  failWith?: Error;
  private counter = 0;

  createItem(_board: string, name: string, values: Record<string, unknown>) {
    if (this.failWith) return Promise.reject(this.failWith);
    const id = `item-${++this.counter}`;
    this.created.push({ name, values });
    this.existing.add(id);
    return Promise.resolve(id);
  }
  updateItem(_board: string, itemId: string, values: Record<string, unknown>) {
    if (this.failWith) return Promise.reject(this.failWith);
    this.updates.push({ itemId, values });
    return Promise.resolve();
  }
  moveToGroup(itemId: string, groupId: string) {
    this.moves.push({ itemId, groupId });
    return Promise.resolve();
  }
  itemExists(itemId: string) {
    return Promise.resolve(this.existing.has(itemId));
  }
  deleteItem(itemId: string) {
    this.existing.delete(itemId);
    return Promise.resolve();
  }
}

const monday = (fake: FakeMonday) => fake as unknown as MondayClient;

let phoneCounter = 0;
async function seedLead(
  over: { stage?: string; extracted?: Record<string, unknown> } = {},
): Promise<{ conversationId: string; contact: Contact }> {
  const contact = await upsertContactByPhone(db, {
    phone: `+9725055555${String(phoneCounter++).padStart(2, '0')}`,
    name: 'ישראל',
    entryPoint: 'meta_lead_form',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);
  if (over.stage || over.extracted) {
    await db
      .update(conversations)
      .set({
        ...(over.stage ? { stage: over.stage as never } : {}),
        ...(over.extracted ? { extracted: over.extracted } : {}),
      })
      .where(eq(conversations.id, conversation.id));
  }
  return { conversationId: conversation.id, contact };
}

describe('syncLead', () => {
  it('creates the item without a status, then sets it', async () => {
    // A board automation sets the status on creation; passing it in the create
    // call races that automation.
    const fake = new FakeMonday();
    const { conversationId } = await seedLead({ stage: 'qualified' });

    const result = await syncLead({ db, monday: monday(fake) }, conversationId);

    expect(result).toMatchObject({ synced: true, created: true });
    expect(fake.created[0]?.values).not.toHaveProperty('lead_status');
    expect(fake.updates[0]?.values).toEqual({
      lead_status: { index: LEAD_STATUS.awaitingCall },
    });
  });

  it('queues a second pass on creation, because the board overwrites the status', async () => {
    // The "when an item is created" automation sets ליד חדש asynchronously and
    // overwrites whatever the create pass wrote. Verified live. The second pass
    // takes the update path, where nothing competes.
    const fake = new FakeMonday();
    const { conversationId } = await seedLead({ stage: 'qualified' });

    await syncLead({ db, monday: monday(fake) }, conversationId);

    const queued = await db.select().from(outbox);
    expect(queued.filter((row) => row.aggregateId === conversationId)).toHaveLength(1);
  });

  it('does not queue another pass when updating, so it cannot loop', async () => {
    const fake = new FakeMonday();
    const { conversationId } = await seedLead();
    await syncLead({ db, monday: monday(fake) }, conversationId);
    await db.delete(outbox);

    await syncLead({ db, monday: monday(fake) }, conversationId);

    expect(await db.select().from(outbox)).toHaveLength(0);
  });

  it('stores the item id so the next sync updates rather than duplicates', async () => {
    const fake = new FakeMonday();
    const { conversationId } = await seedLead();

    await syncLead({ db, monday: monday(fake) }, conversationId);
    await syncLead({ db, monday: monday(fake) }, conversationId);

    expect(fake.created).toHaveLength(1);
  });

  it('recreates an item that was deleted from the board by hand', async () => {
    // Updating a dead id fails forever otherwise.
    const fake = new FakeMonday();
    const { conversationId } = await seedLead();
    await syncLead({ db, monday: monday(fake) }, conversationId);
    fake.existing.clear();

    const result = await syncLead({ db, monday: monday(fake) }, conversationId);

    expect(result).toMatchObject({ created: true });
    expect(fake.created).toHaveLength(2);
  });

  it('files a disqualified lead itself, since no automation covers it', async () => {
    const fake = new FakeMonday();
    const { conversationId } = await seedLead();
    await syncLead({ db, monday: monday(fake) }, conversationId);
    await db
      .update(conversations)
      .set({ stage: 'disqualified', disqualificationReason: 'not_selling' })
      .where(eq(conversations.id, conversationId));

    await syncLead({ db, monday: monday(fake) }, conversationId);

    expect(fake.moves.at(-1)?.groupId).toBe(UNSUITABLE_GROUP_ID);
  });

  it('leaves an automated status to the board', async () => {
    const fake = new FakeMonday();
    const { conversationId } = await seedLead();
    await syncLead({ db, monday: monday(fake) }, conversationId);
    await db
      .update(conversations)
      .set({ stage: 'closed_no_response' })
      .where(eq(conversations.id, conversationId));

    await syncLead({ db, monday: monday(fake) }, conversationId);

    expect(fake.moves).toHaveLength(0);
  });

  it('reports a vanished conversation instead of throwing', async () => {
    const fake = new FakeMonday();

    const result = await syncLead(
      { db, monday: monday(fake) },
      '00000000-0000-0000-0000-000000000000',
    );

    expect(result).toEqual({ synced: false, reason: 'conversation_missing' });
  });
});

describe('outbox', () => {
  it('claims a due event once', async () => {
    const { conversationId } = await seedLead();
    await enqueueOutboxEvent(db, conversationId);

    const first = await claimOutboxBatch(db, 10);
    const second = await claimOutboxBatch(db, 10);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('backs off a retryable failure and keeps it pending', async () => {
    const { conversationId } = await seedLead();
    await enqueueOutboxEvent(db, conversationId);
    const [row] = await claimOutboxBatch(db, 10);

    await markFailed(db, [row!.id], 'upstream down', 8);

    const [after] = await db.select().from(outbox);
    expect(after?.status).toBe('pending');
    expect(after?.attempts).toBe(1);
    expect(after?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('parks an event that has exhausted its attempts', async () => {
    // Retrying forever would starve the queue behind it.
    const { conversationId } = await seedLead();
    await enqueueOutboxEvent(db, conversationId);
    const [row] = await claimOutboxBatch(db, 10);

    await markFailed(db, [row!.id], 'permanent', 1);

    const [after] = await db.select().from(outbox);
    expect(after?.status).toBe('failed');
    expect(after?.lastError).toContain('permanent');
  });
});

describe('outbox worker', () => {
  const worker = (fake: FakeMonday) =>
    startOutboxWorker({
      db,
      monday: monday(fake),
      intervalMs: 60_000,
      batchSize: 50,
      maxAttempts: 8,
    });

  it('delivers a queued projection', async () => {
    const fake = new FakeMonday();
    const { conversationId } = await seedLead();
    await enqueueOutboxEvent(db, conversationId);

    const w = worker(fake);
    const result = await w.runOnce();
    w.stop();

    expect(result.delivered).toBe(1);
    expect(fake.created).toHaveLength(1);
  });

  it('coalesces several events for one conversation into one projection', async () => {
    // A busy conversation queues many events; the projection reads current
    // state, so one write satisfies all of them.
    const fake = new FakeMonday();
    const { conversationId } = await seedLead();
    await enqueueOutboxEvent(db, conversationId);
    await enqueueOutboxEvent(db, conversationId);
    await enqueueOutboxEvent(db, conversationId);

    const w = worker(fake);
    const result = await w.runOnce();
    w.stop();

    expect(fake.created).toHaveLength(1);
    expect(result.delivered).toBe(3);
  });

  it('retries a transient Monday failure', async () => {
    const fake = new FakeMonday();
    fake.failWith = new MondayError('rate limited', true, 429);
    const { conversationId } = await seedLead();
    await enqueueOutboxEvent(db, conversationId);

    const w = worker(fake);
    await w.runOnce();
    w.stop();

    const [row] = await db.select().from(outbox);
    expect(row?.status).toBe('pending');
  });

  it('parks a permanent failure immediately rather than backing off eight times', async () => {
    const fake = new FakeMonday();
    fake.failWith = new MondayError('malformed mutation', false);
    const { conversationId } = await seedLead();
    await enqueueOutboxEvent(db, conversationId);

    const w = worker(fake);
    await w.runOnce();
    w.stop();

    const [row] = await db.select().from(outbox);
    expect(row?.status).toBe('failed');
  });

  it('retires an event whose conversation no longer exists', async () => {
    const fake = new FakeMonday();
    await enqueueOutboxEvent(db, '00000000-0000-0000-0000-000000000000');

    const w = worker(fake);
    await w.runOnce();
    w.stop();

    const [row] = await db.select().from(outbox);
    expect(row?.status).toBe('delivered');
  });
});

describe('the exclusivity callback reminder', () => {
  const exclusive = {
    sellIntent: 'ready',
    neighborhood: 'רמות',
    currentlyMarketed: 'with_agent',
    exclusivityEndsAt: 'מחר',
    exclusivityEndsOn: '2026-09-09',
  };

  it('is filed in the calendar, linked to the lead, when the lead is projected', async () => {
    const fake = new FakeMonday();
    const { conversationId } = await seedLead({
      stage: 'disqualified',
      extracted: exclusive,
    });

    await syncLead(
      { db, monday: monday(fake), timeZone: 'Asia/Jerusalem' },
      conversationId,
    );

    const reminder = fake.created.find((item) => item.name === CALLBACK_ITEM_NAME);
    expect(reminder).toBeDefined();
    // Linked to the lead item created moments before, in the same pass, and
    // remembered on the conversation so it is never filed twice.
    expect(reminder!.values).toHaveProperty(ACTIVITY_COLUMNS.contact);
    const [row] = await db
      .select({ id: conversations.exclusivityCallbackItemId })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(row?.id).toBe('item-2');
    expect(reminder!.values[ACTIVITY_COLUMNS.start]).toEqual({
      date: '2026-09-09',
      time: '07:00:00',
    });
  });

  it('is filed exactly once, however often the lead is projected', async () => {
    const fake = new FakeMonday();
    const { conversationId } = await seedLead({
      stage: 'disqualified',
      extracted: exclusive,
    });

    await syncLead({ db, monday: monday(fake) }, conversationId);
    await syncLead({ db, monday: monday(fake) }, conversationId);
    await syncLead({ db, monday: monday(fake) }, conversationId);

    expect(fake.created.filter((item) => item.name === CALLBACK_ITEM_NAME)).toHaveLength(
      1,
    );
  });

  it('is not filed when the end is unknown or the lead declined a follow-up', async () => {
    const fake = new FakeMonday();
    const vague = await seedLead({
      stage: 'disqualified',
      extracted: { ...exclusive, exclusivityEndsOn: undefined },
    });
    const declined = await seedLead({
      stage: 'disqualified',
      extracted: { ...exclusive, wantsExclusivityFollowup: false },
    });

    await syncLead({ db, monday: monday(fake) }, vague.conversationId);
    await syncLead({ db, monday: monday(fake) }, declined.conversationId);

    expect(fake.created.some((item) => item.name === CALLBACK_ITEM_NAME)).toBe(false);
  });
});
