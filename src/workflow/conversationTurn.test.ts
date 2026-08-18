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
import { conversations, messages, optOuts } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { FakeLlmClient } from '../llm/fake.js';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { createCheckpointer } from './checkpointer.js';
import { createConversationWorkflow, type ConversationDeps } from './conversationTurn.js';
import type { KnownFacts } from './decide.js';
import { INTRO_VIDEO_PATH, WELCOME_MESSAGE } from './interactive.js';
import { persistTurn, type PersistTurnInput } from './persist.js';
import { testDatabaseUrl } from '../db/testing.js';

/**
 * End-to-end tests for the assembled conversation workflow, against a real
 * PostgreSQL and a real Postgres-backed checkpointer. The LLM and WhatsApp
 * transport are faked; everything else is the production path.
 */

let db: Database;
let checkpointer: PostgresSaver;
let counter = 0;

/** A distinct valid Israeli mobile per call, so contacts never collide. */
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
  /**
   * Lead origin, which drives the screening branch (spec §3). Defaults to a Meta
   * form lead, so these tests exercise the Q2+Q4 flow unless they opt into the
   * direct-message all-four path.
   */
  entryPoint?: EntryPoint;
  /**
   * A prior outbound reply to record before the inbound, so the turn is not the
   * bot's first response — which suppresses the opening welcome/video sequence.
   */
  priorReply?: string;
}

