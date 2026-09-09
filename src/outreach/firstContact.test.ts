import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { upsertContactByPhone, type Contact } from '../db/repositories/contacts.js';
import { findOrCreateConversation } from '../db/repositories/conversations.js';
import { recordOptOut } from '../db/repositories/optOuts.js';
import { conversations, events, messages, outbox } from '../db/schema.js';
import { CloudApiError } from '../whatsapp/cloudApiChannel.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import type { OutboundTemplate } from '../whatsapp/channel.js';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { ConsentRequiredError } from '../whatsapp/guardedSend.js';
import { WELCOME_MESSAGE } from '../workflow/interactive.js';
import { findLeadsAwaitingFirstContact, sendFirstContact } from './firstContact.js';

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

const TEMPLATE: OutboundTemplate = { name: 'welcome_message', language: 'he' };

let phoneCounter = 0;
const nextPhone = (): string => `+9725012345${String(phoneCounter++).padStart(2, '0')}`;

/** A lead as `ingestLead` leaves it: consented, awaiting first contact. */
async function seedLead(
  options: {
    consentStatus?: Contact['consentStatus'];
    stage?: 'awaiting_first_contact' | 'engaged' | 'awaiting_reply';
    createdAt?: Date;
    lastInboundAt?: Date;
  } = {},
): Promise<{ conversationId: string; contact: Contact }> {
  const contact = await upsertContactByPhone(db, {
    phone: nextPhone(),
    entryPoint: 'meta_lead_form',
    consentStatus: options.consentStatus ?? 'whatsapp_opt_in',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);

  await db
    .update(conversations)
    .set({
      stage: options.stage ?? 'awaiting_first_contact',
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options.lastInboundAt ? { lastInboundAt: options.lastInboundAt } : {}),
    })
    .where(eq(conversations.id, conversation.id));

  return { conversationId: conversation.id, contact };
}

function deps(channel: FakeChannel) {
  return { db, channel, template: TEMPLATE };
}

describe('sendFirstContact', () => {
  it('sends the approved template to a consenting lead', async () => {
    const channel = new FakeChannel();
    const { conversationId, contact } = await seedLead();

    const outcome = await sendFirstContact(deps(channel), conversationId);

    expect(outcome).toMatchObject({ sent: true });
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({
      kind: 'template',
      to: contact.phone,
      template: { name: 'welcome_message', language: 'he' },
    });
  });

  it('moves the conversation to awaiting_reply', async () => {
    const channel = new FakeChannel();
    const { conversationId } = await seedLead();

    await sendFirstContact(deps(channel), conversationId);

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation?.stage).toBe('awaiting_reply');
    expect(conversation?.lastOutboundAt).not.toBeNull();
  });

  it('does NOT open a messaging window', async () => {
    // Only the lead's reply opens one. Treating a template as window-opening
    // would let the next turn send free-form text that Meta rejects.
    const channel = new FakeChannel();
    const { conversationId } = await seedLead();

    await sendFirstContact(deps(channel), conversationId);

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation?.windowExpiresAt).toBeNull();
  });

  it('records the outbound with its template reference and real wording', async () => {
    const channel = new FakeChannel();
    const { conversationId } = await seedLead();

    await sendFirstContact(deps(channel), conversationId);

    const [message] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(message?.direction).toBe('outbound');
    expect(message?.templateRef).toBe('welcome_message');
    // The stored body is the wording the person saw, so the model reads a
    // faithful transcript when they reply.
    expect(message?.body).toBe(WELCOME_MESSAGE);
  });

  it('writes a stage-transition event for the audit trail', async () => {
    const channel = new FakeChannel();
    const { conversationId } = await seedLead();

    await sendFirstContact(deps(channel), conversationId);

    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, conversationId));
    expect(event).toMatchObject({
      fromStage: 'awaiting_first_contact',
      toStage: 'awaiting_reply',
    });
  });

  describe('sends at most once', () => {
    it('does not send twice for the same lead', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seedLead();

      await sendFirstContact(deps(channel), conversationId);
      const second = await sendFirstContact(deps(channel), conversationId);

      expect(second).toEqual({ sent: false, reason: 'claimed_elsewhere' });
      expect(channel.sent).toHaveLength(1);
    });

    it('claims exactly once under concurrent sweeps', async () => {
      // Two workers looking at the same lead simultaneously. The compare-and-swap
      // on stage is what makes this safe; a read-then-write would send twice.
      const channel = new FakeChannel();
      const { conversationId } = await seedLead();

      const outcomes = await Promise.all([
        sendFirstContact(deps(channel), conversationId),
        sendFirstContact(deps(channel), conversationId),
      ]);

      expect(outcomes.filter((o) => o.sent)).toHaveLength(1);
      expect(channel.sent).toHaveLength(1);
    });

    it.each(['engaged', 'awaiting_reply'] as const)(
      'skips a conversation already in %s',
      async (stage) => {
        const channel = new FakeChannel();
        const { conversationId } = await seedLead({ stage });

        const outcome = await sendFirstContact(deps(channel), conversationId);

        expect(outcome.sent).toBe(false);
        expect(channel.sent).toHaveLength(0);
      },
    );
  });

  describe('refusals', () => {
    it('refuses a lead without WhatsApp consent (NN-2), and does not retry', async () => {
      // A refusal is permanent by construction: the same person will be refused
      // on the next sweep too. Before this was handled, a refused lead was
      // released back to the pool and picked up again every minute, for ever.
      const channel = new FakeChannel();
      const { conversationId } = await seedLead({
        consentStatus: 'privacy_policy_only',
      });

      const outcome = await sendFirstContact(deps(channel), conversationId);

      expect(outcome).toEqual({ sent: false, reason: 'send_refused' });
      expect(channel.sent).toHaveLength(0);

      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.stage).toBe('error');
      expect(conversation?.errorState).toContain(ConsentRequiredError.name);
      // Nothing about the person's identity leaks into the recorded cause.
      expect(conversation?.errorState).not.toMatch(/\+?972/);
    });

    it('parks an opted-out lead as opted out', async () => {
      const channel = new FakeChannel();
      const { conversationId, contact } = await seedLead();
      await recordOptOut(db, contact.phone, 'keyword', 'stop');

      const outcome = await sendFirstContact(deps(channel), conversationId);

      expect(outcome).toEqual({ sent: false, reason: 'send_refused' });
      expect(channel.sent).toHaveLength(0);
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.stage).toBe('opted_out');
    });

    it('leaves a parked lead out of the pool, and tells the board why', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seedLead({ consentStatus: 'none' });
      await sendFirstContact(deps(channel), conversationId);

      // A second sweep finds nothing to claim.
      const again = await sendFirstContact(deps(channel), conversationId);
      expect(again).toEqual({ sent: false, reason: 'claimed_elsewhere' });
      expect(channel.sent).toHaveLength(0);

      // Audited, and projected so it shows on Lidor's board rather than silently
      // vanishing from the queue.
      const [event] = await db
        .select()
        .from(events)
        .where(eq(events.aggregateId, conversationId));
      expect(event).toMatchObject({ toStage: 'error' });
      const queued = await db.select().from(outbox);
      expect(queued.some((row) => row.aggregateId === conversationId)).toBe(true);
    });

    it('parks a lead whose number Meta reports as undeliverable', async () => {
      // A 4xx from the Cloud API for this recipient will not change on retry.
      const channel = new FakeChannel();
      channel.sendTemplate = () =>
        Promise.reject(new CloudApiError('send failed: 400 undeliverable', false, 400));
      const { conversationId } = await seedLead();

      const outcome = await sendFirstContact(deps(channel), conversationId);

      expect(outcome).toEqual({ sent: false, reason: 'send_refused' });
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.stage).toBe('error');
      expect(conversation?.errorState).toContain('CloudApiError 400');
    });

    it('retries a lead when the Cloud API failure was transient', async () => {
      // A 5xx or a rate limit is Meta's problem, not this lead's.
      const channel = new FakeChannel();
      channel.sendTemplate = () =>
        Promise.reject(new CloudApiError('send failed: 503', true, 503));
      const { conversationId } = await seedLead();

      await expect(sendFirstContact(deps(channel), conversationId)).rejects.toThrow();

      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.stage).toBe('awaiting_first_contact');
    });

    it('releases the claim when the channel fails', async () => {
      const channel = new FakeChannel();
      channel.failNext(1);
      const { conversationId } = await seedLead();

      await expect(sendFirstContact(deps(channel), conversationId)).rejects.toThrow();

      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.stage).toBe('awaiting_first_contact');
    });

    it('leaves a lead who already messaged us to the inbound flow', async () => {
      // They opened the chat themselves. Reaching out now would talk over them.
      const channel = new FakeChannel();
      const { conversationId } = await seedLead({ lastInboundAt: new Date() });

      const outcome = await sendFirstContact(deps(channel), conversationId);

      expect(outcome.sent).toBe(false);
      expect(channel.sent).toHaveLength(0);
    });
  });
});

