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
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { createCheckpointer } from './checkpointer.js';
import { createConversationWorkflow, type ConversationDeps } from './conversationTurn.js';
import type { KnownFacts } from './decide.js';
import type { MondayClient } from '../monday/client.js';
import {
  DELETION_ACK_MESSAGE,
  MAIN_MENU,
  RECONSENT_DECLINED_MESSAGE,
  RECONSENT_QUESTION,
} from './interactive.js';

/**
 * The deletion request /privacy tells people to send (NN-8). It must work
 * without a model — the fake has nothing queued, so a model call would fail the
 * test loudly — erase the person everywhere, and block nothing: the person may
 * come back.
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
  deleteItem(itemId: string) {
    this.deleted.push(itemId);
    return Promise.resolve();
  }
  updateItem() {
    return Promise.resolve();
  }
}

const PHONE = '+972501234567';

async function seed(options: {
  stage: ConversationStage;
  inbound: string;
  known?: KnownFacts;
  mondayItemId?: string;
  /** The bot's last message before the inbound. */
  lastBotMessage?: string;
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
    body: options.lastBotMessage ?? 'באיזו שכונה נמצא הנכס?',
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
  it('acknowledges, erases everything, deletes the lead item and the thread, blocks nothing', async () => {
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

    expect(result).toMatchObject({ action: 'data_deleted', sent: true });
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
    // Nothing is kept, so nothing is blocked.
    expect(await isOptedOut(db, PHONE)).toBe(false);
  });

  it('lets the person come back: a new form submission starts over, eligible for outreach', async () => {
    const { conversationId } = await seed({
      stage: 'engaged',
      inbound: 'delete my data',
    });
    await run(
      { db, llm: new FakeLlmClient([]), channel: new FakeChannel() },
      conversationId,
    );

    const again = await upsertContactByPhone(db, {
      phone: PHONE,
      name: 'רועי גולסט',
      entryPoint: 'meta_lead_form',
      consentStatus: 'whatsapp_opt_in',
    });
    const { conversation } = await findOrCreateConversation(db, again.id);

    expect(again).toMatchObject({
      consentStatus: 'whatsapp_opt_in',
      doNotContact: false,
    });
    expect(conversation.id).not.toBe(conversationId);
    expect(await isOptedOut(db, PHONE)).toBe(false);
  });

  it('erases a contact who already opted out, acknowledges, and their opt-out stays', async () => {
    const { conversationId } = await seed({
      stage: 'opted_out',
      inbound: 'delete my data',
    });
    await recordOptOut(db, PHONE, 'keyword');
    const channel = new FakeChannel();

    const result = await run({ db, llm: new FakeLlmClient([]), channel }, conversationId);

    expect(result).toMatchObject({ action: 'data_deleted', sent: true });
    expect(channel.sent).toEqual([
      expect.objectContaining({ kind: 'text', text: DELETION_ACK_MESSAGE }),
    ]);
    expect(await db.select().from(contacts)).toEqual([]);
    expect(await isOptedOut(db, PHONE)).toBe(true);
  });

  it('drops a turn still queued for the erased conversation', async () => {
    const { conversationId } = await seed({
      stage: 'engaged',
      inbound: 'delete my data',
    });
    await run(
      { db, llm: new FakeLlmClient([]), channel: new FakeChannel() },
      conversationId,
    );

    const channel = new FakeChannel();
    const late = await run({ db, llm: new FakeLlmClient([]), channel }, conversationId);

    expect(late).toMatchObject({ action: 'skipped_erased', sent: false });
    expect(channel.sent).toEqual([]);
    expect(
      await checkpointer.getTuple({ configurable: { thread_id: conversationId } }),
    ).toBeUndefined();
  });
});

