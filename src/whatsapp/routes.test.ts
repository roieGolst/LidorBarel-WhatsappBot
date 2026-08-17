import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config.js';
import type { Database } from '../db/client.js';
import type { TurnProducer } from '../queue/conversationQueue.js';
import { conversations, messages } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { buildServer } from '../server.js';

const APP_SECRET = 'test_app_secret';
const VERIFY_TOKEN = 'test_verify_token';

let db: Database;
let app: FastifyInstance;
let config: Config;

beforeAll(async () => {
  db = await setupTestDatabase();
  config = parseConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    META_APP_SECRET: APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    LOG_LEVEL: 'fatal',
  });
  app = buildServer({ db, config });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** Posts a webhook body with a valid signature unless one is supplied. */
function postWebhook(body: unknown, signature?: string) {
  const payload = JSON.stringify(body);
  return app.inject({
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

function textMessagePayload(id = 'wamid.TEST', from = '972501234567') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '972533374203',
                phone_number_id: 'PHONE_ID',
              },
              contacts: [{ wa_id: from, profile: { name: 'ישראל' } }],
              messages: [
                {
                  id,
                  from,
                  timestamp: '1755331200',
                  type: 'text',
                  text: { body: 'שלום, אני רוצה למכור דירה' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload(id = 'wamid.SENT', status = 'delivered') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PHONE_ID' },
              statuses: [
                {
                  id,
                  status,
                  timestamp: '1755331200',
                  recipient_id: '972501234567',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Records every enqueue so a test can assert exactly what was handed off. */
class RecordingProducer implements TurnProducer {
  readonly enqueued: string[] = [];

  enqueueTurn(conversationId: string): Promise<void> {
    this.enqueued.push(conversationId);
    return Promise.resolve();
  }
}

describe('GET /webhooks/whatsapp', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp',
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '9876543210',
      },
    });

    expect(response.statusCode).toBe(200);
    // Meta expects plain text, not a JSON-quoted string.
    expect(response.body).toBe('9876543210');
  });

  it('rejects a wrong verify token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp',
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong',
        'hub.challenge': '123',
      },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('POST /webhooks/whatsapp', () => {
  it('accepts a correctly signed webhook and stores the message', async () => {
    const response = await postWebhook(textMessagePayload());

    expect(response.statusCode).toBe(200);

    const stored = await db.select().from(messages);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.body).toBe('שלום, אני רוצה למכור דירה');
    expect(await db.select().from(conversations)).toHaveLength(1);
  });

  // Without this, anyone who learns the URL can inject messages, impersonate a
  // lead, and write whatever they like into the CRM.
  it('rejects an unsigned request and stores nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(textMessagePayload()),
    });

    expect(response.statusCode).toBe(403);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it('rejects a wrongly signed request', async () => {
    const response = await postWebhook(textMessagePayload(), 'sha256=' + '0'.repeat(64));

    expect(response.statusCode).toBe(403);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  // The signature covers exact bytes. This fails unless the raw body survives
  // Fastify's JSON parsing, which is the whole reason for the custom parser.
  it('verifies against the raw body rather than a re-serialization', async () => {
    // Whitespace that JSON.stringify would never produce, so a re-serialized
    // body would have a different signature.
    const raw = '{"object":"whatsapp_business_account",   "entry":  []}';
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
      },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
  });

  // Meta retries on any non-2xx. A body we cannot interpret would otherwise be
  // redelivered forever.
  it('returns 200 for a signed but unrecognisable payload', async () => {
    const response = await postWebhook({ unexpected: 'shape' });

    expect(response.statusCode).toBe(200);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it('is idempotent across redelivery of the same webhook', async () => {
    const payload = textMessagePayload('wamid.RETRY');

    expect((await postWebhook(payload)).statusCode).toBe(200);
    expect((await postWebhook(payload)).statusCode).toBe(200);

    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('ingests every message in a batch', async () => {
    await postWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PHONE_ID' },
                messages: [
                  {
                    id: 'wamid.A',
                    from: '972501111111',
                    timestamp: '1755331200',
                    type: 'text',
                    text: { body: 'a' },
                  },
                  {
                    id: 'wamid.B',
                    from: '972502222222',
                    timestamp: '1755331201',
                    type: 'text',
                    text: { body: 'b' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(await db.select().from(messages)).toHaveLength(2);
    expect(await db.select().from(conversations)).toHaveLength(2);
  });

  it('accepts an empty entry array', async () => {
    const response = await postWebhook({
      object: 'whatsapp_business_account',
      entry: [],
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /webhooks/whatsapp — enqueueing turns', () => {
  let producer: RecordingProducer;
  let enqueueApp: FastifyInstance;

  beforeAll(async () => {
    producer = new RecordingProducer();
    enqueueApp = buildServer({ db, config, producer });
    await enqueueApp.ready();
  });

  afterAll(async () => {
    await enqueueApp.close();
  });

  beforeEach(() => {
    producer.enqueued.length = 0;
  });

  function post(body: unknown) {
    const payload = JSON.stringify(body);
    return enqueueApp.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(payload).digest('hex')}`,
      },
      payload,
    });
  }

  it('enqueues exactly one turn for a non-duplicate inbound', async () => {
    const response = await post(textMessagePayload('wamid.ENQ1'));
    expect(response.statusCode).toBe(200);

    // The enqueued id is the conversation the message was stored against.
    const [conversation] = await db.select().from(conversations);
    expect(producer.enqueued).toEqual([conversation!.id]);
  });

  it('does not enqueue on redelivery of the same webhook', async () => {
    const payload = textMessagePayload('wamid.ENQ_DUP');

    await post(payload);
    expect(producer.enqueued).toHaveLength(1);

    // The redelivery is a duplicate at ingestion, so it must not enqueue a
    // second turn — otherwise Meta's retries would double-reply.
    await post(payload);
    expect(producer.enqueued).toHaveLength(1);
  });

  it('does not enqueue for a delivery-status event', async () => {
    const response = await post(statusPayload());
    expect(response.statusCode).toBe(200);
    expect(producer.enqueued).toHaveLength(0);
  });
});

describe('GET /health', () => {
  it('reports ok when the database is reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('missing configuration', () => {
  it('returns 503 rather than accepting unverifiable webhooks', async () => {
    const unconfigured = buildServer({
      db,
      config: parseConfig({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        LOG_LEVEL: 'fatal',
      }),
    });
    await unconfigured.ready();

    const response = await unconfigured.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(response.statusCode).toBe(503);
    await unconfigured.close();
  });
});
