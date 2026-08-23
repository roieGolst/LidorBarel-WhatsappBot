import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphLeadsClient, LeadRetrievalError } from './graphLeads.js';

const CREDENTIALS = {
  pageAccessToken: 'page-token-SECRET',
  graphApiVersion: 'v21.0',
};

const LEAD_BODY = {
  id: '444444444444',
  created_time: '2026-08-20T22:26:24+0000',
  form_id: '555555555555',
  ad_id: '666666666666',
  campaign_id: '777777777777',
  field_data: [
    { name: 'full_name', values: ['ישראל ישראלי'] },
    { name: 'phone_number', values: ['+972501234567'] },
  ],
};

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
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

describe('GraphLeadsClient.fetchLead', () => {
  it('requests the lead by id with the field list and a bearer token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(LEAD_BODY));

    await new GraphLeadsClient(CREDENTIALS).fetchLead('444444444444');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://graph.facebook.com/v21.0/444444444444');
    expect(url).toContain('field_data');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer page-token-SECRET',
    );
  });

  it('never puts the token in the URL', async () => {
    // A query-string token leaks into access logs and proxies.
    fetchMock.mockResolvedValue(jsonResponse(LEAD_BODY));

    await new GraphLeadsClient(CREDENTIALS).fetchLead('L1');

    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('page-token-SECRET');
  });

  it('returns the answers and the raw body for the audit trail', async () => {
    fetchMock.mockResolvedValue(jsonResponse(LEAD_BODY));

    const lead = await new GraphLeadsClient(CREDENTIALS).fetchLead('444444444444');

    expect(lead.id).toBe('444444444444');
    expect(lead.formId).toBe('555555555555');
    expect(lead.createdTime).toEqual(new Date('2026-08-20T22:26:24+0000'));
    expect(lead.fieldData).toHaveLength(2);
    expect(lead.raw).toEqual(LEAD_BODY);
  });

  it('escapes the lead id in the path', async () => {
    fetchMock.mockResolvedValue(jsonResponse(LEAD_BODY));

    await new GraphLeadsClient(CREDENTIALS).fetchLead('a/../b');

    expect(fetchMock.mock.calls[0]?.[0]).toContain('a%2F..%2Fb');
  });

  it('treats a lead with no answers as valid but empty', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'L1' }));

    expect((await new GraphLeadsClient(CREDENTIALS).fetchLead('L1')).fieldData).toEqual(
      [],
    );
  });

  describe('failure classification', () => {
    // This decides the webhook status code, and therefore whether Meta ever
    // sends the lead again. Getting it wrong either loses a paid lead or makes
    // Meta redeliver something that can never succeed, forever.

    it.each([500, 502, 503, 429])('marks %s retryable', async (status) => {
      fetchMock.mockResolvedValue(jsonResponse({ error: {} }, { status }));

      await expect(
        new GraphLeadsClient(CREDENTIALS).fetchLead('L1'),
      ).rejects.toMatchObject({ retryable: true, status });
    });

    it.each([400, 401, 403, 404])('marks %s permanent', async (status) => {
      // A deleted lead, a bad id, or a token without `leads_retrieval`.
      fetchMock.mockResolvedValue(jsonResponse({ error: {} }, { status }));

      await expect(
        new GraphLeadsClient(CREDENTIALS).fetchLead('L1'),
      ).rejects.toMatchObject({ retryable: false, status });
    });

    it('marks a network failure retryable', async () => {
      fetchMock.mockRejectedValue(new Error('socket hang up'));

      await expect(
        new GraphLeadsClient(CREDENTIALS).fetchLead('L1'),
      ).rejects.toMatchObject({ retryable: true });
    });

    it('marks an unrecognisable 2xx permanent', async () => {
      // Redelivery will produce the same unusable body.
      fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }));

      await expect(
        new GraphLeadsClient(CREDENTIALS).fetchLead('L1'),
      ).rejects.toMatchObject({ retryable: false });
    });

    it('raises LeadRetrievalError, not a bare Error', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }));

      await expect(
        new GraphLeadsClient(CREDENTIALS).fetchLead('L1'),
      ).rejects.toBeInstanceOf(LeadRetrievalError);
    });

    it('does not leak the token in the error message', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, { status: 403 }));

      const error = await new GraphLeadsClient(CREDENTIALS)
        .fetchLead('L1')
        .then(() => undefined)
        .catch((err: unknown) => err as Error);

      expect(error).toBeInstanceOf(LeadRetrievalError);
      expect(error?.message).not.toContain('page-token-SECRET');
    });
  });
});
