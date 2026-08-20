import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MetaMediaUploader, videoMimeType } from './media.js';

const credentials = {
  accessToken: 'secret-token',
  phoneNumberId: '123',
  graphApiVersion: 'v21.0',
};

let dir: string;
let videoPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'media-test-'));
  videoPath = join(dir, 'clip.mp4');
  await writeFile(videoPath, Buffer.from('fake video bytes'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function okResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

describe('videoMimeType', () => {
  it('maps by extension, defaulting to mp4', () => {
    expect(videoMimeType('a.mp4')).toBe('video/mp4');
    expect(videoMimeType('a.webm')).toBe('video/webm');
    expect(videoMimeType('a.unknown')).toBe('video/mp4');
  });
});

describe('MetaMediaUploader', () => {
  it('uploads the file and returns the media id, sending the bearer token', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(okResponse({ id: 'media-123' })));
    const uploader = new MetaMediaUploader(credentials, fetchImpl);

    const id = await uploader.upload(videoPath, 'video/mp4');

    expect(id).toBe('media-123');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/123/media');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret-token',
    );
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('nope'),
      } as unknown as Response),
    );
    const uploader = new MetaMediaUploader(credentials, fetchImpl);

    await expect(uploader.upload(videoPath, 'video/mp4')).rejects.toThrow('400');
  });

  it('throws when the response has no media id', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(okResponse({ unexpected: true })));
    const uploader = new MetaMediaUploader(credentials, fetchImpl);

    await expect(uploader.upload(videoPath, 'video/mp4')).rejects.toThrow('media id');
  });
});
