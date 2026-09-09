import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MondayClient, MondayError } from './client.js';

const CREDENTIALS = { apiToken: 'monday-token-SECRET', apiVersion: '2024-10' };

function response(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
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

describe('MondayClient.itemExists', () => {
  // Monday returns deleted and archived items by id, with `state` set. Verified
  // live: two freshly deleted items came back as {state:"deleted"}. Trusting the
  // array length made syncLead's recreate-if-deleted path unreachable.
  it('is true for a live item', async () => {
    fetchMock.mockResolvedValue(
      response({ data: { items: [{ id: '1', state: 'active' }] } }),
    );

    expect(await new MondayClient(CREDENTIALS).itemExists('1')).toBe(true);
  });

  it.each(['deleted', 'archived'])(
    'is false for a %s item, even though Monday returns it',
    async (state) => {
      fetchMock.mockResolvedValue(response({ data: { items: [{ id: '1', state }] } }));

      expect(await new MondayClient(CREDENTIALS).itemExists('1')).toBe(false);
    },
  );

  it('is false when nothing comes back', async () => {
    fetchMock.mockResolvedValue(response({ data: { items: [] } }));

    expect(await new MondayClient(CREDENTIALS).itemExists('1')).toBe(false);
  });

  it('asks Monday for the state, not just the id', async () => {
    fetchMock.mockResolvedValue(response({ data: { items: [] } }));

    await new MondayClient(CREDENTIALS).itemExists('1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body as string).toContain('state');
  });
});

describe('MondayClient failure classification', () => {
  // The outbox retries on this. A rate limit or outage deserves another attempt;
  // a malformed mutation will never succeed and must be parked, not retried.
  it.each([429, 500, 503])('treats HTTP %i as retryable', async (status) => {
    fetchMock.mockResolvedValue(response({}, status));

    await expect(new MondayClient(CREDENTIALS).itemExists('1')).rejects.toMatchObject({
      retryable: true,
      status,
    });
  });

  it('treats a 200 carrying a complexity-budget error as retryable', async () => {
    fetchMock.mockResolvedValue(
      response({
        errors: [{ message: 'Complexity budget exhausted, reset in 12 seconds' }],
      }),
    );

    await expect(new MondayClient(CREDENTIALS).itemExists('1')).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('treats any other 200-with-errors as permanent', async () => {
    fetchMock.mockResolvedValue(response({ errors: [{ message: 'Column not found' }] }));

    await expect(new MondayClient(CREDENTIALS).itemExists('1')).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('raises a MondayError, never leaking the token', async () => {
    fetchMock.mockResolvedValue(response({ errors: [{ message: 'nope' }] }));

    const error = await new MondayClient(CREDENTIALS)
      .itemExists('1')
      .then(() => undefined)
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(MondayError);
    expect(error?.message).not.toContain('monday-token-SECRET');
  });
});
