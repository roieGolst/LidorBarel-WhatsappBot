import { z } from 'zod';

/**
 * Parsing of Meta's **Page** `leadgen` webhook into flat events.
 *
 * This is a different product surface from the WhatsApp webhook in
 * `../whatsapp/payload.ts`, even though both arrive at the same callback URL and
 * are signed with the same app secret. They are told apart by the envelope's
 * `object` field: `page` here, `whatsapp_business_account` there.
 *
 * The webhook itself carries only identifiers — never the submitted answers. The
 * answers must be fetched from the Graph API with the `leadgen_id`
 * (see `./graphLeads.ts`). That split is Meta's design, not ours.
 *
 * Reference: Meta Lead Ads webhook payload documentation.
 */

/**
 * The identifiers Meta sends for one form submission.
 *
 * Only `leadgen_id` is required: it is the retrieval key and the idempotency key,
 * and a payload without it is unusable. Everything else is attribution metadata
 * that Meta may omit, and losing a lead because an `ad_id` was absent would be a
 * far worse outcome than storing an incomplete referral.
 */
const leadgenValueSchema = z
  .object({
    leadgen_id: z.string().min(1),
    form_id: z.string().optional(),
    page_id: z.string().optional(),
    ad_id: z.string().optional(),
    adgroup_id: z.string().optional(),
    /** Unix seconds. */
    created_time: z.number().optional(),
  })
  .passthrough();

/**
 * The Page webhook envelope.
 *
 * `value` is deliberately left as `unknown` and validated per change instead of
 * inline. A Page may be subscribed to several fields at once (`feed`, `messages`,
 * `leadgen`), and a strict shape here would reject the whole batch — including a
 * real lead — because an unrelated change had a different body.
 */
export const leadgenEnvelopeSchema = z
  .object({
    object: z.string(),
    entry: z
      .array(
        z
          .object({
            id: z.string().optional(),
            time: z.number().optional(),
            changes: z
              .array(
                z
                  .object({
                    field: z.string().optional(),
                    value: z.unknown(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type LeadgenEnvelope = z.infer<typeof leadgenEnvelopeSchema>;

/** One lead-form submission, flattened out of the envelope. */
export interface LeadgenEvent {
  /**
   * Meta's lead id. Both the Graph retrieval key and the idempotency key — it
   * carries a unique index on `campaign_referrals.external_lead_id`, so a
   * redelivered webhook cannot create a second lead.
   */
  leadgenId: string;
  formId?: string;
  pageId?: string;
  adId?: string;
  adgroupId?: string;
  createdTime?: Date;
}

/**
 * Whether a webhook body is a Page webhook rather than a WhatsApp one.
 *
 * Called before parsing so the router can dispatch to the right handler. Kept
 * deliberately loose — a body that is not an object at all is simply not a Page
 * webhook, and saying so is the caller's cue to try the WhatsApp path.
 */
export function isPageWebhook(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { object?: unknown }).object === 'page'
  );
}

/**
 * Flattens a Page webhook into lead events.
 *
 * Never throws. Meta retries any non-2xx response, so one malformed change must
 * not cause an entire batch — possibly containing valid, paid-for leads — to be
 * redelivered forever. Anything unparseable is skipped and the rest returned.
 */
export function extractLeadgenEvents(envelope: LeadgenEnvelope): LeadgenEvent[] {
  const events: LeadgenEvent[] = [];

  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen') continue;

      const parsed = leadgenValueSchema.safeParse(change.value);
      if (!parsed.success) continue;

      const value = parsed.data;
      events.push({
        leadgenId: value.leadgen_id,
        ...(value.form_id ? { formId: value.form_id } : {}),
        ...(value.page_id ? { pageId: value.page_id } : {}),
        ...(value.ad_id ? { adId: value.ad_id } : {}),
        ...(value.adgroup_id ? { adgroupId: value.adgroup_id } : {}),
        ...(value.created_time !== undefined
          ? { createdTime: new Date(value.created_time * 1000) }
          : {}),
      });
    }
  }

  return events;
}
