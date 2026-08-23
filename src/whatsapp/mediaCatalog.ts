import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { upsertMediaAsset } from '../db/repositories/mediaAssets.js';
import { normalizeNeighborhood } from '../domain/neighborhoods.js';
import type { getLogger } from '../logger.js';

/**
 * The startup testimonial-catalog scan (Part B).
 *
 * Reads every video under `assets/recommendations/` and its `<name>.json`
 * sidecar, and upserts the *metadata* (type, targeted neighborhoods, audience,
 * path) into `media_assets`. It does NOT upload anything — the channel uploads a
 * video's bytes to Meta lazily on first send and caches the id — so this is cheap
 * and safe to run in the background at boot. A missing/invalid sidecar is logged
 * and skipped; a scan failure is logged, never thrown.
 */

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.3gp']);

const metadataSchema = z.object({
  type: z.string().min(1),
  neighborhoods: z.array(z.string()).default([]),
  audience: z.string().nullable().default(null),
});

export interface CatalogSummary {
  scanned: number;
  catalogued: number;
  skipped: number;
}

export async function refreshMediaCatalog(
  db: Database,
  assetsRoot: string,
  logger: ReturnType<typeof getLogger>,
): Promise<CatalogSummary> {
  const dir = join(assetsRoot, 'recommendations');
  const summary: CatalogSummary = { scanned: 0, catalogued: 0, skipped: 0 };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    logger.info({ dir }, 'no recommendations directory — media catalog scan skipped');
    return summary;
  }

  for (const name of entries) {
    if (!VIDEO_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    summary.scanned += 1;
    const relPath = join('recommendations', name);
    try {
      const metadata = await readMetadata(join(dir, name));
      if (!metadata) {
        logger.warn({ path: relPath }, 'video has no valid sidecar metadata — skipped');
        summary.skipped += 1;
        continue;
      }
      await upsertMediaAsset(db, {
        path: relPath,
        type: metadata.type,
        neighborhoods: metadata.neighborhoods.map(toCanonical),
        audience: metadata.audience,
      });
      summary.catalogued += 1;
      logger.info({ path: relPath, type: metadata.type }, 'media asset catalogued');
    } catch (err) {
      logger.error({ path: relPath, err }, 'failed to catalog media asset');
      summary.skipped += 1;
    }
  }

  logger.info(summary, 'media catalog scan complete');
  return summary;
}

async function readMetadata(
  videoPath: string,
): Promise<z.infer<typeof metadataSchema> | null> {
  const sidecar = videoPath.replace(/\.[^.]+$/, '.json');
  try {
    const raw = await readFile(sidecar, 'utf8');
    const parsed = metadataSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toCanonical(name: string): string {
  const match = normalizeNeighborhood(name);
  return match.canonical ?? match.original;
}
