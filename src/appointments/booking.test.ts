import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import { findOrCreateConversation } from '../db/repositories/conversations.js';
import { appointmentRequests, conversations, outbox } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import type { MondayClient } from '../monday/client.js';
import { ACTIVITY_COLUMNS, ACTIVITY_TYPE } from '../monday/leadMapping.js';
import { DEFAULT_SLOT_OPTIONS, type Slot, type SlotOptions } from './availability.js';
import { bookSlot, busyBlocks, findSlotsToOffer, recordOffer } from './booking.js';

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

const TZ = 'Asia/Jerusalem';
const OPTIONS: SlotOptions = { ...DEFAULT_SLOT_OPTIONS, timeZone: TZ };
const NOW = new Date('2026-08-23T06:00:00Z'); // Sunday 09:00 local

/** Stands in for the פעילות board, which mirrors Lidor's calendar. */
class FakeMonday {
  items: {
    id: string;
    columnValues: Record<string, { text: string | null; value: string | null }>;
  }[] = [];
  created: { board: string; name: string; values: Record<string, unknown> }[] = [];
  private counter = 0;

  listItems() {
    return Promise.resolve(this.items);
  }
  createItem(board: string, name: string, values: Record<string, unknown>) {
    this.created.push({ board, name, values });
    return Promise.resolve(`activity-${++this.counter}`);
  }
  /**
   * Adds a commitment exactly as Monday returns one: UTC in `value`, and
   * account-local in `text`, three hours ahead. The mismatch is the point — the
   * code must read `value`.
   */
  busy(startUtc: Date, endUtc: Date): void {
    const asValue = (d: Date) =>
      JSON.stringify({
        date: d.toISOString().slice(0, 10),
        time: d.toISOString().slice(11, 19),
      });
    const asLocalText = (d: Date) => {
      const shifted = new Date(d.getTime() + 3 * 60 * 60 * 1000);
      return `${shifted.toISOString().slice(0, 10)} ${shifted.toISOString().slice(11, 16)}`;
    };
    this.items.push({
      id: `busy-${this.items.length}`,
      columnValues: {
        [ACTIVITY_COLUMNS.start]: {
          text: asLocalText(startUtc),
          value: asValue(startUtc),
        },
        [ACTIVITY_COLUMNS.end]: { text: asLocalText(endUtc), value: asValue(endUtc) },
      },
    });
  }
}

const deps = (fake: FakeMonday) => ({
  db,
  monday: fake as unknown as MondayClient,
  slotOptions: OPTIONS,
});

let phoneCounter = 0;
async function seedLead(mondayItemId: string | null = '555'): Promise<string> {
  const contact = await upsertContactByPhone(db, {
    phone: `+9725088888${String(phoneCounter++).padStart(2, '0')}`,
    entryPoint: 'meta_lead_form',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);
  await db
    .update(conversations)
    .set({ stage: 'qualified', mondayItemId })
    .where(eq(conversations.id, conversation.id));
  return conversation.id;
}

describe('busyBlocks', () => {
  it('reads commitments from the activity board', async () => {
    const fake = new FakeMonday();
    const start = new Date('2026-08-24T09:00:00Z');
    fake.busy(start, new Date('2026-08-24T10:00:00Z'));

    const blocks = await busyBlocks(deps(fake));

    expect(blocks).toHaveLength(1);
    // Read from the UTC value, not the account-local text three hours ahead.
    expect(blocks[0]?.start).toEqual(start);
  });

  it('treats an entry with no end time as occupying the default duration', async () => {
    // A calendar entry with a missing end is still a commitment; skipping it
    // would book straight over it.
    const fake = new FakeMonday();
    fake.items.push({
      id: 'x',
      columnValues: {
        // Local text and UTC value disagree by three hours, as Monday returns
        // them; the code must use the value.
        [ACTIVITY_COLUMNS.start]: {
          text: '2026-08-24 12:00',
          value: JSON.stringify({ date: '2026-08-24', time: '09:00:00' }),
        },
        [ACTIVITY_COLUMNS.end]: { text: null, value: null },
      },
    });

    const blocks = await busyBlocks(deps(fake));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.end.getTime() - blocks[0]!.start.getTime()).toBe(
      OPTIONS.durationMs,
    );
  });

  it('ignores an entry with no start time', async () => {
    const fake = new FakeMonday();
    fake.items.push({
      id: 'x',
      columnValues: { [ACTIVITY_COLUMNS.start]: { text: null, value: null } },
    });

    expect(await busyBlocks(deps(fake))).toEqual([]);
  });
});

