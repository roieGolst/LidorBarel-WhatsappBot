import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { z } from 'zod';

/**
 * Uploading a local media file to Meta and getting back a reusable media id.
 *
 * Meta media ids are how a video is sent without re-uploading its bytes each
 * time (see `whatsapp/channel.ts` `sendVideo`). This is the upload half: the
 * startup cache refresh calls it for a new or changed file, and the send path
 * calls it again to recover from an expired id. An interface so the cache refresh
 * is testable without hitting Meta.
 */
export interface MediaUploader {
  /** Uploads a file and returns its Meta media id. */
  upload(filePath: string, mimeType: string): Promise<string>;
}

export interface MediaCredentials {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
}

const uploadResponseSchema = z.object({ id: z.string().min(1) });

/** Video MIME type for a file, by extension. Defaults to mp4. */
export function videoMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.mp4':
      return 'video/mp4';
    case '.3gp':
      return 'video/3gpp';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    default:
      return 'video/mp4';
  }
}

/** Production uploader over the Meta Graph API `/media` endpoint. */
export class MetaMediaUploader implements MediaUploader {
  constructor(
    private readonly credentials: MediaCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async upload(filePath: string, mimeType: string): Promise<string> {
    const { accessToken, phoneNumberId, graphApiVersion } = this.credentials;
    const url = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/media`;

    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    // A fresh Uint8Array view avoids SharedArrayBuffer typing on the Buffer.
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: mimeType }),
      basename(filePath),
    );

    const response = await this.fetchImpl(url, {
      method: 'POST',
      // The bearer token lives only in this header — never in a logged request.
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable response body>');
      throw new Error(
        `Meta media upload failed: ${response.status} ${response.statusText} — ${detail}`,
      );
    }

    const body: unknown = await response.json();
    const parsed = uploadResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `Meta media upload returned no media id; unexpected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.id;
  }
}
