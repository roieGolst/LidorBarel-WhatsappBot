import type {
  Conversation,
  ConversationStage,
} from '../db/repositories/conversations.js';
import type { Analysis } from './classify.js';

/**
 * `decideTransition` — turns a classification into the next stage (§5.1).
 *
 * This is the safety pin of the whole workflow: **plain TypeScript, no model
 * call.** The LLM produces an {@link Analysis} (an observation); this function
 * decides what it means. Because the stage is chosen here by deterministic
 * rules over that observation, a hallucinated stage is structurally impossible —
 * the model has no way to write `conversations.stage`.
 *
 * The rules are the spec's, in priority order, and nothing here invents business
 * logic on top of them.
 */

/** Screening facts gathered so far — same shape as the classifier's extraction. */
export type KnownFacts = Analysis['extracted'];

/** Reasons a conversation may be disqualified. Kept in sync with the DB enum. */
export type DisqualificationReason = NonNullable<Conversation['disqualificationReason']>;

/** What the reply-generation step should do this turn. */
export type TurnAction =
  | 'ask_neighborhood' // spec Q2
  | 'ask_currently_marketed' // spec Q4
  | 'proceed_qualified'
  | 'send_disqualification'
  | 'acknowledge_opt_out'
  | 'answer_faq'
  | 'handle_objection'
  | 'clarify';

export interface Decision {
  nextStage: ConversationStage;
  action: TurnAction;
  /** Generate the reply with the stronger model (§7). */
  escalate: boolean;
  /** Set only at the qualified/disqualified fork. */
  qualified?: boolean;
  disqualificationReason?: DisqualificationReason;
}

/**
 * Below this, the classification is not trusted enough to act on: the turn
 * routes to a clarifying question rather than a guessed transition.
 */
export const CONFIDENCE_THRESHOLD = 0.5;

export function decideTransition(
  current: ConversationStage,
  analysis: Analysis,
  known: KnownFacts = {},
): Decision {
  // Whether the reply needs the stronger model. Frustration or an unclear read
  // pushes to Sonnet; screening answers stay on Haiku (§7).
  const escalate = analysis.needsEscalation;

  // 1. Opt-out wins from any stage, before any other consideration. It is a
  //    legal and trust obligation, not a conversational branch.
  if (analysis.intent === 'OPT_OUT') {
    return { nextStage: 'opted_out', action: 'acknowledge_opt_out', escalate: false };
  }

  // 2. Low confidence or a genuinely unclear message: never guess a transition.
  //    Ask, on the stronger model, rather than act on a shaky read.
  if (analysis.intent === 'UNCLEAR' || analysis.confidence < CONFIDENCE_THRESHOLD) {
    return { nextStage: holdStage(current), action: 'clarify', escalate: true };
  }

  // Fold this turn's extraction over what we already knew. Q1/Q3 arrive
  // pre-filled from the lead form; Q2/Q4 accumulate across screening turns.
  const facts: KnownFacts = { ...known, ...analysis.extracted };

  // 3. Disqualification — spec rules only, the highest business priority after
  //    opt-out. Checked on the merged facts so an answer given earlier still
  //    disqualifies even when this turn is about something else.
  const reason = disqualifyingReason(facts);
  if (reason) {
    return {
      nextStage: 'disqualified',
      action: 'send_disqualification',
      qualified: false,
      disqualificationReason: reason,
      escalate,
    };
  }

  // 4. An objection is not an answer: address the concern instead of advancing
  //    screening, and reach for the stronger model to do it.
  if (analysis.intent === 'OBJECTION') {
    return { nextStage: holdStage(current), action: 'handle_objection', escalate: true };
  }

  // 5. FAQ / off-topic: respond without moving the screening forward.
  if (analysis.intent === 'FAQ') {
    return { nextStage: holdStage(current), action: 'answer_faq', escalate };
  }
  if (analysis.intent === 'OFF_TOPIC') {
    return { nextStage: holdStage(current), action: 'clarify', escalate };
  }

  // 6. ANSWER: advance screening. The bot only asks Q2 (neighborhood) and Q4
  //    (currently marketed) — one question at a time, in order — since Q1/Q3
  //    are already answered by the form.
  if (facts.neighborhood === undefined) {
    return { nextStage: 'screening_neighborhood', action: 'ask_neighborhood', escalate };
  }
  if (facts.currentlyMarketed === undefined) {
    return {
      nextStage: 'screening_currently_marketed',
      action: 'ask_currently_marketed',
      escalate,
    };
  }

  // Both screening answers are in and none disqualifies → qualified.
  return {
    nextStage: 'qualified',
    action: 'proceed_qualified',
    qualified: true,
    escalate,
  };
}

/** The spec's disqualifiers, mapped from screening facts. First match wins. */
function disqualifyingReason(facts: KnownFacts): DisqualificationReason | undefined {
  if (facts.sellIntent === 'not_selling') return 'not_selling';
  if (facts.timeline === 'no_urgency') return 'no_urgency';
  if (facts.currentlyMarketed === 'with_agent') return 'exclusive_with_other_agent';
  return undefined;
}

/**
 * The stage to hold when a turn doesn't advance screening (a clarification, an
 * objection, an FAQ). A first inbound must not linger in `new`; everything else
 * stays where it is.
 */
function holdStage(current: ConversationStage): ConversationStage {
  return current === 'new' || current === 'awaiting_first_contact' ? 'engaged' : current;
}
