import type {
  Conversation,
  ConversationStage,
} from '../db/repositories/conversations.js';
import type { Analysis, StoredFacts } from './classify.js';
import type { AnswerValidation } from './validateAnswer.js';
import { cloneScreeningState, type ScreeningState } from './screeningState.js';

/**
 * `decideTransition` — turns a validated observation into the next stage (§5.1).
 *
 * This is the safety pin of the whole workflow: **plain TypeScript, no model
 * call.** The LLM produces an {@link Analysis} (an observation) and the validator
 * says which of it is a real answer; this function decides what it all means.
 * Because the stage and the qualification verdict are chosen here by
 * deterministic rules, a hallucinated stage or a bot that "qualifies" itself is
 * structurally impossible.
 *
 * What changed after the review (Part A): a screening question advances **only on
 * a valid answer**; an invalid or off-topic reply never advances the flow and is
 * escalated (re-ask → redirect → warn → stop) rather than accepted; and reaching
 * the last question no longer qualifies a lead — that is a separate quality
 * judgment (`assessQuality`), run once after a gentle motivation question.
 */

/** Screening facts gathered so far. */
export type KnownFacts = StoredFacts;

/** Reasons a conversation may be disqualified. Kept in sync with the DB enum. */
export type DisqualificationReason = NonNullable<Conversation['disqualificationReason']>;

/** What the reply-generation step should do this turn. */
export type TurnAction =
  | 'ask_sell_intent' // spec Q1 (direct-message leads only)
  | 'ask_neighborhood' // spec Q2
  | 'ask_timeline' // spec Q3 (direct-message leads only)
  | 'ask_currently_marketed' // spec Q4
  | 'ask_motivation' // one gentle seriousness question before handoff
  | 'proceed_qualified'
  | 'hold_needs_review' // in-between: thank them WITHOUT promising a handoff
  | 'send_disqualification'
  | 'acknowledge_opt_out'
  | 'answer_faq'
  | 'handle_objection'
  | 'send_testimonial' // customer asked for social proof
  | 'send_investment_promo' // buyer/investor interest
  | 'reject_english' // deterministic: Hebrew-only
  | 'redirect_off_topic' // deterministic: refocus on the property
  | 'warn_off_topic' // deterministic: final warning
  | 'stop_responding' // deterministic: silence, no send
  | 'clarify';

export interface Decision {
  nextStage: ConversationStage;
  action: TurnAction;
  /** Generate the reply with the stronger model (§7). */
  escalate: boolean;
  /** The rule that fired, for the audit trail and debug endpoint. */
  triggeredRule: string;
  /** Human-readable reason for this transition. */
  reason: string;
  /** Set only at the qualified/disqualified fork. */
  qualified?: boolean;
  disqualificationReason?: DisqualificationReason;
  /** Re-ask context when an answer failed validation. */
  revalidation?: { field: string; reason: string };
  /** A video to attempt to send this turn (selection happens in the turn). */
  media?: 'testimonial' | 'investment_promo';
  /**
   * When true, the turn must run the lead-quality judge and
   * {@link ../workflow/qualify.js} to finalize the verdict — the one place an
   * LLM call is folded into a decision, done outside this pure function.
   */
  assessQuality?: boolean;
}

/** The result of a decision: the next step plus the updated bookkeeping. */
export interface DecisionResult {
  decision: Decision;
  state: ScreeningState;
}

/**
 * Below this, the classification is not trusted enough to act on: the turn
 * routes to a clarifying question rather than a guessed transition.
 */
export const CONFIDENCE_THRESHOLD = 0.5;

/** Off-topic messages before the final warning is sent and the LLM is switched off. */
export const OFF_TOPIC_WARN_AT = 2;
/** Max times one question is re-asked before the reply is treated as off-topic. */
export const MAX_REASKS = 2;

/**
 * Whether to screen all four questions (spec §3). A Meta-lead-form lead answered
 * Q1 and Q3 on the form, so only Q2 and Q4 are asked; any other origin is
 * screened on all four. Defaults to the form path.
 */
export function screensAllQuestions(entryPoint: string | null | undefined): boolean {
  return entryPoint !== 'meta_lead_form';
}

export interface DecideInput {
  current: ConversationStage;
  analysis: Analysis;
  known: KnownFacts;
  validation: AnswerValidation;
  screenAll: boolean;
  state: ScreeningState;
}

