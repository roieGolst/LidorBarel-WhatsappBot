import { eq } from 'drizzle-orm';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { findContactByPhone } from '../db/repositories/contacts.js';
import { conversations } from '../db/schema.js';
import { setupTestDatabase, testDatabaseUrl, truncateAll } from '../db/testing.js';
import type { GraphLeadsClient, RetrievedLead } from '../leads/graphLeads.js';
import { ingestLead } from '../leads/ingestLead.js';
import { FakeLlmClient } from '../llm/fake.js';
import { sendFirstContact } from '../outreach/firstContact.js';
import { sendFollowUp } from '../outreach/followUp.js';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { ingestMessage } from '../whatsapp/ingest.js';
import type { InboundMessageEvent } from '../whatsapp/payload.js';
import { createCheckpointer } from '../workflow/checkpointer.js';
import { createConversationWorkflow } from '../workflow/conversationTurn.js';

/**
 * The central flow, end to end: a paid lead submits the Meta form, the bot opens
 * with the approved template, the lead replies, and the qualification
 * conversation continues.
 *
 * This exists because every other test starts from an inbound message. The whole
 * proactive product — the reason this system exists — could have been deleted and
 * the suite would have stayed green. If this test fails, the product is broken
 * regardless of what the unit tests say.
 *
 * Requirements covered: PRODUCT-REQUIREMENTS §2 steps 1, 2, 4a, and rule NN-2.
 */

let db: Database;
let checkpointer: PostgresSaver;

const PHONE = '+972501112233';
const FORM_ID = '1746567036243410';
const Q1 = 'הנכס_שלך_כבר_מוכן_לשיווק,_או_שאתה_עדיין_בשלב_בדיקה/התלבטות?';
const Q3 = 'תוך_כמה_זמן_אתה_מתכנן_למכור?';

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

/** A lead exactly as the live seller form delivers one. */
function retrievedLead(): RetrievedLead {
  return {
    id: 'LEAD-1',
    formId: FORM_ID,
    createdTime: new Date(),
    fieldData: [
      { name: Q1, values: ['מוכן_לשיווק'] },
      { name: Q3, values: ['מיידי'] },
      { name: 'full_name', values: ['ישראל ישראלי'] },
      { name: 'phone_number', values: [PHONE] },
      { name: 'email', values: ['israel@example.com'] },
    ],
    raw: { id: 'LEAD-1' },
  };
}

function leadsClient(): GraphLeadsClient {
  return {
    fetchLead: () => Promise.resolve(retrievedLead()),
  } as unknown as GraphLeadsClient;
}

/** The live configuration: the seller form both engages and carries consent. */
const INGEST_DEPS = {
  leads: leadsClient(),
  consent: {
    consentForms: [FORM_ID],
    formConsentText: 'אני מאשר/ת את מדיניות הפרטיות ומסכים/ה לקבלת הודעת אישור בוואטסאפ',
  },
  sellerForms: [FORM_ID],
};

const TEMPLATE = { name: 'welcome_message', language: 'he' };
const FOLLOW_UP_TEMPLATE = { name: 'followup_nudge', language: 'he' };
const TZ = 'Asia/Jerusalem';

function inbound(text: string, id: string): InboundMessageEvent {
  return {
    kind: 'message',
    providerMessageId: id,
    from: PHONE.replace('+', ''),
    timestamp: new Date(),
    messageType: 'text',
    text,
  };
}

