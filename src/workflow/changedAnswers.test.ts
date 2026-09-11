import { eq } from 'drizzle-orm';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SLOT_OPTIONS } from '../appointments/availability.js';
import { findSlotsToOffer, latestOffer, recordOffer } from '../appointments/booking.js';
import {
  formatSlot,
  SLOT_REOFFER_BODY,
  SLOT_SUGGEST_BODY,
  SLOTS_DECLINED_MESSAGE,
  STALE_SLOT_MESSAGE,
} from '../appointments/slotMessages.js';
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
import { createConversationWorkflow, type ConversationDeps } from './conversationTurn.js';
import type { KnownFacts } from './decide.js';
import {
  EXCLUSIVE_FOLLOWUP_MESSAGE,
  EXCLUSIVITY_QUESTION,
  FACT_CHANGE_DECLINED_MESSAGE,
  FACT_CHANGE_NO,
  FACT_CHANGE_YES,
  FACT_CHANGE_APPLIED_MESSAGE,
  MARKETED_YES_QUESTION,
  RETRY_PREFIX,
  neighborhoodClarification,
  screeningQuestionFor,
} from './interactive.js';

/**
 * What happens after a lead's answers are complete and they say something
 * that does not fit the script — a question about the offered times, a changed
 * answer, a tap on a stale meeting time. Pinned from one live conversation in
 * which each of these went wrong in turn: the bot denied having a calendar
 * right after offering times, closed a booked lead on one stray tap, sent a
 * close that was not Hebrew, and re-ran the questionnaire from the top when the
 * person tapped an old time.
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

/** An empty calendar that records what is written to it. */
class FakeCalendar {
  created: { name: string; values: Record<string, unknown> }[] = [];
  private counter = 0;
  listItems() {
    return Promise.resolve([]);
  }
  createItem(_board: string, name: string, values: Record<string, unknown>) {
    this.created.push({ name, values });
    return Promise.resolve(`activity-${++this.counter}`);
  }
}

function appointments(calendar = new FakeCalendar()) {
  return {
    db,
    monday: calendar as unknown as MondayClient,
    slotOptions: { ...DEFAULT_SLOT_OPTIONS, timeZone: TZ },
  };
}

const COMPLETE: KnownFacts = {
  sellIntent: 'ready',
  neighborhood: 'רמות',
  timeline: 'immediate',
  currentlyMarketed: 'no',
  bookingIntent: true,
  intentAssessed: true,
};

let phoneCounter = 0;

