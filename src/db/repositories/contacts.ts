import { eq } from 'drizzle-orm';
import { normalizePhone } from '../../domain/phone.js';
import type { DbClient } from '../client.js';
import { contacts, optOuts } from '../schema.js';

export type Contact = typeof contacts.$inferSelect;
export type ConsentStatus = Contact['consentStatus'];
export type EntryPoint = NonNullable<Contact['entryPoint']>;

/** Fields accepted when creating or updating a contact. */
export interface ContactInput {
  /** Any format — normalized to E.164 before it touches the database. */
  phone: string;
  name?: string | null;
  email?: string | null;
  gender?: string | null;
  consentStatus?: ConsentStatus;
  consentSource?: string | null;
  consentText?: string | null;
  consentRecordedAt?: Date | null;
  entryPoint?: EntryPoint | null;
}

/**
 * Finds a contact by phone number in any format.
 *
 * @throws {InvalidPhoneNumberError} if the number cannot be normalized.
 */
export async function findContactByPhone(
  db: DbClient,
  phone: string,
): Promise<Contact | undefined> {
  const normalized = normalizePhone(phone);
  const [found] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.phone, normalized))
    .limit(1);
  return found;
}

/**
 * Creates a contact, or updates the existing one with the same phone number.
 *
 * This is the single entry point through which contacts are created, and it is
 * what keeps one person as one row. The same individual can arrive as a Meta
 * lead-form submission and then as an inbound WhatsApp message minutes later;
 * both must resolve to the same contact or we message them twice and split
 * their history across two records.
 *
 * Deduplication is enforced by the database via `contacts_phone_unique` rather
 * than by a read-then-write in application code, which would race under
 * concurrent webhooks.
 *
 * Only fields explicitly provided are updated — a later inbound message with no
 * name must not erase a name captured earlier by the lead form.
 *
 * Consent is never silently downgraded: see {@link mergeConsent}.
 */
export async function upsertContactByPhone(
  db: DbClient,
  input: ContactInput,
): Promise<Contact> {
  const phone = normalizePhone(input.phone);

  const existing = await findContactByPhone(db, phone);

  // `opt_outs` is the durable opt-out record and must be consulted here, not
  // just the contact row. A number can be opted out while no contact exists —
  // and a contact row can be deleted or re-imported — so relying on
  // `contacts.consent_status` alone would let a later lead-form submission
  // silently restore consent for someone who asked us to stop.
  const [priorOptOut] = await db
    .select({ id: optOuts.id })
    .from(optOuts)
    .where(eq(optOuts.phone, phone))
    .limit(1);

  const consentStatus = priorOptOut
    ? 'opted_out'
    : mergeConsent(existing?.consentStatus, input.consentStatus);
  const doNotContact = priorOptOut !== undefined || (existing?.doNotContact ?? false);

  const [row] = await db
    .insert(contacts)
    .values({
      phone,
      name: input.name ?? null,
      email: input.email ?? null,
      gender: input.gender ?? null,
      consentStatus,
      consentSource: input.consentSource ?? null,
      consentText: input.consentText ?? null,
      consentRecordedAt: input.consentRecordedAt ?? null,
      entryPoint: input.entryPoint ?? null,
      doNotContact,
    })
    .onConflictDoUpdate({
      target: contacts.phone,
      set: {
        ...definedOnly({
          name: input.name,
          email: input.email,
          gender: input.gender,
          consentSource: input.consentSource,
          consentText: input.consentText,
          consentRecordedAt: input.consentRecordedAt,
          entryPoint: input.entryPoint,
        }),
        consentStatus,
        doNotContact,
        updatedAt: new Date(),
      },
    })
    .returning();

  // The insert always returns exactly one row.
  return row!;
}

/**
 * Combines an existing consent status with an incoming one.
 *
 * Two rules, both of which exist to prevent messaging someone we should not:
 *
 *  1. `opted_out` is terminal. A later lead-form submission carrying
 *     `privacy_policy_only` must never quietly re-enable messaging for someone
 *     who asked us to stop. Re-consent is a deliberate, separate action.
 *  2. Consent is never downgraded. If someone has given explicit WhatsApp
 *     opt-in, a subsequent weaker signal does not reduce it.
 */
export function mergeConsent(
  existing: ConsentStatus | undefined,
  incoming: ConsentStatus | undefined,
): ConsentStatus {
  if (existing === 'opted_out') return 'opted_out';
  if (incoming === 'opted_out') return 'opted_out';

  const rank: Record<ConsentStatus, number> = {
    none: 0,
    privacy_policy_only: 1,
    whatsapp_opt_in: 2,
    opted_out: 3,
  };

  const current = existing ?? 'none';
  const next = incoming ?? 'none';
  return rank[next] > rank[current] ? next : current;
}

/**
 * Whether a contact may receive a business-initiated message.
 *
 * Only explicit WhatsApp opt-in qualifies. A privacy-policy checkbox does not:
 * Meta's policy requires the person to have been told they will receive
 * WhatsApp messages from this business, and Israeli Amendment 40 requires
 * explicit consent for commercial messages.
 *
 * This does not govern replies to someone who messaged us first — that is
 * always permitted and is checked separately against the messaging window.
 */
export function canReceiveProactiveMessage(contact: Contact): boolean {
  return !contact.doNotContact && contact.consentStatus === 'whatsapp_opt_in';
}

/** Drops keys whose value is `undefined`, so absent fields are left untouched. */
function definedOnly<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
