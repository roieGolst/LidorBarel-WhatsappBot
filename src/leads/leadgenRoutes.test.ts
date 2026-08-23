import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config.js';
import type { Database } from '../db/client.js';
import { campaignReferrals, contacts } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { buildServer } from '../server.js';
import type { GraphLeadsClient, RetrievedLead } from './graphLeads.js';
import { LeadRetrievalError } from './graphLeads.js';
import type { LeadIngestDeps } from './ingestLead.js';

const APP_SECRET = 'test_app_secret';

let db: Database;
let config: Config;
/** Swapped per test to control what the Graph API "returns". */
let leadResponse: RetrievedLead | Error;
let app: FastifyInstance;
/** A server with no lead-retrieval credentials configured. */
let appWithoutLeads: FastifyInstance;

const PHONE = '+972501234567';

function lead(): RetrievedLead {
  return {
    id: 'L1',
    formId: '555',
    fieldData: [
      { name: 'full_name', values: ['ישראל ישראלי'] },
      { name: 'phone_number', values: [PHONE] },
    ],
    raw: { id: 'L1' },
  };
}

const leadIngest: LeadIngestDeps = {
  leads: {
    fetchLead: () =>
      leadResponse instanceof Error
        ? Promise.reject(leadResponse)
        : Promise.resolve(leadResponse),
  } as unknown as GraphLeadsClient,
  consent: {},
  sellerForms: ['555'],
};

beforeAll(async () => {
  db = await setupTestDatabase();
  config = parseConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    META_APP_SECRET: APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: 'verify',
    LOG_LEVEL: 'fatal',
  });
  app = buildServer({ db, config, leadIngest });
  appWithoutLeads = buildServer({ db, config });
  await app.ready();
  await appWithoutLeads.ready();
});

afterAll(async () => {
  await app.close();
  await appWithoutLeads.close();
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
  leadResponse = lead();
});

function post(body: unknown, target: FastifyInstance = app, signature?: string) {
  const payload = JSON.stringify(body);
  return target.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256':
        signature ??
        `sha256=${createHmac('sha256', APP_SECRET).update(payload).digest('hex')}`,
    },
    payload,
  });
}

function pageWebhook(value: Record<string, unknown>, field = 'leadgen'): unknown {
  return { object: 'page', entry: [{ id: '111', changes: [{ field, value }] }] };
}

describe('POST /webhooks/whatsapp — Page leadgen', () => {
  it('ingests a lead and acknowledges', async () => {
    const response = await post(pageWebhook({ leadgen_id: 'L1', form_id: '555' }));

    expect(response.statusCode).toBe(200);
    expect(await db.select().from(campaignReferrals)).toHaveLength(1);
    expect(await db.select().from(contacts)).toHaveLength(1);
  });

  it('rejects an invalid signature before touching the lead', async () => {
    const response = await post(pageWebhook({ leadgen_id: 'L1' }), app, 'sha256=wrong');

    expect(response.statusCode).toBe(403);
    expect(await db.select().from(campaignReferrals)).toHaveLength(0);
  });

  it('fails closed with 503 when lead retrieval is not configured', async () => {
    // ACKing would discard a paid lead permanently. A 503 makes Meta redeliver
    // once the Page token is in place.
    const response = await post(pageWebhook({ leadgen_id: 'L1' }), appWithoutLeads);

    expect(response.statusCode).toBe(503);
    expect(await db.select().from(campaignReferrals)).toHaveLength(0);
  });

  it('acknowledges a Page webhook for a field we do not act on', async () => {
    const response = await post(pageWebhook({ some: 'thing' }, 'feed'));

    expect(response.statusCode).toBe(200);
    expect(await db.select().from(campaignReferrals)).toHaveLength(0);
  });

  it('acknowledges an unparseable Page body rather than looping forever', async () => {
    const response = await post({ object: 'page', entry: 'not-an-array' });

    expect(response.statusCode).toBe(200);
  });

  it('returns non-2xx on a retryable failure so Meta redelivers', async () => {
    leadResponse = new LeadRetrievalError('upstream down', true, 503);

    const response = await post(pageWebhook({ leadgen_id: 'L1' }));

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('acknowledges a permanent failure so Meta stops retrying', async () => {
    leadResponse = new LeadRetrievalError('lead deleted', false, 404);

    const response = await post(pageWebhook({ leadgen_id: 'L1' }));

    expect(response.statusCode).toBe(200);
  });

  it('is idempotent across redelivery', async () => {
    await post(pageWebhook({ leadgen_id: 'L1' }));
    const second = await post(pageWebhook({ leadgen_id: 'L1' }));

    expect(second.statusCode).toBe(200);
    expect(await db.select().from(campaignReferrals)).toHaveLength(1);
  });

  it('still handles a WhatsApp webhook on the same endpoint', async () => {
    // One URL serves both products; the leadgen branch must not shadow the
    // existing message path.
    const response = await post({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.X',
                    from: '972501234567',
                    timestamp: '1755000000',
                    type: 'text',
                    text: { body: 'שלום' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(await db.select().from(campaignReferrals)).toHaveLength(0);
    expect(await db.select().from(contacts)).toHaveLength(1);
  });
});
