import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { findContactById } from '../db/repositories/contacts.js';
import {
  isWithinServiceWindow,
  TERMINAL_STAGES,
  type Conversation,
} from '../db/repositories/conversations.js';
import { contacts, conversations, events, messages } from '../db/schema.js';
import { getLogger } from '../logger.js';
import type { OutboundTemplate, WhatsAppChannel } from '../whatsapp/channel.js';
import {
  guardedSend,
  isPermanentSendFailure,
  OptedOutError,
} from '../whatsapp/guardedSend.js';
import { enqueueOutboxEvent } from '../outbox/outbox.js';
import {
  findSlotsToOffer,
  OFFER_HOLD_MS,
  recordOffer,
  type BookingDeps,
} from '../appointments/booking.js';
import { SLOT_OFFER_BUTTON, slotListRows } from '../appointments/slotMessages.js';
import { APPOINTMENT_NUDGE_BODY, followUpMessage } from './followUpMessages.js';
import { offerStrategyFor, type KnownFacts } from '../workflow/decide.js';
import {
  decideFollowUp,
  scheduleNextFollowUp,
  type FollowUpLimits,
  type FollowUpStop,
} from './followUpPolicy.js';

/** How long to wait before retrying a nudge that failed for a transient reason. */
const TRANSIENT_RETRY_MS = 15 * 60 * 1000;

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
  | 'no_template_available'
  /** The send can never succeed as things stand; the sequence was stopped, not retried. */
  | 'send_refused';

export interface FollowUpDeps {
  db: Database;
  channel: WhatsAppChannel;
  limits: FollowUpLimits;
  /** IANA timezone for business hours. */
  timeZone: string;
  /**
   * Templates for nudging outside the 24-hour window, by situation. A missing
   * one means that situation cannot be nudged — see {@link sendFollowUp}.
   */
  templates?: FollowUpTemplates | undefined;
  /**
   * Booking, when it is wired up. Lets the nudge to a lead who was offered
   * times re-offer them (fresh) instead of asking whether they want to start.
   * Absent, that lead gets the ordinary ladder.
   */
  appointments?: BookingDeps | undefined;
}

/**
 * The two situations a follow-up template has to cover, which need different
 * words.
 *
 * Someone who never answered has to be re-introduced to why we are writing at
 * all. Someone who answered three questions and stopped has not forgotten —
 * thanking them for leaving details would read as though we had. A template's
 * wording is fixed at approval time, so the distinction cannot be papered over
 * with a variable; it needs two approvals.
 */
export interface FollowUpTemplates {
  /** Never replied to the opening. */
  noReply?: OutboundTemplate | undefined;
  /** Started answering, then went quiet before finishing. */
  incomplete?: OutboundTemplate | undefined;
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

  // Outside the window only an approved template may be sent, and which one
  // depends on how far the person got: `lastInboundAt` is the whole test, since
  // anyone who has ever answered is mid-conversation rather than cold.
  const startedButUnfinished = claimed.lastInboundAt !== null;
  const template = startedButUnfinished
    ? deps.templates?.incomplete
    : deps.templates?.noReply;

  // Without the right template there is nothing legitimate to send, so the
  // sequence pauses rather than sending something Meta would reject — or, worse,
  // the wrong words to someone who already told us about their property.
  if (!windowOpen && !template) {
    logger.warn(
      { conversationId, followUpNumber, startedButUnfinished },
      'follow-up skipped: outside the messaging window and no template configured for this case',
    );
    return { sent: false, reason: 'no_template_available' };
  }

  // A lead who was offered times and went quiet is one tap away from a
  // booking, so inside the window the nudge is the offer again — a fresh list,
  // since the calendar may have moved, recorded so a tap on it books through
  // the ordinary slot-selection path. Only free-form can carry a list; outside
  // the window the template goes as for anyone else. An empty calendar falls
  // back to the ladder rather than promising times that do not exist.
  const reoffer =
    windowOpen && claimed.stage === 'appointment_proposed' && deps.appointments
      ? await findSlotsToOffer(
          deps.appointments,
          undefined,
          now,
          offerStrategyFor(claimed.extracted as KnownFacts),
        )
      : [];
  if (reoffer.length > 0) {
    await recordOffer(deps.appointments!, conversationId, reoffer, OFFER_HOLD_MS, now);
  }

