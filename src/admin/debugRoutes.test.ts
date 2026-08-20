import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config.js';
import type { Database } from '../db/client.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import { findOrCreateConversation } from '../db/repositories/conversations.js';
import { conversations, events } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { buildServer } from '../server.js';
import type { ScreeningState } from '../workflow/screeningState.js';

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

/** Seeds a conversation with screening state, extracted facts, and one event. */
async function seedLead(): Promise<string> {
  const contact = await upsertContactByPhone(db, {
    phone: '+972521239999',
    entryPoint: 'meta_lead_form',
  });
  const { conversation } = await findOrCreateConversation(db, contact.id);

  const state: ScreeningState = {
    answers: {
      neighborhood: { value: 'Opus 4.8', isValid: false, reason: 'not a place name' },
    },
    irrelevantResponseCount: 3,
    invalidAnswerCount: 1,
    reaskCount: 1,
    warningSent: true,
    mode: 'containment',
    sentVideoIds: [],
    promoSent: false,
    unknownNeighborhoods: [],
    qualification: {
      status: 'needs_review',
      score: 25,
      reasons: ['Customer provided irrelevant responses'],
    },
  };

  await db
    .update(conversations)
    .set({
      stage: 'screening_neighborhood',
      qualified: false,
      screeningState: state,
      extracted: {},
    })
    .where(eq(conversations.id, conversation.id));

  await db.insert(events).values({
    aggregateType: 'conversation',
    aggregateId: conversation.id,
    eventType: 'stage_transition',
    fromStage: 'screening_neighborhood',
    toStage: 'screening_neighborhood',
    actor: 'system',
    metadata: {
      action: 'ask_neighborhood',
      triggeredRule: 'neighborhood_validation',
      reason: 'Invalid neighborhood: not a place name',
    },
  });

  return conversation.id;
}

describe('GET /debug/leads/:leadId (development)', () => {
  it('returns the full lead state with reasons, masking the phone', async () => {
    const app = buildServer({ db, config: devConfig });
    await app.ready();
    try {
      const leadId = await seedLead();
      const response = await app.inject({ method: 'GET', url: `/debug/leads/${leadId}` });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        qualification: { isQualified: boolean; score: number };
        answers: Record<string, { isValid: boolean }>;
        irrelevantResponseCount: number;
        warningSent: boolean;
        mode: string;
        nextAction: string;
        stateHistory: { triggeredRule: string }[];
        contact: { phoneMasked: string };
      }>();
      expect(body.qualification).toMatchObject({ isQualified: false, score: 25 });
      expect(body.answers.neighborhood).toMatchObject({ isValid: false });
      expect(body.irrelevantResponseCount).toBe(3);
      expect(body.warningSent).toBe(true);
      expect(body.mode).toBe('containment');
      expect(body.nextAction).toBe('stop_responding');
      expect(body.stateHistory).toHaveLength(1);
      expect(body.stateHistory[0]).toMatchObject({
        triggeredRule: 'neighborhood_validation',
      });
      // Phone is masked — the raw number never appears.
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
