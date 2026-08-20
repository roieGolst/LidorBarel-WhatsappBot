import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidMediaError } from './channel.js';
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

  it('sends a video by media id with an optional caption', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.VID' }] }));
    const channel = new CloudApiChannel(CREDENTIALS);

    const result = await channel.sendVideo('+972521234501', 'media-9', 'המלצה');

    expect(result.providerMessageId).toBe('wamid.VID');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '+972521234501',
      type: 'video',
      video: { id: 'media-9', caption: 'המלצה' },
    });
  });

  it('maps an expired media id to InvalidMediaError so the caller can re-upload', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { message: 'media id does not exist', code: 100 } },
        { status: 400, ok: false },
      ),
    );
    const channel = new CloudApiChannel(CREDENTIALS);

    await expect(channel.sendVideo('+972521234501', 'media-x')).rejects.toBeInstanceOf(
      InvalidMediaError,
    );
  });
});