/** Creates a contact + conversation and stores one inbound message. */
async function seed(
  options: SeedOptions,
): Promise<{ conversationId: string; phone: string }> {
  const phone = nextPhone();
  const contact = await upsertContactByPhone(db, {
    phone,
    entryPoint: options.entryPoint ?? 'meta_lead_form',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);

  if (options.stage || options.extracted) {
    await db
      .update(conversations)
      .set({
        ...(options.stage ? { stage: options.stage } : {}),
        ...(options.extracted ? { extracted: options.extracted } : {}),
      })
      .where(eq(conversations.id, conversation.id));
  }

  if (options.priorReply) {
    await db.insert(messages).values({
      conversationId: conversation.id,
      direction: 'outbound',
      body: options.priorReply,
      providerMessageId: `seed-out-${conversation.id}`,
      deliveryStatus: 'sent',
      createdAt: new Date(Date.now() - 1000),
    });
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
  it('opens with welcome + intro video, then the first question as a list', async () => {
    // Only the classifier runs — a screening question is deterministic, not
    // model-written, so no generate call is made.
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{}}',
    ]);
    const channel = new FakeChannel();
    const { conversationId } = await seed({ inbound: 'היי, ראיתי את המודעה' });

    const result = await workflow({ db, llm, channel }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.stage).toBe('screening_neighborhood');
    expect(result.action).toBe('ask_neighborhood');
    expect(result.text).toBe('באיזו שכונה נמצא הנכס?');

    // welcome text → intro video → neighborhood list, in that order.
    expect(channel.sent).toHaveLength(3);
    const [welcome, video, question] = channel.sent;
    expect(welcome).toMatchObject({ kind: 'text', text: WELCOME_MESSAGE });
    expect(video).toMatchObject({ kind: 'video', filePath: INTRO_VIDEO_PATH });
    expect(question?.kind).toBe('list');
    if (question?.kind === 'list') {
      expect(question.body).toBe('באיזו שכונה נמצא הנכס?');
      expect(question.rows.map((r) => r.id)).toContain('neighborhood:ramot');
    }

    // The classifier ran; the generator did not.
    expect(llm.requests).toHaveLength(1);

    const outbound = (await recentMessages(db, conversationId)).filter(
      (m) => m.direction === 'outbound',
    );
    expect(outbound).toHaveLength(3);
    expect(outbound.at(-1)?.body).toBe(result.text);
  });

  it('sends a three-option screening question as buttons', async () => {
    // A returning turn (Q4) after the neighborhood is known — no opening sequence.
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{}}',
    ]);
    const channel = new FakeChannel();
    const { conversationId } = await seed({
      inbound: 'רמות',
      stage: 'screening_neighborhood',
      extracted: { neighborhood: 'רמות' },
      priorReply: 'באיזו שכונה נמצא הנכס?',
    });

    const result = await workflow({ db, llm, channel }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.action).toBe('ask_currently_marketed');
    // No opening sequence on a later turn: just the one buttons message.
    expect(channel.sent).toHaveLength(1);
    const [question] = channel.sent;
    expect(question?.kind).toBe('buttons');
    if (question?.kind === 'buttons') {
      expect(question.body).toBe('האם הנכס משווק כרגע?');
      expect(question.buttons.map((b) => b.id)).toEqual([
        'marketed:no',
        'marketed:privately',
        'marketed:with_agent',
      ]);
    }
  });

  it('qualifies once both screening answers are in', async () => {
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{"currentlyMarketed":"no"}}',
      'מצוין, תודה! לידור יחזור אליך בהקדם.',
    ]);
    const { conversationId } = await seed({
      inbound: 'עדיין לא שיווקתי',
      stage: 'screening_currently_marketed',
      extracted: { neighborhood: 'רמות' },
      priorReply: 'האם הנכס משווק כרגע?',
    });

    const result = await workflow({ db, llm, channel: new FakeChannel() }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.stage).toBe('qualified');
    const conversation = await getConversationById(db, conversationId);
    expect(conversation?.stage).toBe('qualified');
    expect(conversation?.qualified).toBe(true);
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
      priorReply: 'האם הנכס משווק כרגע?',
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

    const conversation = await getConversationById(db, conversationId);
    const optOut = await db.select().from(optOuts).where(eq(optOuts.phone, phone));
    expect(optOut).toHaveLength(1);

    const contact = await findContactById(db, conversation!.contactId);
    expect(contact?.doNotContact).toBe(true);
    expect(contact?.consentStatus).toBe('opted_out');
  });

  it('leaves an already opted-out contact in silence', async () => {
    const llm = new FakeLlmClient([]); // must never be called
    const channel = new FakeChannel();
    const { conversationId, phone } = await seed({ inbound: 'עוד הודעה' });

    // The contact opted out on a previous turn.
    await recordOptOut(db, phone, 'classifier');

    const result = await workflow({ db, llm, channel }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.sent).toBe(false);
    expect(result.action).toBe('skipped_opted_out');
    expect(llm.requests).toHaveLength(0); // no classification, no cost
    expect(channel.sent).toHaveLength(0);

    const outbound = (await recentMessages(db, conversationId)).filter(
      (m) => m.direction === 'outbound',
    );
    expect(outbound).toHaveLength(0);
  });

  it('sends the regenerated reply, never the one that failed validation', async () => {
    // Only model-written replies (here, an FAQ answer) go through the
    // validate → regenerate path; screening questions are canned, so they cannot.
    const clean = 'נשמח לעזור, אפשר לפרט מה חשוב לך לדעת?';
    const llm = new FakeLlmClient([
      '{"intent":"FAQ","confidence":0.9}',
      'יש לנו מבצע דחוף בשבילך!', // banned words → rejected
      clean, // clean retry
    ]);
    const channel = new FakeChannel();
    const { conversationId } = await seed({
      inbound: 'כמה עולה לעבוד איתכם?',
      stage: 'engaged',
      priorReply: 'שלום', // not the first response → no opening sequence
    });

    const result = await workflow({ db, llm, channel }).invoke(
      conversationId,
      config(conversationId),
    );

    expect(result.text).toBe(clean);
    const last = channel.sent.at(-1);
    expect(last?.kind).toBe('text');
    if (last?.kind === 'text') expect(last.text).toBe(clean);
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
      },
      mergedExtracted: {},
      outbound: [
        {
          body: 'באיזו שכונה נמצא הנכס?',
          providerMessageId: 'out-replayed',
          llmModel: 'claude-haiku-4-5',
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
        },
      ],
      regenerated: false,
      fellBack: false,
    };

    // The same turn committed twice — as a redelivery or a retry would — must
    // not double-record the outbound message.
    await persistTurn(db, input);
    await persistTurn(db, input);

    const outbound = (await recentMessages(db, conversationId)).filter(
      (m) => m.direction === 'outbound',
    );
    expect(outbound).toHaveLength(1);
  });
});
