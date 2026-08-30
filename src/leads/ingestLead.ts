import { eq } from 'drizzle-orm';
import type { DbClient } from '../db/client.js';
import type { ConsentStatus } from '../db/repositories/contacts.js';
import { upsertContactByPhone } from '../db/repositories/contacts.js';
import { findOrCreateConversation } from '../db/repositories/conversations.js';
import { campaignReferrals, conversations } from '../db/schema.js';
import { tryNormalizePhone } from '../domain/phone.js';
import { getLogger } from '../logger.js';
import { enqueueOutboxEvent } from '../outbox/outbox.js';
import {
  decideConsent,
  mapLeadFields,
  mapScreeningAnswers,
  type ConsentConfig,
} from './fieldMapping.js';
import type { GraphLeadsClient } from './graphLeads.js';
import type { LeadgenEvent } from './leadgenPayload.js';

/**
 * Turning a `leadgen` webhook into durable state, exactly once.
 *
 * Like WhatsApp ingestion (`../whatsapp/ingest.ts`), this deliberately stops at
 * persistence. **Nothing is sent here.** Whether this lead may be contacted, and
 * with what, belongs to the proactive send path — gated on the consent status
 * this module records.
 */

export interface LeadIngestResult {
  leadgenId: string;
  contactId?: string;
  conversationId?: string;
  /** True when this lead had already been ingested. */
  duplicate: boolean;
  /** Consent recorded for the contact. */
  consentStatus?: ConsentStatus;
  /**
   * Whether a conversation was opened for outreach. False for a lead from a form
   * outside the seller campaign — it is recorded for attribution, not engaged.
   */
  engaged: boolean;
  /** Set when the lead was deliberately not stored, with the reason. */
  skipped?: string;
}

/** What {@link ingestLead} needs, injected so it is testable without live Meta. */
export interface LeadIngestDeps {
  leads: GraphLeadsClient;
  /** Consent recognition. `formId` is filled per lead. */
  consent: Omit<ConsentConfig, 'formId'>;
  /**
   * Forms whose leads enter the seller qualification flow.
   *
   * The Page runs several campaigns — investor and recruitment forms alongside
   * the seller ones. Their leads are real and worth recording for attribution,
   * but dropping an investor into a flow that asks which neighbourhood their
   * property is in would be nonsense. Empty means engage nothing.
   */
  sellerForms: readonly string[];
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
 * The contact, conversation, and referral commit as one transaction.
 */
export async function ingestLead(
  db: DbClient,
  event: LeadgenEvent,
  deps: LeadIngestDeps,
): Promise<LeadIngestResult> {
  const logger = getLogger();
  const lead = await deps.leads.fetchLead(event.leadgenId);

  const formId = event.formId ?? lead.formId;
  const fields = mapLeadFields(lead.fieldData);
  const consent = decideConsent(fields.answers, {
    ...deps.consent,
    ...(formId ? { formId } : {}),
  });

  // Meta validates phone format only loosely, and a lead we cannot dial can never
  // be contacted. Recording it is impossible anyway: the phone is the contact's
  // identity. Skipped rather than failed, because redelivery would produce the
  // same unusable number.
  const phone = fields.phone ? tryNormalizePhone(fields.phone) : undefined;
  if (!phone) {
    logger.warn(
      { leadgenId: event.leadgenId, formId, hasPhoneField: Boolean(fields.phone) },
      'lead skipped: no usable phone number',
    );
    return {
      leadgenId: event.leadgenId,
      duplicate: false,
      engaged: false,
      skipped: 'unusable_phone',
    };
  }

  const isSellerForm = formId !== undefined && deps.sellerForms.includes(formId);
  if (!isSellerForm) {
    logger.info(
      { leadgenId: event.leadgenId, formId },
      'lead recorded without engagement: form is not in the seller campaign',
    );
  }

  return db.transaction(async (tx) => {
    const contact = await upsertContactByPhone(tx, {
      phone,
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.email ? { email: fields.email } : {}),
      entryPoint: 'meta_lead_form',
      consentStatus: consent.status,
      // Provenance for the audit trail: which form, the exact wording agreed to,
      // and when. Required to demonstrate consent under Amendment 40.
      consentSource: formId ?? null,
      consentText: consent.evidence ?? null,
      consentRecordedAt: lead.createdTime ?? event.createdTime ?? new Date(),
    });

    let conversationId: string | undefined;
    if (isSellerForm) {
      const { conversation, created } = await findOrCreateConversation(tx, contact.id);
      conversationId = conversation.id;

      // A brand-new conversation from a form submission starts in
      // `awaiting_first_contact`: the lead exists and the bot has not spoken yet.
      // The form's own answers to Q1 and Q3 are seeded here — a form lead is
      // screened on Q2 and Q4 only, so without them those answers would be
      // neither asked nor known.
      //
      // An existing conversation is left untouched. This person may already be
      // mid-chat, and a resubmission must not rewind their stage or overwrite
      // answers they have since given the bot directly.
      if (created) {
        await tx
          .update(conversations)
          .set({
            stage: 'awaiting_first_contact',
            extracted: mapScreeningAnswers(fields.answers),
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conversation.id));
      }
    }

    // The unique index on `external_lead_id` is what makes redelivery safe. An
    // insert that conflicts returns no row, which is how a duplicate is detected
    // — a read-then-write would race a concurrent redelivery.
    const inserted = await tx
      .insert(campaignReferrals)
      .values({
        contactId: contact.id,
        externalLeadId: event.leadgenId,
        formId: formId ?? null,
        adId: event.adId ?? lead.adId ?? null,
        // Every answer exactly as Meta delivered it, so a form whose keys are not
        // yet mapped still has its answers captured.
        rawPayload: lead.raw,
      })
      .onConflictDoNothing({ target: campaignReferrals.externalLeadId })
      .returning({ id: campaignReferrals.id });

    // A paid lead should reach Lidor's board straight away, not only once the
    // person replies. Queued in this transaction, so a lead cannot exist without
    // its projection being queued. Only for a lead we actually engage — an
    // investor-form lead is recorded for attribution and does not belong on the
    // seller board.
    if (inserted.length > 0 && conversationId) {
      await enqueueOutboxEvent(tx, conversationId);
    }

    return {
      leadgenId: event.leadgenId,
      contactId: contact.id,
      ...(conversationId ? { conversationId } : {}),
      duplicate: inserted.length === 0,
      consentStatus: contact.consentStatus,
      engaged: isSellerForm,
    };
  });
}

/**
 * Ingests every lead in a webhook batch.
 *
 * Each is handled independently so one failure cannot strand the others. A
 * retryable failure is reported after the rest are processed, so the webhook
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
          engaged: false,
          skipped: 'permanent_failure',
        });
      }
    }
  }

  return { results, ...(retryableError ? { retryableError } : {}) };
}
