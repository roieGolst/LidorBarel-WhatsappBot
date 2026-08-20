import { resolve } from 'node:path';
import { entrypoint, task } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { Database } from '../db/client.js';
import { findContactById } from '../db/repositories/contacts.js';
import { listMediaAssets } from '../db/repositories/mediaAssets.js';
import {
  getConversationById,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { countInboundMessages, recentMessages } from '../db/repositories/messages.js';
import { isOptedOut } from '../db/repositories/optOuts.js';
import { getLogger } from '../logger.js';
import type { LlmClient, LlmMessage, LlmUsage } from '../llm/client.js';
import type {
  ListRow,
  OutboundResult,
  ReplyButton,
  WhatsAppChannel,
} from '../whatsapp/channel.js';
import { guardedSend } from '../whatsapp/guardedSend.js';
import { classifyAndExtract } from './classify.js';
import {
  decideMainMenu,
  decideTransition,
  screensAllQuestions,
  type Decision,
  type KnownFacts,
  type TurnAction,
} from './decide.js';
import { evaluateGate, isMalicious, RATE_WINDOW_MS, type GateResult } from './gate.js';
import { generateValidatedReply } from './generate.js';
import {
  BOOKING_LEADIN_MESSAGE,
  cannedReplyFor,
  INTRO_VIDEO_PATH,
  MAIN_MENU,
  mainMenuChoiceFor,
  screeningQuestionFor,
  WELCOME_MESSAGE,
  type ScreeningQuestion,
} from './interactive.js';
import { ENGLISH_ONLY_REPLY, isPredominantlyEnglish } from './language.js';
import { isOptOutKeyword } from './optOutKeywords.js';
import {
  persistTurn,
  type OutboundMessageRecord,
  type PersistTurnInput,
} from './persist.js';
import { selectVideo } from './testimonial.js';
import { sanitizeExtraction } from './validateAnswer.js';

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
 * other reply (FAQ, objection, handoff) is still model-written and validated.
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
  // --- Deterministic guard-rail inputs (see gate.ts) ---
  /** Total inbound in this conversation, including the current message. */
  inboundCount: number;
  /** Inbound within the last rate-limit window, including the current. */
  recentInboundCount: number;
  /** Milliseconds since the conversation started. */
  conversationAgeMs: number;
  /** Whether an earlier inbound in this conversation was malicious. */
  priorMalicious: boolean;
  /** The bot's most recent outbound text, to dedupe a throttle notice. */
  lastOutboundText?: string;
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
): Promise<TurnContext | null> {
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
    // Nothing to respond to: the latest message is already the bot's reply (a
    // stale/duplicate enqueue, or a redelivery whose inbound was answered on an
    // earlier turn). This is a no-op, not an error — returning null lets the turn
    // skip silently instead of failing and retrying forever.
    return null;
  }

  const now = Date.now();
  const [inboundCount, recentInboundCount] = await Promise.all([
    countInboundMessages(db, conversationId),
    countInboundMessages(db, conversationId, new Date(now - RATE_WINDOW_MS)),
  ]);

  // Earlier user turns (excluding the current message), for the abuse strike.
  const priorMalicious = turns
    .slice(0, -1)
    .some((turn) => turn.role === 'user' && isMalicious(turn.content));
  const lastOutboundText = turns
    .filter((turn) => turn.role === 'assistant')
    .at(-1)?.content;

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
    inboundCount,
    recentInboundCount,
    conversationAgeMs: now - conversation.createdAt.getTime(),
    priorMalicious,
    ...(lastOutboundText !== undefined ? { lastOutboundText } : {}),
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

/** Renders a screening question into the outbound part that carries it. */
function questionPart(question: ScreeningQuestion): OutboundPart {
  switch (question.kind) {
    case 'text':
      return { kind: 'text', text: question.body };
    case 'buttons':
      return { kind: 'buttons', body: question.body, buttons: question.buttons };
    case 'list':
      return {
        kind: 'list',
        body: question.body,
        buttonLabel: question.buttonLabel,
        rows: question.rows,
      };
  }
}

/** Stored placeholder for a media message, which has no text body. */
const VIDEO_PLACEHOLDER = '[סרטון היכרות]';

/** Stored placeholder for the sent testimonial video. */
const TESTIMONIAL_PLACEHOLDER = '[סרטון המלצה]';

/** Stored placeholder for the investor-tour (buyer-pool proof) video. */
const BUYER_POOL_PLACEHOLDER = '[סרטון סיור משקיעים]';

