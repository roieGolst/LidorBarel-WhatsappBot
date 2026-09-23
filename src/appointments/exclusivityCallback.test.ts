import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import {
  findOrCreateConversation,
  getConversationById,
} from '../db/repositories/conversations.js';
import { conversations } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import type { MondayClient } from '../monday/client.js';
import {
  ACTIVITY_COLUMNS,
  ACTIVITY_STATUS,
  ACTIVITY_TYPE,
} from '../monday/leadMapping.js';
import type { KnownFacts } from '../workflow/decide.js';
import {
  CALLBACK_ITEM_NAME,
  callbackColumnValues,
  callbackStart,
  ensureExclusivityCallback,
  wantsExclusivityCallback,
} from './exclusivityCallback.js';

const TZ = 'Asia/Jerusalem';

describe('wantsExclusivityCallback', () => {
  const exclusive: KnownFacts = {
    currentlyMarketed: 'with_agent',
    exclusivityEndsAt: 'בעוד חודשיים',
    exclusivityEndsOn: '2026-11-08',
  };

  it('wants one for an exclusive lead with a known end date', () => {
    expect(wantsExclusivityCallback(exclusive)).toBe(true);
  });

  it('treats silence on the follow-up question as a yes, an explicit no as a no', () => {
    expect(
      wantsExclusivityCallback({ ...exclusive, wantsExclusivityFollowup: true }),
    ).toBe(true);
    expect(
      wantsExclusivityCallback({ ...exclusive, wantsExclusivityFollowup: false }),
    ).toBe(false);
  });

  it('needs a real date — "בקרוב" is a note, not a calendar entry', () => {
    expect(wantsExclusivityCallback({ ...exclusive, exclusivityEndsOn: undefined })).toBe(
      false,
    );
  });

  it('is not for a lead who is not exclusive', () => {
    expect(wantsExclusivityCallback({ ...exclusive, currentlyMarketed: 'no' })).toBe(
      false,
    );
  });
});

describe('callbackStart', () => {
  it('is 10:00 local on the end date — in September, 07:00Z', () => {
    expect(callbackStart('2026-09-09', TZ).toISOString()).toBe(
      '2026-09-09T07:00:00.000Z',
    );
  });

  it('is 10:00 local in winter too — 08:00Z', () => {
    expect(callbackStart('2026-12-09', TZ).toISOString()).toBe(
      '2026-12-09T08:00:00.000Z',
    );
  });

  it('never lands on Shabbat', () => {
    // 2026-09-12 is a Saturday → Sunday the 13th.
    expect(callbackStart('2026-09-12', TZ).toISOString()).toBe(
      '2026-09-13T07:00:00.000Z',
    );
  });
});

describe('callbackColumnValues', () => {
  it('is an open intro-call activity linked to the lead', () => {
    const values = callbackColumnValues(new Date('2026-09-09T07:00:00Z'), '555');
    expect(values[ACTIVITY_COLUMNS.type]).toEqual({ index: ACTIVITY_TYPE.introCall });
    expect(values[ACTIVITY_COLUMNS.status]).toEqual({ index: ACTIVITY_STATUS.open });
    expect(values[ACTIVITY_COLUMNS.start]).toEqual({
      date: '2026-09-09',
      time: '07:00:00',
    });
    expect(values[ACTIVITY_COLUMNS.end]).toEqual({
      date: '2026-09-09',
      time: '07:30:00',
    });
    expect(values[ACTIVITY_COLUMNS.contact]).toEqual({ item_ids: [555] });
  });

  it('is created without a link when the lead has no board item', () => {
    expect(callbackColumnValues(new Date(), null)).not.toHaveProperty(
      ACTIVITY_COLUMNS.contact,
    );
  });
});

describe('ensureExclusivityCallback', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  class FakeMonday {
    created: { name: string; values: Record<string, unknown> }[] = [];
    private counter = 0;
    createItem(_board: string, name: string, values: Record<string, unknown>) {
      this.created.push({ name, values });
      return Promise.resolve(`activity-${++this.counter}`);
    }
  }

  const CONTACT = { name: 'רועי גולסט', phone: '+972501234567' };

  const exclusive: KnownFacts = {
    currentlyMarketed: 'with_agent',
    exclusivityEndsAt: 'מחר',
    exclusivityEndsOn: '2026-09-09',
  };

  async function seedLead(): Promise<string> {
    const contact = await upsertContactByPhone(db, {
      phone: '+972501112233',
      entryPoint: 'meta_lead_form',
    });
    const { conversation } = await findOrCreateConversation(db, contact.id);
    await db
      .update(conversations)
      .set({ stage: 'disqualified', mondayItemId: '777' })
      .where(eq(conversations.id, conversation.id));
    return conversation.id;
  }

  it('creates the reminder once and remembers it', async () => {
    const fake = new FakeMonday();
    const deps = { db, monday: fake as unknown as MondayClient, timeZone: TZ };
    const conversationId = await seedLead();
    const conversation = (await getConversationById(db, conversationId))!;

    const first = await ensureExclusivityCallback(deps, conversation, exclusive, CONTACT);
    expect(first).toBe('activity-1');
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.name).toBe(`${CALLBACK_ITEM_NAME} עם רועי גולסט`);
    // The event's description: who, how to reach them, and when to call.
    const note = fake.created[0]!.values[ACTIVITY_COLUMNS.description];
    expect(note).toContain('+972501234567');
    expect(note).toContain('2026-09-09');
    expect(fake.created[0]!.values[ACTIVITY_COLUMNS.contact]).toEqual({
      item_ids: [777],
    });

    // A later projection of the same lead sees the record and does nothing.
    const again = (await getConversationById(db, conversationId))!;
    expect(again.exclusivityCallbackItemId).toBe('activity-1');
    const second = await ensureExclusivityCallback(deps, again, exclusive, CONTACT);
    expect(second).toBe('activity-1');
    expect(fake.created).toHaveLength(1);
  });

  it('does nothing when the facts do not call for one', async () => {
    const fake = new FakeMonday();
    const conversationId = await seedLead();
    const conversation = (await getConversationById(db, conversationId))!;

    const result = await ensureExclusivityCallback(
      { db, monday: fake as unknown as MondayClient, timeZone: TZ },
      conversation,
      { currentlyMarketed: 'no' },
      CONTACT,
    );

    expect(result).toBeUndefined();
    expect(fake.created).toHaveLength(0);
  });
});
