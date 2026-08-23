import { resolve } from 'node:path';
import { entrypoint, task } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { Database } from '../db/client.js';
import { findContactById } from '../db/repositories/contacts.js';
import { listMediaAssets } from '../db/repositories/mediaAssets.js';
import {
  getConversationById,
  wipeClientForDev,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { getConfig } from '../config.js';
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
import { classifyAndExtract, WORKFLOW_OWNED_FIELDS } from './classify.js';
import { isAffirmative, isNegative } from './confirmation.js';
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
  OFF_TOPIC_REDIRECT_MESSAGE,
  RESTART_DECLINED_MESSAGE,
  screeningAnswerFor,
  screeningQuestionFor,
  UNSUPPORTED_MEDIA_MESSAGE,
  WELCOME_MESSAGE,
  type ScreeningQuestion,
} from './interactive.js';
import { ENGLISH_ONLY_REPLY, hasHebrew, isPredominantlyEnglish } from './language.js';
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
  /** Meta's id for the latest inbound, used to show a typing indicator against it. */
  currentMessageId: string;
  /**
   * Media attached to the latest inbound, when any — e.g. a property photo the
   * lead sent. `kind` is Meta's media type ("image", "video", …); `id` is the
   * Meta media id (the binary is fetched from the Graph API separately).
   */
  currentMedia?: { kind: string; id: string };
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

  const messageRows = await recentMessages(db, conversationId);

  // Whether there is a fresh inbound to respond to is decided from the RAW latest
  // message, not the text transcript — a photo with no caption has an empty body
  // and would otherwise be filtered out entirely, making the turn look like there
  // was nothing to answer (and going silent).
  const latest = messageRows.at(-1);
  if (!latest || latest.direction !== 'inbound') {
    // Nothing to respond to: the latest message is already the bot's reply (a
    // stale/duplicate enqueue, or a redelivery whose inbound was answered on an
    // earlier turn). This is a no-op, not an error — returning null lets the turn
    // skip silently instead of failing and retrying forever.
    return null;
  }

  const currentText = latest.body ?? '';
  const currentMedia =
    latest.mediaType && latest.mediaUrl
      ? { kind: latest.mediaType, id: latest.mediaUrl }
      : undefined;

  // The text transcript for the LLM. Media-only messages (no caption) contribute
  // no text and are simply absent here; the current message's own text, when it
  // has any, is the last user turn.
  const turns: LlmMessage[] = messageRows
    .map((message) => ({
      role: message.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
      content: message.body ?? '',
    }))
    .filter((turn) => turn.content.length > 0);

  const now = Date.now();
  const [inboundCount, recentInboundCount] = await Promise.all([
    countInboundMessages(db, conversationId),
    countInboundMessages(db, conversationId, new Date(now - RATE_WINDOW_MS)),
  ]);

  // History for classification excludes the current message when it carried text
  // (it is the last user turn); a media-only current message is not in `turns`.
  const classifyHistory =
    currentText.length > 0 && turns.at(-1)?.role === 'user' ? turns.slice(0, -1) : turns;

  // Earlier user turns, for the abuse strike.
  const priorMalicious = classifyHistory.some(
    (turn) => turn.role === 'user' && isMalicious(turn.content),
  );
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
    currentText,
    currentMessageId: latest.providerMessageId ?? '',
    ...(currentMedia ? { currentMedia } : {}),
    classifyHistory,
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

/**
 * Stages where the bot is actively collecting a specific answer. A non-Hebrew or
 * terse reply here is handled by the normal validation/classification path (which
 * re-asks the pending question), so the no-Hebrew redirect is skipped for them.
 */
const COLLECTING_STAGES: ReadonlySet<ConversationStage> = new Set([
  'screening_sell_intent',
  'screening_neighborhood',
  'screening_timeline',
  'screening_currently_marketed',
  'screening_exclusivity',
  'assessing_intent',
]);

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

