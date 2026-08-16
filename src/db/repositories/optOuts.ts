import { eq } from 'drizzle-orm';
import { normalizePhone } from '../../domain/phone.js';
import type { DbClient } from '../client.js';
import { contacts, optOuts } from '../schema.js';

export type OptOut = typeof optOuts.$inferSelect;

/** How an opt-out was detected. */
export type OptOutSource =
  /** Matched an opt-out keyword. Runs without the LLM so it cannot be missed. */
  | 'keyword'
  /** The LLM classified the message as an opt-out request. */
  | 'classifier'
  /** A person marked it in the admin panel. */
  | 'staff'
  /** Meta reported the user blocked the business. */
  | 'provider';

/**
 * Records an opt-out.
 *
 * Writes the durable `opt_outs` row and flips the contact's flags in a single
 * transaction. Splitting these risks a crash between them leaving a contact who
 * asked us to stop still eligible to be messaged — the single worst failure
 * this system can have, both for trust and under Israeli Amendment 40.
 *
 * Keyed by phone rather than contact id so the record survives contacts being
 * deleted, merged, or re-imported. It is deliberately possible to opt out a
 * number that has no contact row at all.
 *
 * Idempotent: repeated opt-outs keep the original timestamp, since what matters
 * is when the person first asked.
 */
export async function recordOptOut(
  db: DbClient,
  phone: string,
  source: OptOutSource,
  reason?: string,
): Promise<void> {
  const normalized = normalizePhone(phone);

  await db.transaction(async (tx) => {
    await tx
      .insert(optOuts)
      .values({ phone: normalized, source, reason: reason ?? null })
      .onConflictDoNothing({ target: optOuts.phone });

    await tx
      .update(contacts)
      .set({
        doNotContact: true,
        consentStatus: 'opted_out',
        updatedAt: new Date(),
      })
      .where(eq(contacts.phone, normalized));
  });
}

/**
 * Whether this number has opted out.
 *
 * Consulted before every outbound send, including templates and follow-ups.
 * Reads `opt_outs` rather than `contacts.do_not_contact` because it is the
 * durable record: a contact row can be deleted or re-imported, this cannot.
 */
export async function isOptedOut(db: DbClient, phone: string): Promise<boolean> {
  const normalized = normalizePhone(phone);
  const [found] = await db
    .select({ id: optOuts.id })
    .from(optOuts)
    .where(eq(optOuts.phone, normalized))
    .limit(1);
  return found !== undefined;
}

/**
 * Reverses an opt-out after explicit re-consent.
 *
 * Separate and deliberately explicit: nothing in the normal message flow calls
 * this. Consent is set to `whatsapp_opt_in` only because re-opting-in requires
 * the person to have actively agreed again.
 */
export async function reverseOptOut(
  db: DbClient,
  phone: string,
  consentSource: string,
  consentText: string,
): Promise<void> {
  const normalized = normalizePhone(phone);

  await db.transaction(async (tx) => {
    await tx.delete(optOuts).where(eq(optOuts.phone, normalized));
    await tx
      .update(contacts)
      .set({
        doNotContact: false,
        consentStatus: 'whatsapp_opt_in',
        consentSource,
        consentText,
        consentRecordedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(contacts.phone, normalized));
  });
}