describe('findSlotsToOffer', () => {
  it('offers six times across the day parts by default', async () => {
    const fake = new FakeMonday();

    const slots = await findSlotsToOffer(deps(fake), undefined, NOW);

    expect(slots).toHaveLength(6);
  });

  it('offers nothing when the calendar is full', async () => {
    const fake = new FakeMonday();
    fake.busy(new Date('2026-08-23T00:00:00Z'), new Date('2026-09-30T00:00:00Z'));

    expect(await findSlotsToOffer(deps(fake), 3, NOW)).toEqual([]);
  });
});

describe('bookSlot', () => {
  async function offerAndPick(fake: FakeMonday, conversationId: string): Promise<Slot> {
    const slots = await findSlotsToOffer(deps(fake), 3, NOW);
    await recordOffer(deps(fake), conversationId, slots, 30 * 60 * 1000, NOW);
    return slots[0]!;
  }

  it('creates a consultation linked to the lead', async () => {
    const fake = new FakeMonday();
    const conversationId = await seedLead('555');
    const slot = await offerAndPick(fake, conversationId);

    const outcome = await bookSlot(deps(fake), conversationId, slot, NOW);

    expect(outcome).toMatchObject({ booked: true });
    const created = fake.created[0]!;
    expect(created.values[ACTIVITY_COLUMNS.type]).toEqual({
      index: ACTIVITY_TYPE.consultation,
    });
    expect(created.values[ACTIVITY_COLUMNS.contact]).toEqual({ item_ids: [555] });
  });

  it('books without a link when the lead has no board item yet', async () => {
    // The projection may not have run; a missing link must not block the booking.
    const fake = new FakeMonday();
    const conversationId = await seedLead(null);
    const slot = await offerAndPick(fake, conversationId);

    const outcome = await bookSlot(deps(fake), conversationId, slot, NOW);

    expect(outcome).toMatchObject({ booked: true });
    expect(fake.created[0]!.values).not.toHaveProperty(ACTIVITY_COLUMNS.contact);
  });

  it('moves the conversation to appointment_confirmed', async () => {
    const fake = new FakeMonday();
    const conversationId = await seedLead();
    const slot = await offerAndPick(fake, conversationId);

    await bookSlot(deps(fake), conversationId, slot, NOW);

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation?.stage).toBe('appointment_confirmed');
  });

  it('records the booking and releases the hold', async () => {
    const fake = new FakeMonday();
    const conversationId = await seedLead();
    const slot = await offerAndPick(fake, conversationId);

    await bookSlot(deps(fake), conversationId, slot, NOW);

    const [request] = await db.select().from(appointmentRequests);
    expect(request?.status).toBe('approved');
    expect(request?.mondayActivityItemId).toBe('activity-1');
    expect(request?.holdExpiresAt).toBeNull();
    expect(request?.selectedSlot).toEqual(slot.start);
  });

  it('queues the board projection in the same transaction', async () => {
    const fake = new FakeMonday();
    const conversationId = await seedLead();
    const slot = await offerAndPick(fake, conversationId);

    await bookSlot(deps(fake), conversationId, slot, NOW);

    const queued = await db.select().from(outbox);
    expect(queued.some((row) => row.aggregateId === conversationId)).toBe(true);
  });

  it('refuses a slot taken between the offer and the choice', async () => {
    // The whole mitigation for sync lag: availability is re-read at booking
    // time, never trusted from when the slots were offered.
    const fake = new FakeMonday();
    const conversationId = await seedLead();
    const slot = await offerAndPick(fake, conversationId);

    fake.busy(slot.start, slot.end);

    const outcome = await bookSlot(deps(fake), conversationId, slot, NOW);

    expect(outcome).toEqual({ booked: false, reason: 'slot_taken' });
    expect(fake.created).toHaveLength(0);
  });

  it('does not book when no slots were ever offered', async () => {
    const fake = new FakeMonday();
    const conversationId = await seedLead();
    const slot = (await findSlotsToOffer(deps(fake), 1, NOW))[0]!;

    const outcome = await bookSlot(deps(fake), conversationId, slot, NOW);

    expect(outcome).toEqual({ booked: false, reason: 'no_offer' });
  });

  it('reports a vanished conversation rather than throwing', async () => {
    const fake = new FakeMonday();
    const slot = (await findSlotsToOffer(deps(fake), 1, NOW))[0]!;

    const outcome = await bookSlot(
      deps(fake),
      '00000000-0000-0000-0000-000000000000',
      slot,
      NOW,
    );

    expect(outcome).toEqual({ booked: false, reason: 'conversation_missing' });
  });
});
