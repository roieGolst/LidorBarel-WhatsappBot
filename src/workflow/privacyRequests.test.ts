import { eq } from 'drizzle-orm';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import {
  findOrCreateConversation,
  getConversationById,
  recordInboundActivity,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { recordInboundMessage } from '../db/repositories/messages.js';
import { isOptedOut, recordOptOut } from '../db/repositories/optOuts.js';
import { contacts, conversations, messages } from '../db/schema.js';
import { setupTestDatabase, testDatabaseUrl, truncateAll } from '../db/testing.js';
import { FakeLlmClient } from '../llm/fake.js';
import type { MondayClient } from '../monday/client.js';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { createCheckpointer } from './checkpointer.js';
import { createConversationWorkflow, type ConversationDeps } from './conversationTurn.js';
import type { KnownFacts } from './decide.js';
import { DELETION_ACK_MESSAGE, HANDOFF_TO_HUMAN_MESSAGE } from './interactive.js';

/**
 * The two promises on /privacy that are answered in the conversation itself:
 * "write 'מחקו את המידע שלי' and it is erased at once" (NN-8) and "you can ask
 * for a person at any time" (NN-10). Both must work without a model — the fake
 * has nothing queued, so a model call would fail the test loudly.
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

class FakeMonday {
  deleted: string[] = [];
  updated: string[] = [];
  deleteItem(itemId: string) {
    this.deleted.push(itemId);
    return Promise.resolve();
  }
  updateItem(_board: string, itemId: string) {
    this.updated.push(itemId);
    return Promise.resolve();
  }
}

const PHONE = '+972501234567';

async function seed(options: {
  stage: ConversationStage;
  inbound: string;
  known?: KnownFacts;
  mondayItemId?: string;
}): Promise<{ conversationId: string; contactId: string }> {
  const contact = await upsertContactByPhone(db, {
    phone: PHONE,
    name: 'רועי גולסט',
    entryPoint: 'direct_message',
    consentStatus: 'whatsapp_opt_in',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);
  await db
    .update(conversations)
    .set({
      stage: options.stage,
      extracted: options.known ?? {},
      mondayItemId: options.mondayItemId ?? null,
    })
    .where(eq(conversations.id, conversation.id));
  await db.insert(messages).values({
    conversationId: conversation.id,
    direction: 'outbound',
    body: 'באיזו שכונה נמצא הנכס?',
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
  return { conversationId: conversation.id, contactId: contact.id };
}

function run(deps: ConversationDeps, conversationId: string) {
  return createConversationWorkflow(deps, checkpointer).invoke(conversationId, {
    configurable: { thread_id: conversationId },
  });
}

describe('a deletion request (NN-8)', () => {
  it('acknowledges, erases everything, deletes the lead item, drops the thread, keeps the number', async () => {
    const { conversationId } = await seed({
      stage: 'screening_neighborhood',
      inbound: 'מחקו את המידע שלי',
      known: { sellIntent: 'ready' },
      mondayItemId: 'lead-1',
    });
    const channel = new FakeChannel();
    const monday = new FakeMonday();

    const result = await run(
      {
        db,
        llm: new FakeLlmClient([]),
        channel,
        monday: monday as unknown as MondayClient,
      },
      conversationId,
    );

    expect(result.action).toBe('data_deleted');
    expect(result.sent).toBe(true);
    expect(channel.sent).toEqual([
      expect.objectContaining({ kind: 'text', text: DELETION_ACK_MESSAGE }),
    ]);
    // Gone from the database…
    expect(await db.select().from(contacts)).toEqual([]);
    expect(await getConversationById(db, conversationId)).toBeUndefined();
    // …from the board…
    expect(monday.deleted).toEqual(['lead-1']);
    // …and the checkpoint thread of this very turn.
    expect(
      await checkpointer.getTuple({ configurable: { thread_id: conversationId } }),
    ).toBeUndefined();
    // The one thing kept.
    expect(await isOptedOut(db, PHONE)).toBe(true);
  });

  it('works for a contact who already opted out — in silence', async () => {
    const { conversationId } = await seed({
      stage: 'engaged',
      inbound: 'delete my data',
    });
    await recordOptOut(db, PHONE, 'keyword');
    const channel = new FakeChannel();

    const result = await run({ db, llm: new FakeLlmClient([]), channel }, conversationId);

    expect(result.action).toBe('data_deleted');
    expect(result.sent).toBe(false);
    expect(channel.sent).toEqual([]);
    expect(await db.select().from(contacts)).toEqual([]);
  });
});

describe('asking for a person (NN-10)', () => {
  it('ends the automated flow with the handoff, without a model', async () => {
    const { conversationId } = await seed({
      stage: 'screening_neighborhood',
      inbound: 'אני רוצה לדבר עם לידור',
      known: { sellIntent: 'ready' },
    });
    const channel = new FakeChannel();

    const result = await run({ db, llm: new FakeLlmClient([]), channel }, conversationId);

    expect(result.action).toBe('handoff_to_human');
    expect(result.stage).toBe('handed_off');
    expect(result.text).toBe(HANDOFF_TO_HUMAN_MESSAGE);
    // The answers already given stay with the lead.
    expect((await getConversationById(db, conversationId))!.extracted).toMatchObject({
      sellIntent: 'ready',
    });
  });

  it('keeps a booked lead in their booked stage', async () => {
    const { conversationId } = await seed({
      stage: 'appointment_confirmed',
      inbound: 'אפשר לדבר עם בן אדם?',
    });

    const result = await run(
      { db, llm: new FakeLlmClient([]), channel: new FakeChannel() },
      conversationId,
    );

    expect(result.action).toBe('handoff_to_human');
    expect(result.stage).toBe('appointment_confirmed');
  });

  it('an opt-out in the same breath is an opt-out', async () => {
    const { conversationId } = await seed({
      stage: 'engaged',
      inbound: 'תפסיקו, אני רוצה לדבר עם בן אדם',
    });

    const result = await run(
      {
        db,
        llm: new FakeLlmClient([
          '{"intent":"OPT_OUT","confidence":0.95,"extracted":{}}',
          'קיבלתי, לא נפנה אליך יותר. תודה.',
        ]),
        channel: new FakeChannel(),
      },
      conversationId,
    );

    expect(result.action).toBe('acknowledge_opt_out');
    expect(await isOptedOut(db, PHONE)).toBe(true);
  });
});
