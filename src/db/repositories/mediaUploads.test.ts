import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../client.js';
import { setupTestDatabase, truncateAll } from '../testing.js';
import { getFreshMediaId, MEDIA_ID_MAX_AGE_MS, saveMediaId } from './mediaUploads.js';

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

describe('media-id cache', () => {
  it('stores and returns a fresh media id', async () => {
    await saveMediaId(db, 'intro.mp4:1', 'media-1');
    expect(await getFreshMediaId(db, 'intro.mp4:1')).toBe('media-1');
  });

  it('returns undefined for an unknown key', async () => {
    expect(await getFreshMediaId(db, 'nope')).toBeUndefined();
  });

  it('upserts a new id for the same key', async () => {
    await saveMediaId(db, 'intro.mp4:1', 'media-1');
    await saveMediaId(db, 'intro.mp4:1', 'media-2');
    expect(await getFreshMediaId(db, 'intro.mp4:1')).toBe('media-2');
  });

  it('ignores an id older than the max age (forces a re-upload)', async () => {
    await saveMediaId(db, 'intro.mp4:1', 'media-old');
    const later = new Date(Date.now() + MEDIA_ID_MAX_AGE_MS + 1000);
    expect(await getFreshMediaId(db, 'intro.mp4:1', later)).toBeUndefined();
  });
});
