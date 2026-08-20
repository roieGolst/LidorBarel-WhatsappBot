import { entrypoint, task } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { Database } from '../db/client.js';
import { findContactById } from '../db/repositories/contacts.js';
import {
  getConversationById,
  type ConversationStage,
} from '../db/repositories/conversations.js';
import { listSendableAssets } from '../db/repositories/mediaAssets.js';
import { recentMessages } from '../db/repositories/messages.js';
import { isOptedOut } from '../db/repositories/optOuts.js';
import { getLogger } from '../logger.js';
import type { LlmClient, LlmMessage } from '../llm/client.js';
import type { OutboundResult, WhatsAppChannel } from '../whatsapp/channel.js';
import { guardedSend, guardedSendMedia } from '../whatsapp/guardedSend.js';
import {
  classifyAndExtract,
  judgeLeadQuality,
  type Analysis,
  type StoredFacts,
} from './classify.js';
import {
  decideTransition,
  screensAllQuestions,
  type Decision,
  type TurnAction,
} from './decide.js';
import {
  deterministicReply,
  generateValidatedReply,
  SAFE_VARIANTS,
  type ValidatedReply,
} from './generate.js';
import { isPredominantlyEnglish } from './language.js';
import { isOptOutKeyword } from './optOutKeywords.js';
import { persistTurn, type OutboundRecord, type PersistTurnInput } from './persist.js';
import { assessQualification } from './qualify.js';
import {
  cloneScreeningState,
  toScreeningState,
  type ScreeningState,
} from './screeningState.js';
import { selectVideo, type SendableVideo, type VideoTrack } from './testimonial.js';
import { validateAnswers } from './validateAnswer.js';

/**
 * The conversation workflow — one turn (§5.1), now with the review's validation
 * and quality layer.
 *
 *   load → [containment / English gate: deterministic, no model]
 *        → classify → validateAnswer → decide
 *        → [after Q4: judge quality → qualify]
 *        → generate / select video → send → persist
 *
 * Two invariants hold as before: a stage is only ever chosen by `decideTransition`
 * (pure TS), and every send passes `guardedSend`/`guardedSendMedia`. Two new ones:
 * only *validated* facts are stored, and a conversation in containment mode makes
 * **no** LLM calls at all.
 */
export interface ConversationDeps {
  db: Database;
  llm: LlmClient;
  channel: WhatsAppChannel;
}

export interface TurnContext {
  stage: ConversationStage;
  known: StoredFacts;
  screeningState: ScreeningState;
  contactId: string;
  contactPhone: string;
  screenAll: boolean;
  optedOut: boolean;
  currentText: string;
  classifyHistory: LlmMessage[];
  turns: LlmMessage[];
}

export interface TurnResult {
  stage: ConversationStage;
  text: string;
  action: string;
  sent: boolean;
}

/** Reads everything a turn needs from Postgres and shapes it into primitives. */
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
    screeningState: toScreeningState(conversation.screeningState),
    contactId: contact.id,
    contactPhone: contact.phone,
    screenAll: screensAllQuestions(contact.entryPoint),
    optedOut: await isOptedOut(db, contact.phone),
    currentText: last.content,
    classifyHistory: turns.slice(0, -1),
    turns,
  };
}

