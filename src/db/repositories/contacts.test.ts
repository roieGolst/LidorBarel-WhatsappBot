import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../client.js';
import { setupTestDatabase, truncateAll } from '../testing.js';
import {
  canReceiveProactiveMessage,
  findContactByPhone,
  mergeConsent,
  upsertContactByPhone,
  type Contact,
} from './contacts.js';

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

describe('upsertContactByPhone', () => {
  it('creates a contact and stores the phone in E.164', async () => {
    const contact = await upsertContactByPhone(db, {
      phone: '053-337-4203',
      name: 'ישראל ישראלי',
    });

    expect(contact.phone).toBe('+972533374203');
    expect(contact.name).toBe('ישראל ישראלי');
  });

  // The central dedup guarantee. A lead-form submission and an inbound WhatsApp
  // message from the same person arrive in different formats; if they do not
  // collapse to one row we message them twice and split their history.
  it('resolves every phone format to a single contact', async () => {
    const first = await upsertContactByPhone(db, {
      phone: '053-337-4203',
      name: 'From lead form',
    });
    const second = await upsertContactByPhone(db, { phone: '972533374203' });
    const third = await upsertContactByPhone(db, { phone: '+972 53 337 4203' });

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
  });

  // A WhatsApp message carries no name. It must not erase the name the lead
  // form already captured.
  it('leaves existing fields untouched when new values are absent', async () => {
    await upsertContactByPhone(db, {
      phone: '0533374203',
      name: 'ישראל ישראלי',
      email: 'israel@example.com',
    });

    const updated = await upsertContactByPhone(db, { phone: '0533374203' });

    expect(updated.name).toBe('ישראל ישראלי');
    expect(updated.email).toBe('israel@example.com');
  });

  it('updates fields that are explicitly provided', async () => {
    await upsertContactByPhone(db, { phone: '0533374203', name: 'Old name' });
    const updated = await upsertContactByPhone(db, {
      phone: '0533374203',
      name: 'New name',
    });

    expect(updated.name).toBe('New name');
  });

  it('defaults consent to none and do-not-contact to false', async () => {
    const contact = await upsertContactByPhone(db, { phone: '0533374203' });

    expect(contact.consentStatus).toBe('none');
    expect(contact.doNotContact).toBe(false);
  });

  it('records consent provenance for the audit trail', async () => {
    const recordedAt = new Date('2026-08-16T10:00:00Z');
    const contact = await upsertContactByPhone(db, {
      phone: '0533374203',
      consentStatus: 'whatsapp_opt_in',
      consentSource: 'meta_form_12345',
      consentText: 'אני מאשר/ת לקבל הודעות וואטסאפ מלידור בראל תיווך נדל״ן',
      consentRecordedAt: recordedAt,
      entryPoint: 'meta_lead_form',
    });

    expect(contact.consentStatus).toBe('whatsapp_opt_in');
    expect(contact.consentSource).toBe('meta_form_12345');
    expect(contact.consentText).toContain('וואטסאפ');
    expect(contact.consentRecordedAt).toEqual(recordedAt);
    expect(contact.entryPoint).toBe('meta_lead_form');
  });

  it('rejects an unparseable phone number rather than storing it', async () => {
    await expect(upsertContactByPhone(db, { phone: 'garbage' })).rejects.toThrow();
  });

  // Two webhooks for the same person can arrive simultaneously. Dedup is
  // enforced by the unique index, not a read-then-write, so this must not
  // produce two rows.
  it('creates one row under concurrent upserts of the same number', async () => {
    const results = await Promise.all([
      upsertContactByPhone(db, { phone: '0533374203', name: 'A' }),
      upsertContactByPhone(db, { phone: '+972533374203', name: 'B' }),
      upsertContactByPhone(db, { phone: '972533374203', name: 'C' }),
    ]);

    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
  });
});

describe('findContactByPhone', () => {
  it('finds a contact regardless of the format queried', async () => {
    await upsertContactByPhone(db, { phone: '+972533374203' });

    expect(await findContactByPhone(db, '0533374203')).toBeDefined();
    expect(await findContactByPhone(db, '053-337-4203')).toBeDefined();
    expect(await findContactByPhone(db, '972533374203')).toBeDefined();
  });

  it('returns undefined for an unknown number', async () => {
    expect(await findContactByPhone(db, '0501234567')).toBeUndefined();
  });
});

describe('mergeConsent', () => {
  // The rule that prevents re-messaging someone who asked us to stop. A later
  // lead-form submission carrying weaker consent must not quietly undo it.
  it('treats opted_out as terminal', () => {
    expect(mergeConsent('opted_out', 'privacy_policy_only')).toBe('opted_out');
    expect(mergeConsent('opted_out', 'whatsapp_opt_in')).toBe('opted_out');
    expect(mergeConsent('opted_out', 'none')).toBe('opted_out');
  });

  it('applies an incoming opt-out immediately', () => {
    expect(mergeConsent('whatsapp_opt_in', 'opted_out')).toBe('opted_out');
  });

  it('never downgrades consent', () => {
    expect(mergeConsent('whatsapp_opt_in', 'privacy_policy_only')).toBe(
      'whatsapp_opt_in',
    );
    expect(mergeConsent('privacy_policy_only', 'none')).toBe('privacy_policy_only');
  });

  it('upgrades consent when the incoming signal is stronger', () => {
    expect(mergeConsent('none', 'privacy_policy_only')).toBe('privacy_policy_only');
    expect(mergeConsent('privacy_policy_only', 'whatsapp_opt_in')).toBe(
      'whatsapp_opt_in',
    );
  });

  it('defaults to none when nothing is known', () => {
    expect(mergeConsent(undefined, undefined)).toBe('none');
  });

  it('preserves opted_out through an upsert', async () => {
    await upsertContactByPhone(db, {
      phone: '0533374203',
      consentStatus: 'opted_out',
    });

    const after = await upsertContactByPhone(db, {
      phone: '0533374203',
      consentStatus: 'privacy_policy_only',
    });

    expect(after.consentStatus).toBe('opted_out');
  });
});

describe('canReceiveProactiveMessage', () => {
  function contact(overrides: Partial<Contact>): Contact {
    return {
      consentStatus: 'none',
      doNotContact: false,
      ...overrides,
    } as Contact;
  }

  // Proactive messaging is business-initiated, so it needs explicit opt-in.
  // A privacy-policy checkbox is not sufficient under Meta's policy or
  // Israeli Amendment 40 — this is the gate that enforces that in code.
  it('allows only explicit WhatsApp opt-in', () => {
    expect(
      canReceiveProactiveMessage(contact({ consentStatus: 'whatsapp_opt_in' })),
    ).toBe(true);
  });

  it.each(['none', 'privacy_policy_only', 'opted_out'] as const)(
    'refuses consent status %s',
    (status) => {
      expect(canReceiveProactiveMessage(contact({ consentStatus: status }))).toBe(false);
    },
  );

  it('refuses when do-not-contact is set, even with opt-in', () => {
    expect(
      canReceiveProactiveMessage(
        contact({ consentStatus: 'whatsapp_opt_in', doNotContact: true }),
      ),
    ).toBe(false);
  });
});
