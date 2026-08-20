import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import { findContactById } from '../db/repositories/contacts.js';
import {
  getConversationById,
  type Conversation,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { events } from '../db/schema.js';
import { screensAllQuestions, type KnownFacts } from '../workflow/decide.js';

/**
 * `GET /debug/leads/:leadId` — a development-only window into a lead's full state
 * (review req #7).
 *
 * "The bot said it forwarded the lead" is not enough to debug: you need to see
 * the collected facts, whether the lead qualified and why, what is still missing,
 * and the transition history. All of that already lives in Postgres (the
 * conversation, its `extracted` facts, and the append-only `events`); this
 * assembles it.
 *
 * Registered **only when `NODE_ENV !== 'production'`** (see `server.ts`), so it
 * can never be reached by a WhatsApp customer in production. The phone is masked
 * and transcripts are never included.
 */

function statusForStage(stage: ConversationStage): string {
  switch (stage) {
    case 'new':
    case 'awaiting_first_contact':
    case 'engaged':
      return 'engaged';
    case 'qualified':
      return 'qualified';
    case 'disqualified':
      return 'disqualified';
    case 'opted_out':
      return 'opted_out';
    case 'blocked':
      return 'blocked';
    case 'assessing_intent':
      return 'assessing_intent';
    case 'handed_off':
      return 'handed_off';
    default:
      return 'qualifying';
  }
}

function nextActionFor(stage: ConversationStage): string {
  switch (stage) {
    case 'screening_sell_intent':
      return 'ask_sell_intent';
    case 'screening_neighborhood':
      return 'ask_neighborhood';
    case 'screening_timeline':
      return 'ask_timeline';
    case 'screening_currently_marketed':
      return 'ask_currently_marketed';
    case 'assessing_intent':
      return 'ask_intent';
    case 'qualified':
      return 'hand_off_to_lidor';
    case 'disqualified':
    case 'opted_out':
    case 'blocked':
      return 'none';
    case 'handed_off':
      return 'awaiting_human';
    default:
      return 'ask_next_question';
  }
}

/** The screening fields still missing, given the lead's origin. */
function missingFields(facts: KnownFacts, screenAll: boolean): string[] {
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
  const facts = (conversation.extracted ?? {}) as KnownFacts;

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

  return {
    leadId,
    stage: conversation.stage,
    status: statusForStage(conversation.stage),
    nextAction: nextActionFor(conversation.stage),
    qualification: {
      isQualified: conversation.qualified === true,
      qualified: conversation.qualified,
      disqualificationReason: conversation.disqualificationReason ?? null,
      priorityScore: conversation.priorityScore ?? null,
    },
    facts: {
      sellIntent: facts.sellIntent ?? null,
      neighborhood: facts.neighborhood ?? null,
      timeline: facts.timeline ?? null,
      currentlyMarketed: facts.currentlyMarketed ?? null,
      seriousSeller: facts.seriousSeller ?? null,
      sellMotivation: facts.sellMotivation ?? null,
      additionalNotes: facts.additionalNotes ?? null,
    },
    missingFields: missingFields(facts, screenAll),
    contact: contact ? { phoneMasked: maskPhone(contact.phone) } : null,
    stateHistory: history.map((event) => {
      const metadata = (event.metadata ?? {}) as Record<string, unknown>;
      return {
        from: event.fromStage,
        to: event.toStage,
        action: metadata.action ?? null,
        qualified: metadata.qualified ?? null,
        disqualificationReason: metadata.disqualificationReason ?? null,
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
