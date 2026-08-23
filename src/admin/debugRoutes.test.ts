import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config.js';
import type { Database } from '../db/client.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import { findOrCreateConversation } from '../db/repositories/conversations.js';
import { conversations, events } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { buildServer } from '../server.js';

let db: Database;
let devConfig: Config;
let prodConfig: Config;

const BASE_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  LOG_LEVEL: 'fatal' as const,
};

beforeAll(async () => {
  db = await setupTestDatabase();
  devConfig = parseConfig({ ...BASE_ENV, NODE_ENV: 'development' });
  prodConfig = parseConfig({ ...BASE_ENV, NODE_ENV: 'production' });
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function seedLead(): Promise<string> {
  const contact = await upsertContactByPhone(db, {
    phone: '+972521239999',
    entryPoint: 'meta_lead_form',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);

  await db
    .update(conversations)
    .set({
      stage: 'qualified',
      qualified: true,
      priorityScore: 80,
      extracted: { neighborhood: 'רמות', currentlyMarketed: 'no', seriousSeller: true },
    })
    .where(eq(conversations.id, conversation.id));

  await db.insert(events).values({
    aggregateType: 'conversation',
    aggregateId: conversation.id,
    eventType: 'stage_transition',
    fromStage: 'assessing_intent',
    toStage: 'qualified',
    actor: 'system',
    metadata: { action: 'proceed_qualified', qualified: true },
  });

  return conversation.id;
}

describe('GET /debug/leads/:leadId (development)', () => {
  it('returns the full lead state, masking the phone', async () => {
    const app = buildServer({ db, config: devConfig });
    await app.ready();
    try {
      const leadId = await seedLead();
      const response = await app.inject({ method: 'GET', url: `/debug/leads/${leadId}` });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        qualification: { isQualified: boolean; priorityScore: number };
        facts: { neighborhood: string; seriousSeller: boolean };
        stage: string;
        nextAction: string;
        stateHistory: { action: string }[];
        contact: { phoneMasked: string };
      }>();
      expect(body.stage).toBe('qualified');
      expect(body.qualification).toMatchObject({ isQualified: true, priorityScore: 80 });
      expect(body.facts.neighborhood).toBe('רמות');
      expect(body.nextAction).toBe('hand_off_to_lidor');
      expect(body.stateHistory).toHaveLength(1);
      expect(body.stateHistory[0]?.action).toBe('proceed_qualified');
      expect(JSON.stringify(body)).not.toContain('972521239999');
      expect(body.contact.phoneMasked).toMatch(/\*+99$/);
    } finally {
      await app.close();
    }
  });

  it('404s for an unknown lead', async () => {
    const app = buildServer({ db, config: devConfig });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/debug/leads/00000000-0000-0000-0000-000000000000',
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('GET /debug/leads/:leadId (production)', () => {
  it('is not registered in production', async () => {
    const app = buildServer({ db, config: prodConfig });
    await app.ready();
    try {
      const leadId = await seedLead();
      const response = await app.inject({ method: 'GET', url: `/debug/leads/${leadId}` });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
