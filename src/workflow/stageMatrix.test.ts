import { eq } from 'drizzle-orm';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SLOT_OPTIONS } from '../appointments/availability.js';
import {
  bookedAppointment,
  findSlotsToOffer,
  latestOffer,
  recordOffer,
} from '../appointments/booking.js';
import { formatSlot, parseStoredSlots } from '../appointments/slotMessages.js';
import type { Database } from '../db/client.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import {
  findOrCreateConversation,
  getConversationById,
  recordInboundActivity,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { recordInboundMessage } from '../db/repositories/messages.js';
import { appointmentRequests, conversations, messages } from '../db/schema.js';
import { setupTestDatabase, testDatabaseUrl, truncateAll } from '../db/testing.js';
import { FakeLlmClient } from '../llm/fake.js';
import type { MondayClient } from '../monday/client.js';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { createCheckpointer } from './checkpointer.js';
import { WORKFLOW_OWNED_FIELDS } from './classify.js';
import { createConversationWorkflow } from './conversationTurn.js';
import { POST_SCREENING_STAGES, type KnownFacts } from './decide.js';
import {
  RESTART_CONFIRM_BOOKED_MESSAGE,
  RESTART_CONFIRM_MESSAGE,
} from './interactive.js';

/**
 * Every live stage × every deterministic input, checked against the rules that
 * were broken in production on 2026-09-22 — when a lead with a booked meeting
 * typed "חזור", was dropped to the menu with an answer deleted, re-screened,
 * and offered times again as if nothing had been booked.
 *
 * This is the graph walked exhaustively rather than one path at a time. The
 * inputs are the ones the bot resolves without a model (control words, menu
 * taps, a time label, yes/no) plus one free-text message the fake model reads
 * as UNCLEAR, so a violation here is a structural bug, never a prompt.
 *
 * The rules:
 *  1. A turn never throws, whatever the stage and input.
 *  2. After qualification, no single turn deletes a collected answer. Undoing
 *     needs a confirmation turn first (the restart question), so the facts a
 *     turn starts with are a subset of the facts it ends with.
 *  3. A booked consultation survives every turn: the approved request keeps
 *     its board item, and no second item is ever created. The only way to a new
 *     time is a reschedule, which MOVES the same item.
 *  4. A booked lead is never sent back to screening or the menu in one turn.
 */

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

const TZ = 'Asia/Jerusalem';

class FakeCalendar {
  created: { name: string; values: Record<string, unknown> }[] = [];
  updated: { itemId: string; values: Record<string, unknown> }[] = [];
  private counter = 0;
  listItems() {
    return Promise.resolve([]);
  }
  createItem(_board: string, name: string, values: Record<string, unknown>) {
    this.created.push({ name, values });
    return Promise.resolve(`activity-${++this.counter}`);
  }
  updateItem(_board: string, itemId: string, values: Record<string, unknown>) {
    this.updated.push({ itemId, values });
    return Promise.resolve();
  }
}

const COMPLETE: KnownFacts = {
  sellIntent: 'ready',
  neighborhood: 'רמות',
  timeline: 'immediate',
  currentlyMarketed: 'no',
  bookingIntent: true,
  intentAssessed: true,
};

/** The stages a live conversation can be in when a message arrives. */
const LIVE_STAGES: ConversationStage[] = [
  'engaged',
  'screening_sell_intent',
  'screening_neighborhood',
  'screening_timeline',
  'screening_currently_marketed',
  'screening_exclusivity',
  'assessing_intent',
  'qualified',
  'appointment_proposed',
  'appointment_confirmed',
  'handed_off',
];

/** Facts consistent with having reached the stage. */
function factsFor(stage: ConversationStage): KnownFacts {
  switch (stage) {
    case 'engaged':
      return {};
    case 'screening_sell_intent':
      return {};
    case 'screening_neighborhood':
      return { sellIntent: 'ready' };
    case 'screening_timeline':
      return { sellIntent: 'ready', neighborhood: 'רמות' };
    case 'screening_currently_marketed':
      return { sellIntent: 'ready', neighborhood: 'רמות', timeline: 'immediate' };
    case 'screening_exclusivity':
      return {
        sellIntent: 'ready',
        neighborhood: 'רמות',
        timeline: 'immediate',
        currentlyMarketed: 'with_agent',
      };
    default:
      return COMPLETE;
  }
}

