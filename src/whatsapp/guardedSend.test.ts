import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { upsertContactByPhone, type Contact } from '../db/repositories/contacts.js';
import { recordOptOut } from '../db/repositories/optOuts.js';
import { setupTestDatabase, truncateAll } from '../db/testing.js';
import { FakeChannel } from './fakeChannel.js';
import {
  ConsentRequiredError,
  guardedSend,
  OptedOutError,
  RecipientMismatchError,
  WindowClosedError,
} from './guardedSend.js';

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

const PHONE = '+972521234501';

/** A window that is open, and one that closed an hour ago. */
const OPEN = { windowExpiresAt: new Date(Date.now() + 60 * 60 * 1000) };
const CLOSED = { windowExpiresAt: new Date(Date.now() - 60 * 60 * 1000) };
const NEVER_OPENED = { windowExpiresAt: null };

function contactWith(overrides: Partial<Contact> = {}): Contact {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    phone: PHONE,
    name: null,
    email: null,
    gender: null,
    consentStatus: 'whatsapp_opt_in',
    consentSource: null,
    consentText: null,
    consentRecordedAt: null,
    entryPoint: 'meta_lead_form',
    doNotContact: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('guardedSend — replies', () => {
  it('sends inside an open window', async () => {
    const channel = new FakeChannel();

    const result = await guardedSend(
      db,
      { kind: 'reply', to: PHONE, conversation: OPEN },
      () => channel.sendText(PHONE, 'שלום'),
    );

    expect(result.providerMessageId).toBeTruthy();
    expect(channel.sent).toHaveLength(1);
  });

  it('does not require consent — the person messaged first', async () => {
    // A reply to an inbound is always allowed; consent governs who we may
    // approach, not who we may answer.
    const channel = new FakeChannel();

    await expect(
      guardedSend(db, { kind: 'reply', to: PHONE, conversation: OPEN }, () =>
        channel.sendText(PHONE, 'שלום'),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a contact who opted out', async () => {
    await recordOptOut(db, PHONE, 'keyword', 'stop');
    const channel = new FakeChannel();

    await expect(
      guardedSend(db, { kind: 'reply', to: PHONE, conversation: OPEN }, () =>
        channel.sendText(PHONE, 'שלום'),
      ),
    ).rejects.toBeInstanceOf(OptedOutError);
    expect(channel.sent).toHaveLength(0);
  });

  it('normalizes the number before checking the opt-out record', async () => {
    await recordOptOut(db, PHONE, 'keyword', 'stop');
    const channel = new FakeChannel();

    await expect(
      guardedSend(db, { kind: 'reply', to: '0521234501', conversation: OPEN }, () =>
        channel.sendText('0521234501', 'שלום'),
      ),
    ).rejects.toBeInstanceOf(OptedOutError);
  });
});

/**
 * Defect D-2. `sendWindow`/`canSendFreeForm` were implemented and tested with no
 * production caller, so nothing stopped a free-form send outside the window —
 * Meta would simply reject it, with an opaque error far from the cause.
 */
describe('guardedSend — messaging window', () => {
  it('refuses free-form text after the window closes', async () => {
    const channel = new FakeChannel();

    await expect(
      guardedSend(db, { kind: 'reply', to: PHONE, conversation: CLOSED }, () =>
        channel.sendText(PHONE, 'שלום'),
      ),
    ).rejects.toBeInstanceOf(WindowClosedError);
    expect(channel.sent).toHaveLength(0);
  });

  it('refuses free-form text when no window has ever opened', async () => {
    const channel = new FakeChannel();

    await expect(
      guardedSend(db, { kind: 'reply', to: PHONE, conversation: NEVER_OPENED }, () =>
        channel.sendText(PHONE, 'שלום'),
      ),
    ).rejects.toBeInstanceOf(WindowClosedError);
  });

  it('allows an approved template outside the window', async () => {
    // The one thing Meta accepts when the window is shut.
    const channel = new FakeChannel();

    await expect(
      guardedSend(
        db,
        { kind: 'reply', to: PHONE, conversation: CLOSED, isTemplate: true },
        () => channel.sendText(PHONE, 'template'),
      ),
    ).resolves.toBeDefined();
  });

  it('still refuses a template to someone who opted out', async () => {
    // Opt-out outranks every other rule, template or not.
    await recordOptOut(db, PHONE, 'keyword', 'stop');
    const channel = new FakeChannel();

    await expect(
      guardedSend(
        db,
        { kind: 'reply', to: PHONE, conversation: CLOSED, isTemplate: true },
        () => channel.sendText(PHONE, 'template'),
      ),
    ).rejects.toBeInstanceOf(OptedOutError);
  });
});

/**
 * Defect D-1, and requirement NN-2. `canReceiveProactiveMessage` was implemented
 * and tested but had no caller, so the consent gate the schema and the plan both
 * claimed was "enforced in code" did nothing at all.
 *
 * A regression here means a business-initiated message to someone who never
 * agreed to receive one: up to ₪1,000 per message under Israeli Amendment 40,
 * plus Meta opt-in policy exposure.
 */
describe('guardedSend — proactive consent (NN-2)', () => {
  it('sends a template to a consenting contact', async () => {
    const channel = new FakeChannel();

    const result = await guardedSend(
      db,
      { kind: 'proactive', to: PHONE, contact: contactWith(), isTemplate: true },
      () => channel.sendText(PHONE, 'template'),
    );

    expect(result.providerMessageId).toBeTruthy();
  });

  it.each(['none', 'privacy_policy_only', 'opted_out'] as const)(
    'refuses a contact whose consent is %s',
    async (consentStatus) => {
      const channel = new FakeChannel();

      await expect(
        guardedSend(
          db,
          {
            kind: 'proactive',
            to: PHONE,
            contact: contactWith({ consentStatus }),
            isTemplate: true,
          },
          () => channel.sendText(PHONE, 'template'),
        ),
      ).rejects.toBeInstanceOf(ConsentRequiredError);
      expect(channel.sent).toHaveLength(0);
    },
  );

  it('refuses a contact flagged do-not-contact even with consent recorded', async () => {
    const channel = new FakeChannel();

    await expect(
      guardedSend(
        db,
        {
          kind: 'proactive',
          to: PHONE,
          contact: contactWith({ doNotContact: true }),
          isTemplate: true,
        },
        () => channel.sendText(PHONE, 'template'),
      ),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('refuses when the durable opt-out record disagrees with the contact row', async () => {
    // The contact row can be stale; `opt_outs` is the durable record and wins.
    await recordOptOut(db, PHONE, 'keyword', 'stop');
    const channel = new FakeChannel();

    await expect(
      guardedSend(
        db,
        { kind: 'proactive', to: PHONE, contact: contactWith(), isTemplate: true },
        () => channel.sendText(PHONE, 'template'),
      ),
    ).rejects.toBeInstanceOf(OptedOutError);
  });

  it('refuses when the contact does not match the recipient', async () => {
    // Authorising a send by checking a different person's consent would be
    // invisible in the logs and catastrophic in effect.
    const channel = new FakeChannel();

    await expect(
      guardedSend(
        db,
        {
          kind: 'proactive',
          to: '+972521234599',
          contact: contactWith(),
          isTemplate: true,
        },
        () => channel.sendText('+972521234599', 'template'),
      ),
    ).rejects.toBeInstanceOf(RecipientMismatchError);
  });

  it('refuses free-form proactive text with no open window', async () => {
    const channel = new FakeChannel();

    await expect(
      guardedSend(
        db,
        { kind: 'proactive', to: PHONE, contact: contactWith(), isTemplate: false },
        () => channel.sendText(PHONE, 'שלום'),
      ),
    ).rejects.toBeInstanceOf(WindowClosedError);
  });

  it('allows free-form proactive text while a window happens to be open', async () => {
    const channel = new FakeChannel();

    await expect(
      guardedSend(
        db,
        {
          kind: 'proactive',
          to: PHONE,
          contact: contactWith(),
          isTemplate: false,
          conversation: OPEN,
        },
        () => channel.sendText(PHONE, 'שלום'),
      ),
    ).resolves.toBeDefined();
  });

  it('reflects consent as actually stored, not as passed in', async () => {
    // End-to-end against a real row: a lead ingested without consent must not be
    // contactable just because a caller constructed an optimistic object.
    const stored = await upsertContactByPhone(db, {
      phone: PHONE,
      consentStatus: 'privacy_policy_only',
    });
    const channel = new FakeChannel();

    await expect(
      guardedSend(
        db,
        { kind: 'proactive', to: stored.phone, contact: stored, isTemplate: true },
        () => channel.sendText(stored.phone, 'template'),
      ),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });
});
