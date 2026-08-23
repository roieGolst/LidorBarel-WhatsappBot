import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudApiChannel } from './cloudApiChannel.js';

const CREDENTIALS = {
  accessToken: 'test-token-SECRET',
  phoneNumberId: '1234567890',
  graphApiVersion: 'v21.0',
};

/** Builds a `fetch` Response double with a JSON body. */
function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): Response {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CloudApiChannel', () => {
  it('POSTs to the correct URL with the auth header and text-message body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.ABC' }] }));
    const channel = new CloudApiChannel(CREDENTIALS);

    await channel.sendText('+972521234501', 'שלום');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token-SECRET');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '+972521234501',
      type: 'text',
      text: { body: 'שלום' },
    });
  });

  it("returns Meta's message id as the providerMessageId", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.XYZ' }] }));
    const channel = new CloudApiChannel(CREDENTIALS);

    const result = await channel.sendText('+972521234501', 'hi');

    expect(result).toEqual({ providerMessageId: 'wamid.XYZ' });
  });

  it('markTyping POSTs a read + typing-indicator status for the inbound id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    const channel = new CloudApiChannel(CREDENTIALS);

    await channel.markTyping('wamid.INBOUND');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.INBOUND',
      typing_indicator: { type: 'text' },
    });
  });

  it('throws on a non-2xx response, including the error payload', async () => {
    const errorBody = {
      error: { message: 'Invalid parameter', code: 100, fbtrace_id: 'Axyz' },
    };
    fetchMock.mockResolvedValue(jsonResponse(errorBody, { status: 400, ok: false }));
    const channel = new CloudApiChannel(CREDENTIALS);

    await expect(channel.sendText('+972521234501', 'hi')).rejects.toThrow(
      /Invalid parameter/,
    );
  });

  it('never leaks the access token in a failure error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: 'nope' } }, { status: 401, ok: false }),
    );
    const channel = new CloudApiChannel(CREDENTIALS);

    const error = await channel.sendText('+972521234501', 'hi').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('test-token-SECRET');
  });

  it('throws when a 2xx response is missing a message id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [] }));
    const channel = new CloudApiChannel(CREDENTIALS);

    await expect(channel.sendText('+972521234501', 'hi')).rejects.toThrow(
      /without a message id/,
    );
  });

  it('builds an interactive reply-button payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.B' }] }));
    const channel = new CloudApiChannel(CREDENTIALS);

    await channel.sendButtons('+972521234501', 'האם הנכס משווק כרגע?', [
      { id: 'marketed:no', title: 'לא' },
      { id: 'marketed:privately', title: 'כן, באופן פרטי' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '+972521234501',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'האם הנכס משווק כרגע?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'marketed:no', title: 'לא' } },
            {
              type: 'reply',
              reply: { id: 'marketed:privately', title: 'כן, באופן פרטי' },
            },
          ],
        },
      },
    });
  });

  it('builds an interactive list payload with a section of rows', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.L' }] }));
    const channel = new CloudApiChannel(CREDENTIALS);

    await channel.sendList('+972521234501', 'באיזו שכונה נמצא הנכס?', 'בחירת שכונה', [
      { id: 'neighborhood:ramot', title: 'שכונת רמות' },
      { id: 'neighborhood:alef_tet', title: 'שכונות א׳–ט׳', description: 'א׳–ט׳' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '+972521234501',
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'באיזו שכונה נמצא הנכס?' },
        action: {
          button: 'בחירת שכונה',
          sections: [
            {
              rows: [
                { id: 'neighborhood:ramot', title: 'שכונת רמות' },
                {
                  id: 'neighborhood:alef_tet',
                  title: 'שכונות א׳–ט׳',
                  description: 'א׳–ט׳',
                },
              ],
            },
          ],
        },
      },
    });
  });

  it('uploads a video for a media id, then sends it — and caches the id', async () => {
    const filePath = join(tmpdir(), `intro-${Date.now()}.mp4`);
    await writeFile(filePath, Buffer.from([0, 1, 2, 3]));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'media-999' })) // upload
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.V1' }] })) // send
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.V2' }] })); // second send

    const channel = new CloudApiChannel(CREDENTIALS);
    const first = await channel.sendVideo('+972521234501', filePath);
    expect(first.providerMessageId).toBe('wamid.V1');

    // Upload hit the /media endpoint; the message referenced the returned id.
    const [uploadUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(uploadUrl).toBe('https://graph.facebook.com/v21.0/1234567890/media');
    const [, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(sendInit.body as string)).toMatchObject({
      type: 'video',
      video: { id: 'media-999' },
    });

    // Second send reuses the cached media id — no second upload.
    await channel.sendVideo('+972521234501', filePath);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const uploadCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).endsWith('/media'),
    );
    expect(uploadCalls).toHaveLength(1);
  });

  it('reuses a durably-cached media id without uploading (survives a restart)', async () => {
    const filePath = join(tmpdir(), `intro-cache-${Date.now()}.mp4`);
    await writeFile(filePath, Buffer.from([9, 9, 9]));

    // A store already populated by a previous process run.
    const store = new Map<string, string>();
    const cache = {
      get: (key: string) => Promise.resolve(store.get(key)),
      set: (key: string, id: string) => {
        store.set(key, id);
        return Promise.resolve();
      },
    };

    // First channel uploads once and writes through to the durable cache.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'media-persist' }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.P1' }] }));
    await new CloudApiChannel(CREDENTIALS, cache).sendVideo('+972521234501', filePath);
    expect(store.size).toBe(1);

    // A fresh channel (as after a restart) finds the id in the cache — no upload.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.P2' }] }));
    const result = await new CloudApiChannel(CREDENTIALS, cache).sendVideo(
      '+972521234501',
      filePath,
    );

    expect(result.providerMessageId).toBe('wamid.P2');
    expect(fetchMock).toHaveBeenCalledTimes(1); // send only, no /media upload
    const [, sendInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(sendInit.body as string)).toMatchObject({
      type: 'video',
      video: { id: 'media-persist' },
    });
  });
});

describe('CloudApiChannel.sendTemplate', () => {
  it('posts the template name and language', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.T' }] }));

    await new CloudApiChannel(CREDENTIALS).sendTemplate('+972521234501', {
      name: 'welcome_message',
      language: 'he',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '+972521234501',
      type: 'template',
      template: { name: 'welcome_message', language: { code: 'he' } },
    });
  });

  it('sends no components when the template has no media header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.T' }] }));

    await new CloudApiChannel(CREDENTIALS).sendTemplate('+972521234501', {
      name: 'welcome_message',
      language: 'he',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      template: Record<string, unknown>;
    };
    expect(body.template.components).toBeUndefined();
  });

  it('uploads the header video and references it by media id', async () => {
    // The approved welcome_message template has a VIDEO header, which Meta
    // requires as a parameter on every send.
    const path = join(tmpdir(), `tpl-${Date.now()}.mp4`);
    await writeFile(path, 'fake-video-bytes');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'media-123' }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.T' }] }));

    await new CloudApiChannel(CREDENTIALS).sendTemplate('+972521234501', {
      name: 'welcome_message',
      language: 'he',
      headerVideoPath: path,
    });

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      template: { components: { type: string; parameters: unknown[] }[] };
    };
    expect(body.template.components[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'video', video: { id: 'media-123' } }],
    });
  });

  it('returns the provider message id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.TPL' }] }));

    const result = await new CloudApiChannel(CREDENTIALS).sendTemplate('+972521234501', {
      name: 'welcome_message',
      language: 'he',
    });

    expect(result.providerMessageId).toBe('wamid.TPL');
  });
});