/** A form lead at the given stage, with the bot's last message already sent. */
async function seed(options: {
  stage: ConversationStage;
  known?: KnownFacts;
  priorReply: string;
  inbound: string;
  /** A direct-message lead is asked all four questions; a form lead Q2 + Q4. */
  entryPoint?: 'meta_lead_form' | 'direct_message';
}): Promise<string> {
  const contact = await upsertContactByPhone(db, {
    phone: `+9725044444${String(phoneCounter++).padStart(2, '0')}`,
    entryPoint: options.entryPoint ?? 'meta_lead_form',
    consentStatus: 'whatsapp_opt_in',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);
  await db
    .update(conversations)
    .set({ stage: options.stage, extracted: options.known ?? COMPLETE })
    .where(eq(conversations.id, conversation.id));
  await db.insert(messages).values({
    conversationId: conversation.id,
    direction: 'outbound',
    body: options.priorReply,
    providerMessageId: `prior-${conversation.id}`,
    createdAt: new Date(Date.now() - 1000),
  });
  await recordInboundMessage(db, {
    conversationId: conversation.id,
    providerMessageId: `in-${conversation.id}`,
    body: options.inbound,
    createdAt: new Date(),
  });
  await recordInboundActivity(db, conversation.id, new Date());
  return conversation.id;
}

async function reply(conversationId: string, text: string): Promise<void> {
  // Dated now, never ahead: a message dated in the future would sort after the
  // reply the turn persists, and read as unanswered on the next turn.
  await recordInboundMessage(db, {
    conversationId,
    providerMessageId: `in-${conversationId}-${text}`,
    body: text,
    createdAt: new Date(),
  });
}

function run(deps: ConversationDeps, conversationId: string) {
  return createConversationWorkflow(deps, checkpointer).invoke(conversationId, {
    configurable: { thread_id: conversationId },
  });
}

const facts = async (conversationId: string): Promise<KnownFacts> =>
  (await getConversationById(db, conversationId))!.extracted as KnownFacts;

describe('a question while meeting times are on the table', () => {
  const asksForEarlier =
    '{"intent":"FAQ","confidence":0.9,"asksQuestion":true,"extracted":{}}';

  it('is answered with the real times in view, not deflected', async () => {
    const deps = appointments();
    const conversationId = await seed({
      stage: 'appointment_proposed',
      priorReply: 'מעולה! 📅 אלה הזמנים הפנויים הקרובים של לידור — מה מתאים לך?',
      inbound: 'אין מוקדם יותר היום?',
    });
    const offered = await findSlotsToOffer(deps);
    await recordOffer(deps, conversationId, offered, 30 * 60 * 1000);

    const llm = new FakeLlmClient([
      asksForEarlier,
      'המועד הכי מוקדם שפנוי אצל לידור הוא הראשון ברשימה. איזה מהם מתאים לך?',
    ]);
    const result = await run(
      { db, llm, channel: new FakeChannel(), appointments: deps },
      conversationId,
    );

    expect(result.action).toBe('assist_booking');
    expect(result.stage).toBe('appointment_proposed');
    // The generator was told the standing times — a list message stores only
    // its body, so without this the model has no idea what was offered.
    const instruction = llm.requests[1]!.messages.at(-1)!.content;
    expect(instruction).toContain('[CONTEXT]');
    expect(instruction).toContain(formatSlot(offered[0]!, TZ));
    expect(instruction).toContain('nothing earlier is available');
  });

  it('keeps the standing offer when it is fresh — no second list', async () => {
    const deps = appointments();
    const channel = new FakeChannel();
    const conversationId = await seed({
      stage: 'appointment_proposed',
      priorReply: 'מעולה! 📅 אלה הזמנים הפנויים הקרובים של לידור — מה מתאים לך?',
      inbound: 'אין מוקדם יותר היום?',
    });
    await recordOffer(deps, conversationId, await findSlotsToOffer(deps), 30 * 60 * 1000);

    await run(
      {
        db,
        llm: new FakeLlmClient([asksForEarlier, 'הראשון הוא הכי מוקדם. איזה מתאים לך?']),
        channel,
        appointments: deps,
      },
      conversationId,
    );

    expect(channel.sent.map((m) => m.kind)).toEqual(['text']);
  });

  it('offers the times again when the earlier offer has lapsed', async () => {
    const deps = appointments();
    const channel = new FakeChannel();
    const conversationId = await seed({
      stage: 'appointment_proposed',
      priorReply: 'מעולה! 📅 אלה הזמנים הפנויים הקרובים של לידור — מה מתאים לך?',
      inbound: 'ומה לגבי בערב?',
    });
    // Held for thirty minutes, an hour ago.
    await recordOffer(
      deps,
      conversationId,
      await findSlotsToOffer(deps),
      30 * 60 * 1000,
      new Date(Date.now() - 60 * 60 * 1000),
    );

    await run(
      {
        db,
        llm: new FakeLlmClient([asksForEarlier, 'אלה המועדים שפנויים. איזה מתאים לך?']),
        channel,
        appointments: deps,
      },
      conversationId,
    );

    expect(channel.sent.map((m) => m.kind)).toEqual(['text', 'list']);
    const list = channel.sent[1]!;
    expect(list.kind === 'list' && list.body).toBe(SLOT_REOFFER_BODY);
    // A new, current hold — so a tap on the re-sent list books.
    const offer = await latestOffer(db, conversationId);
    expect(offer?.holdExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('turning the times down ends the booking honestly', async () => {
    const deps = appointments();
    const channel = new FakeChannel();
    const conversationId = await seed({
      stage: 'appointment_proposed',
      priorReply: 'מעולה! 📅 אלה הזמנים הפנויים הקרובים של לידור — מה מתאים לך?',
      inbound: 'אף אחד לא מתאים לי, שלידור יתקשר אליי',
    });
    await recordOffer(deps, conversationId, await findSlotsToOffer(deps), 30 * 60 * 1000);

    const result = await run(
      {
        db,
        llm: new FakeLlmClient([
          '{"intent":"ANSWER","confidence":0.9,"declinesOfferedTimes":true,"extracted":{}}',
        ]),
        channel,
        appointments: deps,
      },
      conversationId,
    );

    expect(result.action).toBe('decline_slots');
    expect(result.stage).toBe('qualified');
    expect(result.text).toBe(SLOTS_DECLINED_MESSAGE);
  });
});

describe('a changed answer after the details are with Lidor', () => {
  const nowWithAgent =
    '{"intent":"ANSWER","confidence":0.9,"extracted":{"currentlyMarketed":"with_agent"}}';
  const booked = 'מצוין, קבעתי! ✅ נתראה ביום שלישי 19:00 (8 בספטמבר).';

  it('is checked with the person and not applied meanwhile', async () => {
    const channel = new FakeChannel();
    const conversationId = await seed({
      stage: 'appointment_confirmed',
      priorReply: booked,
      inbound: 'כן, עם מתווך',
    });

    const result = await run(
      {
        db,
        llm: new FakeLlmClient([nowWithAgent]),
        channel,
        appointments: appointments(),
      },
      conversationId,
    );

    expect(result.action).toBe('confirm_fact_change');
    expect(result.stage).toBe('appointment_confirmed');
    const sent = channel.sent[0]!;
    expect(sent.kind).toBe('buttons');
    expect(sent.kind === 'buttons' && sent.body).toContain('משווק דרך מתווך אחר');
    expect(sent.kind === 'buttons' && sent.body).toContain('לא משווק כרגע');
    expect(sent.kind === 'buttons' && sent.buttons.map((b) => b.title)).toEqual([
      FACT_CHANGE_YES,
      FACT_CHANGE_NO,
    ]);

    const known = await facts(conversationId);
    expect(known.currentlyMarketed).toBe('no'); // untouched
    expect(known.pendingFactChange).toEqual({
      field: 'currentlyMarketed',
      value: 'with_agent',
    });
    const conversation = await getConversationById(db, conversationId);
    expect(conversation?.disqualificationReason).toBeNull();
  });

  it('a yes applies it, and what follows from it follows — in fixed Hebrew', async () => {
    const conversationId = await seed({
      stage: 'appointment_confirmed',
      known: {
        ...COMPLETE,
        pendingFactChange: { field: 'currentlyMarketed', value: 'with_agent' },
      },
      priorReply: 'רק מוודא שהבנתי נכון 🙂',
      inbound: FACT_CHANGE_YES,
    });
    const llm = new FakeLlmClient([]); // no model call: the change is deterministic

    const result = await run({ db, llm, channel: new FakeChannel() }, conversationId);

    expect(result.action).toBe('ask_exclusivity');
    expect(result.stage).toBe('screening_exclusivity');
    expect(result.text).toBe(EXCLUSIVITY_QUESTION);
    const known = await facts(conversationId);
    expect(known.currentlyMarketed).toBe('with_agent');
    expect(known.pendingFactChange).toBeUndefined();
    expect(llm.requests).toHaveLength(0);
  });

  it('a change with no consequence is simply acknowledged and passed on', async () => {
    const conversationId = await seed({
      stage: 'qualified',
      known: {
        ...COMPLETE,
        pendingFactChange: { field: 'neighborhood', value: 'נווה זאב' },
      },
      priorReply: 'רק מוודא שהבנתי נכון 🙂',
      inbound: 'כן',
    });

    const result = await run(
      { db, llm: new FakeLlmClient([]), channel: new FakeChannel() },
      conversationId,
    );

    expect(result.action).toBe('fact_change_applied');
    expect(result.stage).toBe('qualified');
    expect(result.text).toBe(FACT_CHANGE_APPLIED_MESSAGE);
    expect((await facts(conversationId)).neighborhood).toBe('נווה זאב');
  });

  it('a no keeps the earlier answer', async () => {
    const conversationId = await seed({
      stage: 'appointment_confirmed',
      known: {
        ...COMPLETE,
        pendingFactChange: { field: 'currentlyMarketed', value: 'with_agent' },
      },
      priorReply: 'רק מוודא שהבנתי נכון 🙂',
      inbound: FACT_CHANGE_NO,
    });

    const result = await run(
      { db, llm: new FakeLlmClient([]), channel: new FakeChannel() },
      conversationId,
    );

    expect(result.action).toBe('fact_change_declined');
    expect(result.text).toBe(FACT_CHANGE_DECLINED_MESSAGE);
    const known = await facts(conversationId);
    expect(known.currentlyMarketed).toBe('no');
    expect(known.pendingFactChange).toBeUndefined();
  });

  it('anything else lets the check lapse without applying the change', async () => {
    const conversationId = await seed({
      stage: 'appointment_confirmed',
      known: {
        ...COMPLETE,
        pendingFactChange: { field: 'currentlyMarketed', value: 'with_agent' },
      },
      priorReply: 'רק מוודא שהבנתי נכון 🙂',
      inbound: 'בסדר, נדבר בפגישה',
    });
    // The classifier, reading the transcript, re-emits the unconfirmed value.
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{"currentlyMarketed":"with_agent"}}',
      'מעולה, נתראה בפגישה. יש עוד משהו שחשוב שלידור יידע לפני כן?',
    ]);

    const result = await run({ db, llm, channel: new FakeChannel() }, conversationId);

    expect(result.action).toBe('assist_qualified');
    const known = await facts(conversationId);
    expect(known.currentlyMarketed).toBe('no');
    expect(known.pendingFactChange).toBeUndefined();
  });

  it('the exclusivity end closes the lead with the fixed close and a real date', async () => {
    const conversationId = await seed({
      stage: 'screening_exclusivity',
      known: { ...COMPLETE, currentlyMarketed: 'with_agent' },
      priorReply: EXCLUSIVITY_QUESTION,
      inbound: 'מחר',
    });
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{"exclusivityEndsAt":"מחר","exclusivityEndsOn":"2026-09-09"}}',
    ]);

    const result = await run({ db, llm, channel: new FakeChannel() }, conversationId);

    expect(result.stage).toBe('disqualified');
    expect(result.text).toBe(EXCLUSIVE_FOLLOWUP_MESSAGE);
    // The classifier was told what day it is, so "מחר" can become a date.
    const classifyMessages = llm.requests[0]!.messages;
    expect(classifyMessages.some((m) => m.content.startsWith('(היום: יום'))).toBe(true);
    const known = await facts(conversationId);
    expect(known.exclusivityEndsOn).toBe('2026-09-09');
    expect(llm.requests).toHaveLength(1); // the close was not model-written
  });
});

