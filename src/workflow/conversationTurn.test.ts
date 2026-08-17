import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { findContactById, upsertContactByPhone } from '../db/repositories/contacts.js';
import {
  findOrCreateConversation,
  getConversationById,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { recentMessages, recordInboundMessage } from '../db/repositories/messages.js';
import { conversations, optOuts } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { FakeLlmClient } from '../llm/fake.js';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { createCheckpointer } from './checkpointer.js';
import { createConversationWorkflow, type ConversationDeps } from './conversationTurn.js';
import type { KnownFacts } from './decide.js';
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
}

/** Creates a contact + conversation and stores one inbound message. */
async function seed(
  options: SeedOptions,
): Promise<{ conversationId: string; phone: string }> {
  const phone = nextPhone();
  const contact = await upsertContactByPhone(db, { phone });
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

    const conversation = await getConversationById(db, conversationId);
    expect(conversation?.stage).toBe('screening_neighborhood');

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.text).toBe('שלום! באיזו שכונה נמצא הנכס?');

    const outbound = (await recentMessages(db, conversationId)).filter(
      (m) => m.direction === 'outbound',
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.body).toBe(result.text);
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
  });

  it('sends the regenerated reply, never the one that failed validation', async () => {
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{}}',
      'יש לנו מבצע דחוף בשבילך!', // banned words → rejected
      'שמחתי לשמוע, באיזו שכונה הנכס?', // clean retry
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
      },
      mergedExtracted: {},
      reply: {
        text: 'באיזו שכונה נמצא הנכס?',
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
      providerMessageId: 'out-replayed',
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
