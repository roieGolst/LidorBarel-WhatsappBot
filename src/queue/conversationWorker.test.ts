import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Database } from '../db/client.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import {
  findOrCreateConversation,
  getConversationById,
} from '../db/repositories/conversations.js';
import { recentMessages, recordInboundMessage } from '../db/repositories/messages.js';
import { setupTestDatabase, testDatabaseUrl, truncateAll } from '../db/testing.js';
import { FakeLlmClient } from '../llm/fake.js';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { createCheckpointer } from '../workflow/checkpointer.js';
import { processTurn } from './conversationWorker.js';

/**
 * Tests the per-job logic directly, with no BullMQ or Redis in sight — the whole
 * point of extracting {@link processTurn} from the worker shell. It runs against
 * a real Postgres + Postgres-backed checkpointer, faking only the LLM and the
 * WhatsApp transport, exactly as `workflow/conversationTurn.test.ts` does. That
 * a job, once dequeued, advances the conversation and sends a reply is the
 * contract the worker relies on; the BullMQ wiring around it is a thin wrapper.
 */

let db: Database;
let checkpointer: PostgresSaver;
let counter = 0;

function nextPhone(): string {
  counter += 1;
  return `+9725212346${String(counter).padStart(2, '0')}`;
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

/** Creates a contact + conversation and stores one inbound message. */
async function seed(inbound: string): Promise<{ conversationId: string; phone: string }> {
  const phone = nextPhone();
  // A Meta form lead: Q1/Q3 are pre-answered, so screening opens on Q2 (§3).
  const contact = await upsertContactByPhone(db, { phone, entryPoint: 'meta_lead_form' });
  const { conversation } = await findOrCreateConversation(db, contact.id);

  await recordInboundMessage(db, {
    conversationId: conversation.id,
    providerMessageId: `in-${conversation.id}`,
    body: inbound,
    createdAt: new Date(),
  });

  return { conversationId: conversation.id, phone };
}

describe('processTurn', () => {
  it('advances the conversation and sends a reply for a queued turn', async () => {
    // The opening is deterministic (welcome/video/menu), so only the classifier
    // runs on this turn.
    const llm = new FakeLlmClient([
      '{"intent":"UNCLEAR","confidence":0.2,"extracted":{}}',
    ]);
    const channel = new FakeChannel();
    const { conversationId, phone } = await seed('היי, ראיתי את המודעה');

    await processTurn({ db, llm, channel }, checkpointer, conversationId);

    // The stage advanced in the source of truth, not just in the workflow's
    // return value.
    const conversation = await getConversationById(db, conversationId);
    expect(conversation?.stage).toBe('engaged');

    // The first response is a single all-in-one opening: intro video header +
    // welcome body + menu buttons, to the right recipient, persisted.
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent.every((m) => m.to === phone)).toBe(true);
    expect(channel.sent.at(-1)?.kind).toBe('video_buttons');

    const outbound = (await recentMessages(db, conversationId)).filter(
      (m) => m.direction === 'outbound',
    );
    expect(outbound).toHaveLength(1);
  });
});