/**
 * DEV-ONLY trigger word that hard-resets the conversation to a clean slate (see
 * {@link resetConversationForDev}). A developer sends exactly this string to wipe
 * everything collected and re-drive the same thread from the opening sequence.
 * Gated to non-production; in production this is treated as an ordinary message.
 * A long random token so a real customer can never send it by accident.
 */
const DEV_RESET_TRIGGER = 'zTDjKr9Ip6mfYPkiH9iyNxWH';

/** Dev-only confirmation sent after a wipe, so the developer sees it worked. */
const DEV_RESET_CONFIRMATION =
  '🧹 [dev] כל נתוני הלקוח נמחקו. שלח הודעה כדי להתחיל מחדש.';

/**
 * Brief, model-free acknowledgement when the lead sends a property photo. Short
 * and non-derailing on purpose — it does not answer or re-ask a screening
 * question, so a photo sent mid-flow does not knock the conversation off course;
 * the pending question still stands. On a burst of photos it is sent once (see
 * the dedupe in the entrypoint), not once per image.
 */
const PHOTO_ACK_MESSAGE = 'קיבלתי את התמונות, תודה! 📸 אצרף אותן לפרטים שיעברו ללידור.';

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

  // A supplementary media send (intro/testimonial/proof clip). The failure is
  // caught INSIDE the task so its promise resolves rather than rejects — a
  // rejected task aborts the whole LangGraph run, which is exactly how an
  // unreadable clip (EPERM) once crashed the turn and left the person with no
  // reply. On failure it returns null; the turn drops the clip and still sends
  // its text.
  const sendOptionalMedia = task(
    'ct_sendOptionalMedia',
    async (args: { to: string; part: OutboundPart }): Promise<string | null> => {
      try {
        const { providerMessageId } = await guardedSend(deps.db, args.to, () =>
          sendOutbound(deps.channel, args.to, args.part),
        );
        return providerMessageId;
      } catch (error) {
        logger.warn(
          { error, kind: args.part.kind },
          'optional media send failed — skipping the clip, continuing the turn',
        );
        return null;
      }
    },
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

      // DEV-ONLY hard wipe: an exact trigger word deletes EVERYTHING tied to this
      // client — the contact and every conversation, message, appointment, opt-out
      // and audit row — so the next inbound starts a brand-new client from the
      // opening sequence. Runs before every other branch (even opt-out) so a
      // developer can always get a clean slate. Never active in production — there
      // the token is just an ordinary inbound message. The confirmation is sent
      // directly (not persisted), and the conversation row itself is gone.
      if (
        getConfig().nodeEnv !== 'production' &&
        ctx.currentText.trim() === DEV_RESET_TRIGGER
      ) {
        await wipeClientForDev(deps.db, conversationId);
        await deps.channel.sendText(ctx.contactPhone, DEV_RESET_CONFIRMATION);
        logger.warn({ conversationId }, 'dev reset: client data wiped');
        return {
          stage: 'new',
          action: 'dev_reset',
          text: DEV_RESET_CONFIRMATION,
          sent: true,
        };
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

      // Property photo: the lead attached an image. Record it on the lead (a
      // running photoCount, so Lidor knows photos are attached) and acknowledge
      // briefly — no classification, no flow advance, so a photo sent mid-screening
      // does not derail the pending question. On a burst (WhatsApp delivers each
      // image as its own message → its own turn), only the first gets the ack; the
      // rest are recorded silently. Runs BEFORE the language gates so a caption-less
      // photo (empty text) is not mistaken for gibberish and redirected. On the very
      // first turn the opening sequence takes precedence (fall through).
      if (ctx.currentMedia?.kind === 'image' && !ctx.isFirstResponse) {
        const photoCount = (ctx.known.photoCount ?? 0) + 1;
        const extracted: KnownFacts = { ...ctx.known, photoCount };
        const alreadyAcked = ctx.lastOutboundText === PHOTO_ACK_MESSAGE;
        logger.info(
          { conversationId, photoCount, alreadyAcked },
          'property photo received',
        );

        const outbound: OutboundMessageRecord[] = [];
        if (!alreadyAcked) {
          const { providerMessageId } = await send({
            to: ctx.contactPhone,
            part: { kind: 'text', text: PHOTO_ACK_MESSAGE },
          });
          outbound.push({ body: PHOTO_ACK_MESSAGE, providerMessageId });
        }
        await persist({
          conversationId,
          contactId: ctx.contactId,
          contactPhone: ctx.contactPhone,
          fromStage: ctx.stage,
          toStage: ctx.stage,
          action: 'acknowledge_photos',
          extracted,
          outbound,
        });
        return {
          stage: ctx.stage,
          action: 'acknowledge_photos',
          text: alreadyAcked ? '' : PHOTO_ACK_MESSAGE,
          sent: !alreadyAcked,
        };
      }

      // Other media the bot can't process — a voice note, audio, a document, a
      // sticker, a video. Reply, once, pointing them to what DOES work (text or the
      // buttons) instead of the off-topic/gibberish redirect a caption-less media
      // message would otherwise trigger below. No classification, no flow advance;
      // a burst is answered once (dedupe on the last outbound). The opening takes
      // precedence on the very first turn.
      if (ctx.currentMedia && !ctx.isFirstResponse) {
        const alreadyTold = ctx.lastOutboundText === UNSUPPORTED_MEDIA_MESSAGE;
        logger.info(
          { conversationId, mediaKind: ctx.currentMedia.kind, alreadyTold },
          'unsupported media received',
        );
        const outbound: OutboundMessageRecord[] = [];
        if (!alreadyTold) {
          const { providerMessageId } = await send({
            to: ctx.contactPhone,
            part: { kind: 'text', text: UNSUPPORTED_MEDIA_MESSAGE },
          });
          outbound.push({ body: UNSUPPORTED_MEDIA_MESSAGE, providerMessageId });
        }
        await persist({
          conversationId,
          contactId: ctx.contactId,
          contactPhone: ctx.contactPhone,
          fromStage: ctx.stage,
          toStage: ctx.stage,
          action: 'unsupported_media',
          extracted: ctx.known,
          outbound,
        });
        return {
          stage: ctx.stage,
          action: 'unsupported_media',
          text: alreadyTold ? '' : UNSUPPORTED_MEDIA_MESSAGE,
          sent: !alreadyTold,
        };
      }

      // Restart confirmation: an already-complete lead tapped "check fit" or "book
      // a meeting" again and was asked whether they really want to start over.
      // ONLY an explicit yes redoes the flow — anything else (a "no", a question, a
      // change of subject) simply clears the pending state and is handled as a
      // normal message, so the questionnaire is never re-run by accident.
      if (ctx.known.awaitingRestartConfirm) {
        const pendingChoice = ctx.known.pendingRestartChoice ?? 'check_fit';
        // The question is answered either way — the pending state ends here.
        delete ctx.known.awaitingRestartConfirm;
        delete ctx.known.pendingRestartChoice;

        if (isAffirmative(ctx.currentText)) {
          // Confirmed: drop the collected answers and re-run the chosen flow from
          // its first question. Booking keeps its top-urgency implications.
          const restartFacts: KnownFacts =
            pendingChoice === 'book_meeting'
              ? { bookingIntent: true, timeline: 'immediate' }
              : {};
          const decision = decideMainMenu(
            pendingChoice,
            'engaged',
            restartFacts,
            ctx.screenAll,
          );
          const question = screeningQuestionFor(decision.action);
          const part: OutboundPart = question
            ? questionPart(question)
            : {
                kind: 'list',
                body: MAIN_MENU.body,
                buttonLabel: MAIN_MENU.buttonLabel,
                rows: [...MAIN_MENU.rows],
              };
          const storeBody = question ? question.body : MAIN_MENU.body;
          logger.info({ conversationId, pendingChoice }, 'restart confirmed by the lead');

          const { providerMessageId } = await send({ to: ctx.contactPhone, part });
          await persist({
            conversationId,
            contactId: ctx.contactId,
            contactPhone: ctx.contactPhone,
            fromStage: ctx.stage,
            toStage: decision.nextStage,
            action: 'restart_confirmed',
            extracted: restartFacts,
            outbound: [{ body: storeBody, providerMessageId }],
          });
          return {
            stage: decision.nextStage,
            action: 'restart_confirmed',
            text: storeBody,
            sent: true,
          };
        }
        // An explicit "no" is answered here, deterministically. It must never reach
        // the classifier: a bare "לא" answering "are you sure?" has been read as an
        // OPT_OUT, which marked the lead do-not-contact and silenced the bot for
        // good — declining one offer is not a request to never be contacted again.
        if (isNegative(ctx.currentText)) {
          logger.info({ conversationId }, 'restart declined — nothing changes');
          const { providerMessageId } = await send({
            to: ctx.contactPhone,
            part: { kind: 'text', text: RESTART_DECLINED_MESSAGE },
          });
          await persist({
            conversationId,
            contactId: ctx.contactId,
            contactPhone: ctx.contactPhone,
            fromStage: ctx.stage,
            toStage: ctx.stage,
            action: 'restart_declined',
            extracted: ctx.known,
            outbound: [{ body: RESTART_DECLINED_MESSAGE, providerMessageId }],
          });
          return {
            stage: ctx.stage,
            action: 'restart_declined',
            text: RESTART_DECLINED_MESSAGE,
            sent: true,
          };
        }
        // Anything else (a question, a change of subject) is handled normally —
        // including a genuine opt-out, which must still be honoured.
        logger.info({ conversationId }, 'restart not confirmed — continuing as normal');
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

      // No-Hebrew filter: a message with no Hebrew letters at all — random
      // symbols, digits, emoji, or gibberish — carries no information for this
      // Hebrew-only bot. It must not be processed as an answer or acknowledged as
      // property details (which produced a spurious "תודה על הפרטים"). Redirect it
      // to keep the conversation on the property, with no model call. Skipped
      // during the opening and while collecting a specific answer (there the
      // normal validation/classification re-asks the pending question); an
      // explicit opt-out is still honored below.
      if (
        !hasHebrew(ctx.currentText) &&
        !isOptOutKeyword(ctx.currentText) &&
        !ctx.isFirstResponse &&
        !COLLECTING_STAGES.has(ctx.stage)
      ) {
        const holdStage: ConversationStage = ctx.stage === 'new' ? 'engaged' : ctx.stage;
        const { providerMessageId } = await send({
          to: ctx.contactPhone,
          part: { kind: 'text', text: OFF_TOPIC_REDIRECT_MESSAGE },
        });
        await persist({
          conversationId,
          contactId: ctx.contactId,
          contactPhone: ctx.contactPhone,
          fromStage: ctx.stage,
          toStage: holdStage,
          action: 'stay_on_topic',
          extracted: ctx.known,
          outbound: [{ body: OFF_TOPIC_REDIRECT_MESSAGE, providerMessageId }],
        });
        return {
          stage: holdStage,
          text: OFF_TOPIC_REDIRECT_MESSAGE,
          action: 'stay_on_topic',
          sent: true,
        };
      }

      // From here the turn does the slow model work (classification, and usually
      // generation). Show the person a "typing…" indicator and mark their message
      // read so the wait reads as a real reply being composed. Purely cosmetic and
      // best-effort: a failure here must never block the actual reply.
      if (ctx.currentMessageId) {
        try {
          await deps.channel.markTyping(ctx.currentMessageId);
        } catch (error) {
          logger.warn({ conversationId, error }, 'typing indicator failed (ignored)');
        }
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

      // Workflow-owned bookkeeping (photo count, restart confirmation, sent clips)
      // is application state, not an observation: whatever the model returned for
      // those fields is discarded so it can never write them.
      for (const field of WORKFLOW_OWNED_FIELDS) {
        delete validated.extracted[field];
      }

      // `seriousSeller` / `sellMotivation` are the answer to the intent question,
      // not to a screening button. If the classifier inferred them from a
      // screening answer (e.g. reading "כן, באופן פרטי" as low intent), drop them
      // so only the real intent-check answer can set them.
      if (ctx.stage !== 'assessing_intent') {
        delete validated.extracted.seriousSeller;
        delete validated.extracted.sellMotivation;
      }

      // Deterministic screening answer: when the message exactly matches one of
      // the pending question's fixed options (a tapped button, or the same word
      // typed), map it straight to the enum instead of trusting the classifier —
      // which occasionally missed a terse "לא"/"מיד" and re-asked the same
      // question. Treated as a confident answer for that field; opt-out still
      // wins (an option title is never an opt-out phrase, so this never fires on
      // one, but the guard keeps that explicit).
      const screeningAnswer = screeningAnswerFor(ctx.stage, ctx.currentText);
      if (screeningAnswer && validated.intent !== 'OPT_OUT') {
        validated.intent = 'ANSWER';
        validated.confidence = Math.max(validated.confidence, 0.9);
        Object.assign(validated.extracted, screeningAnswer);
      }

      // A tapped menu row is a deterministic, unambiguous choice, so it OUTRANKS a
      // classifier `OPT_OUT` read — which has mistaken a plain "בדיקת התאמה" tap for
      // "stop contacting me" and permanently silenced a live lead. A message that
      // trips the deterministic opt-out keywords is never treated as a menu choice,
      // so a genuine request to stop is still honoured (and `decideTransition` puts
      // opt-out first for everything else).
      const menuChoice = isOptOutKeyword(ctx.currentText)
        ? undefined
        : mainMenuChoiceFor(ctx.currentText);

      // The one place a stage is chosen — pure code, never the model. The very
      // first response opens with the welcome sequence (§2/§8); a menu tap routes
      // deterministically; anything else runs the classify-driven flow, which
      // applies opt-out before every other rule.
      let decision: Decision;
      if (ctx.isFirstResponse && validated.intent !== 'OPT_OUT') {
        decision = { nextStage: 'engaged', action: 'show_main_menu', escalate: false };
      } else if (menuChoice) {
        decision = decideMainMenu(menuChoice, ctx.stage, ctx.known, ctx.screenAll);
      } else {
        decision = decideTransition(ctx.stage, validated, ctx.known, ctx.screenAll);
      }

      // Booking intent: the "קביעת פגישה" menu choice, or a message the classifier
      // read as wanting to schedule / proceed. It is stored as a fact so it boosts
      // the lead's weighted priority (see leadPriorityScore). The brief booking
      // lead-in is sent only the first time AND only when this turn actually opens
      // the screening flow — never for an already-qualified lead who just says
      // "כן" (there is nothing left to collect; the acknowledgement is enough).
      // A `confirm_restart` turn only ASKS whether to start over; it must not write
      // booking facts onto a lead who has not confirmed anything yet.
      const bookingIntent =
        decision.action !== 'confirm_restart' &&
        (menuChoice === 'book_meeting' || validated.extracted.bookingIntent === true);
      const enteringScreening =
        decision.action === 'ask_sell_intent' ||
        decision.action === 'ask_neighborhood' ||
        decision.action === 'ask_timeline' ||
        decision.action === 'ask_currently_marketed';
      const bookingTriggered =
        bookingIntent && ctx.known.bookingIntent !== true && enteringScreening;

      // Assemble the ordered messages this turn will send.
      const plan: { part: OutboundPart; storeBody: string; usage?: LlmUsage[] }[] = [];

      // Opening (§2) on the very first bot response — but never greet someone
      // whose opening move is to opt out; that turn only acknowledges. Two
      // messages: the intro clip carrying the welcome as its caption, then the
      // elegant list menu (`show_main_menu` below). If the clip can't be sent it
      // is dropped (see the video-send handling); the welcome then arrives with
      // the menu that follows, so the greeting is never lost.
      if (ctx.isFirstResponse && decision.action !== 'acknowledge_opt_out') {
        plan.push({
          part: { kind: 'video', filePath: INTRO_VIDEO_PATH, caption: WELCOME_MESSAGE },
          storeBody: WELCOME_MESSAGE,
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

      // Testimonial video (Part B): when the customer asks for social proof — from
      // the menu or in their own words — attach a matching customer video before the
      // model-written text. Neighborhood-specific is preferred; unknown
      // neighborhoods are never guessed. The channel uploads and caches the file on
      // first send. Clips already sent are excluded, so asking again brings a
      // DIFFERENT testimonial rather than the same one twice.
      let sentTestimonial: string | undefined;
      if (decision.action === 'send_social_proof') {
        const selection = selectVideo({
          track: 'testimonial',
          intent: 'seller',
          neighborhoodCanonical: ctx.known.neighborhood ?? null,
          alreadySent: ctx.known.sentTestimonials ?? [],
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
          sentTestimonial = selection.asset.path;
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

      // The person asked something while also answering the pending question.
      // Answer them FIRST, then let the flow continue below with its own message —
      // otherwise the bot reads as a form that ignores anything it did not expect.
      // This reply deliberately ends without a question, since the screening
      // question follows it immediately.
      if (decision.addressFirst) {
        const aside = await generate({
          action: decision.addressFirst,
          escalate: decision.escalate,
          history: ctx.turns,
        });
        plan.push({
          part: { kind: 'text', text: aside.text },
          storeBody: aside.text,
          usage: aside.usage,
        });
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
      // A VIDEO is supplementary (an intro/testimonial/proof clip): if it cannot be
      // sent — a bad upload, an unreadable file (the EPERM that once crashed the
      // whole turn) — it is skipped and the turn still delivers its text reply. A
      // failed text/interactive send stays fatal: that IS the reply, so the turn
      // should fail and be retried rather than leave the person with nothing.
      const outbound: OutboundMessageRecord[] = [];
      for (const planned of plan) {
        if (planned.part.kind === 'video') {
          const providerMessageId = await sendOptionalMedia({
            to: ctx.contactPhone,
            part: planned.part,
          });
          if (providerMessageId === null) {
            // The clip was dropped. If it carried a caption — the opening welcome
            // rides on the intro video — send that caption as plain text so the
            // greeting is never lost, then carry on. (A failed text send here is
            // fatal, as it should be: the welcome is essential.)
            if (planned.part.caption) {
              const { providerMessageId: textId } = await send({
                to: ctx.contactPhone,
                part: { kind: 'text', text: planned.part.caption },
              });
              outbound.push({ body: planned.storeBody, providerMessageId: textId });
            }
            continue;
          }
          outbound.push({ body: planned.storeBody, providerMessageId });
          continue;
        }
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
          // Remember which flow is awaiting a yes, so the next message can act on
          // it (and only redo the flow they actually asked for).
          ...(decision.action === 'confirm_restart' && menuChoice
            ? {
                awaitingRestartConfirm: true,
                pendingRestartChoice: menuChoice as 'check_fit' | 'book_meeting',
              }
            : {}),
          // Remember the clip that went out, so the next request brings another one.
          ...(sentTestimonial
            ? {
                sentTestimonials: [
                  ...(ctx.known.sentTestimonials ?? []),
                  sentTestimonial,
                ],
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
