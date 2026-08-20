import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client.js';
import { getAssetByPath } from '../db/repositories/mediaAssets.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { getLogger } from '../logger.js';
import type { MediaUploader } from './media.js';
import { refreshMediaCache } from './mediaCache.js';

let db: Database;
let root: string;
let recs: string;

const logger = getLogger();

/** An uploader that hands back a new id each call and counts its calls. */
function fakeUploader() {
  let n = 0;
  return {
    upload: vi.fn((): Promise<string> => Promise.resolve(`media-${(n += 1)}`)),
  } satisfies MediaUploader & { upload: ReturnType<typeof vi.fn> };
}

async function writeVideo(name: string, bytes: string, meta: unknown): Promise<void> {
  await writeFile(join(recs, name), Buffer.from(bytes));
  const sidecar = name.replace(/\.[^.]+$/, '.json');
  if (meta !== undefined) {
    await writeFile(join(recs, sidecar), JSON.stringify(meta));
  }
}

beforeAll(async () => {
  db = await setupTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'assets-'));
  recs = join(root, 'recommendations');
  await mkdir(recs, { recursive: true });
});

afterAll(async () => {
  await db.close();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(db);
  await rm(recs, { recursive: true, force: true });
  await mkdir(recs, { recursive: true });
});

describe('refreshMediaCache', () => {
  it('uploads a new video and stores its media id and metadata', async () => {
    await writeVideo('story.mp4', 'aaa', {
      type: 'testimonial',
      neighborhoods: ['שכונה ט'],
      audience: 'seller',
    });
    const uploader = fakeUploader();

    const summary = await refreshMediaCache({ db, uploader, assetsRoot: root, logger });

    expect(summary.uploaded).toBe(1);
    const row = await getAssetByPath(db, 'recommendations/story.mp4');
    expect(row?.mediaId).toBe('media-1');
    expect(row?.type).toBe('testimonial');
    // The sidecar neighborhood is normalized to its canonical name.
    expect(row?.neighborhoods).toEqual(['שכונה ט׳']);
  });

  it('reuses the cached media id when the file is unchanged', async () => {
    await writeVideo('story.mp4', 'aaa', { type: 'testimonial', neighborhoods: [] });
    const uploader = fakeUploader();

    await refreshMediaCache({ db, uploader, assetsRoot: root, logger });
    const second = await refreshMediaCache({ db, uploader, assetsRoot: root, logger });

    expect(second.reused).toBe(1);
    expect(uploader.upload).toHaveBeenCalledTimes(1); // not re-uploaded
  });

  it('re-uploads when the file bytes change', async () => {
    await writeVideo('story.mp4', 'aaa', { type: 'testimonial', neighborhoods: [] });
    const uploader = fakeUploader();
    await refreshMediaCache({ db, uploader, assetsRoot: root, logger });

    await writeVideo('story.mp4', 'bbb-different', {
      type: 'testimonial',
      neighborhoods: [],
    });
    await refreshMediaCache({ db, uploader, assetsRoot: root, logger });

    expect(uploader.upload).toHaveBeenCalledTimes(2);
    const row = await getAssetByPath(db, 'recommendations/story.mp4');
    expect(row?.mediaId).toBe('media-2');
  });

  it('skips a video with no valid sidecar', async () => {
    await writeVideo('orphan.mp4', 'aaa', undefined);
    const uploader = fakeUploader();

    const summary = await refreshMediaCache({ db, uploader, assetsRoot: root, logger });

    expect(summary.skipped).toBe(1);
    expect(uploader.upload).not.toHaveBeenCalled();
  });

  it('returns zeros and does not throw when the directory is absent', async () => {
    const summary = await refreshMediaCache({
      db,
      uploader: fakeUploader(),
      assetsRoot: join(root, 'does-not-exist'),
      logger,
    });
    expect(summary).toEqual({ scanned: 0, uploaded: 0, reused: 0, skipped: 0 });
  });
});
