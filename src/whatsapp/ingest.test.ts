import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { findContactByPhone } from '../db/repositories/contacts.js';
import { isWithinServiceWindow } from '../db/repositories/conversations.js';
import { campaignReferrals, conversations, messages } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { ingestEvents, ingestMessage, ingestStatus } from './ingest.js';
import type { InboundMessageEvent } from './payload.js';

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

function messageEvent(overrides: Partial<InboundMessageEvent> = {}): InboundMessageEvent {
  return {
    kind: 'message',
    providerMessageId: 'wamid.DEFAULT',
    from: '972501234567',
    timestamp: new Date('2026-08-16T10:00:00Z'),
    messageType: 'text',
    text: 'שלום',
    ...overrides,
  };
}

describe('ingestMessage', () => {
  it('creates contact, conversation, and message together', async () => {
    const result = await ingestMessage(db, messageEvent({ profileName: 'ישראל' }));

    expect(result.duplicate).toBe(false);
    expect(result.conversationCreated).toBe(true);

    const contact = await findContactByPhone(db, '972501234567');
    expect(contact?.phone).toBe('+972501234567');
    expect(contact?.name).toBe('ישראל');

    const stored = await db.select().from(messages);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.body).toBe('שלום');
    expect(stored[0]?.direction).toBe('inbound');
  });

  // Meta retries whenever it does not get a prompt 2xx, which happens routinely
  // under load or during a deploy. Without dedup the bot replies twice to the
  // same customer message and pays for two LLM calls.
  it('ignores a redelivered webhook', async () => {
    const event = messageEvent({ providerMessageId: 'wamid.RETRY' });

    const first = await ingestMessage(db, event);
    const second = await ingestMessage(db, event);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.conversationId).toBe(first.conversationId);

    const stored = await db.select().from(messages);
    expect(stored).toHaveLength(1);
  });

  // Meta can deliver the same webhook to two workers at once. Dedup relies on
  // the unique index rather than a read-then-write, so both must not get through.
  it('stores one row under concurrent redelivery', async () => {
    const event = messageEvent({ providerMessageId: 'wamid.CONCURRENT' });

    const results = await Promise.allSettled([
      ingestMessage(db, event),
      ingestMessage(db, event),
      ingestMessage(db, event),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded.length).toBeGreaterThan(0);

    const stored = await db.select().from(messages);
    expect(stored).toHaveLength(1);
  });

  it('does not refresh the messaging window on a redelivery', async () => {
    const event = messageEvent({ providerMessageId: 'wamid.WINDOW' });
    await ingestMessage(db, event);

    const [before] = await db.select().from(conversations);

    await ingestMessage(db, event);
    const [after] = await db.select().from(conversations);

    expect(after?.windowExpiresAt).toEqual(before?.windowExpiresAt);
  });

  it('reuses the open conversation for a second message', async () => {
    const first = await ingestMessage(db, messageEvent({ providerMessageId: 'wamid.1' }));
    const second = await ingestMessage(
      db,
      messageEvent({ providerMessageId: 'wamid.2' }),
    );

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.conversationCreated).toBe(false);
    expect(await db.select().from(conversations)).toHaveLength(1);
  });

  // One conversation record per contact, always — a return reopens the same row
  // in place rather than spawning a duplicate that would fracture their history.
  it('reopens the previous conversation in place instead of duplicating it', async () => {
    const first = await ingestMessage(db, messageEvent({ providerMessageId: 'wamid.1' }));

    await db
      .update(conversations)
      .set({ stage: 'disqualified', qualified: false })
      .where(eq(conversations.id, first.conversationId!));

    const second = await ingestMessage(
      db,
      messageEvent({ providerMessageId: 'wamid.2' }),
    );

    // Same record, reopened clean — never a second row for the same contact.
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.conversationCreated).toBe(false);
    expect(await db.select().from(conversations)).toHaveLength(1);

    const [reopened] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, first.conversationId!));
    expect(reopened?.stage).toBe('engaged');
    expect(reopened?.qualified).toBeNull();
  });

  // A banned / opted-out contact must never get a duplicate record or a fresh
  // start — the conversation is reused so the worker can stay silent.
  it('reuses a banned conversation instead of creating a new one', async () => {
    const first = await ingestMessage(db, messageEvent({ providerMessageId: 'wamid.1' }));

    await db
      .update(conversations)
      .set({ stage: 'blocked' })
      .where(eq(conversations.id, first.conversationId!));

    const second = await ingestMessage(
      db,
      messageEvent({ providerMessageId: 'wamid.2' }),
    );

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.conversationCreated).toBe(false);
    expect(await db.select().from(conversations)).toHaveLength(1);
  });

  // The window decides whether the bot may reply in its own words at all.
  it('opens a 24-hour service window from the message timestamp', async () => {
    const sentAt = new Date('2026-08-16T10:00:00Z');
    await ingestMessage(db, messageEvent({ timestamp: sentAt }));

    const [conversation] = await db.select().from(conversations);
    expect(conversation?.windowExpiresAt).toEqual(new Date('2026-08-17T10:00:00Z'));

    expect(isWithinServiceWindow(conversation!, new Date('2026-08-17T09:59:00Z'))).toBe(
      true,
    );
    expect(isWithinServiceWindow(conversation!, new Date('2026-08-17T10:01:00Z'))).toBe(
      false,
    );
  });

  it('records Click-to-WhatsApp referral data for attribution', async () => {
    await ingestMessage(
      db,
      messageEvent({
        referral: {
          sourceId: 'AD_123',
          sourceUrl: 'https://fb.com/ad/123',
          headline: 'מוכר דירה בבאר שבע?',
        },
      }),
    );

    const referrals = await db.select().from(campaignReferrals);
    expect(referrals).toHaveLength(1);
    expect(referrals[0]?.adId).toBe('AD_123');

    const contact = await findContactByPhone(db, '972501234567');
    expect(contact?.entryPoint).toBe('click_to_whatsapp');
  });

  it('stores media references', async () => {
    await ingestMessage(
      db,
      messageEvent({
        text: 'זו הדירה',
        media: { id: 'MEDIA_1', kind: 'image', mimeType: 'image/jpeg' },
      }),
    );

    const [stored] = await db.select().from(messages);
    expect(stored?.mediaType).toBe('image');
    expect(stored?.mediaUrl).toBe('MEDIA_1');
  });

  // Rejecting the webhook would make Meta retry a message we can never act on.
  it('skips an unparseable sender without failing', async () => {
    const result = await ingestMessage(db, messageEvent({ from: 'not-a-number' }));

    expect(result.skipped).toBe('unparseable_phone');
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  // A WhatsApp message carries no name beyond the profile display name, which
  // must not overwrite the real name captured on the lead form.
  it('does not overwrite an existing name with the profile name', async () => {
    const { upsertContactByPhone } = await import('../db/repositories/contacts.js');
    await upsertContactByPhone(db, { phone: '972501234567', name: 'From lead form' });

    await ingestMessage(db, messageEvent({ profileName: 'whatsapp nickname' }));

    const contact = await findContactByPhone(db, '972501234567');
    expect(contact?.name).toBe('From lead form');
  });

  it('uses the profile name when no name is known yet', async () => {
    await ingestMessage(db, messageEvent({ profileName: 'ישראל ישראלי' }));

    const contact = await findContactByPhone(db, '972501234567');
    expect(contact?.name).toBe('ישראל ישראלי');
  });
});

