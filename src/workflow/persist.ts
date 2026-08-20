import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { ConversationStage } from '../db/repositories/conversations.js';
import { contacts, conversations, events, messages, optOuts } from '../db/schema.js';
import type { StoredFacts } from './classify.js';
import type { Decision } from './decide.js';
import type { LlmUsage } from '../llm/client.js';
import type { ScreeningState } from './screeningState.js';

/**
 * `persistTurn` — commits everything a turn changed, in one transaction (§5.2).
 *
 * The rule this enforces: every business-meaningful transition lands in Postgres
 * atomically — the stage change, the outbound message (if any), the screening
 * state, and the audit event all commit together or none do.
 *
 * Two guarantees added after the review: only **validated** facts reach
 * `extracted` (the caller merges valid facts only), and the audit `events` row
 * records **why** the transition happened — the `triggeredRule` and `reason` — so
 * the debug endpoint can reconstruct the full state-transition history.
 *
 * Idempotent by the outbound message's provider id: a replayed turn (send already
 * happened, id checkpointed) no-ops the message insert rather than duplicating.
 * A turn that sent nothing (`stop_responding`, opted-out) simply has no message.
 */

/** The message that actually went out this turn, when one did. */
export interface OutboundRecord {
  providerMessageId: string;
  body: string;
  /** Set for a video send; the `messages.media_type` column. */
  mediaType?: string;
  mediaRef?: string;
  /** Per-attempt LLM usage; empty/absent for deterministic sends. */
  usage?: LlmUsage[];
  regenerated?: boolean;
  fellBack?: boolean;
}

export interface PersistTurnInput {
  conversationId: string;
  contactId: string;
  /** E.164 — needed to write the durable opt-out record. */
  contactPhone: string;
  fromStage: ConversationStage;
  decision: Decision;
  /** Validated screening facts merged over what was known. */
  mergedExtracted: StoredFacts;
  /** The turn's validation/qualification bookkeeping. */
  screeningState: ScreeningState;
  /** Present only when a message was sent (text or video). */
  outbound?: OutboundRecord;
}

export async function persistTurn(db: Database, input: PersistTurnInput): Promise<void> {
  const { decision, outbound } = input;
  const at = new Date();

  const inputTokens = sumUsage(outbound?.usage, 'inputTokens');
  const outputTokens = sumUsage(outbound?.usage, 'outputTokens');
  const cacheReadTokens = sumUsage(outbound?.usage, 'cacheReadTokens');
  const llmModel = outbound?.usage?.at(-1)?.model ?? null;

  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({
        stage: decision.nextStage,
        extracted: input.mergedExtracted,
        screeningState: input.screeningState,
        updatedAt: at,
        ...(outbound ? { lastOutboundAt: at } : {}),
        ...(decision.qualified !== undefined ? { qualified: decision.qualified } : {}),
        ...(decision.disqualificationReason !== undefined
          ? { disqualificationReason: decision.disqualificationReason }
          : {}),
      })
      .where(eq(conversations.id, input.conversationId));

    // The outbound message, when one was sent. onConflictDoNothing makes replay
    // after a crash safe: the same provider id cannot produce a second row.
    if (outbound) {
      await tx
        .insert(messages)
        .values({
          conversationId: input.conversationId,
          direction: 'outbound',
          body: outbound.body,
          ...(outbound.mediaType ? { mediaType: outbound.mediaType } : {}),
          ...(outbound.mediaRef ? { mediaUrl: outbound.mediaRef } : {}),
          providerMessageId: outbound.providerMessageId,
          deliveryStatus: 'sent',
          llmModel,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          createdAt: at,
        })
        .onConflictDoNothing({ target: messages.providerMessageId });
    }

    await tx.insert(events).values({
      aggregateType: 'conversation',
      aggregateId: input.conversationId,
      eventType: 'stage_transition',
      fromStage: input.fromStage,
      toStage: decision.nextStage,
      actor: 'system',
      metadata: {
        action: decision.action,
        triggeredRule: decision.triggeredRule,
        reason: decision.reason,
        sent: outbound !== undefined,
        ...(outbound?.regenerated !== undefined
          ? { regenerated: outbound.regenerated }
          : {}),
        ...(outbound?.fellBack !== undefined ? { fellBack: outbound.fellBack } : {}),
        ...(decision.qualified !== undefined ? { qualified: decision.qualified } : {}),
        ...(decision.disqualificationReason !== undefined
          ? { disqualificationReason: decision.disqualificationReason }
          : {}),
        ...(input.screeningState.qualification
          ? {
              qualificationStatus: input.screeningState.qualification.status,
              qualificationScore: input.screeningState.qualification.score,
            }
          : {}),
      },
    });

    // Opt-out is a durable, phone-keyed record checked before every future send,
    // plus the denormalized flag on the contact for the hot path.
    if (decision.nextStage === 'opted_out') {
      await tx
        .insert(optOuts)
        .values({
          phone: input.contactPhone,
          reason: 'user_request',
          source: 'classifier',
        })
        .onConflictDoNothing({ target: optOuts.phone });

      await tx
        .update(contacts)
        .set({ doNotContact: true, consentStatus: 'opted_out', updatedAt: at })
        .where(eq(contacts.id, input.contactId));
    }
  });
}

function sumUsage(
  usage: LlmUsage[] | undefined,
  field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens',
): number {
  return (usage ?? []).reduce((total, u) => total + u[field], 0);
}
