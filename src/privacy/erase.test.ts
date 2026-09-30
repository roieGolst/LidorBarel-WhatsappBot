import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import { findOrCreateConversation } from '../db/repositories/conversations.js';
import { recordInboundMessage } from '../db/repositories/messages.js';
import { isOptedOut, recordOptOut } from '../db/repositories/optOuts.js';
import {
  appointmentRequests,
  optOuts,
  campaignReferrals,
  contacts,
  conversations,
  events,
  messages,
  outbox,
} from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import type { MondayClient } from '../monday/client.js';
import { enqueueOutboxEvent } from '../outbox/outbox.js';
import { eraseContact } from './erase.js';

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

class FakeMonday {
  deleted: string[] = [];
  updated: { itemId: string; values: Record<string, unknown> }[] = [];
  failOn = new Set<string>();
  deleteItem(itemId: string) {
    if (this.failOn.has(itemId)) return Promise.reject(new Error('monday down'));
    this.deleted.push(itemId);
    return Promise.resolve();
  }
  updateItem(_board: string, itemId: string, values: Record<string, unknown>) {
    this.updated.push({ itemId, values });
    return Promise.resolve();
  }
}

/** A person with everything the bot can write about them. */
async function seedPerson(phone: string) {
  const contact = await upsertContactByPhone(db, {
    phone,
    name: 'רועי גולסט',
    entryPoint: 'meta_lead_form',
    consentStatus: 'whatsapp_opt_in',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);
  await db
    .update(conversations)
    .set({
      stage: 'appointment_confirmed',
      mondayItemId: 'lead-1',
      exclusivityCallbackItemId: 'callback-1',
      extracted: { neighborhood: 'רמות', additionalNotes: 'רגר 15, 4 חדרים' },
    })
    .where(eq(conversations.id, conversation.id));
  await recordInboundMessage(db, {
    conversationId: conversation.id,
    providerMessageId: `in-${conversation.id}`,
    body: 'הדירה ברגר 15',
    createdAt: new Date(),
  });
  await db.insert(appointmentRequests).values({
    conversationId: conversation.id,
    proposedSlots: [],
    status: 'approved',
    selectedSlot: new Date(),
    mondayActivityItemId: 'activity-1',
  });
  await db.insert(campaignReferrals).values({
    contactId: contact.id,
    externalLeadId: `lead-${phone}`,
    rawPayload: {},
  });
  await db.insert(events).values({
    aggregateType: 'conversation',
    aggregateId: conversation.id,
    eventType: 'test',
    metadata: {},
  });
  await enqueueOutboxEvent(db, conversation.id);
  return { contactId: contact.id, conversationId: conversation.id };
}

const rowCount = async (): Promise<Record<string, number>> => ({
  optOuts: (await db.select().from(optOuts)).length,
  contacts: (await db.select().from(contacts)).length,
  conversations: (await db.select().from(conversations)).length,
  messages: (await db.select().from(messages)).length,
  appointments: (await db.select().from(appointmentRequests)).length,
  referrals: (await db.select().from(campaignReferrals)).length,
  events: (await db.select().from(events)).length,
  outbox: (await db.select().from(outbox)).length,
});

describe('eraseContact — a deletion request (NN-8)', () => {
  it('erases every record and the lead item, leaves meeting items alone, keeps nothing', async () => {
    const { contactId, conversationId } = await seedPerson('+972501234567');
    // A second person is untouched.
    await seedPerson('+972507654321');
    const monday = new FakeMonday();

    const report = await eraseContact(
      { db, monday: monday as unknown as MondayClient },
      contactId,
    );

    expect(report.conversationIds).toEqual([conversationId]);
    expect(report.leadItemsDeleted).toBe(1);
    expect(report.boardFailures).toEqual([]);
    expect(monday.deleted).toEqual(['lead-1']);
    // Meeting items sync to Lidor's calendar and are not touched.
    expect(monday.updated).toEqual([]);
    // Only the other person remains, everywhere — the consent record included.
    expect(await rowCount()).toEqual({
      optOuts: 0,
      contacts: 1,
      conversations: 1,
      messages: 1,
      appointments: 1,
      referrals: 1,
      events: 1,
      outbox: 1,
    });
    // Nothing is kept, so the number is not blocked: they may come back.
    expect(await isOptedOut(db, '+972501234567')).toBe(false);
  });

  it('leaves an opt-out the person gave earlier in force', async () => {
    const { contactId } = await seedPerson('+972501234567');
    await recordOptOut(db, '+972501234567', 'keyword');

    await eraseContact({ db }, contactId);

    expect((await rowCount()).contacts).toBe(0);
    // The refusal is the one thing kept: phone, reason, source, time.
    expect(await isOptedOut(db, '+972501234567')).toBe(true);
  });

  it('still erases the database when the board cannot be reached, and reports the items', async () => {
    const { contactId } = await seedPerson('+972501234567');
    const monday = new FakeMonday();
    monday.failOn.add('lead-1');

    const report = await eraseContact(
      { db, monday: monday as unknown as MondayClient },
      contactId,
    );

    expect(report.boardFailures).toEqual(['lead-1']);
    expect((await rowCount()).contacts).toBe(0);
  });

  it('without a board client, reports the lead item for a person to remove', async () => {
    const { contactId } = await seedPerson('+972501234567');

    const report = await eraseContact({ db }, contactId);

    expect(report.boardFailures).toEqual(['lead-1']);
    expect((await rowCount()).contacts).toBe(0);
  });
});
