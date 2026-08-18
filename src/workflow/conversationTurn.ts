import { entrypoint, task } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { Database } from '../db/client.js';
import { findContactById } from '../db/repositories/contacts.js';
import {
  getConversationById,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { recentMessages } from '../db/repositories/messages.js';
import { isOptedOut } from '../db/repositories/optOuts.js';
import type { LlmClient, LlmMessage } from '../llm/client.js';
import type { WhatsAppChannel } from '../whatsapp/channel.js';
import { guardedSend } from '../whatsapp/guardedSend.js';
import { classifyAndExtract } from './classify.js';
import { decideTransition, screensAllQuestions, type KnownFacts } from './decide.js';
import { generateValidatedReply } from './generate.js';
import { persistTurn, type PersistTurnInput } from './persist.js';

/**
 * The conversation workflow — one turn, per the plan's §5.1 shape.
 *
 * This is the assembled pipeline that replaced the de-risking spike:
 *
 *   load context → classifyAndExtract (Claude → JSON)
 *                → decideTransition   (plain TS, no model — owns the stage)
 *                → generateValidatedReply (Claude, with the regen/fallback loop)
 *                → send               (channel)
 *                → persistTurn        (Postgres, one transaction)
 *
 * Each IO step is a LangGraph `task` on a Postgres-backed checkpointer, so a
 * turn runs as durable, checkpointed execution — the substrate M6's
 * appointment-approval `interrupt()` will resume on (that interrupt/resume round
 * trip is de-risked separately). Replay safety at the data layer comes from
 * `persistTurn` being idempotent by the outbound message id, so a redelivered or
 * retried turn never double-records the reply.
 *
 * The stage the model sees never becomes the stage we store: `decideTransition`
 * is pure TypeScript, so a hallucinated stage is structurally impossible.
 */
export interface ConversationDeps {
  db: Database;
  llm: LlmClient;
  channel: WhatsAppChannel;
}

export interface TurnContext {
  stage: ConversationStage;
  known: KnownFacts;
  contactId: string;
  contactPhone: string;
  /**
   * True when the lead did not come through the Meta form, so all four screening
   * questions must be asked (spec §3). A form lead has Q1/Q3 pre-answered.
   */
  screenAll: boolean;
  /** True when this contact already opted out — the turn does nothing. */
  optedOut: boolean;
  /** The latest inbound message — the turn we are responding to. */
  currentText: string;
  /** Turns before the current one, for classification context. */
  classifyHistory: LlmMessage[];
  /** The full recent transcript, for reply generation. */
  turns: LlmMessage[];
}

export interface TurnResult {
  stage: ConversationStage;
  text: string;
  action: string;
  /** False when the turn sent nothing — an opted-out contact is left in silence. */
  sent: boolean;
}

/**
 * Reads everything a turn needs from Postgres — the source of truth — and shapes
 * it into serializable primitives so it can cross the checkpoint boundary safely
 * (no Drizzle rows with `Date` fields into the checkpoint).
 */
export async function loadContext(
  db: Database,
  conversationId: string,
): Promise<TurnContext> {
  const conversation = await getConversationById(db, conversationId);
  if (!conversation) {
    throw new Error(`conversationTurn: conversation ${conversationId} not found`);
  }

  const contact = await findContactById(db, conversation.contactId);
  if (!contact) {
    throw new Error(`conversationTurn: contact ${conversation.contactId} not found`);
  }

  const turns: LlmMessage[] = (await recentMessages(db, conversationId))
    .map((message) => ({
      role: message.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
      content: message.body ?? '',
    }))
    .filter((turn) => turn.content.length > 0);

  const last = turns.at(-1);
  if (!last || last.role !== 'user') {
    throw new Error('conversationTurn: no inbound message to respond to');
  }

  return {
    stage: conversation.stage,
    known: conversation.extracted ?? {},
    contactId: contact.id,
    contactPhone: contact.phone,
    screenAll: screensAllQuestions(contact.entryPoint),
    optedOut: await isOptedOut(db, contact.phone),
    currentText: last.content,
    classifyHistory: turns.slice(0, -1),
    turns,
  };
}

/**
 * Builds the checkpointed conversation-turn workflow.
 *
 * `thread_id` is the conversation id, so every turn of a conversation shares one
 * durable execution thread.
 */
export function createConversationWorkflow(
  deps: ConversationDeps,
  checkpointer: BaseCheckpointSaver,
) {
  const load = task('ct_loadContext', (conversationId: string) =>
    loadContext(deps.db, conversationId),
  );

  const classify = task('ct_classify', (args: { text: string; history: LlmMessage[] }) =>
    classifyAndExtract(deps.llm, args),
  );

  const generate = task(
    'ct_generate',
    (args: {
      action: PersistTurnInput['decision']['action'];
      escalate: boolean;
      history: LlmMessage[];
    }) => generateValidatedReply(deps.llm, args),
  );

  // Every outbound message goes through guardedSend, so opt-out enforcement
  // cannot be bypassed by this send path (§6).
  const send = task('ct_send', (args: { to: string; text: string }) =>
    guardedSend(deps.db, deps.channel, args.to, args.text),
  );

  const persist = task('ct_persist', (args: PersistTurnInput) =>
    persistTurn(deps.db, args),
  );

  return entrypoint(
    { name: 'conversationTurn', checkpointer },
    async (conversationId: string): Promise<TurnResult> => {
      const ctx = await load(conversationId);

      // A contact who already opted out is left in silence — no reply is
      // generated and nothing is sent. The acknowledgement of the opt-out itself
      // went out on the turn that recorded it, before this became true.
      if (ctx.optedOut) {
        return { stage: ctx.stage, action: 'skipped_opted_out', text: '', sent: false };
      }

      const { analysis } = await classify({
        text: ctx.currentText,
        history: ctx.classifyHistory,
      });

      // The one place a stage is chosen — pure code, never the model.
      const decision = decideTransition(ctx.stage, analysis, ctx.known, ctx.screenAll);

      const reply = await generate({
        action: decision.action,
        escalate: decision.escalate,
        history: ctx.turns,
      });

      const sent = await send({ to: ctx.contactPhone, text: reply.text });

      await persist({
        conversationId,
        contactId: ctx.contactId,
        contactPhone: ctx.contactPhone,
        fromStage: ctx.stage,
        decision,
        mergedExtracted: { ...ctx.known, ...analysis.extracted },
        reply,
        providerMessageId: sent.providerMessageId,
      });

      return {
        stage: decision.nextStage,
        text: reply.text,
        action: decision.action,
        sent: true,
      };
    },
  );
}