describe('lead lifecycle: form submission to qualification', () => {
  it('carries a lead from the form through to the bot answering their reply', async () => {
    const channel = new FakeChannel();

    // 1. The form submission arrives on the leadgen webhook.
    const ingested = await ingestLead(
      db,
      { leadgenId: 'LEAD-1', formId: FORM_ID },
      INGEST_DEPS,
    );

    expect(ingested.engaged).toBe(true);
    expect(ingested.consentStatus).toBe('whatsapp_opt_in');
    const conversationId = ingested.conversationId!;

    // The form's own answers are known, so the bot will not re-ask Q1 or Q3.
    const [afterIngest] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(afterIngest?.stage).toBe('awaiting_first_contact');
    expect(afterIngest?.extracted).toEqual({
      sellIntent: 'ready',
      timeline: 'immediate',
    });

    // 2. The grace period elapses and the bot opens with the approved template.
    const outcome = await sendFirstContact(
      { db, channel, template: TEMPLATE },
      conversationId,
    );

    expect(outcome.sent).toBe(true);
    expect(channel.sent[0]).toMatchObject({ kind: 'template', to: PHONE });

    // A template does not open a messaging window — only the lead's reply does.
    const [afterTemplate] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(afterTemplate?.stage).toBe('awaiting_reply');
    expect(afterTemplate?.windowExpiresAt).toBeNull();

    // 3. The lead taps a template button. Quick replies arrive as ordinary text,
    //    which is why the template's buttons mirror the bot's own menu.
    await ingestMessage(db, inbound('בדיקת התאמה', 'wamid.REPLY-1'));

    const [afterReply] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(afterReply?.windowExpiresAt).not.toBeNull();

    // 4. The conversation continues: the bot may now answer free-form, and asks
    //    the next screening question rather than repeating the opening.
    const llm = new FakeLlmClient([
      JSON.stringify({ intent: 'ANSWER', confidence: 0.9, extracted: {} }),
    ]);
    const workflow = createConversationWorkflow({ db, llm, channel }, checkpointer);
    const result = await workflow.invoke(conversationId, {
      configurable: { thread_id: conversationId },
    });

    expect(result.sent).toBe(true);
    // Q2 is next: Q1 and Q3 came from the form, so only neighbourhood and
    // currently-marketed remain.
    expect(result.stage).toBe('screening_neighborhood');
    expect(channel.sent.length).toBeGreaterThan(1);
  });

  it('nudges a silent lead, then stops — and a reply cancels the sequence', async () => {
    // Requirement §2.3 and §2.6 end to end: the lead is contacted, ignores it,
    // gets nudged, then answers — after which nothing further is scheduled.
    const channel = new FakeChannel();
    const DAY = 24 * 60 * 60 * 1000;
    const limits = { intervalMs: DAY, maxFollowUps: 5, maxAgeMs: 5 * DAY };

    const ingested = await ingestLead(
      db,
      { leadgenId: 'LEAD-4', formId: FORM_ID },
      INGEST_DEPS,
    );
    const conversationId = ingested.conversationId!;

    await sendFirstContact(
      { db, channel, template: TEMPLATE, followUp: { limits, timeZone: TZ } },
      conversationId,
    );

    // The opening scheduled a nudge rather than leaving the lead in silence.
    const [afterOpening] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(afterOpening?.nextFollowupAt).not.toBeNull();

    // A day passes with no reply. The nudge needs a template, because a lead who
    // never answered has no open window.
    await db
      .update(conversations)
      .set({ nextFollowupAt: new Date(Date.now() - 1000) })
      .where(eq(conversations.id, conversationId));

    const nudge = await sendFollowUp(
      { db, channel, limits, timeZone: TZ, template: FOLLOW_UP_TEMPLATE },
      conversationId,
    );
    expect(nudge).toMatchObject({ sent: true, followUpNumber: 1 });

    // Now they answer. Any reply cancels the sequence and resets the counter.
    await ingestMessage(db, inbound('בדיקת התאמה', 'wamid.LATE-REPLY'));

    const [afterReply] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(afterReply?.nextFollowupAt).toBeNull();
    expect(afterReply?.followupCount).toBe(0);
  });

  it('never opens with a template for a lead who did not consent', async () => {
    // NN-2 end to end: a form not declared as carrying consent yields a lead that
    // is captured, attributed, and never messaged.
    const channel = new FakeChannel();

    const ingested = await ingestLead(
      db,
      { leadgenId: 'LEAD-2', formId: FORM_ID },
      { ...INGEST_DEPS, consent: {} },
    );

    expect(ingested.consentStatus).toBe('privacy_policy_only');
    await expect(
      sendFirstContact({ db, channel, template: TEMPLATE }, ingested.conversationId!),
    ).rejects.toThrow();
    expect(channel.sent).toHaveLength(0);

    // The lead is still on record — it was paid for.
    expect(await findContactByPhone(db, PHONE)).toBeDefined();
  });

  it('lets a lead who messages first keep the inbound opening', async () => {
    // They tapped through to WhatsApp before the grace period elapsed. The bot
    // must not talk over them with a template.
    const channel = new FakeChannel();
    const ingested = await ingestLead(
      db,
      { leadgenId: 'LEAD-3', formId: FORM_ID },
      INGEST_DEPS,
    );

    await ingestMessage(db, inbound('שלום', 'wamid.EARLY-1'));
    const outcome = await sendFirstContact(
      { db, channel, template: TEMPLATE },
      ingested.conversationId!,
    );

    expect(outcome.sent).toBe(false);
    expect(channel.sent).toHaveLength(0);
  });
});
