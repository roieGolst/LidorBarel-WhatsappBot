import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { recordOptOut } from '../db/repositories/optOuts.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { FakeChannel } from './fakeChannel.js';
import { guardedSend, OptedOutError } from './guardedSend.js';

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

describe('guardedSend', () => {
  it('sends to a contact who has not opted out', async () => {
    const channel = new FakeChannel();

    const result = await guardedSend(db, channel, '+972521234501', 'שלום');

    expect(result.providerMessageId).toBeTruthy();
    expect(channel.sent).toHaveLength(1);
  });

  it('refuses to send to a contact who has opted out', async () => {
    const channel = new FakeChannel();
    await recordOptOut(db, '+972521234502', 'classifier');

    await expect(
      guardedSend(db, channel, '+972521234502', 'שלום'),
    ).rejects.toBeInstanceOf(OptedOutError);
    expect(channel.sent).toHaveLength(0);
  });

  it('matches the opt-out regardless of the number format', async () => {
    const channel = new FakeChannel();
    await recordOptOut(db, '+972521234503', 'keyword');

    // Same number, national format — normalization must still match the opt-out.
    await expect(guardedSend(db, channel, '0521234503', 'שלום')).rejects.toBeInstanceOf(
      OptedOutError,
    );
    expect(channel.sent).toHaveLength(0);
  });
});
