import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { findContactById } from '../db/repositories/contacts.js';
import { conversations, events, messages } from '../db/schema.js';
import { getLogger } from '../logger.js';
import { enqueueOutboxEvent } from '../outbox/outbox.js';
import { WELCOME_MESSAGE } from '../workflow/interactive.js';
import type { OutboundTemplate, WhatsAppChannel } from '../whatsapp/channel.js';
import { guardedSend } from '../whatsapp/guardedSend.js';
import { scheduleNextFollowUp, type FollowUpLimits } from './followUpPolicy.js';

/**
 * Business-initiated first contact: the proactive reach-out to a lead who filled
 * in the form and has not messaged us.
 *
 * This is the product's primary purpose, and the only path that messages someone
 * who has not messaged first. Everything it does is therefore arranged around two
 * questions — *may we send this?* and *could this send twice?*
 *
 * Consent is not decided here. It is enforced at the single choke point
 * (`guardedSend`), which refuses anything short of `whatsapp_opt_in` (NN-2).
 */

/** What a first-contact attempt did, and why. */
export type FirstContactOutcome =
  { sent: true; providerMessageId: string } | { sent: false; reason: FirstContactSkip };

export type FirstContactSkip =
  /** Already contacted, already talking, or finished. Not ours to act on. */
  | 'not_awaiting'
  /** Another worker claimed it first. */
  | 'claimed_elsewhere'
  /** The lead messaged us before the grace period elapsed — they own the opening. */
  | 'lead_already_messaged'
  /** The contact record vanished (deleted between claim and send). */
  | 'contact_missing';

export interface FirstContactDeps {
  db: Database;
  channel: WhatsAppChannel;
  /** The approved template to open with. */
  template: OutboundTemplate;
  /**
   * When to nudge if the lead never answers. Absent means no follow-up is
   * scheduled — the opening is sent and the sequence ends there.
   */
  followUp?: { limits: FollowUpLimits; timeZone: string } | undefined;
}

/**
 * Sends the opening template to one lead, at most once.
 *
 * ## Why the stage is claimed before sending
 *
 * The unit of idempotency is a compare-and-swap on `stage`: the row moves from
 * `awaiting_first_contact` to `awaiting_reply` in a single conditional UPDATE,
 * and only the caller whose update returned a row proceeds to send. A second
 * worker — or a second sweep, or a redelivered job — finds nothing to claim and
 * stops. A read-then-write would race and message the person twice, which for a
 * business-initiated message is both a bad experience and an Amendment 40
 * problem.
 *
 * If the send then fails, the claim is released so the lead is retried rather
 * than silently abandoned. The remaining exposure is a hard crash between the
 * send returning and the message being recorded, which would leave a contacted
 * lead marked `awaiting_reply` with no outbound row — visible, and recoverable,
 * rather than a duplicate message.
 *
 * A template send does **not** open a messaging window, so `windowExpiresAt` is
 * deliberately untouched. Only the lead's reply opens one; until then the bot may
 * send templates and nothing else.
 */
export async function sendFirstContact(
  deps: FirstContactDeps,
  conversationId: string,
): Promise<FirstContactOutcome> {
  const logger = getLogger();

  // Claim: only one caller can move the row out of `awaiting_first_contact`.
  const [claimed] = await deps.db
    .update(conversations)
    .set({ stage: 'awaiting_reply', updatedAt: new Date() })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.stage, 'awaiting_first_contact'),
        // A lead who messaged first is handled by the inbound flow, which opens
        // with the same sequence. Reaching out on top of that would talk over them.
        isNull(conversations.lastInboundAt),
      ),
    )
    .returning();

  if (!claimed) {
    return { sent: false, reason: 'claimed_elsewhere' };
  }

  const contact = await findContactById(deps.db, claimed.contactId);
  if (!contact) {
    await releaseClaim(deps.db, conversationId);
    return { sent: false, reason: 'contact_missing' };
  }

  let providerMessageId: string;
  try {
    const result = await guardedSend(
      deps.db,
      {
        kind: 'proactive',
        to: contact.phone,
        contact,
        // The window is closed by definition — this person has never messaged us.
        isTemplate: true,
      },
      () => deps.channel.sendTemplate(contact.phone, deps.template),
    );
    providerMessageId = result.providerMessageId;
  } catch (error) {
    // Release the claim so a refused or failed send can be retried once the cause
    // is fixed — a missing consent record, an expired token, a Meta outage.
    await releaseClaim(deps.db, conversationId);
    throw error;
  }

  await deps.db.transaction(async (tx) => {
    await tx.insert(messages).values({
      conversationId,
      direction: 'outbound',
      // The approved template's body is the spec's welcome message — the same
      // text the inbound path opens with. Storing the wording rather than a
      // placeholder keeps the transcript faithful: the model reads this as the
      // bot's last turn when the lead replies, and a placeholder would make it
      // answer as though nothing had been said. `templateRef` records that it
      // went out as a template.
      body: WELCOME_MESSAGE,
      providerMessageId,
      deliveryStatus: 'pending',
      templateRef: deps.template.name,
    });

    // Schedule the first nudge now, while we know the sequence just started.
    // `recordInboundActivity` clears it the moment the lead replies, so the
    // cancellation path needs no cooperation from here.
    const now = new Date();
    const nextFollowupAt = deps.followUp
      ? scheduleNextFollowUp(
          {
            followupCount: 0,
            silenceSince: now,
            stageAllowsFollowUp: true,
            lastInboundAt: null,
            lastOutboundAt: now,
          },
          deps.followUp.limits,
          deps.followUp.timeZone,
          now,
        )
      : null;

    await tx
      .update(conversations)
      .set({ lastOutboundAt: now, nextFollowupAt, updatedAt: now })
      .where(eq(conversations.id, conversationId));

    await tx.insert(events).values({
      aggregateType: 'conversation',
      aggregateId: conversationId,
      eventType: 'stage_transition',
      fromStage: 'awaiting_first_contact',
      toStage: 'awaiting_reply',
      actor: 'system',
      metadata: { action: 'send_first_contact', template: deps.template.name },
    });

    await enqueueOutboxEvent(tx, conversationId);
  });

  // Safe to log: conversation id and template name only, never the phone.
  logger.info(
    { conversationId, template: deps.template.name },
    'first contact template sent',
  );
  return { sent: true, providerMessageId };
}

/** Returns a claimed conversation to the pool after a failed send. */
async function releaseClaim(db: Database, conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ stage: 'awaiting_first_contact', updatedAt: new Date() })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.stage, 'awaiting_reply'),
      ),
    );
}

/**
 * Conversations whose grace period has elapsed and which have not been contacted.
 *
 * The grace period exists so the bot does not talk over someone who is already
 * opening the chat themselves — a lead who taps through to WhatsApp within a
 * minute of submitting should meet the inbound flow, not a template.
 *
 * Ordered oldest first so a backlog drains fairly rather than starving the leads
 * that have waited longest.
 */
export async function findLeadsAwaitingFirstContact(
  db: Database,
  gracePeriodMs: number,
  limit: number,
  now: Date = new Date(),
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - gracePeriodMs);

  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.stage, 'awaiting_first_contact'),
        isNull(conversations.lastInboundAt),
        lte(conversations.createdAt, cutoff),
      ),
    )
    .orderBy(sql`${conversations.createdAt} asc`)
    .limit(limit);

  return rows.map((row) => row.id);
}