describe('a meeting time tapped outside the booking stage', () => {
  it('after the meeting is booked: told it is set, nothing re-runs', async () => {
    const deps = appointments();
    const conversationId = await seed({
      stage: 'appointment_confirmed',
      priorReply: 'מצוין, קבעתי! ✅',
      inbound: 'יום חמישי 09:00',
    });
    const slot = new Date('2026-09-15T16:00:00Z'); // Tuesday 19:00 local
    await db.insert(appointmentRequests).values({
      conversationId,
      proposedSlots: [],
      status: 'approved',
      selectedSlot: slot,
    });
    const llm = new FakeLlmClient([]);

    const result = await run(
      { db, llm, channel: new FakeChannel(), appointments: deps },
      conversationId,
    );

    expect(result.action).toBe('already_booked');
    expect(result.stage).toBe('appointment_confirmed');
    expect(result.text).toContain('יום שלישי 19:00');
    expect(llm.requests).toHaveLength(0);
  });

  it('from a qualified lead: a fresh offer, in the same list shape', async () => {
    const deps = appointments();
    const channel = new FakeChannel();
    const conversationId = await seed({
      stage: 'qualified',
      priorReply: 'תודה על הפרטים!',
      inbound: 'יום חמישי 09:00',
    });

    const result = await run(
      { db, llm: new FakeLlmClient([]), channel, appointments: deps },
      conversationId,
    );

    expect(result.action).toBe('offer_slots');
    expect(result.stage).toBe('appointment_proposed');
    const list = channel.sent.at(-1)!;
    expect(list.kind === 'list' && list.body).toBe(STALE_SLOT_MESSAGE);
  });

  it('after a close was reopened: only the one missing answer is asked, then real times', async () => {
    // The live case. A lead closed as exclusive tapped an old time; the reopen
    // had wiped every answer and the bot asked "are you selling?" from scratch.
    // Now the reopen keeps the answers minus the one that closed the door (Q4),
    // so that one question is asked — and answered, the times follow directly.
    const deps = appointments();
    const channel = new FakeChannel();
    const conversationId = await seed({
      stage: 'engaged',
      known: { ...COMPLETE, currentlyMarketed: undefined },
      priorReply: 'תודה רבה על הזמן והכנות 🙏',
      inbound: 'יום חמישי 09:00',
    });

    const first = await run(
      { db, llm: new FakeLlmClient([]), channel, appointments: deps },
      conversationId,
    );
    expect(first.action).toBe('ask_currently_marketed');
    expect(first.text).toBe(screeningQuestionFor('ask_currently_marketed')!.body);

    await reply(conversationId, 'לא');
    const second = await run(
      {
        db,
        llm: new FakeLlmClient([
          '{"intent":"ANSWER","confidence":0.9,"extracted":{"currentlyMarketed":"no"}}',
        ]),
        channel,
        appointments: deps,
      },
      conversationId,
    );
    expect(second.action).toBe('offer_slots');
    expect(second.stage).toBe('appointment_proposed');
    expect(
      channel.sent.some((m) => m.kind === 'text' && /חדרים|קומה|כתובת/.test(m.text)),
    ).toBe(false);
  });
});

