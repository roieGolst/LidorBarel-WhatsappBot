import { eq } from 'drizzle-orm';
import type { DbClient } from '../db/client.js';
import type { ConsentStatus } from '../db/repositories/contacts.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import { findOrCreateConversation } from '../db/repositories/conversations.js';
import { campaignReferrals, conversations } from '../db/schema.js';
import { tryNormalizePhone } from '../domain/phone.js';
import { getLogger } from '../logger.js';
import { decideConsent, mapLeadFields, type ConsentFieldConfig } from './fieldMapping.js';
import type { GraphLeadsClient } from './graphLeads.js';
import type { LeadgenEvent } from './leadgenPayload.js';

/**
 * Turning a `leadgen` webhook into durable state, exactly once.
 *
 * Like WhatsApp ingestion (`../whatsapp/ingest.ts`), this deliberately stops at
 * persistence. **Nothing is sent here.** Deciding whether this lead may be
 * contacted, and with what, belongs to the proactive send path — which is gated
 * on the consent status this module records.
 */

export interface LeadIngestResult {
  leadgenId: string;
  contactId?: string;
  conversationId?: string;
  /** True when this lead had already been ingested. */
  duplicate: boolean;
  /** Consent recorded for the contact, when one was created or updated. */
  consentStatus?: ConsentStatus;
  /** Set when the lead was deliberately not stored, with the reason. */
  skipped?: string;
}

/** What {@link ingestLead} needs, injected so it is testable without live Meta. */
export interface LeadIngestDeps {
  leads: GraphLeadsClient;
  consentField: ConsentFieldConfig;
}

/**
 * Retrieves one lead's answers and persists them.
 *
 * Retrieval happens on the webhook request path rather than on a queue. That is a
 * deliberate trade: it costs one Graph round trip before Meta gets its ACK, and
 * in exchange a failure returns non-2xx and Meta redelivers the lead. The
 * alternative — ACK first, retrieve later — would silently lose a paid lead
 * whenever the process died between the two. The call is bounded by a timeout,
 * and redelivery is safe because `external_lead_id` is unique.
 *
 * The contact, conversation, and referral commit as one transaction. A partial
 * write would produce a contact with no referral (unattributable) or a referral
 * with no conversation (nothing to contact them through).
 */
export async function ingestLead(
  db: DbClient,
  event: LeadgenEvent,
  deps: LeadIngestDeps,
): Promise<LeadIngestResult> {
  const logger = getLogger();
  const lead = await deps.leads.fetchLead(event.leadgenId);

  const fields = mapLeadFields(lead.fieldData);
  const consent = decideConsent(fields.answers, deps.consentField);

  if (consent.missingConsentField) {
    // The form was expected to carry a consent field and did not. The lead is
    // still captured — it simply cannot be messaged proactively. Worth an alert:
    // it usually means the form was edited.
    logger.warn(
      { leadgenId: event.leadgenId, formId: event.formId },
      'lead form is missing its configured WhatsApp consent field',
    );
  }

  // Meta validates phone format only loosely, and a lead we cannot dial is a lead
  // we can never contact. Recording it against a contact is impossible anyway:
  // the phone is the contact's identity. Skipped rather than failed, because
  // redelivery would produce exactly the same unusable number.
  const phone = fields.phone ? tryNormalizePhone(fields.phone) : undefined;
  if (!phone) {
    logger.warn(
      { leadgenId: event.leadgenId, hasPhoneField: Boolean(fields.phone) },
      'lead skipped: no usable phone number',
    );
    return { leadgenId: event.leadgenId, duplicate: false, skipped: 'unusable_phone' };
  }

  return db.transaction(async (tx) => {
    const contact = await upsertContactByPhone(tx, {
      phone,
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.email ? { email: fields.email } : {}),
      entryPoint: 'meta_lead_form',
      consentStatus: consent.status,
      // Provenance for the audit trail: which form, what exact wording was
      // agreed to, and when. Required to demonstrate consent under Amendment 40.
      consentSource: event.formId ?? lead.formId ?? null,
      consentText: consent.evidence ?? null,
      consentRecordedAt: lead.createdTime ?? event.createdTime ?? new Date(),
    });

    const { conversation, created } = await findOrCreateConversation(tx, contact.id);

    // A brand-new conversation from a form submission starts in
    // `awaiting_first_contact`: the lead exists and the bot has not spoken yet.
    // An existing conversation is left exactly as it is — this person may already
    // be mid-chat, and a form resubmission must not rewind them.
    if (created) {
      await tx
        .update(conversations)
        .set({ stage: 'awaiting_first_contact', updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));
    }

    // The unique index on `external_lead_id` is what makes redelivery safe. An
    // insert that conflicts returns no row, which is how a duplicate is detected
    // — a read-then-write would race against a concurrent redelivery.
    const inserted = await tx
      .insert(campaignReferrals)
      .values({
        contactId: contact.id,
        externalLeadId: event.leadgenId,
        formId: event.formId ?? lead.formId ?? null,
        adId: event.adId ?? lead.adId ?? null,
        // Every answer exactly as Meta delivered it. The form's custom question
        // keys differ per form, so they are preserved verbatim rather than
        // guessed at; the qualification flow reads them once they are confirmed.
        rawPayload: lead.raw,
      })
      .onConflictDoNothing({ target: campaignReferrals.externalLeadId })
      .returning({ id: campaignReferrals.id });

    const duplicate = inserted.length === 0;

    return {
      leadgenId: event.leadgenId,
      contactId: contact.id,
      conversationId: conversation.id,
      duplicate,
      consentStatus: contact.consentStatus,
    };
  });
}

/**
 * Ingests every lead in a webhook batch.
 *
 * Each is handled independently so one failure cannot strand the others. A
 * retryable failure is rethrown after the rest are processed, so the webhook
 * returns non-2xx and Meta redelivers the batch — the leads already stored are
 * then recognised as duplicates.
 */
export async function ingestLeads(
  db: DbClient,
  events: LeadgenEvent[],
  deps: LeadIngestDeps,
): Promise<{ results: LeadIngestResult[]; retryableError?: Error }> {
  const results: LeadIngestResult[] = [];
  let retryableError: Error | undefined;

  for (const event of events) {
    try {
      results.push(await ingestLead(db, event, deps));
    } catch (err) {
      const retryable =
        err instanceof Error && 'retryable' in err
          ? (err as { retryable: boolean }).retryable
          : true;

      getLogger().error(
        { err, leadgenId: event.leadgenId, retryable },
        'failed to ingest lead',
      );

      if (retryable) {
        retryableError ??= err instanceof Error ? err : new Error(String(err));
      } else {
        results.push({
          leadgenId: event.leadgenId,
          duplicate: false,
          skipped: 'permanent_failure',
        });
      }
    }
  }

  return { results, ...(retryableError ? { retryableError } : {}) };
}