/** Builds the checkpointed conversation-turn workflow. */
export function createConversationWorkflow(
  deps: ConversationDeps,
  checkpointer: BaseCheckpointSaver,
) {
  const logger = getLogger();

  const load = task('ct_loadContext', (conversationId: string) =>
    loadContext(deps.db, conversationId),
  );

  const classify = task('ct_classify', (args: { text: string; history: LlmMessage[] }) =>
    classifyAndExtract(deps.llm, args),
  );

  const judge = task('ct_judge', (args: { history: LlmMessage[] }) =>
    judgeLeadQuality(deps.llm, args),
  );

  const generate = task(
    'ct_generate',
    (args: { action: TurnAction; escalate: boolean; history: LlmMessage[] }) =>
      generateValidatedReply(deps.llm, args),
  );

  const send = task('ct_send', (args: { to: string; text: string }) =>
    guardedSend(deps.db, deps.channel, args.to, args.text),
  );

  const sendVideoTask = task(
    'ct_sendVideo',
    (args: { to: string; mediaId: string; caption?: string }) =>
      guardedSendMedia(deps.db, deps.channel, args.to, args.mediaId, args.caption),
  );

  const persist = task('ct_persist', (args: PersistTurnInput) =>
    persistTurn(deps.db, args),
  );

  return entrypoint(
    { name: 'conversationTurn', checkpointer },
    async (conversationId: string): Promise<TurnResult> => {
      const ctx = await load(conversationId);

      // Already opted out: silence. The acknowledgement went out on the turn that
      // recorded the opt-out.
      if (ctx.optedOut) {
        return { stage: ctx.stage, action: 'skipped_opted_out', text: '', sent: false };
      }

      // -------------------------------------------------------------------
      // Deterministic (no-LLM) paths: containment and the English gate. Both
      // still honor an explicit opt-out via the keyword safety net.
      // -------------------------------------------------------------------
      const inContainment = ctx.screeningState.mode === 'containment';
      const english = isPredominantlyEnglish(ctx.currentText);

      // Thin adapters collapse LangGraph's `task` double-Promise typing.
      const sendText = async (args: {
        to: string;
        text: string;
      }): Promise<OutboundResult> => send(args);
      const sendVideo = async (args: {
        to: string;
        mediaId: string;
        caption?: string;
      }): Promise<OutboundResult> => sendVideoTask(args);
      const generateReply = async (args: {
        action: TurnAction;
        escalate: boolean;
        history: LlmMessage[];
      }): Promise<ValidatedReply> => generate(args);

      if (inContainment || english) {
        const { decision, state, text } = deterministicTurn(ctx, inContainment);
        const outbound = text
          ? await sendDeterministic(sendText, ctx.contactPhone, text)
          : undefined;
        await persist(
          buildPersist(conversationId, ctx, decision, ctx.known, state, outbound),
        );
        return {
          stage: decision.nextStage,
          action: decision.action,
          text: text ?? '',
          sent: outbound !== undefined,
        };
      }

      // -------------------------------------------------------------------
      // Normal path.
      // -------------------------------------------------------------------
      const { analysis } = await classify({
        text: ctx.currentText,
        history: ctx.classifyHistory,
      });

      const validation = validateAnswers(analysis.extracted, analysis);
      const mergedExtracted: StoredFacts = { ...ctx.known, ...validation.validFacts };

      if (validation.unknownNeighborhood) {
        // Surface for review so the reference list can grow (Part B).
        logger.info(
          { conversationId, unknownNeighborhood: validation.unknownNeighborhood },
          'unknown neighborhood accepted and saved verbatim',
        );
      }

      let { decision, state } = decideTransition({
        current: ctx.stage,
        analysis,
        known: ctx.known,
        validation,
        screenAll: ctx.screenAll,
        state: ctx.screeningState,
      });

      // The one place an LLM call folds into a decision: judge overall lead
      // quality after the motivation answer, then let pure code set the verdict.
      if (decision.assessQuality) {
        const { quality } = await judge({ history: ctx.turns });
        const qualification = assessQualification({
          facts: mergedExtracted,
          quality,
          screenAll: ctx.screenAll,
          irrelevantResponseCount: state.irrelevantResponseCount,
          invalidAnswerCount: state.invalidAnswerCount,
        });
        state = cloneScreeningState(state);
        state.qualification = qualification;
        decision = finalizeQualification(
          qualification.reasons[0] ?? '',
          qualification.status,
        );
        logger.info(
          { conversationId, status: qualification.status, score: qualification.score },
          'lead quality assessed',
        );
      }

      // Media actions: try to send a video; fall back to a text reply if none fits.
      const outbound = await produceOutbound(
        {
          generate: generateReply,
          send: sendText,
          sendVideoTask: sendVideo,
          db: deps.db,
          logger,
        },
        conversationId,
        ctx,
        decision,
        analysis.contactIntent,
        mergedExtracted,
        state,
      );

      await persist(
        buildPersist(
          conversationId,
          ctx,
          decision,
          mergedExtracted,
          state,
          outbound.record,
        ),
      );

      return {
        stage: decision.nextStage,
        action: decision.action,
        text: outbound.text,
        sent: outbound.record !== undefined,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Deterministic (no-LLM) turn
// ---------------------------------------------------------------------------

function deterministicTurn(
  ctx: TurnContext,
  inContainment: boolean,
): { decision: Decision; state: ScreeningState; text: string | null } {
  const state = cloneScreeningState(ctx.screeningState);

  // Explicit opt-out is honored even here.
  if (isOptOutKeyword(ctx.currentText)) {
    return {
      decision: {
        nextStage: 'opted_out',
        action: 'acknowledge_opt_out',
        escalate: false,
        triggeredRule: 'opt_out_keyword',
        reason: 'Explicit opt-out keyword (no-LLM path)',
      },
      state,
      text: SAFE_VARIANTS.acknowledge_opt_out,
    };
  }

  if (inContainment) {
    state.irrelevantResponseCount += 1;
    // The warning was sent when containment was entered, so a further message
    // means we stop responding: terminal and silent, never qualified.
    if (state.warningSent) {
      return {
        decision: {
          nextStage: 'disqualified',
          action: 'stop_responding',
          qualified: false,
          disqualificationReason: 'off_topic_abandoned',
          escalate: false,
          triggeredRule: 'containment_stop',
          reason: 'Off-topic continued after warning — no longer responding',
        },
        state,
        text: null,
      };
    }
    // Defensive: reached containment without a warning yet — send it now.
    state.warningSent = true;
    return {
      decision: {
        nextStage: holdStageExternal(ctx.stage),
        action: 'warn_off_topic',
        escalate: false,
        triggeredRule: 'containment_warn',
        reason: 'Final off-topic warning',
      },
      state,
      text: deterministicReply('warn_off_topic'),
    };
  }

  // English gate: unsupported input — no fact change, no advance.
  return {
    decision: {
      nextStage: holdStageExternal(ctx.stage),
      action: 'reject_english',
      escalate: false,
      triggeredRule: 'english_only',
      reason: 'Message was predominantly English',
    },
    state,
    text: deterministicReply('reject_english'),
  };
}

async function sendDeterministic(
  send: (args: { to: string; text: string }) => Promise<OutboundResult>,
  to: string,
  text: string,
): Promise<OutboundRecord> {
  const result = await send({ to, text });
  return { providerMessageId: result.providerMessageId, body: text };
}

// ---------------------------------------------------------------------------
// Reply / media production
// ---------------------------------------------------------------------------

interface OutboundDeps {
  generate: (args: {
    action: TurnAction;
    escalate: boolean;
    history: LlmMessage[];
  }) => Promise<ValidatedReply>;
  send: (args: { to: string; text: string }) => Promise<OutboundResult>;
  sendVideoTask: (args: {
    to: string;
    mediaId: string;
    caption?: string;
  }) => Promise<OutboundResult>;
  db: Database;
  logger: ReturnType<typeof getLogger>;
}

/**
 * Produces the outbound message for a decision: a video for a media action (with
 * a text fallback when nothing suitable exists), a fixed string for a
 * deterministic action, nothing for `stop_responding`, else a validated LLM reply.
 */
async function produceOutbound(
  deps: OutboundDeps,
  conversationId: string,
  ctx: TurnContext,
  decision: Decision,
  intent: Analysis['contactIntent'],
  facts: StoredFacts,
  state: ScreeningState,
): Promise<{ record: OutboundRecord | undefined; text: string }> {
  if (decision.action === 'stop_responding') {
    return { record: undefined, text: '' };
  }

  // Media actions.
  if (decision.media) {
    const track: VideoTrack =
      decision.media === 'investment_promo' ? 'investment_promo' : 'testimonial';
    const assets = (await listSendableAssets(deps.db)).map(toSendable);
    const selection = selectVideo({
      track,
      intent,
      neighborhoodCanonical: facts.neighborhoodCanonical ?? null,
      alreadySent: state.sentVideoIds,
      promoSent: state.promoSent,
      assets,
    });

    deps.logger.info(
      {
        conversationId,
        track,
        intent,
        neighborhood: facts.neighborhoodCanonical ?? null,
        decision: selection.kind,
        reason: selection.reason,
        ...(selection.kind === 'send'
          ? {
              asset: selection.asset.path,
              matchedNeighborhood: selection.matchedNeighborhood,
            }
          : {}),
      },
      'video selection',
    );

    if (selection.kind === 'send') {
      const result = await deps.sendVideoTask({
        to: ctx.contactPhone,
        mediaId: selection.asset.mediaId,
      });
      state.sentVideoIds.push(selection.asset.id);
      if (track === 'investment_promo') state.promoSent = true;
      return {
        record: {
          providerMessageId: result.providerMessageId,
          body: '',
          mediaType: 'video',
          mediaRef: selection.asset.path,
        },
        text: '',
      };
    }
    // No suitable video — fall through to the text reply for this action.
  }

  // Deterministic fixed text (shouldn't normally reach here on the normal path,
  // but kept for completeness).
  const fixed = deterministicReply(decision.action, state.irrelevantResponseCount);
  if (fixed !== null) {
    const result = await deps.send({ to: ctx.contactPhone, text: fixed });
    return {
      record: { providerMessageId: result.providerMessageId, body: fixed },
      text: fixed,
    };
  }

  // Validated LLM reply.
  const reply = await deps.generate({
    action: decision.action,
    escalate: decision.escalate,
    history: ctx.turns,
  });
  const result = await deps.send({ to: ctx.contactPhone, text: reply.text });
  return {
    record: {
      providerMessageId: result.providerMessageId,
      body: reply.text,
      usage: reply.usage,
      regenerated: reply.regenerated,
      fellBack: reply.fellBack,
    },
    text: reply.text,
  };
}

function toSendable(asset: {
  id: string;
  path: string;
  mediaId: string | null;
  type: string;
  neighborhoods: unknown;
  audience: string | null;
}): SendableVideo {
  return {
    id: asset.id,
    path: asset.path,
    mediaId: asset.mediaId ?? '',
    type: asset.type,
    neighborhoods: Array.isArray(asset.neighborhoods)
      ? (asset.neighborhoods as string[])
      : [],
    audience: asset.audience,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maps a quality status onto the final decision for the handoff fork. */
function finalizeQualification(reason: string, status: string): Decision {
  if (status === 'qualified') {
    return {
      nextStage: 'qualified',
      action: 'proceed_qualified',
      qualified: true,
      escalate: false,
      triggeredRule: 'qualified',
      reason: reason || 'Lead qualified',
    };
  }
  if (status === 'disqualified') {
    return {
      nextStage: 'disqualified',
      action: 'send_disqualification',
      qualified: false,
      disqualificationReason: 'spam_or_abuse',
      escalate: false,
      triggeredRule: 'quality_disqualified',
      reason: reason || 'Disqualified on quality',
    };
  }
  return {
    nextStage: 'needs_review',
    action: 'hold_needs_review',
    qualified: false,
    escalate: false,
    triggeredRule: 'needs_review',
    reason: reason || 'Held for review',
  };
}

function buildPersist(
  conversationId: string,
  ctx: TurnContext,
  decision: Decision,
  mergedExtracted: StoredFacts,
  screeningState: ScreeningState,
  outbound: OutboundRecord | undefined,
): PersistTurnInput {
  return {
    conversationId,
    contactId: ctx.contactId,
    contactPhone: ctx.contactPhone,
    fromStage: ctx.stage,
    decision,
    mergedExtracted,
    screeningState,
    ...(outbound ? { outbound } : {}),
  };
}

/** `holdStage` duplicated here for the deterministic paths (decide keeps its own). */
function holdStageExternal(current: ConversationStage): ConversationStage {
  return current === 'new' || current === 'awaiting_first_contact' ? 'engaged' : current;
}
