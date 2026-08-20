import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { getAssetByPath, upsertAsset } from '../db/repositories/mediaAssets.js';
import { normalizeNeighborhood } from '../domain/neighborhoods.js';
import type { getLogger } from '../logger.js';
import { videoMimeType, type MediaUploader } from './media.js';

/**
 * The startup media-cache refresh (Part B).
 *
 * Scans `assets/recommendations/`, and for each video ensures Meta holds a valid,
 * reusable media id: a new or changed file (by sha256), or one whose id has aged
 * past the refresh window, is (re)uploaded; an unchanged, still-fresh file keeps
 * its cached id. Postgres (`media_assets`) is the source of truth; the Meta
 * upload is a rebuildable projection.
 *
 * Runs in the background at boot (never on a request path), and every failure is
 * logged rather than thrown — a media problem must not stop the bot from serving
 * text conversations.
 */

/** Refresh a media id once it is older than this — comfortably under Meta's ~30d. */
export const MEDIA_REFRESH_TTL_MS = 25 * 24 * 60 * 60 * 1000;

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.3gp']);

/** Sidecar metadata (`<video>.json`) — see the plan, Part B. */
const metadataSchema = z.object({
  type: z.string().min(1),
  neighborhoods: z.array(z.string()).default([]),
  audience: z.string().nullable().default(null),
});

export interface RefreshDeps {
  db: Database;
  uploader: MediaUploader;
  /** Root under which `recommendations/` lives (usually the project `assets/`). */
  assetsRoot: string;
  logger: ReturnType<typeof getLogger>;
  now?: () => Date;
}

export interface RefreshSummary {
  scanned: number;
  uploaded: number;
  reused: number;
  skipped: number;
}

export async function refreshMediaCache(deps: RefreshDeps): Promise<RefreshSummary> {
  const { db, uploader, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const dir = join(deps.assetsRoot, 'recommendations');
  const summary: RefreshSummary = { scanned: 0, uploaded: 0, reused: 0, skipped: 0 };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    logger.info({ dir }, 'no recommendations directory — media cache refresh skipped');
    return summary;
  }

  const videos = entries.filter((name) =>
    VIDEO_EXTENSIONS.has(extname(name).toLowerCase()),
  );

  for (const name of videos) {
    summary.scanned += 1;
    const fullPath = join(dir, name);
    const relPath = join('recommendations', name);
    try {
      const metadata = await readMetadata(fullPath);
      if (!metadata) {
        logger.warn({ path: relPath }, 'video has no valid sidecar metadata — skipped');
        summary.skipped += 1;
        continue;
      }

      const bytes = await readFile(fullPath);
      const sha256 = createHash('sha256').update(bytes).digest('hex');

      const existing = await getAssetByPath(db, relPath);
      const stale =
        existing?.uploadedAt != null &&
        now().getTime() - existing.uploadedAt.getTime() > MEDIA_REFRESH_TTL_MS;
      const needUpload =
        !existing || existing.sha256 !== sha256 || !existing.mediaId || stale;

      let mediaId: string | null;
      let uploadedAt: Date | null;
      if (needUpload) {
        mediaId = await uploader.upload(fullPath, videoMimeType(fullPath));
        uploadedAt = now();
        summary.uploaded += 1;
      } else {
        mediaId = existing.mediaId;
        uploadedAt = existing.uploadedAt;
        summary.reused += 1;
      }

      await upsertAsset(db, {
        path: relPath,
        sha256,
        mediaId,
        metadata: {
          type: metadata.type,
          neighborhoods: metadata.neighborhoods.map(toCanonical),
          audience: metadata.audience,
        },
        uploadedAt,
      });

      logger.info(
        {
          path: relPath,
          type: metadata.type,
          mediaIdRefreshed: needUpload,
          action: needUpload ? 'uploaded' : 'reused',
        },
        'media asset cached',
      );
    } catch (err) {
      logger.error({ path: relPath, err }, 'failed to refresh media asset');
      summary.skipped += 1;
    }
  }

  logger.info(summary, 'media cache refresh complete');
  return summary;
}

/** Reads and validates a video's sidecar `<name>.json`, or null if absent/invalid. */
async function readMetadata(
  videoPath: string,
): Promise<z.infer<typeof metadataSchema> | null> {
  const sidecar = videoPath.replace(
    new RegExp(`${escapeExt(extname(videoPath))}$`),
    '.json',
  );
  try {
    const raw = await readFile(sidecar, 'utf8');
    const parsed = metadataSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Normalizes a sidecar neighborhood to its canonical name (else keep as given). */
function toCanonical(name: string): string {
  const match = normalizeNeighborhood(name);
  return match.canonical ?? match.original;
}

function escapeExt(ext: string): string {
  return ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
