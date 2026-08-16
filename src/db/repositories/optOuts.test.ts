import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../client.js';
import { setupTestDatabase, truncateAll } from '../testing.js';
import { findContactByPhone, upsertContactByPhone } from './contacts.js';
import { isOptedOut, recordOptOut, reverseOptOut } from './optOuts.js';

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

describe('recordOptOut', () => {
  it('records the opt-out and flags the contact in one operation', async () => {
    await upsertContactByPhone(db, {
      phone: '0533374203',
      consentStatus: 'whatsapp_opt_in',
    });

    await recordOptOut(db, '0533374203', 'keyword', 'said stop');

    expect(await isOptedOut(db, '0533374203')).toBe(true);

    const contact = await findContactByPhone(db, '0533374203');
    expect(contact?.doNotContact).toBe(true);
    expect(contact?.consentStatus).toBe('opted_out');
  });

  // The opt-out record is keyed by phone, not contact id, so that it survives
  // contacts being deleted, merged, or re-imported.
  it('opts out a number with no contact row', async () => {
    await recordOptOut(db, '0501234567', 'keyword');

    expect(await isOptedOut(db, '0501234567')).toBe(true);
  });

  it('recognises the opt-out regardless of phone format', async () => {
    await recordOptOut(db, '053-337-4203', 'classifier');

    expect(await isOptedOut(db, '0533374203')).toBe(true);
    expect(await isOptedOut(db, '+972533374203')).toBe(true);
    expect(await isOptedOut(db, '972533374203')).toBe(true);
  });

  // What matters is when the person first asked us to stop, so a repeat must
  // not move the timestamp.
  it('is idempotent and preserves the original timestamp', async () => {
    await recordOptOut(db, '0533374203', 'keyword', 'first');
    const first = await db.query.optOuts.findFirst();

    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordOptOut(db, '0533374203', 'staff', 'second');

    const all = await db.query.optOuts.findMany();
    expect(all).toHaveLength(1);
    expect(all[0]?.createdAt).toEqual(first?.createdAt);
    expect(all[0]?.reason).toBe('first');
  });

  // Regression: upsert previously consulted only the contact row. When a number
  // opted out before any contact existed, a later lead-form submission created
  // the contact as whatsapp_opt_in and made them messageable again — exactly
  // the failure Amendment 40 penalises. Upsert now reads `opt_outs` directly.
  it('keeps opt-out when the contact is created only afterwards', async () => {
    await recordOptOut(db, '0533374203', 'keyword');

    const contact = await upsertContactByPhone(db, {
      phone: '0533374203',
      consentStatus: 'whatsapp_opt_in',
      consentSource: 'meta_form_123',
      name: 'Resubmitted the lead form',
    });

    expect(contact.consentStatus).toBe('opted_out');
    expect(contact.doNotContact).toBe(true);
    expect(await isOptedOut(db, '0533374203')).toBe(true);
  });

  it('survives a later upsert attempting to restore consent', async () => {
    await recordOptOut(db, '0533374203', 'keyword');

    await upsertContactByPhone(db, {
      phone: '0533374203',
      consentStatus: 'whatsapp_opt_in',
      name: 'Resubmitted the lead form',
    });

    expect(await isOptedOut(db, '0533374203')).toBe(true);
    const contact = await findContactByPhone(db, '0533374203');
    expect(contact?.consentStatus).toBe('opted_out');
  });

  it.each(['keyword', 'classifier', 'staff', 'provider'] as const)(
    'accepts source %s',
    async (source) => {
      await recordOptOut(db, '0533374203', source);
      expect(await isOptedOut(db, '0533374203')).toBe(true);
    },
  );
});

describe('isOptedOut', () => {
  it('returns false for a number that never opted out', async () => {
    await upsertContactByPhone(db, { phone: '0533374203' });
    expect(await isOptedOut(db, '0533374203')).toBe(false);
  });

  it('returns false for an entirely unknown number', async () => {
    expect(await isOptedOut(db, '0501234567')).toBe(false);
  });
});

describe('reverseOptOut', () => {
  it('clears the opt-out only on explicit re-consent', async () => {
    await upsertContactByPhone(db, { phone: '0533374203' });
    await recordOptOut(db, '0533374203', 'keyword');

    await reverseOptOut(
      db,
      '0533374203',
      'meta_form_999',
      'אני מאשר/ת לקבל הודעות וואטסאפ',
    );

    expect(await isOptedOut(db, '0533374203')).toBe(false);
    const contact = await findContactByPhone(db, '0533374203');
    expect(contact?.doNotContact).toBe(false);
    expect(contact?.consentStatus).toBe('whatsapp_opt_in');
    expect(contact?.consentSource).toBe('meta_form_999');
  });
});
