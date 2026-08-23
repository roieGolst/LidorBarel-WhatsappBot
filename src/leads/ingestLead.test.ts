import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { findContactByPhone } from '../db/repositories/contacts.js';
import { recordOptOut } from '../db/repositories/optOuts.js';
import { campaignReferrals, conversations } from '../db/schema.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import type { ConsentConfig } from './fieldMapping.js';
import type { GraphLeadsClient, RetrievedLead } from './graphLeads.js';
import { LeadRetrievalError } from './graphLeads.js';
import { ingestLead, ingestLeads, type LeadIngestDeps } from './ingestLead.js';
import type { LeadgenEvent } from './leadgenPayload.js';

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

const PHONE = '+972501234567';

function retrievedLead(overrides: Partial<RetrievedLead> = {}): RetrievedLead {
  return {
    id: 'L1',
    createdTime: new Date('2026-08-20T10:00:00Z'),
    formId: '555',
    fieldData: [
      { name: 'full_name', values: ['ישראל ישראלי'] },
      { name: 'phone_number', values: [PHONE] },
      { name: 'email', values: ['israel@example.com'] },
    ],
    raw: { id: 'L1', field_data: 'raw-as-delivered' },
    ...overrides,
  };
}

/** A stub Graph client returning a canned lead, or throwing a canned error. */
function stubLeads(lead: RetrievedLead | Error): GraphLeadsClient {
  return {
    fetchLead: () =>
      lead instanceof Error ? Promise.reject(lead) : Promise.resolve(lead),
  } as unknown as GraphLeadsClient;
}

const SELLER_FORM = '555';

function deps(
  lead: RetrievedLead | Error = retrievedLead(),
  consent: Omit<ConsentConfig, 'formId'> = {},
  sellerForms: readonly string[] = [SELLER_FORM],
): LeadIngestDeps {
  return { leads: stubLeads(lead), consent, sellerForms };
}

const EVENT: LeadgenEvent = { leadgenId: 'L1', formId: '555', adId: '666' };

