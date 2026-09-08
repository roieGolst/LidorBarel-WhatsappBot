import { eq } from 'drizzle-orm';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import {
  findOrCreateConversation,
  getConversationById,
  recordInboundActivity,
} from '../db/repositories/conversations.js';
import { recordInboundMessage } from '../db/repositories/messages.js';
import { conversations, messages } from '../db/schema.js';
import { setupTestDatabase, testDatabaseUrl, truncateAll } from '../db/testing.js';
import { FakeLlmClient } from '../llm/fake.js';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { createCheckpointer } from './checkpointer.js';
import { createConversationWorkflow } from './conversationTurn.js';
import type { KnownFacts } from './decide.js';
import { neighborhoodClarification, screeningQuestionFor } from './interactive.js';
import { findBannedTerms } from './validate.js';
import { sanitizeExtraction } from './validateAnswer.js';

/**
 * The Q2 question invites "a full address", and people give one. Nothing maps
 * an address to a neighbourhood, so before this the address was stored as the
 * neighbourhood and the flow moved on — "אהרון מסקין" (a street) reached Lidor's
 * board as where the property was. These tests pin the clarification that now
 * happens instead, and that it happens exactly once.
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

describe('sanitizeExtraction', () => {
  it('reports a plausible place it does not recognise', () => {
    const result = sanitizeExtraction({ neighborhood: 'אהרון מסקין' });

    expect(result.unknownNeighborhood).toBe('אהרון מסקין');
    // Rule 1: still kept verbatim; the conversation decides what to do with it.
    expect(result.extracted.neighborhood).toBe('אהרון מסקין');
  });

  it('does not flag a known neighbourhood', () => {
    expect(
      sanitizeExtraction({ neighborhood: 'רמות' }).unknownNeighborhood,
    ).toBeUndefined();
  });

  it('does not flag an implausible value — that is a rejection, not a question', () => {
    const result = sanitizeExtraction({ neighborhood: 'Opus 4.8' });

    expect(result.invalidNeighborhood).toBe('Opus 4.8');
    expect(result.unknownNeighborhood).toBeUndefined();
  });
});

describe('the clarification wording', () => {
  const text = neighborhoodClarification('אהרון מסקין');

  it("names the person's own words back so they see what was misread", () => {
    expect(text).toContain('אהרון מסקין');
  });

  it('asks exactly one question and passes the voice rules', () => {
    expect(text.match(/\?/g)).toHaveLength(1);
    expect(findBannedTerms(text)).toEqual([]);
  });
});

let phoneCounter = 0;

/** A form lead at Q2, with the bot's Q2 question already sent. */
async function seedAtQ2(known: KnownFacts, inbound: string): Promise<string> {
  const contact = await upsertContactByPhone(db, {
    phone: `+9725033333${String(phoneCounter++).padStart(2, '0')}`,
    entryPoint: 'meta_lead_form',
    consentStatus: 'whatsapp_opt_in',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);
  await db
    .update(conversations)
    .set({
      stage: 'screening_neighborhood',
      extracted: { sellIntent: 'ready', timeline: 'immediate', ...known },
    })
    .where(eq(conversations.id, conversation.id));

  // The bot has spoken, so this is not the opening turn.
  await db.insert(messages).values({
    conversationId: conversation.id,
    direction: 'outbound',
    body: screeningQuestionFor('ask_neighborhood')!.body,
    providerMessageId: `q2-${conversation.id}`,
    createdAt: new Date(Date.now() - 1000),
  });
  await recordInboundMessage(db, {
    conversationId: conversation.id,
    providerMessageId: `in-${conversation.id}-${Date.now()}`,
    body: inbound,
    createdAt: new Date(),
  });
  await recordInboundActivity(db, conversation.id, new Date());
  return conversation.id;
}

function answer(extracted: Record<string, unknown>): string {
  return JSON.stringify({ intent: 'ANSWER', confidence: 0.9, extracted });
}

async function run(conversationId: string, llm: FakeLlmClient, channel: FakeChannel) {
  return createConversationWorkflow({ db, llm, channel }, checkpointer).invoke(
    conversationId,
    { configurable: { thread_id: conversationId } },
  );
}

describe('an address given as the neighbourhood', () => {
  it('is checked with the person instead of being stored', async () => {
    const channel = new FakeChannel();
    const conversationId = await seedAtQ2({}, 'אהרון מסקין');

    const result = await run(
      conversationId,
      new FakeLlmClient([answer({ neighborhood: 'אהרון מסקין' })]),
      channel,
    );

    expect(result.action).toBe('clarify_neighborhood');
    expect(result.stage).toBe('screening_neighborhood');
    const sent = channel.sent.at(-1);
    expect(sent).toMatchObject({ kind: 'text' });
    expect((sent as { text: string }).text).toContain('אהרון מסקין');

    const facts = (await getConversationById(db, conversationId))
      ?.extracted as KnownFacts;
    expect(facts.neighborhood).toBeUndefined();
    expect(facts.neighborhoodCandidate).toBe('אהרון מסקין');
    expect(facts.neighborhoodClarified).toBe(true);
  });

  it('takes the neighbourhood they then name, and drops the address', async () => {
    const channel = new FakeChannel();
    const conversationId = await seedAtQ2(
      { neighborhoodCandidate: 'אהרון מסקין', neighborhoodClarified: true },
      'רמות',
    );

    const result = await run(
      conversationId,
      new FakeLlmClient([answer({ neighborhood: 'רמות' })]),
      channel,
    );

    expect(result.action).toBe('ask_currently_marketed');
    const facts = (await getConversationById(db, conversationId))
      ?.extracted as KnownFacts;
    expect(facts.neighborhood).toBe('רמות');
    expect(facts.neighborhoodCandidate).toBeUndefined();
  });

  it('keeps their original words when they confirm without naming another place', async () => {
    // "כן, זו השכונה" — nothing new extracted, so the address stands, verbatim.
    const channel = new FakeChannel();
    const conversationId = await seedAtQ2(
      { neighborhoodCandidate: 'אהרון מסקין', neighborhoodClarified: true },
      'כן, זו השכונה',
    );

    const result = await run(conversationId, new FakeLlmClient([answer({})]), channel);

    expect(result.action).toBe('ask_currently_marketed');
    const facts = (await getConversationById(db, conversationId))
      ?.extracted as KnownFacts;
    expect(facts.neighborhood).toBe('אהרון מסקין');
    expect(facts.neighborhoodCandidate).toBeUndefined();
  });

  it('asks only once — a second unknown place is accepted, not questioned again', async () => {
    const channel = new FakeChannel();
    const conversationId = await seedAtQ2({ neighborhoodClarified: true }, 'אופקים');

    const result = await run(
      conversationId,
      new FakeLlmClient([answer({ neighborhood: 'אופקים' })]),
      channel,
    );

    expect(result.action).not.toBe('clarify_neighborhood');
    const facts = (await getConversationById(db, conversationId))
      ?.extracted as KnownFacts;
    expect(facts.neighborhood).toBe('אופקים');
  });

  it('does not question a neighbourhood it recognises', async () => {
    const channel = new FakeChannel();
    const conversationId = await seedAtQ2({}, 'רמות');

    const result = await run(
      conversationId,
      new FakeLlmClient([answer({ neighborhood: 'רמות' })]),
      channel,
    );

    expect(result.action).toBe('ask_currently_marketed');
  });
});