  const body =
    reoffer.length > 0 ? APPOINTMENT_NUDGE_BODY : followUpMessage(followUpNumber);

  let providerMessageId: string;
  try {
    const result = await guardedSend(
      deps.db,
      windowOpen
        ? { kind: 'reply', to: contact.phone, conversation: claimed }
        : { kind: 'proactive', to: contact.phone, contact, isTemplate: true },
      () => {
        if (!windowOpen) return deps.channel.sendTemplate(contact.phone, template!);
        if (reoffer.length > 0) {
          return deps.channel.sendList(
            contact.phone,
            body,
            SLOT_OFFER_BUTTON,
            slotListRows(reoffer, deps.appointments!.slotOptions.timeZone),
          );
        }
        return deps.channel.sendText(contact.phone, body);
      },
    );
    providerMessageId = result.providerMessageId;
  } catch (error) {
    if (isPermanentSendFailure(error)) {
      // Fails identically on every sweep. The claim already cleared the schedule
      // and it stays cleared — the sequence is over. (An earlier version restored
      // the schedule here on the theory that a refusal would "hit a cap"; the cap
      // only counts successful sends, so it retried an opt-out every sweep, for
      // ever.) An opt-out also settles the stage, and the board is told.
      if (error instanceof OptedOutError) {
        await deps.db.transaction(async (tx) => {
          await tx
            .update(conversations)
            .set({ stage: 'opted_out', updatedAt: now })
            .where(eq(conversations.id, conversationId));
          await enqueueOutboxEvent(tx, conversationId);
        });
      }
      logger.warn(
        {
          conversationId,
          followUpNumber,
          reason: error instanceof Error ? error.name : 'unknown',
        },
        'follow-up refused permanently — sequence stopped',
      );
      return { sent: false, reason: 'send_refused' };
    }
    // Transient — retry after a pause rather than on the very next sweep, so an
    // outage is not hammered once a minute.
    await deps.db
      .update(conversations)
      .set({
        nextFollowupAt: new Date(now.getTime() + TRANSIENT_RETRY_MS),
        updatedAt: now,
      })
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
      ...(windowOpen ? {} : { templateRef: template?.name ?? null }),
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

    // The board shows אינטרקציה אחרונה; a nudge moves it.
    await enqueueOutboxEvent(tx, conversationId);

    await tx.insert(events).values({
      aggregateType: 'conversation',
      aggregateId: conversationId,
      eventType: 'follow_up_sent',
      fromStage: claimed.stage,
      toStage: claimed.stage,
      actor: 'system',
      metadata: {
        followUpNumber,
        viaTemplate: !windowOpen,
        offeredSlots: reoffer.length,
      },
    });
  });

  logger.info(
    {
      conversationId,
      followUpNumber,
      viaTemplate: !windowOpen,
      offeredSlots: reoffer.length,
    },
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

  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({ stage: 'closed_no_response', updatedAt: now })
      .where(eq(conversations.id, conversationId));

    await tx.insert(events).values({
      aggregateType: 'conversation',
      aggregateId: conversationId,
      eventType: 'stage_transition',
      fromStage,
      toStage: 'closed_no_response',
      actor: 'system',
      metadata: { action: 'follow_ups_exhausted', stop },
    });

    // Without this the lead reads as still-active on the board indefinitely —
    // ליד ללא מענה exists on Lidor's status column precisely for this moment.
    await enqueueOutboxEvent(tx, conversationId);
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
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(
      and(
        isNotNull(conversations.nextFollowupAt),
        lte(conversations.nextFollowupAt, now),
        // An opted-out person is never even considered (NN-1). Consent is not
        // filtered here: an in-window nudge to someone who messaged first needs
        // none, and an out-of-window one is refused at the choke point.
        eq(contacts.doNotContact, false),
      ),
    )
    .orderBy(sql`${conversations.nextFollowupAt} asc`)
    .limit(limit);

  return rows.map((row) => row.id);
}