/**
 * The contextual intro sent as the investor-tour video's caption, so it is
 * introduced naturally and its relevance explained rather than sent bare. This
 * is proof of Lidor's active buyer/investor pool, used to build trust with a
 * seller who asks about marketing, buyers, or the agent's value.
 */
const BUYER_POOL_PROOF_INTRO =
  'מצרף לך סרטון קצר מסיור שלידור ערך למשקיעים מאזור המרכז. זו דוגמה לעבודה שלו עם מאגר קונים ומשקיעים פעיל, שיכול לסייע בחשיפה ובשיווק הנכס לקהל רלוונטי.';

/** The catalog type of the investor-tour / buyer-pool-proof video. */
const BUYER_POOL_PROOF_TYPE = 'buyer_pool_proof';

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
  const logger = getLogger();

  const load = task('ct_loadContext', (conversationId: string) =>
    loadContext(deps.db, conversationId),
  );

  const classify = task(
    'ct_classify',
    (args: { text: string; history: LlmMessage[]; priorNotes?: string }) =>
      classifyAndExtract(deps.llm, args),
  );

  const generate = task(
    'ct_generate',
    (args: { action: TurnAction; escalate: boolean; history: LlmMessage[] }) =>
      generateValidatedReply(deps.llm, args),
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

  /** The interactive re-ask for a "go back" — the pending question after undo. */
  const backPart = (
    ctx: TurnContext,
    extracted: KnownFacts,
  ): { part: OutboundPart; storeBody: string; toStage: ConversationStage } => {
    const decision = decideMainMenu('check_fit', ctx.stage, extracted, ctx.screenAll);
    const question = screeningQuestionFor(decision.action);
    if (question) {
      return {
        part: questionPart(question),
        storeBody: question.body,
        toStage: decision.nextStage,
      };
    }
    // Nothing left to ask (shouldn't happen after an undo) → re-show the menu.
    return {
      part: {
        kind: 'list',
        body: MAIN_MENU.body,
        buttonLabel: MAIN_MENU.buttonLabel,
        rows: [...MAIN_MENU.rows],
      },
      storeBody: MAIN_MENU.body,
      toStage: 'engaged',
    };
  };

  /**
   * Handles a fired guard rail deterministically: sends the canned reply (or
   * nothing), applies any reset/ban, and records the turn — no model call.
   */
  const handleGate = async (
    gate: Exclude<GateResult, { kind: 'proceed' }>,
    ctx: TurnContext,
    conversationId: string,
  ): Promise<TurnResult> => {
    const base = {
      conversationId,
      contactId: ctx.contactId,
      contactPhone: ctx.contactPhone,
      fromStage: ctx.stage,
    };

    if (gate.kind === 'silent') {
      await persist({
        ...base,
        toStage: gate.nextStage,
        action: gate.action,
        extracted: ctx.known,
        outbound: [],
      });
      return { stage: gate.nextStage, text: '', action: gate.action, sent: false };
    }

    if (gate.kind === 'send') {
      const { providerMessageId } = await send({
        to: ctx.contactPhone,
        part: { kind: 'text', text: gate.text },
      });
      await persist({
        ...base,
        toStage: gate.nextStage,
        action: gate.action,
        extracted: ctx.known,
        outbound: [{ body: gate.text, providerMessageId }],
        ...(gate.ban ? { ban: true } : {}),
      });
      return { stage: gate.nextStage, text: gate.text, action: gate.action, sent: true };
    }

    // restart / back — reset the facts and re-show the menu or re-ask the question.
    const reset =
      gate.kind === 'restart'
        ? {
            part: {
              kind: 'list' as const,
              body: MAIN_MENU.body,
              buttonLabel: MAIN_MENU.buttonLabel,
              rows: [...MAIN_MENU.rows],
            },
            storeBody: MAIN_MENU.body,
            toStage: 'engaged' as ConversationStage,
            extracted: {} as KnownFacts,
          }
        : { ...backPart(ctx, gate.extracted), extracted: gate.extracted };
    const action = gate.kind === 'restart' ? 'restart' : 'go_back';
    const { providerMessageId } = await send({ to: ctx.contactPhone, part: reset.part });
    await persist({
      ...base,
      toStage: reset.toStage,
      action,
      extracted: reset.extracted,
      outbound: [{ body: reset.storeBody, providerMessageId }],
    });
    return { stage: reset.toStage, text: reset.storeBody, action, sent: true };
  };

  return entrypoint(
    { name: 'conversationTurn', checkpointer },
    async (conversationId: string): Promise<TurnResult> => {
      const ctx = await load(conversationId);

      // Nothing to respond to (the latest message is already the bot's reply — a
      // stale or duplicate enqueue). Skip silently rather than fail and retry.
      if (!ctx) {
        return { stage: 'engaged', action: 'skipped_no_inbound', text: '', sent: false };
      }

      // A contact who already opted out is left in silence — no reply is
      // generated and nothing is sent. The acknowledgement of the opt-out itself
      // went out on the turn that recorded it, before this became true.
      if (ctx.optedOut) {
        return { stage: ctx.stage, action: 'skipped_opted_out', text: '', sent: false };
      }

      // Deterministic guard rails run before any model call: abuse, rate/quota
      // limits, expiry, and the typed control words (gate.ts). When one fires the
      // turn is handled here, with no classification or generation.
      const gate = evaluateGate({
        currentText: ctx.currentText,
        stage: ctx.stage,
        known: ctx.known,
        screenAll: ctx.screenAll,
        inboundCount: ctx.inboundCount,
        recentInboundCount: ctx.recentInboundCount,
        conversationAgeMs: ctx.conversationAgeMs,
        priorMalicious: ctx.priorMalicious,
        ...(ctx.lastOutboundText !== undefined
          ? { lastOutboundText: ctx.lastOutboundText }
          : {}),
      });
      if (gate.kind !== 'proceed') {
        return handleGate(gate, ctx, conversationId);
      }

      // Hebrew-only gate (review req #4): a predominantly-English message is
      // unsupported input — a fixed Hebrew reply, no classification, no fact
      // change, no flow advance. An explicit opt-out (even in English, e.g.
      // "unsubscribe") is left to the classifier below rather than refused here.
      if (isPredominantlyEnglish(ctx.currentText) && !isOptOutKeyword(ctx.currentText)) {
        const holdStage: ConversationStage = ctx.stage === 'new' ? 'engaged' : ctx.stage;
        const { providerMessageId } = await send({
          to: ctx.contactPhone,
          part: { kind: 'text', text: ENGLISH_ONLY_REPLY },
        });
        await persist({
          conversationId,
          contactId: ctx.contactId,
          contactPhone: ctx.contactPhone,
          fromStage: ctx.stage,
          toStage: holdStage,
          action: 'reject_english',
          extracted: ctx.known,
          outbound: [{ body: ENGLISH_ONLY_REPLY, providerMessageId }],
        });
        return {
          stage: holdStage,
          text: ENGLISH_ONLY_REPLY,
          action: 'reject_english',
          sent: true,
        };
      }

      const { analysis } = await classify({
        text: ctx.currentText,
        history: ctx.classifyHistory,
        ...(ctx.known.additionalNotes ? { priorNotes: ctx.known.additionalNotes } : {}),
      });

      // Answer validation (review req #1): drop an implausible free-text
      // neighborhood ("Opus 4.8") before it is trusted, so it is neither stored
      // nor advances the flow — the screening question is simply re-asked.
      const { extracted: cleanExtracted, invalidNeighborhood } = sanitizeExtraction(
        analysis.extracted,
      );
      if (invalidNeighborhood !== undefined) {
        logger.info(
          { conversationId, invalidNeighborhood },
          'rejected implausible neighborhood answer',
        );
      }
      const validated = { ...analysis, extracted: cleanExtracted };

      // The one place a stage is chosen — pure code, never the model.
      // Opt-out always wins. Otherwise the very first response opens with the
      // main menu (§2/§8); a later main-menu tap routes deterministically; and
      // anything else runs the classify-driven screening flow.
      const menuChoice = mainMenuChoiceFor(ctx.currentText);
      let decision: Decision;
      if (validated.intent === 'OPT_OUT') {
        decision = decideTransition(ctx.stage, validated, ctx.known, ctx.screenAll);
      } else if (ctx.isFirstResponse) {
        decision = { nextStage: 'engaged', action: 'show_main_menu', escalate: false };
      } else if (menuChoice) {
        decision = decideMainMenu(menuChoice, ctx.stage, ctx.known, ctx.screenAll);
      } else {
        decision = decideTransition(ctx.stage, validated, ctx.known, ctx.screenAll);
      }

      // Booking intent: the "קביעת פגישה" menu choice, or a message the classifier
      // read as wanting to schedule / proceed. It runs the same screening flow and
      // is stored as a fact so it boosts the lead's weighted priority (see
      // leadPriorityScore). `bookingTriggered` fires only the first time, so the
      // brief booking lead-in is sent once.
      const bookingIntent =
        menuChoice === 'book_meeting' || validated.extracted.bookingIntent === true;
      const bookingTriggered = bookingIntent && ctx.known.bookingIntent !== true;

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

      // Booking lead-in: brief and decisive, sent once when the booking flow
      // starts, right before the first screening question.
      if (bookingTriggered) {
        plan.push({
          part: { kind: 'text', text: BOOKING_LEADIN_MESSAGE },
          storeBody: BOOKING_LEADIN_MESSAGE,
        });
      }

      // Testimonial video (Part B): when the customer asks for social proof,
      // attach a matching customer video before the model-written text, if one is
      // catalogued. Neighborhood-specific is preferred; unknown neighborhoods are
      // never guessed. The channel uploads and caches the file on first send.
      if (decision.action === 'send_social_proof') {
        const selection = selectVideo({
          track: 'testimonial',
          intent: 'seller',
          neighborhoodCanonical: ctx.known.neighborhood ?? null,
          assets: await listMediaAssets(deps.db),
        });
        logger.info(
          {
            conversationId,
            decision: selection.kind,
            reason: selection.reason,
            ...(selection.kind === 'send'
              ? {
                  asset: selection.asset.path,
                  matchedNeighborhood: selection.matchedNeighborhood,
                }
              : {}),
          },
          'testimonial video selection',
        );
        if (selection.kind === 'send') {
          plan.push({
            part: {
              kind: 'video',
              filePath: resolve(process.cwd(), 'assets', selection.asset.path),
            },
            storeBody: TESTIMONIAL_PLACEHOLDER,
          });
        }
      }

      // Investor-tour video: a seller asking how the property will be marketed,
      // whether there are buyers, or what value the agent brings gets the
      // buyer-pool proof video — introduced with a contextual caption, sent at
      // most once per conversation, and additive to the model's reply.
      if (validated.wantsBuyerProof) {
        const alreadySent = ctx.turns.some(
          (t) => t.role === 'assistant' && t.content === BUYER_POOL_PLACEHOLDER,
        );
        const proof = alreadySent
          ? undefined
          : (await listMediaAssets(deps.db)).find(
              (a) => a.type === BUYER_POOL_PROOF_TYPE,
            );
        logger.info(
          { conversationId, wantsBuyerProof: true, alreadySent, found: Boolean(proof) },
          'buyer-pool proof video selection',
        );
        if (proof) {
          plan.push({
            part: {
              kind: 'video',
              filePath: resolve(process.cwd(), 'assets', proof.path),
              caption: BUYER_POOL_PROOF_INTRO,
            },
            storeBody: BUYER_POOL_PLACEHOLDER,
          });
        }
      }

      // The action's message. The main menu and the screening questions are fixed
      // spec content sent as buttons/a list; every other action is written and
      // validated by the model.
      let regenerated = false;
      let fellBack = false;
      const question = screeningQuestionFor(decision.action);
      const canned = cannedReplyFor(decision.action);
      if (decision.action === 'show_main_menu') {
        plan.push({
          part: {
            kind: 'list',
            body: MAIN_MENU.body,
            buttonLabel: MAIN_MENU.buttonLabel,
            rows: [...MAIN_MENU.rows],
          },
          storeBody: MAIN_MENU.body,
        });
      } else if (canned) {
        // Fixed closes and the intent check — canned so the wording, grammar and
        // "no callback-time promise" rule can never drift.
        plan.push({ part: { kind: 'text', text: canned }, storeBody: canned });
      } else if (question) {
        plan.push({ part: questionPart(question), storeBody: question.body });
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
        toStage: decision.nextStage,
        action: decision.action,
        // additionalNotes is the model's consolidated summary, so overwrite (the
        // prior notes were fed to classify to merge) rather than appending. Uses
        // the validated extraction, so an invalid neighborhood is never stored.
        // A book-meeting tap sets bookingIntent even when the tap text carried
        // none, and implies top urgency — timeline is taken as immediate (Q3 is
        // skipped) unless a timeline is already known.
        extracted: {
          ...ctx.known,
          ...validated.extracted,
          ...(bookingIntent
            ? {
                bookingIntent: true,
                timeline:
                  ctx.known.timeline ?? validated.extracted.timeline ?? 'immediate',
              }
            : {}),
        },
        ...(decision.qualified !== undefined ? { qualified: decision.qualified } : {}),
        ...(decision.disqualificationReason !== undefined
          ? { disqualificationReason: decision.disqualificationReason }
          : {}),
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
