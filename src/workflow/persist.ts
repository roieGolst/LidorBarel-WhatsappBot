import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { ConversationStage } from '../db/repositories/conversations.js';
import { contacts, conversations, events, messages, optOuts } from '../db/schema.js';
import { enqueueOutboxEvent } from '../outbox/outbox.js';
import {
  leadPriorityScore,
  type DisqualificationReason,
  type KnownFacts,
} from './decide.js';

/**
 * `persistTurn` — commits everything a turn changed, in one transaction (§5.2).
 *
 * The rule this enforces: every business-meaningful transition lands in Postgres
 * atomically. Either the stage change, the outbound message(s), and the audit
 * event all commit together, or none do — a reply recorded without its stage
 * change, or a stage change with no message explaining it, are states nothing
 * downstream knows how to read.
 *
 * A turn can send more than one message — the opening sequence is welcome text +
 * intro video + first question — so the outbound is a list. Each row is
 * idempotent by its provider id: if the turn is replayed after a crash (some
 * sends already happened and their ids are checkpointed), those inserts no-op
 * rather than duplicating.
 *
 * It serves both the AI path and the deterministic guard rails (a rate-limit
 * notice, an abuse ban), so it takes plain fields rather than a `Decision`.
 */

/** One outbound message this turn produced. */
export interface OutboundMessageRecord {
  /** Text stored for the row (a placeholder like `[סרטון]` for media). */
  body: string;
  /** The id the channel returned for this message. */
  providerMessageId: string;
  /** Set only for a model-written message; null/absent for canned or media. */
  llmModel?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export interface PersistTurnInput {
  conversationId: string;
  contactId: string;
  /** E.164 — needed to write the durable opt-out / ban record. */
  contactPhone: string;
  fromStage: ConversationStage;
  /** The stage this turn moves the conversation to. */
  toStage: ConversationStage;
  /** The action taken this turn — for the audit event. */
  action: string;
  /** Screening facts known so far plus this turn's extraction. */
  extracted: KnownFacts;
  /** Every message sent this turn, in send order. */
  outbound: OutboundMessageRecord[];
  qualified?: boolean;
  disqualificationReason?: DisqualificationReason;
  /** Ban this contact for abuse (durable opt-out with an abuse reason). */
  ban?: boolean;
  /** Reply-generation audit flags — only meaningful when the model wrote. */
  regenerated?: boolean;
  fellBack?: boolean;
  /**
   * When to nudge if the person does not answer this turn, or `null` to leave no
   * follow-up pending.
   *
   * Computed by the caller, which knows the configured cadence; omitted entirely
   * leaves the existing schedule untouched, so a caller that does not care about
   * follow-ups cannot accidentally cancel one.
   */
  nextFollowupAt?: Date | null;
}

export async function persistTurn(db: Database, input: PersistTurnInput): Promise<void> {
  const at = new Date();
  // Priority orders Lidor's queue; it never gates qualification. Set once the
  // timeline is known.
  const priorityScore = leadPriorityScore(input.extracted);

  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({
        stage: input.toStage,
        extracted: input.extracted,
        lastOutboundAt: at,
        updatedAt: at,
        ...(priorityScore !== undefined ? { priorityScore } : {}),
        ...(input.qualified !== undefined ? { qualified: input.qualified } : {}),
        ...(input.disqualificationReason !== undefined
          ? { disqualificationReason: input.disqualificationReason }
          : {}),
        // Undefined leaves any existing schedule alone; null cancels it. Only a
        // caller that computed a cadence should be moving this.
        ...(input.nextFollowupAt !== undefined
          ? { nextFollowupAt: input.nextFollowupAt }
          : {}),
      })
      .where(eq(conversations.id, input.conversationId));

    // The outbound messages, in order. Each gets a strictly increasing timestamp
    // (a turn can send several — welcome, video, question — in one commit) so the
    // transcript reads back in send order rather than an arbitrary tie-break.
    // onConflictDoNothing makes replay after a crash safe: the same provider id
    // cannot produce a second row, so a resumed turn never double-records a
    // message it already sent.
    for (const [index, message] of input.outbound.entries()) {
      await tx
        .insert(messages)
        .values({
          conversationId: input.conversationId,
          direction: 'outbound',
          body: message.body,
          providerMessageId: message.providerMessageId,
          deliveryStatus: 'sent',
          llmModel: message.llmModel ?? null,
          inputTokens: message.inputTokens ?? 0,
          outputTokens: message.outputTokens ?? 0,
          cacheReadTokens: message.cacheReadTokens ?? 0,
          createdAt: new Date(at.getTime() + index),
        })
        .onConflictDoNothing({ target: messages.providerMessageId });
    }

    // Queued in the same transaction as the state change it describes: the
    // conversation cannot advance without its projection being queued, and the
    // conversation never waits on Monday to do it.
    await enqueueOutboxEvent(tx, input.conversationId);

    await tx.insert(events).values({
      aggregateType: 'conversation',
      aggregateId: input.conversationId,
      eventType: 'stage_transition',
      fromStage: input.fromStage,
      toStage: input.toStage,
      actor: 'system',
      metadata: {
        action: input.action,
        regenerated: input.regenerated ?? false,
        fellBack: input.fellBack ?? false,
        ...(input.qualified !== undefined ? { qualified: input.qualified } : {}),
        ...(input.disqualificationReason !== undefined
          ? { disqualificationReason: input.disqualificationReason }
          : {}),
        ...(input.ban ? { banned: true } : {}),
      },
    });

    // A durable, phone-keyed block, checked before every future send, plus the
    // denormalized `doNotContact` flag for the hot path. Written here so reaching
    // the terminal stage and honoring it commit together. A user opt-out and an
    // abuse ban share the mechanism but record a different reason.
    const block =
      input.toStage === 'opted_out'
        ? { reason: 'user_request', source: 'classifier', consent: true as const }
        : input.ban
          ? { reason: 'abuse', source: 'abuse_guard', consent: false as const }
          : undefined;

    if (block) {
      await tx
        .insert(optOuts)
        .values({ phone: input.contactPhone, reason: block.reason, source: block.source })
        .onConflictDoNothing({ target: optOuts.phone });

      await tx
        .update(contacts)
        .set({
          doNotContact: true,
          updatedAt: at,
          ...(block.consent ? { consentStatus: 'opted_out' as const } : {}),
        })
        .where(eq(contacts.id, input.contactId));
    }
  });
}
