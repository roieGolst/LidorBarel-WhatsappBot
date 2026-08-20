import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import { findContactById } from '../db/repositories/contacts.js';
import {
  getConversationById,
  type Conversation,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { screensAllQuestions } from '../workflow/decide.js';
import { events } from '../db/schema.js';
import { toScreeningState } from '../workflow/screeningState.js';
import type { StoredFacts } from '../workflow/classify.js';

/**
 * `GET /debug/leads/:leadId` — a development-only window into a lead's complete
 * state (review req #7).
 *
 * This exists because "the bot said it forwarded the lead" is not enough to
 * debug: you need to see *why* — which answers were valid, how many off-topic
 * messages there were, whether a warning was sent, the qualification score and
 * its reasons, and the full transition history with the rule that fired each
 * time. All of that already lives in Postgres (the conversation, its
 * `screening_state`, and the append-only `events`); this assembles it.
 *
 * It is registered **only when `NODE_ENV !== 'production'`** (see `server.ts`), so
 * it can never be reached by a WhatsApp customer in production. Personal data is
 * masked: the phone is truncated and transcripts are never included.
 */

/** A human-facing status derived from the stage. */
function statusForStage(stage: ConversationStage): string {
  switch (stage) {
    case 'new':
    case 'awaiting_first_contact':
    case 'engaged':
      return 'engaged';
    case 'qualified':
      return 'qualified';
    case 'needs_review':
      return 'needs_review';
    case 'disqualified':
      return 'disqualified';
    case 'opted_out':
      return 'opted_out';
    case 'assessing_motivation':
      return 'assessing_motivation';
    default:
      return 'qualifying';
  }
}

/** The next action the bot would take, derived from stage and state. */
function nextActionFor(
  stage: ConversationStage,
  mode: string,
  warningSent: boolean,
): string {
  if (mode === 'containment') return warningSent ? 'stop_responding' : 'warn_off_topic';
  switch (stage) {
    case 'screening_sell_intent':
      return 'ask_sell_intent';
    case 'screening_neighborhood':
      return 'ask_neighborhood';
    case 'screening_timeline':
      return 'ask_timeline';
    case 'screening_currently_marketed':
      return 'ask_currently_marketed';
    case 'assessing_motivation':
      return 'assess_quality';
    case 'qualified':
      return 'hand_off_to_lidor';
    case 'needs_review':
      return 'await_manual_review';
    case 'disqualified':
    case 'opted_out':
      return 'none';
    default:
      return 'ask_next_question';
  }
}

/** The screening fields still missing, given the lead's origin. */
function missingFields(facts: StoredFacts, screenAll: boolean): string[] {
  const missing: string[] = [];
  if (screenAll && facts.sellIntent === undefined) missing.push('sellIntent');
  if (facts.neighborhood === undefined) missing.push('neighborhood');
  if (screenAll && facts.timeline === undefined) missing.push('timeline');
  if (facts.currentlyMarketed === undefined) missing.push('currentlyMarketed');
  return missing;
}

/** Masks a phone number, keeping only the last two digits. */
function maskPhone(phone: string): string {
  return phone.length <= 2 ? '***' : `${'*'.repeat(phone.length - 2)}${phone.slice(-2)}`;
}

/** Builds the debug payload, or null when the conversation does not exist. */
export async function buildLeadDebug(
  db: Database,
  leadId: string,
): Promise<Record<string, unknown> | null> {
  let conversation: Conversation | undefined;
  try {
    conversation = await getConversationById(db, leadId);
  } catch {
    // A malformed (non-uuid) id is a not-found, not a 500.
    return null;
  }
  if (!conversation) return null;

  const contact = await findContactById(db, conversation.contactId);
  const screenAll = screensAllQuestions(contact?.entryPoint);
  const facts = (conversation.extracted ?? {}) as StoredFacts;
  const state = toScreeningState(conversation.screeningState);

  const history = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.aggregateType, 'conversation'),
        eq(events.aggregateId, leadId),
        eq(events.eventType, 'stage_transition'),
      ),
    )
    .orderBy(asc(events.createdAt));

  const qualification = state.qualification ?? {
    status: 'pending',
    score: 0,
    reasons: ['Not yet assessed'],
  };

  return {
    leadId,
    currentStep: nextActionFor(conversation.stage, state.mode, state.warningSent),
    stage: conversation.stage,
    status: statusForStage(conversation.stage),
    qualification: {
      isQualified: conversation.qualified === true,
      status: qualification.status,
      score: qualification.score,
      reasons: qualification.reasons,
    },
    answers: state.answers,
    facts: {
      neighborhood: facts.neighborhood ?? null,
      neighborhoodCanonical: facts.neighborhoodCanonical ?? null,
      city: facts.city ?? null,
      outsideServiceArea: facts.outsideServiceArea ?? false,
      sellIntent: facts.sellIntent ?? null,
      timeline: facts.timeline ?? null,
      currentlyMarketed: facts.currentlyMarketed ?? null,
      notes: facts.notes ?? null,
    },
    missingFields: missingFields(facts, screenAll),
    irrelevantResponseCount: state.irrelevantResponseCount,
    invalidAnswerCount: state.invalidAnswerCount,
    warningSent: state.warningSent,
    mode: state.mode,
    unknownNeighborhoods: state.unknownNeighborhoods,
    disqualificationReason: conversation.disqualificationReason ?? null,
    nextAction: nextActionFor(conversation.stage, state.mode, state.warningSent),
    contact: contact ? { phoneMasked: maskPhone(contact.phone) } : null,
    stateHistory: history.map((event) => {
      const metadata = (event.metadata ?? {}) as Record<string, unknown>;
      return {
        from: event.fromStage,
        to: event.toStage,
        reason: metadata.reason ?? null,
        triggeredRule: metadata.triggeredRule ?? null,
        action: metadata.action ?? null,
        at: event.createdAt,
      };
    }),
  };
}

/** Registers the debug endpoints. Call only in non-production. */
export function registerDebugRoutes(app: FastifyInstance, deps: { db: Database }): void {
  app.get('/debug/leads/:leadId', async (request, reply) => {
    const { leadId } = request.params as { leadId: string };
    const payload = await buildLeadDebug(deps.db, leadId);
    if (!payload) return reply.code(404).send({ error: 'lead not found' });
    return reply.send(payload);
  });
}