describe('a burst of messages', () => {
  it('is answered once, as one message — nothing in it is lost', async () => {
    // Live: "תקבע לי פגישה" followed by "נוווו" a second later. The turn read
    // only the last line and answered "נוווו"; the request in the line before
    // it was never classified.
    const deps = appointments();
    const channel = new FakeChannel();
    const conversationId = await seed({
      stage: 'qualified',
      priorReply: 'תודה על הפרטים!',
      inbound: 'תקבע לי פגישה',
    });
    await reply(conversationId, 'נוווו');
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{"bookingIntent":true}}',
    ]);

    const result = await run({ db, llm, channel, appointments: deps }, conversationId);

    // The classifier saw both lines as the message under classification…
    const classified = llm.requests[0]!.messages.at(-1)!.content;
    expect(classified).toBe('תקבע לי פגישה\nנוווו');
    // …and neither line is also in the history it was given.
    expect(
      llm.requests[0]!.messages.slice(0, -1).some((m) => m.content === 'נוווו'),
    ).toBe(false);
    expect(result.action).toBe('offer_slots');
    expect(channel.sent).toHaveLength(1);

    // The surplus turn the second message scheduled finds nothing to answer.
    const again = await run(
      { db, llm: new FakeLlmClient([]), channel, appointments: deps },
      conversationId,
    );
    expect(again.action).toBe('skipped_no_inbound');
    expect(channel.sent).toHaveLength(1);
  });

  it('answers the text and counts the photo when both arrive together', async () => {
    const conversationId = await seed({
      stage: 'qualified',
      priorReply: 'תודה על הפרטים!',
      inbound: 'זה הבית',
    });
    await recordInboundMessage(db, {
      conversationId,
      providerMessageId: `photo-${conversationId}`,
      mediaType: 'image',
      mediaUrl: 'wamid-media-1',
      createdAt: new Date(),
    });
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{"additionalNotes":"בית פרטי"}}',
    ]);

    const result = await run({ db, llm, channel: new FakeChannel() }, conversationId);

    expect(result.action).toBe('acknowledge_additional_info');
    expect((await facts(conversationId)).photoCount).toBe(1);
  });
});