export function decideTransition(input: DecideInput): DecisionResult {
  const { current, analysis, known, validation, screenAll } = input;
  const state = cloneScreeningState(input.state);

  const escalate = analysis.needsEscalation;
  const facts: KnownFacts = { ...known, ...validation.validFacts };

  // Record any newly-accepted valid answers, and note unknown neighborhoods.
  recordValidAnswers(state, validation);

  // 1. Opt-out wins from any stage — a legal and trust obligation, not a branch.
  if (analysis.intent === 'OPT_OUT') {
    return result(state, {
      nextStage: 'opted_out',
      action: 'acknowledge_opt_out',
      escalate: false,
      triggeredRule: 'opt_out',
      reason: 'Customer asked to stop being contacted',
    });
  }

  // 2. Spec disqualifiers, on the merged valid facts. Highest business priority
  //    after opt-out: an answer given earlier still disqualifies later.
  const specReason = disqualifyingReason(facts);
  if (specReason) {
    return result(state, {
      nextStage: 'disqualified',
      action: 'send_disqualification',
      qualified: false,
      disqualificationReason: specReason,
      escalate,
      triggeredRule: 'spec_disqualifier',
      reason: `Disqualified by spec rule: ${specReason}`,
    });
  }

  // 3. Off-topic / unrelated → escalate (redirect → warn → stop). Also the path
  //    for a reply that has been re-asked too many times.
  const offTopic = analysis.intent === 'OFF_TOPIC' || !analysis.relevantToSelling;
  const reaskExhausted = state.reaskCount >= MAX_REASKS;
  if (offTopic || reaskExhausted) {
    return escalateOffTopic(state, current, reaskExhausted);
  }

  // 4. Social-proof request → testimonial video (text fallback if none suitable).
  if (analysis.wantsSocialProof && analysis.contactIntent !== 'investor') {
    return result(state, {
      nextStage: holdStage(current),
      action: 'send_testimonial',
      media: 'testimonial',
      escalate,
      triggeredRule: 'social_proof_request',
      reason: 'Customer asked for recommendations / social proof',
    });
  }

  // 5. Buyer/investor interest → the investment promo, at most once.
  if (
    (analysis.contactIntent === 'investor' || analysis.contactIntent === 'buyer') &&
    !state.promoSent
  ) {
    return result(state, {
      nextStage: holdStage(current),
      action: 'send_investment_promo',
      media: 'investment_promo',
      escalate,
      triggeredRule: 'investment_interest',
      reason: `Detected ${analysis.contactIntent} intent`,
    });
  }

  // 6. Low confidence or genuinely unclear: never guess — ask, on the stronger model.
  if (analysis.intent === 'UNCLEAR' || analysis.confidence < CONFIDENCE_THRESHOLD) {
    return result(state, {
      nextStage: holdStage(current),
      action: 'clarify',
      escalate: true,
      triggeredRule: 'low_confidence',
      reason: 'Message was unclear or low-confidence',
    });
  }

  // 7. Objection → address the concern; do not advance screening.
  if (analysis.intent === 'OBJECTION') {
    return result(state, {
      nextStage: holdStage(current),
      action: 'handle_objection',
      escalate: true,
      triggeredRule: 'objection',
      reason: 'Customer raised an objection',
    });
  }

  // 8. FAQ → answer without advancing screening.
  if (analysis.intent === 'FAQ') {
    return result(state, {
      nextStage: holdStage(current),
      action: 'answer_faq',
      escalate,
      triggeredRule: 'faq',
      reason: 'Customer asked a general question',
    });
  }

  // 9. The gentle motivation answer → run the quality judge (in the turn).
  if (current === 'assessing_motivation') {
    return result(state, {
      nextStage: current, // finalized after the judge runs
      action: 'ask_motivation',
      escalate,
      triggeredRule: 'motivation_answered',
      reason: 'Motivation answered — assessing lead quality',
      assessQuality: true,
    });
  }

  // 10. ANSWER intent but the pending answer failed validation → re-ask, no advance.
  if (analysis.intent === 'ANSWER' && validation.invalidAttempts.length > 0) {
    const bad = validation.invalidAttempts[0]!;
    state.invalidAnswerCount += 1;
    state.reaskCount += 1;
    state.answers[bad.field] = { value: bad.value, isValid: false, reason: bad.reason };
    return result(state, {
      nextStage: holdStage(current),
      action: clarifyActionForField(bad.field),
      escalate,
      triggeredRule: `${bad.field}_validation`,
      reason: `Invalid ${bad.field}: ${bad.reason}`,
      revalidation: { field: bad.field, reason: bad.reason },
    });
  }

  // 11. ANSWER: advance screening one question at a time (Q1 → Q2 → Q3 → Q4),
  //     only on valid answers. Q1/Q3 are asked only for non-form leads.
  state.reaskCount = 0; // a valid, on-topic answer clears the re-ask streak
  if (screenAll && facts.sellIntent === undefined) {
    return ask(state, 'screening_sell_intent', 'ask_sell_intent', escalate);
  }
  if (facts.neighborhood === undefined) {
    return ask(state, 'screening_neighborhood', 'ask_neighborhood', escalate);
  }
  if (screenAll && facts.timeline === undefined) {
    return ask(state, 'screening_timeline', 'ask_timeline', escalate);
  }
  if (facts.currentlyMarketed === undefined) {
    return ask(state, 'screening_currently_marketed', 'ask_currently_marketed', escalate);
  }

  // 12. All four valid → the gentle motivation question, before any handoff.
  return result(state, {
    nextStage: 'assessing_motivation',
    action: 'ask_motivation',
    escalate,
    triggeredRule: 'screening_complete',
    reason: 'All screening answers collected; probing motivation',
  });
}