/** Every deterministic input, plus one the fake model reads as UNCLEAR. */
const INPUTS: { label: string; text: string }[] = [
  { label: 'control: back', text: 'חזור' },
  { label: 'control: restart', text: 'התחל מחדש' },
  { label: 'menu: check fit', text: '✅ בדיקת התאמה' },
  { label: 'menu: book meeting', text: '📅 קביעת פגישה' },
  { label: 'menu: testimonials', text: '⭐ המלצות' },
  { label: 'menu: about', text: 'ℹ️ מידע עלי' },
  { label: 'stale time label', text: 'יום ראשון 09:00' },
  { label: 'yes', text: 'כן' },
  { label: 'no', text: 'לא' },
  { label: 'free text (UNCLEAR)', text: 'שלום, מה נשמע?' },
];

const UNCLEAR = '{"intent":"UNCLEAR","confidence":0.2,"extracted":{}}';

let phoneCounter = 0;

async function seed(stage: ConversationStage, inbound: string, calendar: FakeCalendar) {
  const contact = await upsertContactByPhone(db, {
    phone: `+97250${String(4000000 + phoneCounter++)}`,
    entryPoint: 'direct_message',
    consentStatus: 'whatsapp_opt_in',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);
  await db
    .update(conversations)
    .set({ stage, extracted: factsFor(stage) })
    .where(eq(conversations.id, conversation.id));
  await db.insert(messages).values({
    conversationId: conversation.id,
    direction: 'outbound',
    body: 'הודעה קודמת של הבוט',
    providerMessageId: `prior-${conversation.id}`,
    createdAt: new Date(Date.now() - 1000),
  });

  const deps = {
    db,
    monday: calendar as unknown as MondayClient,
    slotOptions: { ...DEFAULT_SLOT_OPTIONS, timeZone: TZ },
  };
  if (stage === 'appointment_proposed' || stage === 'appointment_confirmed') {
    const slots = await findSlotsToOffer(deps);
    const offerId = await recordOffer(deps, conversation.id, slots, 30 * 60 * 1000);
    if (stage === 'appointment_confirmed') {
      const itemId = await calendar.createItem('board', 'פגישת ייעוץ', {});
      await db
        .update(appointmentRequests)
        .set({
          status: 'approved',
          selectedSlot: slots[0]!.start,
          mondayActivityItemId: itemId,
          holdExpiresAt: null,
        })
        .where(eq(appointmentRequests.id, offerId));
    }
  }

  await recordInboundMessage(db, {
    conversationId: conversation.id,
    providerMessageId: `in-${conversation.id}`,
    body: inbound,
    createdAt: new Date(),
  });
  await recordInboundActivity(db, conversation.id, new Date());
  return { conversationId: conversation.id, deps };
}

function answeredKeys(facts: KnownFacts): string[] {
  return Object.keys(facts).filter(
    (k) => !(WORKFLOW_OWNED_FIELDS as readonly string[]).includes(k),
  );
}

describe('every live stage × every deterministic input', () => {
  for (const stage of LIVE_STAGES) {
    for (const input of INPUTS) {
      it(`${stage} ← ${input.label}`, async () => {
        const calendar = new FakeCalendar();
        const { conversationId, deps } = await seed(stage, input.text, calendar);
        const before = (await getConversationById(db, conversationId))!;
        const bookedBefore = await bookedAppointment(db, conversationId);
        const itemsBefore = calendar.created.length;

        // Rule 1: never throws. Enough UNCLEAR answers for any number of model calls.
        const llm = new FakeLlmClient(Array<string>(4).fill(UNCLEAR));
        const channel = new FakeChannel();
        const turn = createConversationWorkflow(
          { db, llm, channel, appointments: deps },
          checkpointer,
        ).invoke(conversationId, { configurable: { thread_id: conversationId } });
        await expect(turn).resolves.toBeDefined();
        const result = await turn;

        const after = (await getConversationById(db, conversationId))!;

        // Rule 2: after qualification, nothing collected is deleted in one turn.
        if ((POST_SCREENING_STAGES as readonly string[]).includes(stage)) {
          const kept = answeredKeys(after.extracted as KnownFacts);
          for (const key of answeredKeys(before.extracted as KnownFacts)) {
            expect(kept, `${key} was deleted by "${input.text}" at ${stage}`).toContain(
              key,
            );
          }
        }

        // Rule 3: a booked consultation survives, on the same board item.
        if (bookedBefore) {
          const bookedAfter = await bookedAppointment(db, conversationId);
          expect(bookedAfter?.mondayActivityItemId).toBe(
            bookedBefore.mondayActivityItemId,
          );
          expect(calendar.created.length, 'a second consultation was created').toBe(
            itemsBefore,
          );
        }

        // Rule 4: a booked lead is never sent back to screening or the menu.
        if (stage === 'appointment_confirmed') {
          expect(['appointment_confirmed', 'appointment_proposed']).toContain(
            after.stage,
          );
          expect(result.action).not.toMatch(/^ask_|^show_main_menu$|^go_back$|^restart$/);
        }
      });
    }
  }
});

describe('the paths that went wrong live, replayed', () => {
  it('"חזור" from a booked lead asks first, names the meeting, and changes nothing', async () => {
    const calendar = new FakeCalendar();
    const { conversationId, deps } = await seed(
      'appointment_confirmed',
      'חזור',
      calendar,
    );
    const booked = (await bookedAppointment(db, conversationId))!;
    const channel = new FakeChannel();

    const result = await createConversationWorkflow(
      { db, llm: new FakeLlmClient([]), channel, appointments: deps },
      checkpointer,
    ).invoke(conversationId, { configurable: { thread_id: conversationId } });

    expect(result.action).toBe('confirm_restart');
    expect(result.stage).toBe('appointment_confirmed');
    expect(result.text).toBe(
      RESTART_CONFIRM_BOOKED_MESSAGE(
        formatSlot({ start: booked.selectedSlot, end: booked.selectedSlotEnd }, TZ),
      ),
    );
    const after = (await getConversationById(db, conversationId))!;
    expect(after.extracted).toMatchObject({ ...COMPLETE, awaitingRestartConfirm: true });
  });

  it('"חזור" mid-screening still undoes the last answer at once — that is what it is for', async () => {
    const calendar = new FakeCalendar();
    const { conversationId, deps } = await seed('screening_timeline', 'חזור', calendar);

    const result = await createConversationWorkflow(
      { db, llm: new FakeLlmClient([]), channel: new FakeChannel(), appointments: deps },
      checkpointer,
    ).invoke(conversationId, { configurable: { thread_id: conversationId } });

    expect(result.action).toBe('go_back');
    const after = (await getConversationById(db, conversationId))!;
    expect((after.extracted as KnownFacts).neighborhood).toBeUndefined();
    expect((after.extracted as KnownFacts).sellIntent).toBe('ready');
  });

  it('"התחל מחדש" from a qualified lead asks first rather than wiping', async () => {
    const calendar = new FakeCalendar();
    const { conversationId, deps } = await seed('qualified', 'התחל מחדש', calendar);

    const result = await createConversationWorkflow(
      { db, llm: new FakeLlmClient([]), channel: new FakeChannel(), appointments: deps },
      checkpointer,
    ).invoke(conversationId, { configurable: { thread_id: conversationId } });

    expect(result.action).toBe('confirm_restart');
    expect(result.text).toBe(RESTART_CONFIRM_MESSAGE);
    expect((await getConversationById(db, conversationId))!.extracted).toMatchObject(
      COMPLETE,
    );
  });

  it('a booked lead who asks for a meeting is offered to MOVE it, and a pick moves the same item', async () => {
    const calendar = new FakeCalendar();
    const { conversationId, deps } = await seed(
      'appointment_confirmed',
      '📅 קביעת פגישה',
      calendar,
    );
    const booked = (await bookedAppointment(db, conversationId))!;
    const channel = new FakeChannel();

    // A menu tap is classified before it is routed, so the fake answers once.
    const offered = await createConversationWorkflow(
      { db, llm: new FakeLlmClient([UNCLEAR]), channel, appointments: deps },
      checkpointer,
    ).invoke(conversationId, { configurable: { thread_id: conversationId } });

    expect(offered.action).toBe('offer_reschedule');
    expect(offered.stage).toBe('appointment_proposed');
    const list = channel.sent.at(-1)!;
    expect(list.kind).toBe('list');
    expect(offered.text).toContain(
      formatSlot({ start: booked.selectedSlot, end: booked.selectedSlotEnd }, TZ),
    );

    // They pick a different time — from the offer the bot actually recorded
    // (a ready-now lead is offered the earliest times, not the spread).
    const standing = parseStoredSlots(
      (await latestOffer(db, conversationId))!.proposedSlots,
    );
    const newSlot = standing.find(
      (s) => s.start.getTime() !== booked.selectedSlot.getTime(),
    )!;
    await recordInboundMessage(db, {
      conversationId,
      providerMessageId: `in-${conversationId}-2`,
      body: formatSlot(newSlot, TZ),
      createdAt: new Date(),
    });
    const moved = await createConversationWorkflow(
      { db, llm: new FakeLlmClient([]), channel, appointments: deps },
      checkpointer,
    ).invoke(conversationId, { configurable: { thread_id: conversationId } });

    expect(moved.action).toBe('confirm_booking');
    expect(moved.stage).toBe('appointment_confirmed');
    expect(moved.text).toContain('הועברה');
    // The SAME board item, updated — never a second consultation.
    expect(calendar.created).toHaveLength(1);
    expect(calendar.updated).toHaveLength(1);
    expect(calendar.updated[0]!.itemId).toBe(booked.mondayActivityItemId);
    const bookedAfter = (await bookedAppointment(db, conversationId))!;
    expect(bookedAfter.mondayActivityItemId).toBe(booked.mondayActivityItemId);
    expect(bookedAfter.selectedSlot.getTime()).toBe(newSlot.start.getTime());
    // Exactly one approved request remains.
    const approved = await db
      .select()
      .from(appointmentRequests)
      .where(eq(appointmentRequests.status, 'approved'));
    expect(approved).toHaveLength(1);
  });

  it('a booked lead who turns the new times down keeps the meeting', async () => {
    const calendar = new FakeCalendar();
    const { conversationId, deps } = await seed(
      'appointment_confirmed',
      '📅 קביעת פגישה',
      calendar,
    );
    const channel = new FakeChannel();
    await createConversationWorkflow(
      { db, llm: new FakeLlmClient([UNCLEAR]), channel, appointments: deps },
      checkpointer,
    ).invoke(conversationId, { configurable: { thread_id: conversationId } });

    await recordInboundMessage(db, {
      conversationId,
      providerMessageId: `in-${conversationId}-2`,
      body: 'לא, תשאיר כמו שזה',
      createdAt: new Date(),
    });
    const kept = await createConversationWorkflow(
      {
        db,
        llm: new FakeLlmClient([
          '{"intent":"ANSWER","confidence":0.9,"extracted":{},"declinesOfferedTimes":true}',
        ]),
        channel,
        appointments: deps,
      },
      checkpointer,
    ).invoke(conversationId, { configurable: { thread_id: conversationId } });

    expect(kept.action).toBe('decline_slots');
    expect(kept.stage).toBe('appointment_confirmed');
    expect(kept.text).toContain('נשארת');
    expect(calendar.updated).toHaveLength(0);
  });
});