describe('ingestLead', () => {
  it('creates the contact, conversation, and referral together', async () => {
    const result = await ingestLead(db, EVENT, deps());

    expect(result.duplicate).toBe(false);
    expect(result.contactId).toBeDefined();
    expect(result.conversationId).toBeDefined();

    const contact = await findContactByPhone(db, PHONE);
    expect(contact?.name).toBe('ישראל ישראלי');
    expect(contact?.email).toBe('israel@example.com');
    expect(contact?.entryPoint).toBe('meta_lead_form');
  });

  it('starts a form lead in awaiting_first_contact', async () => {
    // The lead exists and the bot has not spoken yet — that is exactly what this
    // stage means, and it is what the proactive send path will look for.
    const result = await ingestLead(db, EVENT, deps());

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, result.conversationId!));
    expect(conversation?.stage).toBe('awaiting_first_contact');
  });

  it('records the referral with its attribution and raw answers', async () => {
    await ingestLead(db, EVENT, deps());

    const [referral] = await db.select().from(campaignReferrals);
    expect(referral?.externalLeadId).toBe('L1');
    expect(referral?.formId).toBe('555');
    expect(referral?.adId).toBe('666');
    expect(referral?.rawPayload).toEqual({ id: 'L1', field_data: 'raw-as-delivered' });
  });

  it('normalizes the phone to E.164', async () => {
    const lead = retrievedLead({
      fieldData: [{ name: 'phone_number', values: ['0501234567'] }],
    });

    await ingestLead(db, EVENT, deps(lead));

    expect(await findContactByPhone(db, PHONE)).toBeDefined();
  });

  describe('redelivery', () => {
    it('reports a redelivered lead as a duplicate', async () => {
      await ingestLead(db, EVENT, deps());
      const second = await ingestLead(db, EVENT, deps());

      expect(second.duplicate).toBe(true);
    });

    it('does not create a second referral or conversation', async () => {
      await ingestLead(db, EVENT, deps());
      await ingestLead(db, EVENT, deps());

      expect(await db.select().from(campaignReferrals)).toHaveLength(1);
      expect(await db.select().from(conversations)).toHaveLength(1);
    });

    it('keeps one contact when the same person submits twice under new lead ids', async () => {
      // Same phone, different submission. One person must stay one contact or
      // they get messaged twice and their history splits.
      await ingestLead(db, { leadgenId: 'L1' }, deps());
      await ingestLead(db, { leadgenId: 'L2' }, deps(retrievedLead({ id: 'L2' })));

      expect(await db.select().from(campaignReferrals)).toHaveLength(2);
      expect(await db.select().from(conversations)).toHaveLength(1);
    });
  });

  describe('consent (requirement NN-2)', () => {
    it('records privacy_policy_only when the form has no consent field', async () => {
      const result = await ingestLead(db, EVENT, deps());

      expect(result.consentStatus).toBe('privacy_policy_only');
    });

    it('records whatsapp_opt_in only for an affirmative consent answer', async () => {
      const lead = retrievedLead({
        fieldData: [
          { name: 'phone_number', values: [PHONE] },
          { name: 'wa_consent', values: ['כן'] },
        ],
      });

      const result = await ingestLead(db, EVENT, deps(lead, { fieldName: 'wa_consent' }));

      expect(result.consentStatus).toBe('whatsapp_opt_in');
    });

    it('stores consent provenance for the audit trail', async () => {
      const lead = retrievedLead({
        fieldData: [
          { name: 'phone_number', values: [PHONE] },
          { name: 'wa_consent', values: ['כן'] },
        ],
      });

      await ingestLead(db, EVENT, deps(lead, { fieldName: 'wa_consent' }));

      const contact = await findContactByPhone(db, PHONE);
      expect(contact?.consentSource).toBe('555');
      expect(contact?.consentText).toBe('כן');
      expect(contact?.consentRecordedAt).toEqual(new Date('2026-08-20T10:00:00Z'));
    });

    it('grants opt-in from a consent-gated form with no per-lead field', async () => {
      // The live seller form's required checkbox never appears in field_data.
      const result = await ingestLead(
        db,
        EVENT,
        deps(retrievedLead(), { consentForms: ['555'], formConsentText: 'הסכמה' }),
      );

      expect(result.consentStatus).toBe('whatsapp_opt_in');
      const contact = await findContactByPhone(db, PHONE);
      expect(contact?.consentText).toBe('הסכמה');
      expect(contact?.consentSource).toBe('555');
    });

    it('never restores consent for someone who opted out', async () => {
      // The single worst failure this system can have. A later form submission
      // must not undo an opt-out.
      await recordOptOut(db, PHONE, 'keyword', 'stop');

      const lead = retrievedLead({
        fieldData: [
          { name: 'phone_number', values: [PHONE] },
          { name: 'wa_consent', values: ['כן'] },
        ],
      });
      const result = await ingestLead(db, EVENT, deps(lead, { fieldName: 'wa_consent' }));

      expect(result.consentStatus).toBe('opted_out');
      const contact = await findContactByPhone(db, PHONE);
      expect(contact?.doNotContact).toBe(true);
    });
  });

  describe('form gating', () => {
    // The Page runs investor and recruitment campaigns too. Their leads are real
    // and worth recording, but must never enter the seller flow.

    it('records a non-seller lead without opening a conversation', async () => {
      const result = await ingestLead(
        db,
        { leadgenId: 'L1', formId: 'investor-form' },
        deps(retrievedLead({ formId: 'investor-form' })),
      );

      expect(result.engaged).toBe(false);
      expect(result.conversationId).toBeUndefined();
      expect(await db.select().from(campaignReferrals)).toHaveLength(1);
      expect(await db.select().from(conversations)).toHaveLength(0);
    });

    it('still records the contact for a non-seller lead', async () => {
      await ingestLead(
        db,
        { leadgenId: 'L1', formId: 'investor-form' },
        deps(retrievedLead({ formId: 'investor-form' })),
      );

      expect(await findContactByPhone(db, PHONE)).toBeDefined();
    });

    it('engages a lead from a seller form', async () => {
      const result = await ingestLead(db, EVENT, deps());

      expect(result.engaged).toBe(true);
      expect(result.conversationId).toBeDefined();
    });

    it('engages nothing when no seller form is configured', async () => {
      const result = await ingestLead(db, EVENT, deps(retrievedLead(), {}, []));

      expect(result.engaged).toBe(false);
    });
  });

  describe('screening answers from the form', () => {
    // A meta_lead_form lead is screened on Q2 and Q4 only, on the premise that Q1
    // and Q3 were answered on the form. If they are not seeded here, they are
    // neither asked nor known and the lead qualifies on incomplete information.

    const Q1 = 'הנכס_שלך_כבר_מוכן_לשיווק,_או_שאתה_עדיין_בשלב_בדיקה/התלבטות?';
    const Q3 = 'תוך_כמה_זמן_אתה_מתכנן_למכור?';

    function sellerLead() {
      return retrievedLead({
        fieldData: [
          { name: 'phone_number', values: [PHONE] },
          { name: Q1, values: ['מוכן_לשיווק'] },
          { name: Q3, values: ['מיידי'] },
        ],
      });
    }

    it('seeds Q1 and Q3 onto the new conversation', async () => {
      const result = await ingestLead(db, EVENT, deps(sellerLead()));

      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, result.conversationId!));
      expect(conversation?.extracted).toEqual({
        sellIntent: 'ready',
        timeline: 'immediate',
      });
    });

    it('does not overwrite answers an existing conversation already holds', async () => {
      await ingestLead(db, { leadgenId: 'L1', formId: '555' }, deps(sellerLead()));
      await db
        .update(conversations)
        .set({ extracted: { sellIntent: 'not_sure', neighborhood: 'רמות' } });

      await ingestLead(
        db,
        { leadgenId: 'L2', formId: '555' },
        deps(retrievedLead({ id: 'L2' })),
      );

      const [conversation] = await db.select().from(conversations);
      expect(conversation?.extracted).toEqual({
        sellIntent: 'not_sure',
        neighborhood: 'רמות',
      });
    });
  });

  describe('unusable leads', () => {
    it('skips a lead with no phone number', async () => {
      const lead = retrievedLead({ fieldData: [{ name: 'email', values: ['a@b.c'] }] });

      const result = await ingestLead(db, EVENT, deps(lead));

      expect(result.skipped).toBe('unusable_phone');
      expect(await db.select().from(campaignReferrals)).toHaveLength(0);
    });

    it('skips a lead whose phone cannot be normalized', async () => {
      const lead = retrievedLead({
        fieldData: [{ name: 'phone_number', values: ['not-a-number'] }],
      });

      expect((await ingestLead(db, EVENT, deps(lead))).skipped).toBe('unusable_phone');
    });
  });

  it('does not rewind someone already mid-conversation', async () => {
    // A resubmission from an engaged lead must not reset their stage.
    await ingestLead(db, { leadgenId: 'L1' }, deps());
    await db.update(conversations).set({ stage: 'screening_neighborhood' });

    await ingestLead(db, { leadgenId: 'L2' }, deps(retrievedLead({ id: 'L2' })));

    const [conversation] = await db.select().from(conversations);
    expect(conversation?.stage).toBe('screening_neighborhood');
  });
});

describe('ingestLeads', () => {
  it('surfaces a retryable failure so Meta redelivers', async () => {
    const failing = new LeadRetrievalError('upstream down', true, 503);

    const { retryableError } = await ingestLeads(
      db,
      [{ leadgenId: 'L1' }],
      deps(failing),
    );

    expect(retryableError).toBe(failing);
  });

  it('swallows a permanent failure so Meta stops retrying', async () => {
    const permanent = new LeadRetrievalError('lead deleted', false, 404);

    const { results, retryableError } = await ingestLeads(
      db,
      [{ leadgenId: 'L1' }],
      deps(permanent),
    );

    expect(retryableError).toBeUndefined();
    expect(results[0]?.skipped).toBe('permanent_failure');
  });

  it('processes every lead in a batch independently', async () => {
    const { results } = await ingestLeads(
      db,
      [{ leadgenId: 'L1' }],
      deps(retrievedLead()),
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.duplicate).toBe(false);
  });
});
