import { eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { mediaAssets } from '../schema.js';

export type MediaAsset = typeof mediaAssets.$inferSelect;

/** A catalog video as the selector needs it. */
export interface CatalogRow {
  id: string;
  path: string;
  type: string;
  neighborhoods: string[];
  audience: string | null;
}

/** All catalogued videos, shaped for {@link ../workflow/testimonial.js}. */
export async function listMediaAssets(db: DbClient): Promise<CatalogRow[]> {
  const rows = await db.select().from(mediaAssets);
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    type: row.type,
    neighborhoods: Array.isArray(row.neighborhoods)
      ? (row.neighborhoods as string[])
      : [],
    audience: row.audience,
  }));
}

export interface UpsertMediaAssetInput {
  path: string;
  type: string;
  neighborhoods: string[];
  audience: string | null;
}

/** Inserts or updates a catalog entry by path (the startup scan calls this). */
export async function upsertMediaAsset(
  db: DbClient,
  input: UpsertMediaAssetInput,
): Promise<void> {
  const values = { ...input, updatedAt: new Date() };
  await db
    .insert(mediaAssets)
    .values(values)
    .onConflictDoUpdate({
      target: mediaAssets.path,
      set: {
        type: values.type,
        neighborhoods: values.neighborhoods,
        audience: values.audience,
        updatedAt: values.updatedAt,
      },
    });
}

/** Removes a catalog entry whose file no longer exists. */
export async function deleteMediaAsset(db: DbClient, path: string): Promise<void> {
  await db.delete(mediaAssets).where(eq(mediaAssets.path, path));
}