describe('answers the script did not anticipate', () => {
  const Q1 = screeningQuestionFor('ask_sell_intent')!.body;
  const Q2 = screeningQuestionFor('ask_neighborhood')!.body;
  const Q4 = screeningQuestionFor('ask_currently_marketed')!.body;

  it('takes a bare "כן" to Q1 as the wish to sell and moves on', async () => {
    // Live: five identical re-asks of Q1 to a lead who kept saying כן.
    const conversationId = await seed({
      stage: 'screening_sell_intent',
      known: {},
      priorReply: Q1,
      inbound: 'כן',
      entryPoint: 'direct_message',
    });
    const llm = new FakeLlmClient([
      '{"intent":"UNCLEAR","confidence":0.2,"extracted":{}}',
    ]);

    const result = await run({ db, llm, channel: new FakeChannel() }, conversationId);

    expect(result.action).toBe('ask_neighborhood');
    expect((await facts(conversationId)).sellIntent).toBe('ready');
  });

  it('narrows a bare "כן" to Q4 instead of asking Q4 again', async () => {
    const channel = new FakeChannel();
    const conversationId = await seed({
      stage: 'screening_currently_marketed',
      known: { sellIntent: 'ready', neighborhood: 'רמות', timeline: 'immediate' },
      priorReply: Q4,
      inbound: 'כן',
    });
    const llm = new FakeLlmClient([]); // deterministic — no model call

    const result = await run({ db, llm, channel }, conversationId);

    expect(result.stage).toBe('screening_currently_marketed');
    expect(result.text).toBe(MARKETED_YES_QUESTION.body);
    expect(channel.sent[0]!.kind).toBe('buttons');
    expect(llm.requests).toHaveLength(0);
    expect((await facts(conversationId)).currentlyMarketed).toBeUndefined();
  });

  it('says it did not understand before asking the same question again', async () => {
    const conversationId = await seed({
      stage: 'screening_sell_intent',
      known: {},
      priorReply: Q1,
      inbound: '🥹',
      entryPoint: 'direct_message',
    });
    const llm = new FakeLlmClient([
      '{"intent":"UNCLEAR","confidence":0.1,"extracted":{}}',
    ]);

    const result = await run({ db, llm, channel: new FakeChannel() }, conversationId);

    expect(result.action).toBe('ask_sell_intent');
    expect(result.text).toBe(RETRY_PREFIX + Q1);
  });

  it('checks an address the classifier could not place, once, then accepts the answer', async () => {
    // Live: a Tel Aviv address at Q2 drew the identical Q2 again, and would
    // have forever — the one-time clarification only fired for a place the
    // classifier *had* extracted.
    const channel = new FakeChannel();
    const conversationId = await seed({
      stage: 'screening_neighborhood',
      known: { sellIntent: 'ready', timeline: 'immediate' },
      priorReply: Q2,
      inbound: 'התימנים 18 בכרם התימנים בתל אביב',
    });

    const first = await run(
      {
        db,
        llm: new FakeLlmClient([
          '{"intent":"ANSWER","confidence":0.9,"extracted":{"additionalNotes":"התימנים 18, תל אביב"}}',
        ]),
        channel,
      },
      conversationId,
    );
    expect(first.action).toBe('clarify_neighborhood');
    expect(first.text).toBe(
      neighborhoodClarification('התימנים 18 בכרם התימנים בתל אביב'),
    );

    await reply(conversationId, 'זה לא בבאר שבע, זה בתל אביב');
    const second = await run(
      {
        db,
        llm: new FakeLlmClient(['{"intent":"ANSWER","confidence":0.9,"extracted":{}}']),
        channel,
      },
      conversationId,
    );
    // The flow moves on (a form lead's next question is Q4) with their words kept.
    expect(second.action).toBe('ask_currently_marketed');
    expect((await facts(conversationId)).neighborhood).toBe(
      'התימנים 18 בכרם התימנים בתל אביב',
    );
  });
});

