import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { findContactById } from '../db/repositories/contacts.js';
import {
  isWithinServiceWindow,
  TERMINAL_STAGES,
  type Conversation,
} from '../db/repositories/conversations.js';
import { conversations, events, messages } from '../db/schema.js';
import { getLogger } from '../logger.js';
import type { OutboundTemplate, WhatsAppChannel } from '../whatsapp/channel.js';
import { guardedSend } from '../whatsapp/guardedSend.js';
import { followUpMessage } from './followUpMessages.js';
import {
  decideFollowUp,
  scheduleNextFollowUp,
  type FollowUpLimits,
  type FollowUpStop,
} from './followUpPolicy.js';

/**
 * Sending the follow-ups that nudge a lead who has gone quiet.
 *
 * This is the only subsystem that messages someone *repeatedly* without them
 * ever replying, which makes stopping — reliably, on every condition — more
 * important than sending. Every path out of here either sends exactly one
 * message or clears the schedule; nothing leaves a conversation due forever, and
 * nothing sends twice.
 */

export type FollowUpOutcome =
  | { sent: true; providerMessageId: string; followUpNumber: number }
  | { sent: false; reason: FollowUpStop | FollowUpSkip };

export type FollowUpSkip =
  /** Not due, or another sweep took it. */
  | 'not_due'
  | 'contact_missing'
  /** Outside the messaging window with no approved follow-up template to use. */
  | 'no_template_available';

export interface FollowUpDeps {
  db: Database;
  channel: WhatsAppChannel;
  limits: FollowUpLimits;
  /** IANA timezone for business hours. */
  timeZone: string;
  /**
   * Template for nudging outside the 24-hour window. Absent means out-of-window
   * follow-ups cannot be sent at all — see {@link sendFollowUp}.
   */
  template?: OutboundTemplate | undefined;
}

/**
 * Stages that end the follow-up sequence.
 *
 * The terminal stages, plus two that are *not* terminal but still mean the
 * nudging is over: requirement §2.6 stops follow-ups when "the client completes
 * the qualification process", and a qualified lead whose details are already
 * with Lidor must not then be asked whether they would like to get started. A
 * confirmed appointment is the same situation.
 *
 * `appointment_proposed` and `appointment_pending` deliberately stay eligible —
 * a lead who was offered slots and went quiet is exactly who a nudge is for.
 */
const NO_FOLLOW_UP_STAGES: readonly string[] = [
  ...TERMINAL_STAGES,
  'qualified',
  'appointment_confirmed',
];

/** Whether a nudge still makes sense from this stage. */
export function followUpAllowedFrom(stage: Conversation['stage']): boolean {
  return !NO_FOLLOW_UP_STAGES.includes(stage);
}

/**
 * Sends one follow-up, or stops the sequence.
 *
 * ## Claiming
 *
 * The schedule *is* the lock. A single conditional UPDATE clears
 * `next_followup_at` for a row that was due, and only the caller whose update
 * returned a row proceeds. A second sweeper, or an overlapping pass, finds
 * nothing due. On a send failure the schedule is restored so the nudge is
 * retried rather than lost.
 *
 * ## Stopping
 *
 * Clearing the schedule up front means every stop condition is honoured by
 * default: if anything below decides not to send, the conversation simply has no
 * pending follow-up and will not be looked at again. Reaching a cap also closes
 * the conversation, so it leaves the working set entirely.
 *
 * Consent and opt-out are *not* checked here. They are enforced at the send
 * choke point, where they cannot be bypassed — a follow-up to someone who opted
 * out throws rather than slipping through a second implementation of the rule.
 */
