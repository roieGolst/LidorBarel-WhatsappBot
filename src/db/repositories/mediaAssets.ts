import { eq, isNotNull } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { mediaAssets } from '../schema.js';

export type MediaAsset = typeof mediaAssets.$inferSelect;

/** The metadata half of an asset row — from the sidecar JSON. */
export interface AssetMetadata {
  type: string;
  neighborhoods: string[];
  audience: string | null;
}

/** Loads one asset by its (relative) path. */
export async function getAssetByPath(
  db: DbClient,
  path: string,
): Promise<MediaAsset | undefined> {
  const [found] = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.path, path))
    .limit(1);
  return found;
}

/** All assets that have a cached Meta media id and can therefore be sent. */
export async function listSendableAssets(db: DbClient): Promise<MediaAsset[]> {
  return db.select().from(mediaAssets).where(isNotNull(mediaAssets.mediaId));
}

export interface UpsertAssetInput {
  path: string;
  sha256: string;
  mediaId: string | null;
  metadata: AssetMetadata;
  uploadedAt: Date | null;
}

/**
 * Inserts or updates an asset by path. Called by the startup cache refresh: a new
 * or changed file lands with its fresh media id, an unchanged file just has its
 * `lastVerifiedAt` bumped.
 */
export async function upsertAsset(db: DbClient, input: UpsertAssetInput): Promise<void> {
  const now = new Date();
  const values = {
    path: input.path,
    sha256: input.sha256,
    mediaId: input.mediaId,
    type: input.metadata.type,
    neighborhoods: input.metadata.neighborhoods,
    audience: input.metadata.audience,
    uploadedAt: input.uploadedAt,
    lastVerifiedAt: now,
    updatedAt: now,
  };

  await db
    .insert(mediaAssets)
    .values(values)
    .onConflictDoUpdate({
      target: mediaAssets.path,
      set: {
        sha256: values.sha256,
        mediaId: values.mediaId,
        type: values.type,
        neighborhoods: values.neighborhoods,
        audience: values.audience,
        uploadedAt: values.uploadedAt,
        lastVerifiedAt: values.lastVerifiedAt,
        updatedAt: values.updatedAt,
      },
    });
}

/** Attaches a freshly-uploaded media id to an existing asset (re-upload path). */
export async function setMediaId(
  db: DbClient,
  path: string,
  mediaId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(mediaAssets)
    .set({ mediaId, uploadedAt: now, lastVerifiedAt: now, updatedAt: now })
    .where(eq(mediaAssets.path, path));
}