describe('a high-priority lead at the end of screening', () => {
  it("is offered Lidor's times as a suggestion, and can decline them", async () => {
    const deps = appointments();
    const channel = new FakeChannel();
    const conversationId = await seed({
      stage: 'assessing_intent',
      known: {
        sellIntent: 'ready',
        neighborhood: 'רמות',
        timeline: 'immediate',
        currentlyMarketed: 'no',
      },
      priorReply: 'כמה חדרים ובאיזו קומה?',
      inbound: '4 חדרים קומה 3, עוברים דירה',
    });

    const offered = await run(
      {
        db,
        llm: new FakeLlmClient([
          '{"intent":"ANSWER","confidence":0.9,"extracted":{"seriousSeller":true,"sellMotivation":"עוברים דירה","additionalNotes":"4 חדרים, קומה 3"}}',
        ]),
        channel,
        appointments: deps,
      },
      conversationId,
    );
    expect(offered.action).toBe('offer_slots');
    expect(offered.stage).toBe('appointment_proposed');
    const list = channel.sent.at(-1)!;
    expect(list.kind === 'list' && list.body).toBe(SLOT_SUGGEST_BODY);
    expect(list.kind === 'list' && list.rows.length).toBe(6);

    await reply(conversationId, 'לא עכשיו, שלידור יתקשר אליי');
    const declined = await run(
      {
        db,
        llm: new FakeLlmClient([
          '{"intent":"ANSWER","confidence":0.9,"declinesOfferedTimes":true,"extracted":{}}',
        ]),
        channel,
        appointments: deps,
      },
      conversationId,
    );
    expect(declined.action).toBe('decline_slots');
    expect(declined.stage).toBe('qualified');
  });
});

describe('a listed neighbourhood typed in a variant', () => {
  it('is taken as the answer even when the classifier does not know the variant', async () => {
    const conversationId = await seed({
      stage: 'screening_neighborhood',
      known: { sellIntent: 'ready', timeline: 'immediate' },
      priorReply: screeningQuestionFor('ask_neighborhood')!.body,
      inbound: "שכונה ו' החדשה",
    });
    // The classifier omits it (not on its list) — the old dead-end.
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.8,"extracted":{}}',
    ]);

    const result = await run({ db, llm, channel: new FakeChannel() }, conversationId);

    expect(result.action).toBe('ask_currently_marketed');
    expect((await facts(conversationId)).neighborhood).toBe('שכונה ו׳');
  });
});
