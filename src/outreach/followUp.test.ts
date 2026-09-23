import { eq } from 'drizzle-orm';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SLOT_OPTIONS } from '../appointments/availability.js';
import { latestOffer } from '../appointments/booking.js';
import { ACTIVITY_COLUMNS } from '../monday/leadMapping.js';
import type { MondayClient } from '../monday/client.js';
import type { Database } from '../db/client.js';
import { upsertContactByPhone, type Contact } from '../db/repositories/contacts.js';
import {
  findOrCreateConversation,
  recordInboundActivity,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { recordInboundMessage } from '../db/repositories/messages.js';
import { recordOptOut } from '../db/repositories/optOuts.js';
import { conversations, messages, outbox } from '../db/schema.js';
import { setupTestDatabase, testDatabaseUrl, truncateAll } from '../db/testing.js';
import { FakeLlmClient } from '../llm/fake.js';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { createCheckpointer } from '../workflow/checkpointer.js';
import { createConversationWorkflow } from '../workflow/conversationTurn.js';
import { findConversationsDueForFollowUp, sendFollowUp } from './followUp.js';
import { APPOINTMENT_NUDGE_BODY, FOLLOW_UP_MESSAGES } from './followUpMessages.js';
import type { FollowUpLimits } from './followUpPolicy.js';

let db: Database;
let checkpointer: PostgresSaver;

beforeAll(async () => {
  db = await setupTestDatabase();
  checkpointer = createCheckpointer(testDatabaseUrl());
  await checkpointer.setup();
});

afterAll(async () => {
  await checkpointer.end();
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
  // Seeded conversations have never replied, so the no-reply slot is the one
  // exercised unless a test says otherwise.
  return {
    db,
    channel,
    limits: LIMITS,
    timeZone: TZ,
    templates: { noReply: template, incomplete: template },
  };
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

    describe('picks the template that fits the situation', () => {
      // Wording is fixed at approval, so the wrong template is not a cosmetic
      // slip: it tells someone who already described their property that we are
      // thanking them for leaving details.
      const NO_REPLY = { name: 'seller_followup_1', language: 'he' };
      const INCOMPLETE = { name: 'seller_followup_incomplete', language: 'he' };

      function bothTemplates(channel: FakeChannel) {
        return {
          db,
          channel,
          limits: LIMITS,
          timeZone: TZ,
          templates: { noReply: NO_REPLY, incomplete: INCOMPLETE },
        };
      }

      it('uses the cold template for a lead who never replied', async () => {
        const channel = new FakeChannel();
        const { conversationId } = await seed({ windowOpen: false });

        await sendFollowUp(bothTemplates(channel), conversationId, NOW);

        expect(channel.sent[0]).toMatchObject({
          kind: 'template',
          template: { name: 'seller_followup_1' },
        });
      });

      it('uses the mid-conversation template once they have answered', async () => {
        const channel = new FakeChannel();
        const { conversationId } = await seed({ windowOpen: false });
        // They answered at some point, then went quiet; the window has since
        // closed, so a template is required but a cold one would be wrong.
        await db
          .update(conversations)
          .set({
            lastInboundAt: new Date(NOW.getTime() - 3 * DAY),
            lastOutboundAt: new Date(NOW.getTime() - 2 * DAY),
            nextFollowupAt: NOW,
            stage: 'screening_neighborhood',
          })
          .where(eq(conversations.id, conversationId));

        await sendFollowUp(bothTemplates(channel), conversationId, NOW);

        expect(channel.sent[0]).toMatchObject({
          kind: 'template',
          template: { name: 'seller_followup_incomplete' },
        });
      });

      it('skips rather than substituting when the fitting template is missing', async () => {
        const channel = new FakeChannel();
        const { conversationId } = await seed({ windowOpen: false });
        await db
          .update(conversations)
          .set({
            lastInboundAt: new Date(NOW.getTime() - 3 * DAY),
            lastOutboundAt: new Date(NOW.getTime() - 2 * DAY),
            nextFollowupAt: NOW,
          })
          .where(eq(conversations.id, conversationId));

        const outcome = await sendFollowUp(
          { db, channel, limits: LIMITS, timeZone: TZ, templates: { noReply: NO_REPLY } },
          conversationId,
          NOW,
        );

        expect(outcome).toEqual({ sent: false, reason: 'no_template_available' });
        expect(channel.sent).toHaveLength(0);
      });
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

    it('never messages someone who opted out — and stops the sequence for good', async () => {
      // Before this was handled, a refused nudge restored its schedule to "now"
      // and was retried on every sweep, indefinitely. The cap never helped: it
      // only counts nudges that were actually sent.
      const channel = new FakeChannel();
      const { conversationId, contact } = await seed({ windowOpen: true });
      await recordOptOut(db, contact.phone, 'keyword', 'stop');

      const outcome = await sendFollowUp(deps(channel), conversationId, NOW);

      expect(outcome).toEqual({ sent: false, reason: 'send_refused' });
      expect(channel.sent).toHaveLength(0);

      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.stage).toBe('opted_out');
      expect(conversation?.nextFollowupAt).toBeNull();

      // Nothing left to claim on the next sweep.
      expect(await sendFollowUp(deps(channel), conversationId, NOW)).toEqual({
        sent: false,
        reason: 'not_due',
      });
      // And the board is told.
      const queued = await db.select().from(outbox);
      expect(queued.some((row) => row.aggregateId === conversationId)).toBe(true);
    });

    it('never sends a template nudge without consent — and does not retry it', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({
        windowOpen: false,
        consentStatus: 'privacy_policy_only',
      });

      const outcome = await sendFollowUp(deps(channel, TEMPLATE), conversationId, NOW);

      expect(outcome).toEqual({ sent: false, reason: 'send_refused' });
      expect(channel.sent).toHaveLength(0);
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.nextFollowupAt).toBeNull();
    });

    it('closes an exhausted sequence on the board too', async () => {
      // ליד ללא מענה exists on Lidor's status column for exactly this moment.
      // Without the projection the lead read as still-active indefinitely.
      const channel = new FakeChannel();
      const { conversationId } = await seed({ windowOpen: true, followupCount: 5 });

      await sendFollowUp(deps(channel), conversationId, NOW);

      const queued = await db.select().from(outbox);
      expect(queued.some((row) => row.aggregateId === conversationId)).toBe(true);
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

    it('restores the schedule when the send fails transiently, after a pause', async () => {
      const channel = new FakeChannel();
      channel.failNext(1);
      const { conversationId } = await seed({ windowOpen: true });

      await expect(sendFollowUp(deps(channel), conversationId, NOW)).rejects.toThrow();

      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.nextFollowupAt).not.toBeNull();
      // Not on the very next sweep — an outage is not hammered once a minute.
      expect(conversation!.nextFollowupAt!.getTime()).toBeGreaterThan(NOW.getTime());
    });

    it('tells the board about a nudge that was sent', async () => {
      const channel = new FakeChannel();
      const { conversationId } = await seed({ windowOpen: true });

      await sendFollowUp(deps(channel), conversationId, NOW);

      const queued = await db.select().from(outbox);
      expect(queued.some((row) => row.aggregateId === conversationId)).toBe(true);
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

  it('never lists someone who opted out, even with a nudge due', async () => {
    const { conversationId, contact } = await seed({
      dueAt: new Date(NOW.getTime() - 1000),
    });
    await recordOptOut(db, contact.phone, 'keyword', 'stop');

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

/** Stands in for the פעילות board; `busy` fills the whole horizon. */
class FakeCalendar {
  created: { name: string; values: Record<string, unknown> }[] = [];
  private items: {
    id: string;
    columnValues: Record<string, { text: null; value: string }>;
  }[] = [];
  private counter = 0;
  listItems() {
    return Promise.resolve(this.items);
  }
  createItem(_board: string, name: string, values: Record<string, unknown>) {
    this.created.push({ name, values });
    return Promise.resolve(`activity-${++this.counter}`);
  }
  createUpdate() {
    return Promise.resolve();
  }
  fullyBooked(): void {
    const asValue = (d: Date) =>
      JSON.stringify({
        date: d.toISOString().slice(0, 10),
        time: d.toISOString().slice(11, 19),
      });
    this.items.push({
      id: 'busy-all',
      columnValues: {
        [ACTIVITY_COLUMNS.start]: {
          text: null,
          value: asValue(new Date(NOW.getTime() - DAY)),
        },
        [ACTIVITY_COLUMNS.end]: {
          text: null,
          value: asValue(new Date(NOW.getTime() + 30 * DAY)),
        },
      },
    });
  }
}

function bookingDeps(calendar: FakeCalendar) {
  return {
    db,
    monday: calendar as unknown as MondayClient,
    slotOptions: { ...DEFAULT_SLOT_OPTIONS, timeZone: TZ },
  };
}

describe('a lead who was offered times and went quiet', () => {
  it('is nudged with the times again — a fresh list they can tap', async () => {
    const channel = new FakeChannel();
    const calendar = new FakeCalendar();
    const { conversationId } = await seed({
      stage: 'appointment_proposed',
      windowOpen: true,
    });

    const outcome = await sendFollowUp(
      { ...deps(channel), appointments: bookingDeps(calendar) },
      conversationId,
      NOW,
    );

    expect(outcome).toMatchObject({ sent: true, followUpNumber: 1 });
    const sent = channel.sent[0]!;
    expect(sent.kind).toBe('list');
    expect(sent.kind === 'list' && sent.body).toBe(APPOINTMENT_NUDGE_BODY);
    expect(sent.kind === 'list' && sent.rows.length).toBeGreaterThan(0);

    // The re-offer is recorded, so a tap on it is a real choice; the stage is
    // unchanged — they are still choosing — and the ladder counts the nudge.
    const offer = await latestOffer(db, conversationId);
    expect(offer).toBeDefined();
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation?.stage).toBe('appointment_proposed');
    expect(conversation?.followupCount).toBe(1);
    expect(conversation?.nextFollowupAt).not.toBeNull();
  });

  it('a tap on the re-offered list books the meeting', async () => {
    const channel = new FakeChannel();
    const calendar = new FakeCalendar();
    const appointments = bookingDeps(calendar);
    const { conversationId } = await seed({
      stage: 'appointment_proposed',
      windowOpen: true,
    });

    await sendFollowUp({ ...deps(channel), appointments }, conversationId, NOW);
    const list = channel.sent[0]!;
    const tapped = list.kind === 'list' ? list.rows[0]!.title : '';

    // WhatsApp echoes a tapped row as its title; ingestion records it and the
    // conversation worker runs the turn.
    await recordInboundMessage(db, {
      conversationId,
      providerMessageId: `tap-${conversationId}`,
      body: tapped,
      createdAt: new Date(),
    });
    await recordInboundActivity(db, conversationId, new Date());
    const result = await createConversationWorkflow(
      { db, llm: new FakeLlmClient([]), channel, appointments },
      checkpointer,
    ).invoke(conversationId, { configurable: { thread_id: conversationId } });

    expect(result.action).toBe('confirm_booking');
    expect(result.stage).toBe('appointment_confirmed');
    expect(calendar.created).toHaveLength(1);
  });

  it('outside the window gets the template, as anyone does', async () => {
    const channel = new FakeChannel();
    const { conversationId } = await seed({
      stage: 'appointment_proposed',
      windowOpen: false,
    });

    const outcome = await sendFollowUp(
      { ...deps(channel, TEMPLATE), appointments: bookingDeps(new FakeCalendar()) },
      conversationId,
      NOW,
    );

    expect(outcome).toMatchObject({ sent: true });
    expect(channel.sent[0]).toMatchObject({ kind: 'template' });
    expect(await latestOffer(db, conversationId)).toBeUndefined();
  });

  it('falls back to the ordinary nudge when nothing is free', async () => {
    const channel = new FakeChannel();
    const calendar = new FakeCalendar();
    calendar.fullyBooked();
    const { conversationId } = await seed({
      stage: 'appointment_proposed',
      windowOpen: true,
    });

    await sendFollowUp(
      { ...deps(channel), appointments: bookingDeps(calendar) },
      conversationId,
      NOW,
    );

    expect(channel.sent[0]).toMatchObject({ kind: 'text', text: FOLLOW_UP_MESSAGES[0] });
    expect(await latestOffer(db, conversationId)).toBeUndefined();
  });

  it('gets the ordinary nudge when booking is not wired up', async () => {
    const channel = new FakeChannel();
    const { conversationId } = await seed({
      stage: 'appointment_proposed',
      windowOpen: true,
    });

    await sendFollowUp(deps(channel), conversationId, NOW);

    expect(channel.sent[0]).toMatchObject({ kind: 'text', text: FOLLOW_UP_MESSAGES[0] });
  });

  it('still stops at the cap', async () => {
    const channel = new FakeChannel();
    const { conversationId } = await seed({
      stage: 'appointment_proposed',
      windowOpen: true,
      followupCount: 5,
    });

    const outcome = await sendFollowUp(
      { ...deps(channel), appointments: bookingDeps(new FakeCalendar()) },
      conversationId,
      NOW,
    );

    expect(outcome).toMatchObject({ sent: false, reason: 'max_followups_reached' });
    expect(channel.sent).toHaveLength(0);
  });
});