describe('ingestStatus', () => {
  async function seedOutbound(providerMessageId: string) {
    await ingestMessage(db, messageEvent({ providerMessageId: 'wamid.SEED' }));
    const [conversation] = await db.select().from(conversations);
    await db.insert(messages).values({
      conversationId: conversation!.id,
      direction: 'outbound',
      body: 'reply',
      providerMessageId,
      deliveryStatus: 'sent',
    });
  }

  it('advances delivery status', async () => {
    await seedOutbound('wamid.OUT');

    await ingestStatus(db, {
      kind: 'status',
      providerMessageId: 'wamid.OUT',
      status: 'delivered',
      recipientId: '972501234567',
      timestamp: new Date(),
    });

    const [stored] = await db
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, 'wamid.OUT'));
    expect(stored?.deliveryStatus).toBe('delivered');
  });

  // Status webhooks arrive out of order; `read` can land before `delivered`.
  it('does not move a status backwards', async () => {
    await seedOutbound('wamid.OUT');

    await ingestStatus(db, {
      kind: 'status',
      providerMessageId: 'wamid.OUT',
      status: 'read',
      recipientId: '972501234567',
      timestamp: new Date(),
    });
    await ingestStatus(db, {
      kind: 'status',
      providerMessageId: 'wamid.OUT',
      status: 'delivered',
      recipientId: '972501234567',
      timestamp: new Date(),
    });

    const [stored] = await db
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, 'wamid.OUT'));
    expect(stored?.deliveryStatus).toBe('read');
  });

  it('records the failure reason', async () => {
    await seedOutbound('wamid.OUT');

    await ingestStatus(db, {
      kind: 'status',
      providerMessageId: 'wamid.OUT',
      status: 'failed',
      recipientId: '972501234567',
      timestamp: new Date(),
      errorTitle: 'Re-engagement message',
    });

    const [stored] = await db
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, 'wamid.OUT'));
    expect(stored?.deliveryStatus).toBe('failed');
    expect(stored?.error).toBe('Re-engagement message');
  });

  it('ignores a status for an unknown message', async () => {
    await expect(
      ingestStatus(db, {
        kind: 'status',
        providerMessageId: 'wamid.NEVER_SENT',
        status: 'delivered',
        recipientId: '972501234567',
        timestamp: new Date(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('ingestEvents', () => {
  it('ingests every message in a batch from different people', async () => {
    const results = await ingestEvents(db, [
      messageEvent({ providerMessageId: 'wamid.A', from: '972501111111' }),
      messageEvent({ providerMessageId: 'wamid.B', from: '972502222222' }),
    ]);

    expect(results).toHaveLength(2);
    expect(await db.select().from(conversations)).toHaveLength(2);
    expect(await db.select().from(messages)).toHaveLength(2);
  });
});
