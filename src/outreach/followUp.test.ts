import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { upsertContactByPhone, type Contact } from '../db/repositories/contacts.js';
import {
  findOrCreateConversation,
  recordInboundActivity,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { recordOptOut } from '../db/repositories/optOuts.js';
import { conversations, messages } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { ConsentRequiredError, OptedOutError } from '../whatsapp/guardedSend.js';
import { findConversationsDueForFollowUp, sendFollowUp } from './followUp.js';
import { FOLLOW_UP_MESSAGES } from './followUpMessages.js';
import type { FollowUpLimits } from './followUpPolicy.js';

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

const DAY = 24 * 60 * 60 * 1000;
const TZ = 'Asia/Jerusalem';
const LIMITS: FollowUpLimits = { intervalMs: DAY, maxFollowUps: 5, maxAgeMs: 5 * DAY };

/** A Sunday morning in Israel — inside business hours, so nothing is deferred. */
const NOW = new Date('2026-08-23T07:00:00Z');

let phoneCounter = 0;

interface SeedOptions {
  stage?: ConversationStage;
  followupCount?: number;
  dueAt?: Date | null;
  windowOpen?: boolean;
  firstOutboundAt?: Date;
  consentStatus?: Contact['consentStatus'];
}

async function seed(
  options: SeedOptions = {},
): Promise<{ conversationId: string; contact: Contact }> {
  const contact = await upsertContactByPhone(db, {
    phone: `+9725077777${String(phoneCounter++).padStart(2, '0')}`,
    entryPoint: 'meta_lead_form',
    consentStatus: options.consentStatus ?? 'whatsapp_opt_in',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);

  // The bot's opening. The five-day cap is measured from this.
  await db.insert(messages).values({
    conversationId: conversation.id,
    direction: 'outbound',
    body: 'opening',
    providerMessageId: `out-${conversation.id}`,
    createdAt: options.firstOutboundAt ?? new Date(NOW.getTime() - DAY),
  });

  await db
    .update(conversations)
    .set({
      stage: options.stage ?? 'awaiting_reply',
      followupCount: options.followupCount ?? 0,
      nextFollowupAt: options.dueAt === undefined ? NOW : options.dueAt,
      // Relative to the real clock, not the fake NOW: the send choke point
      // evaluates the window against wall time, while the follow-up caps use the
      // injected clock.
      ...(options.windowOpen
        ? { windowExpiresAt: new Date(Date.now() + 60 * 60 * 1000) }
        : {}),
    })
    .where(eq(conversations.id, conversation.id));

  return { conversationId: conversation.id, contact };
}

function deps(channel: FakeChannel, template?: { name: string; language: string }) {
  return { db, channel, limits: LIMITS, timeZone: TZ, template };
}

const TEMPLATE = { name: 'followup_nudge', language: 'he' };

describe('sendFollowUp', () => {
  describe('inside the messaging window', () => {
    it('sends the nudge as free-form text', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({ windowOpen: true });

      const outcome = await sendFollowUp(deps(channel), conversationId, NOW);

      expect(outcome).toMatchObject({ sent: true, followUpNumber: 1 });
      expect(channel.sent[0]).toMatchObject({
        kind: 'text',
        text: FOLLOW_UP_MESSAGES[0],
      });
    });

    it('advances the ladder on each nudge', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({ windowOpen: true, followupCount: 1 });

      const outcome = await sendFollowUp(deps(channel), conversationId, NOW);

      expect(outcome).toMatchObject({ followUpNumber: 2 });
      expect(channel.sent[0]).toMatchObject({ text: FOLLOW_UP_MESSAGES[1] });
    });

    it('records the message and schedules the next', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({ windowOpen: true });

      await sendFollowUp(deps(channel), conversationId, NOW);

      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.followupCount).toBe(1);
      expect(conversation?.nextFollowupAt).not.toBeNull();
    });
  });

  describe('outside the messaging window', () => {
    it('sends an approved template when one is configured', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({ windowOpen: false });

      const outcome = await sendFollowUp(deps(channel, TEMPLATE), conversationId, NOW);

      expect(outcome).toMatchObject({ sent: true });
      expect(channel.sent[0]).toMatchObject({ kind: 'template' });
    });

    it('sends nothing when no follow-up template is configured', async () => {
      // A lead who never answered the opening has no window, so without an
      // approved template there is nothing legitimate to send.
      const channel = new FakeChannel();
      const { conversationId } = await seed({ windowOpen: false });

      const outcome = await sendFollowUp(deps(channel), conversationId, NOW);

      expect(outcome).toEqual({ sent: false, reason: 'no_template_available' });
      expect(channel.sent).toHaveLength(0);
    });
  });

  /** Requirement §2.6 and §2.7, and NN-3. Each stop is asserted separately. */
  describe('stop conditions', () => {
    it('stops once the lead replies', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({ windowOpen: true });
      // A real reply clears the schedule outright.
      await recordInboundActivity(db, conversationId, NOW);

      const outcome = await sendFollowUp(deps(channel), conversationId, NOW);

      expect(outcome).toEqual({ sent: false, reason: 'not_due' });
      expect(channel.sent).toHaveLength(0);
    });

    it.each(['qualified', 'disqualified', 'opted_out', 'blocked', 'handed_off'] as const)(
      'sends nothing from %s',
      async (stage) => {
        const channel = new FakeChannel();
        const { conversationId } = await seed({ stage, windowOpen: true });

        const outcome = await sendFollowUp(deps(channel), conversationId, NOW);

        expect(outcome).toEqual({ sent: false, reason: 'stage_terminal' });
        expect(channel.sent).toHaveLength(0);
      },
    );

    it('stops at the message cap and closes the conversation', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({ windowOpen: true, followupCount: 5 });

      const outcome = await sendFollowUp(deps(channel), conversationId, NOW);

      expect(outcome).toEqual({ sent: false, reason: 'max_followups_reached' });
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.stage).toBe('closed_no_response');
    });

    it('stops after five days even with nudges left', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({
        windowOpen: true,
        followupCount: 1,
        firstOutboundAt: new Date(NOW.getTime() - 6 * DAY),
      });

      const outcome = await sendFollowUp(deps(channel), conversationId, NOW);

      expect(outcome).toEqual({ sent: false, reason: 'max_age_reached' });
      expect(channel.sent).toHaveLength(0);
    });

    it('never messages someone who opted out', async () => {
      const channel = new FakeChannel();
      const { conversationId, contact } = await seed({ windowOpen: true });
      await recordOptOut(db, contact.phone, 'keyword', 'stop');

      await expect(
        sendFollowUp(deps(channel), conversationId, NOW),
      ).rejects.toBeInstanceOf(OptedOutError);
      expect(channel.sent).toHaveLength(0);
    });

    it('never sends a template nudge without consent', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({
        windowOpen: false,
        consentStatus: 'privacy_policy_only',
      });

      await expect(
        sendFollowUp(deps(channel, TEMPLATE), conversationId, NOW),
      ).rejects.toBeInstanceOf(ConsentRequiredError);
    });

    it('clears the schedule on every stop, so nothing stays due', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({ stage: 'qualified', windowOpen: true });

      await sendFollowUp(deps(channel), conversationId, NOW);

      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.nextFollowupAt).toBeNull();
    });
  });

  describe('sends at most once', () => {
    it('does not send twice for the same due time', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({ windowOpen: true });

      await sendFollowUp(deps(channel), conversationId, NOW);
      const second = await sendFollowUp(deps(channel), conversationId, NOW);

      expect(second).toEqual({ sent: false, reason: 'not_due' });
      expect(channel.sent).toHaveLength(1);
    });

    it('claims once under concurrent sweeps', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({ windowOpen: true });

      const outcomes = await Promise.all([
        sendFollowUp(deps(channel), conversationId, NOW),
        sendFollowUp(deps(channel), conversationId, NOW),
      ]);

      expect(outcomes.filter((o) => o.sent)).toHaveLength(1);
      expect(channel.sent).toHaveLength(1);
    });

    it('restores the schedule when the send fails, so it retries', async () => {
      const channel = new FakeChannel();
      channel.failNext(1);
      const { conversationId } = await seed({ windowOpen: true });

      await expect(sendFollowUp(deps(channel), conversationId, NOW)).rejects.toThrow();

      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.nextFollowupAt).not.toBeNull();
    });
  });
});

describe('findConversationsDueForFollowUp', () => {
  it('returns a conversation whose nudge is due', async () => {
    const { conversationId } = await seed({ dueAt: new Date(NOW.getTime() - 1000) });

    expect(await findConversationsDueForFollowUp(db, 10, NOW)).toContain(conversationId);
  });

  it('ignores one scheduled for later', async () => {
    const { conversationId } = await seed({ dueAt: new Date(NOW.getTime() + DAY) });

    expect(await findConversationsDueForFollowUp(db, 10, NOW)).not.toContain(
      conversationId,
    );
  });

  it('ignores one with no schedule', async () => {
    const { conversationId } = await seed({ dueAt: null });

    expect(await findConversationsDueForFollowUp(db, 10, NOW)).not.toContain(
      conversationId,
    );
  });

  it('bounds the batch', async () => {
    await seed({ dueAt: new Date(NOW.getTime() - 1000) });
    await seed({ dueAt: new Date(NOW.getTime() - 2000) });
    await seed({ dueAt: new Date(NOW.getTime() - 3000) });

    expect(await findConversationsDueForFollowUp(db, 2, NOW)).toHaveLength(2);
  });
});
