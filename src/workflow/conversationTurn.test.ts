import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import {
  findContactById,
  upsertContactByPhone,
  type EntryPoint,
} from '../db/repositories/contacts.js';
import {
  findOrCreateConversation,
  getConversationById,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { recentMessages, recordInboundMessage } from '../db/repositories/messages.js';
import { recordOptOut } from '../db/repositories/optOuts.js';
import { conversations, optOuts } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { FakeLlmClient } from '../llm/fake.js';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { ENGLISH_ONLY_REPLY } from './language.js';
import { createCheckpointer } from './checkpointer.js';
import { createConversationWorkflow, type ConversationDeps } from './conversationTurn.js';
import type { KnownFacts } from './decide.js';
import { persistTurn, type PersistTurnInput } from './persist.js';
import type { ScreeningState } from './screeningState.js';
import { testDatabaseUrl } from '../db/testing.js';

/**
 * End-to-end tests for the assembled conversation workflow, against a real
 * PostgreSQL and a real Postgres-backed checkpointer. The LLM and WhatsApp
 * transport are faked; everything else is the production path.
 */

let db: Database;
let checkpointer: PostgresSaver;
let counter = 0;

function nextPhone(): string {
  counter += 1;
  return `+9725212345${String(counter).padStart(2, '0')}`;
}

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

interface SeedOptions {
  inbound: string;
  stage?: ConversationStage;
  extracted?: KnownFacts;
  screeningState?: Partial<ScreeningState>;
  entryPoint?: EntryPoint;
}

async function seed(
  options: SeedOptions,
): Promise<{ conversationId: string; phone: string }> {
  const phone = nextPhone();
  const contact = await upsertContactByPhone(db, {
    phone,
    entryPoint: options.entryPoint ?? 'meta_lead_form',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);

  if (options.stage || options.extracted || options.screeningState) {
    await db
      .update(conversations)
      .set({
        ...(options.stage ? { stage: options.stage } : {}),
        ...(options.extracted ? { extracted: options.extracted } : {}),
        ...(options.screeningState ? { screeningState: options.screeningState } : {}),
      })
      .where(eq(conversations.id, conversation.id));
  }

  await recordInboundMessage(db, {
    conversationId: conversation.id,
    providerMessageId: `in-${conversation.id}`,
    body: options.inbound,
    createdAt: new Date(),
  });

  return { conversationId: conversation.id, phone };
}

function workflow(deps: ConversationDeps) {
  return createConversationWorkflow(deps, checkpointer);
}

function config(conversationId: string) {
  return { configurable: { thread_id: conversationId } };
}

describe('conversationTurn', () => {
  it('asks the first screening question on a new conversation', async () => {
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{}}',
      'שלום! באיזו שכונה נמצא הנכס?',
    ]);
    const channel = new FakeChannel();
    const { conversationId } = await seed({ inbound: 'היי, ראיתי את המודעה' });

    const result = await workflow({ db, llm, channel }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.stage).toBe('screening_neighborhood');
    expect(result.action).toBe('ask_neighborhood');
    expect(channel.sent[0]?.text).toBe('שלום! באיזו שכונה נמצא הנכס?');
  });

  it('probes motivation once both screening answers are in (does not qualify yet)', async () => {
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{"currentlyMarketed":"no"},"answersPendingQuestion":true}',
      'רק כדי להבין — מה גורם לך לשקול למכור עכשיו?',
    ]);
    const { conversationId } = await seed({
      inbound: 'עדיין לא שיווקתי',
      stage: 'screening_currently_marketed',
      extracted: { neighborhood: 'רמות' },
    });

    const result = await workflow({ db, llm, channel: new FakeChannel() }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.stage).toBe('assessing_motivation');
    const conversation = await getConversationById(db, conversationId);
    expect(conversation?.qualified).toBeNull();
  });

  it('qualifies a serious, complete lead after the motivation question', async () => {
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{},"answersPendingQuestion":true,"relevantToSelling":true}',
      '{"seriousness":0.9,"genuineIntent":true,"spam":false,"reason":"מוכר רציני"}',
      'מעולה, קיבלתי. אעביר את הפרטים ללידור.',
    ]);
    const { conversationId } = await seed({
      inbound: 'אנחנו עוברים דירה וצריכים למכור',
      stage: 'assessing_motivation',
      extracted: { neighborhood: 'רמות', currentlyMarketed: 'no' },
    });

    const result = await workflow({ db, llm, channel: new FakeChannel() }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.stage).toBe('qualified');
    const conversation = await getConversationById(db, conversationId);
    expect(conversation?.qualified).toBe(true);
  });

  it('holds a weak lead for review without qualifying it', async () => {
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{},"answersPendingQuestion":true,"relevantToSelling":true}',
      '{"seriousness":0.2,"genuineIntent":false,"spam":false,"reason":"לא נראה רציני"}',
      'תודה רבה על הפרטים.',
    ]);
    const { conversationId } = await seed({
      inbound: 'סתם בודק',
      stage: 'assessing_motivation',
      extracted: { neighborhood: 'רמות', currentlyMarketed: 'no' },
    });

    const result = await workflow({ db, llm, channel: new FakeChannel() }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.stage).toBe('needs_review');
    const conversation = await getConversationById(db, conversationId);
    expect(conversation?.qualified).toBe(false);
  });

  it('does not store an invalid neighborhood, and re-asks instead of advancing', async () => {
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{"neighborhood":"Opus 4.8"},"answersPendingQuestion":true,"relevantToSelling":true}',
      'לא הבנתי — באיזו שכונה נמצא הנכס?',
    ]);
    const { conversationId } = await seed({
      inbound: 'Opus 4.8',
      stage: 'screening_neighborhood',
    });

    const result = await workflow({ db, llm, channel: new FakeChannel() }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.stage).toBe('screening_neighborhood');
    const conversation = await getConversationById(db, conversationId);
    const extracted = conversation?.extracted as KnownFacts;
    expect(extracted.neighborhood).toBeUndefined();
    const state = conversation?.screeningState as ScreeningState;
    expect(state.invalidAnswerCount).toBe(1);
  });

  it('rejects a predominantly-English message without any model call', async () => {
    const llm = new FakeLlmClient([]); // must never be called
    const channel = new FakeChannel();
    const { conversationId } = await seed({
      inbound: 'Hello, I want to sell my apartment',
    });

    const result = await workflow({ db, llm, channel }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.action).toBe('reject_english');
    expect(channel.sent[0]?.text).toBe(ENGLISH_ONLY_REPLY);
    expect(llm.requests).toHaveLength(0); // no classification, no cost
  });

  it('makes no model call in containment mode and stops responding', async () => {
    const llm = new FakeLlmClient([]); // must never be called
    const channel = new FakeChannel();
    const { conversationId } = await seed({
      inbound: 'בדיחה אחרת',
      stage: 'engaged',
      screeningState: {
        mode: 'containment',
        warningSent: true,
        irrelevantResponseCount: 2,
      },
    });

    const result = await workflow({ db, llm, channel }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.action).toBe('stop_responding');
    expect(result.sent).toBe(false);
    expect(llm.requests).toHaveLength(0);
    expect(channel.sent).toHaveLength(0);

    const conversation = await getConversationById(db, conversationId);
    expect(conversation?.qualified).not.toBe(true);
  });

  it('disqualifies a lead already exclusive with another agent', async () => {
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{"currentlyMarketed":"with_agent"}}',
      'תודה על הזמן, נשמח לעמוד לרשותך בעתיד.',
    ]);
    const { conversationId } = await seed({
      inbound: 'יש לי כבר מתווך',
      stage: 'screening_currently_marketed',
      extracted: { neighborhood: 'נווה זאב' },
    });

    const result = await workflow({ db, llm, channel: new FakeChannel() }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.stage).toBe('disqualified');
    const conversation = await getConversationById(db, conversationId);
    expect(conversation?.disqualificationReason).toBe('exclusive_with_other_agent');
    expect(conversation?.qualified).toBe(false);
  });

  it('records a durable opt-out and flags the contact', async () => {
    const llm = new FakeLlmClient([
      '{"intent":"OPT_OUT","confidence":0.95}',
      'קיבלתי, לא נפנה אליך יותר. תודה.',
    ]);
    const { conversationId, phone } = await seed({ inbound: 'תפסיקו לשלוח לי הודעות' });

    const result = await workflow({ db, llm, channel: new FakeChannel() }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.stage).toBe('opted_out');
    const optOut = await db.select().from(optOuts).where(eq(optOuts.phone, phone));
    expect(optOut).toHaveLength(1);

    const conversation = await getConversationById(db, conversationId);
    const contact = await findContactById(db, conversation!.contactId);
    expect(contact?.doNotContact).toBe(true);
  });

  it('leaves an already opted-out contact in silence', async () => {
    const llm = new FakeLlmClient([]);
    const channel = new FakeChannel();
    const { conversationId, phone } = await seed({ inbound: 'עוד הודעה' });
    await recordOptOut(db, phone, 'classifier');

    const result = await workflow({ db, llm, channel }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.sent).toBe(false);
    expect(result.action).toBe('skipped_opted_out');
    expect(llm.requests).toHaveLength(0);
    expect(channel.sent).toHaveLength(0);
  });

  it('sends the regenerated reply, never the one that failed validation', async () => {
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{}}',
      'יש לנו מבצע דחוף בשבילך!',
      'שמחתי לשמוע, באיזו שכונה הנכס?',
    ]);
    const channel = new FakeChannel();
    const { conversationId } = await seed({ inbound: 'מעוניין למכור' });

    const result = await workflow({ db, llm, channel }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.text).toBe('שמחתי לשמוע, באיזו שכונה הנכס?');
    expect(channel.sent[0]?.text).toBe('שמחתי לשמוע, באיזו שכונה הנכס?');
  });

  it('persistTurn is idempotent by the outbound message id (replay-safe)', async () => {
    const { conversationId, phone } = await seed({ inbound: 'ראיתי מודעה' });
    const conversation = await getConversationById(db, conversationId);

    const input: PersistTurnInput = {
      conversationId,
      contactId: conversation!.contactId,
      contactPhone: phone,
      fromStage: 'new',
      decision: {
        nextStage: 'screening_neighborhood',
        action: 'ask_neighborhood',
        escalate: false,
        triggeredRule: 'advance_screening',
        reason: 'Advancing to ask_neighborhood',
      },
      mergedExtracted: {},
      screeningState: {
        answers: {},
        irrelevantResponseCount: 0,
        invalidAnswerCount: 0,
        reaskCount: 0,
        warningSent: false,
        mode: 'normal',
        sentVideoIds: [],
        promoSent: false,
        unknownNeighborhoods: [],
      },
      outbound: {
        providerMessageId: 'out-replayed',
        body: 'באיזו שכונה נמצא הנכס?',
        usage: [
          {
            model: 'claude-haiku-4-5',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
          },
        ],
        regenerated: false,
        fellBack: false,
      },
    };

    await persistTurn(db, input);
    await persistTurn(db, input);

    const outbound = (await recentMessages(db, conversationId)).filter(
      (m) => m.direction === 'outbound',
    );
    expect(outbound).toHaveLength(1);
  });
});
