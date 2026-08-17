import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { ConversationStage } from '../db/repositories/conversations.js';
import { contacts, conversations, events, messages, optOuts } from '../db/schema.js';
import type { Decision, KnownFacts } from './decide.js';
import type { ValidatedReply } from './generate.js';

/**
 * `persistTurn` — commits everything a turn changed, in one transaction (§5.2).
 *
 * The rule this enforces: every business-meaningful transition lands in Postgres
 * atomically. Either the stage change, the outbound message, and the audit event
 * all commit together, or none do — a reply recorded without its stage change,
 * or a stage change with no message explaining it, are states nothing downstream
 * knows how to read.
 *
 * Idempotent by the outbound message's provider id: if the turn is replayed
 * after a crash (the send already happened and its id is checkpointed), the
 * message insert no-ops rather than duplicating.
 */
export interface PersistTurnInput {
  conversationId: string;
  contactId: string;
  /** E.164 — needed to write the durable opt-out record. */
  contactPhone: string;
  fromStage: ConversationStage;
  decision: Decision;
  /** Screening facts known so far plus this turn's extraction. */
  mergedExtracted: KnownFacts;
  reply: ValidatedReply;
  /** The id returned by the channel for the message we sent this turn. */
  providerMessageId: string;
}

export async function persistTurn(db: Database, input: PersistTurnInput): Promise<void> {
  const { decision, reply } = input;
  const at = new Date();

  // Aggregate token usage across every attempt this turn (a regeneration is two
  // model calls), so cost accounting is complete (§7).
  const inputTokens = sumUsage(reply, 'inputTokens');
  const outputTokens = sumUsage(reply, 'outputTokens');
  const cacheReadTokens = sumUsage(reply, 'cacheReadTokens');
  const llmModel = reply.usage.at(-1)?.model ?? null;

  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({
        stage: decision.nextStage,
        extracted: input.mergedExtracted,
        lastOutboundAt: at,
        updatedAt: at,
        ...(decision.qualified !== undefined ? { qualified: decision.qualified } : {}),
        ...(decision.disqualificationReason !== undefined
          ? { disqualificationReason: decision.disqualificationReason }
          : {}),
      })
      .where(eq(conversations.id, input.conversationId));

    // The outbound message. onConflictDoNothing makes replay after a crash safe:
    // the same provider id cannot produce a second row, so a resumed turn never
    // double-records the reply.
    await tx
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        direction: 'outbound',
        body: reply.text,
        providerMessageId: input.providerMessageId,
        deliveryStatus: 'sent',
        llmModel,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        createdAt: at,
      })
      .onConflictDoNothing({ target: messages.providerMessageId });

    await tx.insert(events).values({
      aggregateType: 'conversation',
      aggregateId: input.conversationId,
      eventType: 'stage_transition',
      fromStage: input.fromStage,
      toStage: decision.nextStage,
      actor: 'system',
      metadata: {
        action: decision.action,
        regenerated: reply.regenerated,
        fellBack: reply.fellBack,
        ...(decision.qualified !== undefined ? { qualified: decision.qualified } : {}),
        ...(decision.disqualificationReason !== undefined
          ? { disqualificationReason: decision.disqualificationReason }
          : {}),
      },
    });

    // Opt-out is a durable, phone-keyed record checked before every future send,
    // plus the denormalized flag on the contact for the hot-path check. Written
    // here so reaching the opted_out stage and honoring it commit together.
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
  reply: ValidatedReply,
  field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens',
): number {
  return reply.usage.reduce((total, usage) => total + usage[field], 0);
}
