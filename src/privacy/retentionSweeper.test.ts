import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import { findOrCreateConversation } from '../db/repositories/conversations.js';
import { recordInboundMessage } from '../db/repositories/messages.js';
import { contacts, conversations } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { findStaleContacts, startRetentionSweeper } from './retentionSweeper.js';

let db: Database;
beforeAll(async () => {
  db = await setupTestDatabase();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** A lead whose every timestamp is `ageMs` old. */
async function seedLead(phone: string, ageMs: number): Promise<string> {
  const contact = await upsertContactByPhone(db, { phone, entryPoint: 'direct_message' });
  const { conversation } = await findOrCreateConversation(db, contact.id);
  await recordInboundMessage(db, {
    conversationId: conversation.id,
    providerMessageId: `in-${conversation.id}`,
    body: 'שלום',
    createdAt: new Date(Date.now() - ageMs),
  });
  const then = new Date(Date.now() - ageMs);
  await db
    .update(conversations)
    .set({ createdAt: then, updatedAt: then, lastInboundAt: then, lastOutboundAt: then })
    .where(eq(conversations.id, conversation.id));
  await db.update(contacts).set({ updatedAt: then }).where(eq(contacts.id, contact.id));
  return conversation.id;
}

describe('retention purge (NN-9)', () => {
  it('finds only the people silent since the cutoff', async () => {
    await seedLead('+972501111111', 25 * MONTH_MS);
    await seedLead('+972502222222', 1 * MONTH_MS);

    const stale = await findStaleContacts(db, new Date(Date.now() - 24 * MONTH_MS), 10);

    expect(stale.map((c) => c.phone)).toEqual(['+972501111111']);
  });

  it('a recent message on an old lead keeps them', async () => {
    const conversationId = await seedLead('+972501111111', 25 * MONTH_MS);
    await db
      .update(conversations)
      .set({ lastInboundAt: new Date() })
      .where(eq(conversations.id, conversationId));

    const stale = await findStaleContacts(db, new Date(Date.now() - 24 * MONTH_MS), 10);
    expect(stale).toEqual([]);
  });

  it('erases the stale lead and their checkpoint thread, and nothing else', async () => {
    const oldConversation = await seedLead('+972501111111', 25 * MONTH_MS);
    await seedLead('+972502222222', 1 * MONTH_MS);
    const deletedThreads: string[] = [];
    const sweeper = startRetentionSweeper({
      db,
      retentionMs: 24 * MONTH_MS,
      intervalMs: 60 * 60 * 1000,
      initialDelayMs: 60 * 60 * 1000,
      checkpointer: {
        deleteThread: (id) => {
          deletedThreads.push(id);
          return Promise.resolve();
        },
      },
    });

    try {
      const result = await sweeper.runOnce();
      expect(result.erased).toBe(1);
      expect(deletedThreads).toEqual([oldConversation]);
      const remaining = await db.select({ phone: contacts.phone }).from(contacts);
      expect(remaining.map((r) => r.phone)).toEqual(['+972502222222']);
      // Nothing was put on the do-not-contact list: they were forgotten, not blocked.
      const rows = await db.execute<{ count: string }>(
        sql`select count(*)::text as count from opt_outs`,
      );
      expect(rows[0]?.count).toBe('0');
    } finally {
      sweeper.stop();
    }
  });
});
