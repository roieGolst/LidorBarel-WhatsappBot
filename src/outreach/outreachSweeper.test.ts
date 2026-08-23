import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { upsertContactByPhone, type Contact } from '../db/repositories/contacts.js';
import { findOrCreateConversation } from '../db/repositories/conversations.js';
import { conversations } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { FakeChannel } from '../whatsapp/fakeChannel.js';
import { startOutreachSweeper } from './outreachSweeper.js';

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

const GRACE_MS = 20 * 60 * 1000;
let phoneCounter = 0;

async function seedDueLead(
  consentStatus: Contact['consentStatus'] = 'whatsapp_opt_in',
): Promise<string> {
  const contact = await upsertContactByPhone(db, {
    phone: `+9725099999${String(phoneCounter++).padStart(2, '0')}`,
    entryPoint: 'meta_lead_form',
    consentStatus,
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);
  await db
    .update(conversations)
    .set({
      stage: 'awaiting_first_contact',
      createdAt: new Date(Date.now() - GRACE_MS - 1000),
    })
    .where(eq(conversations.id, conversation.id));
  return conversation.id;
}

function sweeper(channel: FakeChannel) {
  return startOutreachSweeper({
    db,
    channel,
    template: { name: 'welcome_message', language: 'he' },
    gracePeriodMs: GRACE_MS,
    // Long enough that only the explicit runOnce() executes during a test.
    intervalMs: 60_000,
    batchSize: 10,
  });
}

describe('outreach sweeper', () => {
  it('contacts every due lead in one sweep', async () => {
    await seedDueLead();
    await seedDueLead();
    const channel = new FakeChannel();
    const sweep = sweeper(channel);

    const result = await sweep.runOnce();
    sweep.stop();

    expect(result.sent).toBe(2);
    expect(channel.sent).toHaveLength(2);
  });

  it('does not contact the same lead on a later sweep', async () => {
    await seedDueLead();
    const channel = new FakeChannel();
    const sweep = sweeper(channel);

    await sweep.runOnce();
    const second = await sweep.runOnce();
    sweep.stop();

    expect(second.sent).toBe(0);
    expect(channel.sent).toHaveLength(1);
  });

  it('keeps going when one lead fails', async () => {
    // A lead without consent throws. The rest of the sweep must still run —
    // otherwise one bad row stalls every lead behind it, indefinitely.
    await seedDueLead('privacy_policy_only');
    await seedDueLead();
    const channel = new FakeChannel();
    const sweep = sweeper(channel);

    const result = await sweep.runOnce();
    sweep.stop();

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
  });

  it('leaves a failed lead claimable for the next sweep', async () => {
    const conversationId = await seedDueLead('privacy_policy_only');
    const channel = new FakeChannel();
    const sweep = sweeper(channel);

    await sweep.runOnce();
    sweep.stop();

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation?.stage).toBe('awaiting_first_contact');
  });

  it('sends nothing when no lead is due', async () => {
    const channel = new FakeChannel();
    const sweep = sweeper(channel);

    const result = await sweep.runOnce();
    sweep.stop();

    expect(result).toEqual({ sent: 0, skipped: 0, failed: 0 });
  });

  it('stops sweeping once stopped', async () => {
    await seedDueLead();
    const channel = new FakeChannel();
    const sweep = sweeper(channel);
    sweep.stop();

    const result = await sweep.runOnce();

    expect(result.sent).toBe(0);
    expect(channel.sent).toHaveLength(0);
  });
});