describe('findLeadsAwaitingFirstContact', () => {
  const GRACE_MS = 20 * 60 * 1000;
  const ago = (ms: number): Date => new Date(Date.now() - ms);

  it('returns a lead whose grace period has elapsed', async () => {
    const { conversationId } = await seedLead({ createdAt: ago(GRACE_MS + 1000) });

    expect(await findLeadsAwaitingFirstContact(db, GRACE_MS, 10)).toContain(
      conversationId,
    );
  });

  it('leaves a fresh lead alone', async () => {
    // The grace period exists so the bot does not talk over someone who is
    // already opening the chat themselves.
    const { conversationId } = await seedLead({ createdAt: new Date() });

    expect(await findLeadsAwaitingFirstContact(db, GRACE_MS, 10)).not.toContain(
      conversationId,
    );
  });

  it('ignores a lead who already messaged us', async () => {
    const { conversationId } = await seedLead({
      createdAt: ago(GRACE_MS + 1000),
      lastInboundAt: new Date(),
    });

    expect(await findLeadsAwaitingFirstContact(db, GRACE_MS, 10)).not.toContain(
      conversationId,
    );
  });

  it('ignores a conversation that is not awaiting first contact', async () => {
    const { conversationId } = await seedLead({
      stage: 'engaged',
      createdAt: ago(GRACE_MS + 1000),
    });

    expect(await findLeadsAwaitingFirstContact(db, GRACE_MS, 10)).not.toContain(
      conversationId,
    );
  });

  it('bounds the batch so a campaign spike is spread over sweeps', async () => {
    for (let i = 0; i < 4; i += 1) {
      await seedLead({ createdAt: ago(GRACE_MS + 1000) });
    }

    expect(await findLeadsAwaitingFirstContact(db, GRACE_MS, 2)).toHaveLength(2);
  });

  it('returns the longest-waiting leads first', async () => {
    const older = await seedLead({ createdAt: ago(GRACE_MS + 60_000) });
    const newer = await seedLead({ createdAt: ago(GRACE_MS + 1000) });

    const due = await findLeadsAwaitingFirstContact(db, GRACE_MS, 10);

    expect(due.indexOf(older.conversationId)).toBeLessThan(
      due.indexOf(newer.conversationId),
    );
  });
});
