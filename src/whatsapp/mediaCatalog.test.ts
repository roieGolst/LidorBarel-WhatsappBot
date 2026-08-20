import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { listMediaAssets } from '../db/repositories/mediaAssets.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { getLogger } from '../logger.js';
import { refreshMediaCatalog } from './mediaCatalog.js';

let db: Database;
let root: string;
let recs: string;
const logger = getLogger();

async function writeVideo(name: string, meta: unknown): Promise<void> {
  await writeFile(join(recs, name), Buffer.from('bytes'));
  if (meta !== undefined) {
    await writeFile(join(recs, name.replace(/\.[^.]+$/, '.json')), JSON.stringify(meta));
  }
}

beforeAll(async () => {
  db = await setupTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'catalog-'));
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

describe('refreshMediaCatalog', () => {
  it('catalogs a video with normalized neighborhoods', async () => {
    await writeVideo('tet.mp4', {
      type: 'testimonial',
      neighborhoods: ['שכונה ט'],
      audience: 'seller',
    });

    const summary = await refreshMediaCatalog(db, root, logger);

    expect(summary.catalogued).toBe(1);
    const assets = await listMediaAssets(db);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      path: 'recommendations/tet.mp4',
      type: 'testimonial',
      neighborhoods: ['שכונה ט׳'],
    });
  });

  it('skips a video with no valid sidecar', async () => {
    await writeVideo('orphan.mp4', undefined);
    const summary = await refreshMediaCatalog(db, root, logger);
    expect(summary.skipped).toBe(1);
    expect(await listMediaAssets(db)).toHaveLength(0);
  });

  it('returns zeros when the directory is absent', async () => {
    const summary = await refreshMediaCatalog(db, join(root, 'nope'), logger);
    expect(summary).toEqual({ scanned: 0, catalogued: 0, skipped: 0 });
  });
});