export async function sendFollowUp(
  deps: FollowUpDeps,
  conversationId: string,
  now: Date = new Date(),
): Promise<FollowUpOutcome> {
  const logger = getLogger();

  const [claimed] = await deps.db
    .update(conversations)
    .set({ nextFollowupAt: null, updatedAt: now })
    .where(
      and(
        eq(conversations.id, conversationId),
        isNotNull(conversations.nextFollowupAt),
        lte(conversations.nextFollowupAt, now),
      ),
    )
    .returning();

  if (!claimed) return { sent: false, reason: 'not_due' };

  // The silence starts at their last message, or at our opening if they have
  // never spoken. The five-day cap runs from there.
  const silenceSince =
    claimed.lastInboundAt ?? (await firstOutboundAt(deps.db, conversationId));
  const state = {
    followupCount: claimed.followupCount,
    silenceSince,
    stageAllowsFollowUp: followUpAllowedFrom(claimed.stage),
    lastInboundAt: claimed.lastInboundAt,
    lastOutboundAt: claimed.lastOutboundAt,
  };

  const decision = decideFollowUp(state, deps.limits, now);
  if (!decision.follow) {
    await closeIfExhausted(deps.db, conversationId, claimed.stage, decision.stop, now);
    logger.info({ conversationId, stop: decision.stop }, 'follow-up sequence stopped');
    return { sent: false, reason: decision.stop };
  }

  const contact = await findContactById(deps.db, claimed.contactId);
  if (!contact) return { sent: false, reason: 'contact_missing' };

  const followUpNumber = claimed.followupCount + 1;
  const windowOpen = isWithinServiceWindow(claimed, now);

  // Outside the window only an approved template may be sent. A lead who never
  // answered the opening template has no window at all, so without a follow-up
  // template approved for that purpose there is nothing legitimate to send —
  // the sequence pauses rather than sending something Meta would reject.
  if (!windowOpen && !deps.template) {
    logger.warn(
      { conversationId, followUpNumber },
      'follow-up skipped: outside the messaging window and no follow-up template configured',
    );
    return { sent: false, reason: 'no_template_available' };
  }

  const body = followUpMessage(followUpNumber);

  let providerMessageId: string;
  try {
    const result = await guardedSend(
      deps.db,
      windowOpen
        ? { kind: 'reply', to: contact.phone, conversation: claimed }
        : { kind: 'proactive', to: contact.phone, contact, isTemplate: true },
      () =>
        windowOpen
          ? deps.channel.sendText(contact.phone, body)
          : deps.channel.sendTemplate(contact.phone, deps.template!),
    );
    providerMessageId = result.providerMessageId;
  } catch (error) {
    // Restore the schedule so a transient failure retries. A refusal (opt-out,
    // consent) will simply be refused again and then hit a cap, which is the
    // correct end for it.
    await deps.db
      .update(conversations)
      .set({ nextFollowupAt: now, updatedAt: now })
      .where(eq(conversations.id, conversationId));
    throw error;
  }

  const next = scheduleNextFollowUp(
    { ...state, followupCount: followUpNumber },
    deps.limits,
    deps.timeZone,
    now,
  );

  await deps.db.transaction(async (tx) => {
    await tx.insert(messages).values({
      conversationId,
      direction: 'outbound',
      body,
      providerMessageId,
      deliveryStatus: 'pending',
      ...(windowOpen ? {} : { templateRef: deps.template?.name ?? null }),
    });

    await tx
      .update(conversations)
      .set({
        followupCount: followUpNumber,
        nextFollowupAt: next,
        lastOutboundAt: now,
        updatedAt: now,
      })
      .where(eq(conversations.id, conversationId));

    await tx.insert(events).values({
      aggregateType: 'conversation',
      aggregateId: conversationId,
      eventType: 'follow_up_sent',
      fromStage: claimed.stage,
      toStage: claimed.stage,
      actor: 'system',
      metadata: { followUpNumber, viaTemplate: !windowOpen },
    });
  });

  logger.info(
    { conversationId, followUpNumber, viaTemplate: !windowOpen },
    'follow-up sent',
  );
  return { sent: true, providerMessageId, followUpNumber };
}

/**
 * Closes a conversation whose follow-up sequence ran out.
 *
 * Only the caps close it. A reply or an already-terminal stage means the
 * conversation is someone else's business — clearing the schedule was enough.
 */
async function closeIfExhausted(
  db: Database,
  conversationId: string,
  fromStage: Conversation['stage'],
  stop: FollowUpStop,
  now: Date,
): Promise<void> {
  if (stop !== 'max_followups_reached' && stop !== 'max_age_reached') return;

  await db
    .update(conversations)
    .set({ stage: 'closed_no_response', updatedAt: now })
    .where(eq(conversations.id, conversationId));

  await db.insert(events).values({
    aggregateType: 'conversation',
    aggregateId: conversationId,
    eventType: 'stage_transition',
    fromStage,
    toStage: 'closed_no_response',
    actor: 'system',
    metadata: { action: 'follow_ups_exhausted', stop },
  });
}

/** When the bot first spoke — the point the five-day cap is measured from. */
async function firstOutboundAt(
  db: Database,
  conversationId: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ at: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'outbound'),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/** Conversations with a follow-up due now, oldest schedule first. */
export async function findConversationsDueForFollowUp(
  db: Database,
  limit: number,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        isNotNull(conversations.nextFollowupAt),
        lte(conversations.nextFollowupAt, now),
      ),
    )
    .orderBy(sql`${conversations.nextFollowupAt} asc`)
    .limit(limit);

  return rows.map((row) => row.id);
}
