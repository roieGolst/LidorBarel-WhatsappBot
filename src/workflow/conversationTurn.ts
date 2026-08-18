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
import type { LlmClient, LlmMessage, LlmUsage } from '../llm/client.js';
import type {
  ListRow,
  OutboundResult,
  ReplyButton,
  WhatsAppChannel,
} from '../whatsapp/channel.js';
import { guardedSend } from '../whatsapp/guardedSend.js';
import { classifyAndExtract } from './classify.js';
import { decideTransition, screensAllQuestions, type KnownFacts } from './decide.js';
import { generateValidatedReply } from './generate.js';
import {
  INTRO_VIDEO_PATH,
  screeningQuestionFor,
  WELCOME_MESSAGE,
} from './interactive.js';
import {
  persistTurn,
  type OutboundMessageRecord,
  type PersistTurnInput,
} from './persist.js';

/**
 * The conversation workflow — one turn, per the plan's §5.1 shape.
 *
 * This is the assembled pipeline that replaced the de-risking spike:
 *
 *   load context → classifyAndExtract (Claude → JSON)
 *                → decideTransition   (plain TS, no model — owns the stage)
 *                → build outbound plan (opening sequence + interactive screening,
 *                                       or a validated model-written reply)
 *                → send               (each part, through the opt-out choke point)
 *                → persistTurn        (Postgres, one transaction)
 *
 * A turn can send more than one message: the very first response opens with the
 * spec sequence (welcome → intro video → first question, §2), and the four
 * screening questions are sent as interactive buttons/lists (§8) rather than
 * model-written text, so their wording and options are exactly the spec's. Every
 * other reply (FAQ, objection, clarify, handoff) is still model-written and
 * validated.
 *
 * Each IO step is a LangGraph `task` on a Postgres-backed checkpointer, so a turn
 * runs as durable, checkpointed execution — sends are individual tasks, so a
 * crash mid-sequence resumes without re-sending a message that already went out.
 * Replay safety at the data layer comes from `persistTurn` being idempotent by
 * each outbound message id.
 *
 * The stage the model sees never becomes the stage we store: `decideTransition`
 * is pure TypeScript, so a hallucinated stage is structurally impossible.
 */
export interface ConversationDeps {
  db: Database;
  llm: LlmClient;
  channel: WhatsAppChannel;
}

/** One message to send this turn, before it has a provider id. */
export type OutboundPart =
  | { kind: 'text'; text: string }
  | { kind: 'video'; filePath: string; caption?: string }
  | { kind: 'buttons'; body: string; buttons: ReplyButton[] }
  | { kind: 'list'; body: string; buttonLabel: string; rows: ListRow[] };

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
  /**
   * True when the bot has not yet replied in this conversation — the turn that
   * opens with the welcome + intro video (spec §2).
   */
  isFirstResponse: boolean;
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
    // No prior outbound message means the bot has not spoken yet.
    isFirstResponse: !turns.some((turn) => turn.role === 'assistant'),
    optedOut: await isOptedOut(db, contact.phone),
    currentText: last.content,
    classifyHistory: turns.slice(0, -1),
    turns,
  };
}

/** Dispatches an outbound part to the right channel method. */
function sendOutbound(
  channel: WhatsAppChannel,
  to: string,
  part: OutboundPart,
): Promise<OutboundResult> {
  switch (part.kind) {
    case 'text':
      return channel.sendText(to, part.text);
    case 'video':
      return channel.sendVideo(to, part.filePath, part.caption);
    case 'buttons':
      return channel.sendButtons(to, part.body, part.buttons);
    case 'list':
      return channel.sendList(to, part.body, part.buttonLabel, part.rows);
  }
}

function sumUsage(
  usage: LlmUsage[],
  field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens',
): number {
  return usage.reduce((total, u) => total + u[field], 0);
}

/** Stored placeholder for a media message, which has no text body. */
const VIDEO_PLACEHOLDER = '[סרטון היכרות]';

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
  // cannot be bypassed by any send path (§6). One task per message keeps each
  // send individually checkpointed, so a resumed turn does not re-send.
  const send = task('ct_send', (args: { to: string; part: OutboundPart }) =>
    guardedSend(deps.db, args.to, () => sendOutbound(deps.channel, args.to, args.part)),
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

      // Assemble the ordered messages this turn will send.
      const plan: { part: OutboundPart; storeBody: string; usage?: LlmUsage[] }[] = [];

      // Opening sequence on the very first bot response (§2) — but never greet
      // someone whose opening move is to opt out; that turn only acknowledges.
      if (ctx.isFirstResponse && decision.action !== 'acknowledge_opt_out') {
        plan.push({
          part: { kind: 'text', text: WELCOME_MESSAGE },
          storeBody: WELCOME_MESSAGE,
        });
        plan.push({
          part: { kind: 'video', filePath: INTRO_VIDEO_PATH },
          storeBody: VIDEO_PLACEHOLDER,
        });
      }

      // A screening question is fixed spec content sent as buttons/a list; every
      // other action is written and validated by the model.
      let regenerated = false;
      let fellBack = false;
      const question = screeningQuestionFor(decision.action);
      if (question) {
        plan.push({
          part:
            question.kind === 'buttons'
              ? { kind: 'buttons', body: question.body, buttons: question.buttons }
              : {
                  kind: 'list',
                  body: question.body,
                  buttonLabel: question.buttonLabel,
                  rows: question.rows,
                },
          storeBody: question.body,
        });
      } else {
        const reply = await generate({
          action: decision.action,
          escalate: decision.escalate,
          history: ctx.turns,
        });
        regenerated = reply.regenerated;
        fellBack = reply.fellBack;
        plan.push({
          part: { kind: 'text', text: reply.text },
          storeBody: reply.text,
          usage: reply.usage,
        });
      }

      // Send each part in order, collecting a persistable record per message.
      const outbound: OutboundMessageRecord[] = [];
      for (const planned of plan) {
        const { providerMessageId } = await send({
          to: ctx.contactPhone,
          part: planned.part,
        });
        outbound.push({
          body: planned.storeBody,
          providerMessageId,
          ...(planned.usage
            ? {
                llmModel: planned.usage.at(-1)?.model ?? null,
                inputTokens: sumUsage(planned.usage, 'inputTokens'),
                outputTokens: sumUsage(planned.usage, 'outputTokens'),
                cacheReadTokens: sumUsage(planned.usage, 'cacheReadTokens'),
              }
            : {}),
        });
      }

      await persist({
        conversationId,
        contactId: ctx.contactId,
        contactPhone: ctx.contactPhone,
        fromStage: ctx.stage,
        decision,
        mergedExtracted: { ...ctx.known, ...analysis.extracted },
        outbound,
        regenerated,
        fellBack,
      });

      return {
        stage: decision.nextStage,
        // The last message is the actual question/answer that drives the turn.
        text: outbound.at(-1)?.body ?? '',
        action: decision.action,
        sent: true,
      };
    },
  );
}