/** Off-topic escalation: redirect → warn (+containment) → stop. */
function escalateOffTopic(
  state: ScreeningState,
  current: ConversationStage,
  reaskExhausted: boolean,
): DecisionResult {
  state.irrelevantResponseCount += 1;
  const rule = reaskExhausted ? 'reask_exhausted' : 'off_topic';

  // Already warned → stop responding. Terminal and silent; never qualifies.
  if (state.warningSent) {
    state.mode = 'containment';
    return result(state, {
      nextStage: 'disqualified',
      action: 'stop_responding',
      qualified: false,
      disqualificationReason: 'off_topic_abandoned',
      escalate: false,
      triggeredRule: 'off_topic_stop',
      reason: 'Off-topic continued after the warning — no longer responding',
    });
  }

  // Second strike → final warning, and switch the LLM off for this conversation.
  if (state.irrelevantResponseCount >= OFF_TOPIC_WARN_AT) {
    state.warningSent = true;
    state.mode = 'containment';
    return result(state, {
      nextStage: holdStage(current),
      action: 'warn_off_topic',
      escalate: false,
      triggeredRule: 'off_topic_warn',
      reason: 'Repeated off-topic messages — final warning, AI disabled',
    });
  }

  // First strike → a single redirect, still allowing recovery on the next turn.
  return result(state, {
    nextStage: holdStage(current),
    action: 'redirect_off_topic',
    escalate: false,
    triggeredRule: rule,
    reason: 'Message unrelated to selling — redirecting',
  });
}

/** Records valid answers into the per-field answer log. */
function recordValidAnswers(state: ScreeningState, validation: AnswerValidation): void {
  const f = validation.validFacts;
  if (f.sellIntent !== undefined) {
    state.answers.sellIntent = { value: f.sellIntent, isValid: true };
  }
  if (f.neighborhood !== undefined) {
    state.answers.neighborhood = { value: f.neighborhood, isValid: true };
  }
  if (f.timeline !== undefined) {
    state.answers.timeline = { value: f.timeline, isValid: true };
  }
  if (f.currentlyMarketed !== undefined) {
    state.answers.currentlyMarketed = { value: f.currentlyMarketed, isValid: true };
  }
  if (
    validation.unknownNeighborhood !== undefined &&
    !state.unknownNeighborhoods.includes(validation.unknownNeighborhood)
  ) {
    state.unknownNeighborhoods.push(validation.unknownNeighborhood);
  }
}

/** Which question to re-ask for a failed field. */
function clarifyActionForField(field: string): TurnAction {
  return field === 'neighborhood' ? 'ask_neighborhood' : 'clarify';
}

function ask(
  state: ScreeningState,
  nextStage: ConversationStage,
  action: TurnAction,
  escalate: boolean,
): DecisionResult {
  return result(state, {
    nextStage,
    action,
    escalate,
    triggeredRule: 'advance_screening',
    reason: `Advancing to ${action}`,
  });
}

function result(state: ScreeningState, decision: Decision): DecisionResult {
  return { decision, state };
}

/** The spec's disqualifiers, mapped from screening facts. First match wins. */
function disqualifyingReason(facts: KnownFacts): DisqualificationReason | undefined {
  if (facts.sellIntent === 'not_selling') return 'not_selling';
  if (facts.timeline === 'no_urgency') return 'no_urgency';
  if (facts.currentlyMarketed === 'with_agent') return 'exclusive_with_other_agent';
  return undefined;
}

/**
 * The stage to hold when a turn doesn't advance screening. A first inbound must
 * not linger in `new`; everything else stays where it is.
 */
function holdStage(current: ConversationStage): ConversationStage {
  return current === 'new' || current === 'awaiting_first_contact' ? 'engaged' : current;
}