describe('someone who opted out writes again (NN-1)', () => {
  const noModel = () => new FakeLlmClient([]);

  it('is asked whether they want messages again — nothing resumes on its own', async () => {
    const { conversationId } = await seed({
      stage: 'opted_out',
      inbound: 'היי, יש לי שאלה',
    });
    await recordOptOut(db, PHONE, 'keyword');
    const channel = new FakeChannel();

    const result = await run({ db, llm: noModel(), channel }, conversationId);

    expect(result).toMatchObject({ action: 'reconsent_asked', stage: 'opted_out' });
    expect(channel.sent).toEqual([
      expect.objectContaining({ kind: 'buttons', body: RECONSENT_QUESTION.body }),
    ]);
    expect(await isOptedOut(db, PHONE)).toBe(true);
  });

  it('a yes reverses the opt-out, records the consent and continues with the menu', async () => {
    const { conversationId } = await seed({
      stage: 'opted_out',
      inbound: 'כן, אפשר להמשיך',
      lastBotMessage: RECONSENT_QUESTION.body,
    });
    await recordOptOut(db, PHONE, 'keyword');
    const channel = new FakeChannel();

    const result = await run({ db, llm: noModel(), channel }, conversationId);

    expect(result).toMatchObject({ action: 'reconsent_accepted', stage: 'engaged' });
    expect(channel.sent).toEqual([
      expect.objectContaining({ kind: 'list', body: MAIN_MENU.body }),
    ]);
    expect(await isOptedOut(db, PHONE)).toBe(false);
    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({
      consentStatus: 'whatsapp_opt_in',
      consentSource: 'whatsapp_reconsent',
      // The consent recorded is the question they said yes to, word for word.
      consentText: RECONSENT_QUESTION.body,
      doNotContact: false,
    });
  });

  it('a no keeps them opted out', async () => {
    const { conversationId } = await seed({
      stage: 'opted_out',
      inbound: 'לא, תודה',
      lastBotMessage: RECONSENT_QUESTION.body,
    });
    await recordOptOut(db, PHONE, 'keyword');
    const channel = new FakeChannel();

    const result = await run({ db, llm: noModel(), channel }, conversationId);

    expect(result).toMatchObject({
      action: 'reconsent_declined',
      text: RECONSENT_DECLINED_MESSAGE,
    });
    expect(await isOptedOut(db, PHONE)).toBe(true);
  });

  it('is asked once: after the question, and after a no, further messages get silence', async () => {
    const { conversationId } = await seed({ stage: 'opted_out', inbound: 'היי' });
    await recordOptOut(db, PHONE, 'keyword');
    const writes = async (text: string, n: number) => {
      await recordInboundMessage(db, {
        conversationId,
        providerMessageId: `in-${conversationId}-${n}`,
        body: text,
        createdAt: new Date(Date.now() + n * 1000),
      });
      await recordInboundActivity(db, conversationId, new Date());
    };
    const turn = async () => {
      const channel = new FakeChannel();
      const result = await run({ db, llm: noModel(), channel }, conversationId);
      return { result, sent: channel.sent.length };
    };

    expect((await turn()).result.action).toBe('reconsent_asked');
    await writes('מה זה?', 1); // not an answer: silence, not a second question
    expect(await turn()).toMatchObject({
      result: { action: 'skipped_opted_out' },
      sent: 0,
    });
    await writes('לא, תודה', 2); // …but the question is still open to a no
    expect((await turn()).result.action).toBe('reconsent_declined');
    await writes('היי שוב', 3);
    expect(await turn()).toMatchObject({
      result: { action: 'skipped_opted_out' },
      sent: 0,
    });
    expect(await isOptedOut(db, PHONE)).toBe(true);
  });

  it('a repeated stop request, or a ban, gets silence', async () => {
    const { conversationId } = await seed({ stage: 'opted_out', inbound: 'תפסיקו' });
    await recordOptOut(db, PHONE, 'keyword');
    const stopChannel = new FakeChannel();
    expect(
      await run({ db, llm: noModel(), channel: stopChannel }, conversationId),
    ).toMatchObject({ action: 'skipped_opted_out' });
    expect(stopChannel.sent).toEqual([]);

    await truncateAll(db);
    const banned = await seed({ stage: 'blocked', inbound: 'היי' });
    await recordOptOut(db, PHONE, 'classifier', 'abuse');
    const banChannel = new FakeChannel();
    expect(
      await run({ db, llm: noModel(), channel: banChannel }, banned.conversationId),
    ).toMatchObject({ action: 'skipped_opted_out' });
    expect(banChannel.sent).toEqual([]);
  });
});
