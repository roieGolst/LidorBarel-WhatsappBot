import { eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { mediaUploads } from '../schema.js';

/**
 * Durable media-id cache (see {@link mediaUploads}). Lets the channel reuse a Meta
 * upload across restarts instead of re-uploading the bytes every process run.
 */

/** How long a cached media id is trusted before a fresh upload — under Meta's ~30 days. */
export const MEDIA_ID_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000;

/** The cached media id for an asset key, if present and not past {@link MEDIA_ID_MAX_AGE_MS}. */
export async function getFreshMediaId(
  db: DbClient,
  assetKey: string,
  now: Date = new Date(),
): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(mediaUploads)
    .where(eq(mediaUploads.assetKey, assetKey))
    .limit(1);
  if (!row) return undefined;
  if (now.getTime() - row.uploadedAt.getTime() > MEDIA_ID_MAX_AGE_MS) return undefined;
  return row.mediaId;
}

/** Stores (or refreshes) the media id for an asset key. */
export async function saveMediaId(
  db: DbClient,
  assetKey: string,
  mediaId: string,
): Promise<void> {
  await db
    .insert(mediaUploads)
    .values({ assetKey, mediaId })
    .onConflictDoUpdate({
      target: mediaUploads.assetKey,
      set: { mediaId, uploadedAt: new Date() },
    });
}
