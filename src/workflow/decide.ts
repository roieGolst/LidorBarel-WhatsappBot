import type {
  Conversation,
  ConversationStage,
} from '../db/repositories/conversations.js';
import type { Analysis } from './classify.js';
import type { MainMenuChoice } from './interactive.js';

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
  | 'show_main_menu' // spec §8 opening buttons
  | 'ask_sell_intent' // spec Q1 (direct-message leads only)
  | 'ask_neighborhood' // spec Q2
  | 'ask_timeline' // spec Q3 (direct-message leads only)
  | 'ask_currently_marketed' // spec Q4
  | 'ask_exclusivity' // Q4 = with another agent: capture exclusivity end + follow-up
  | 'ask_intent' // gauge seriousness/motivation before handing off
  | 'low_intent_hold' // just price-checking → don't forward to Lidor
  | 'proceed_qualified'
  | 'send_disqualification'
  | 'acknowledge_opt_out'
  | 'answer_faq'
  | 'handle_objection'
  | 'send_social_proof' // main-menu "testimonials"
  | 'handoff_to_human' // main-menu "talk to me" / "book a meeting"
  | 'acknowledge_additional_info'; // extra details after the lead already qualified

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
 * Below this, a classification is not trusted enough to act on. A shaky read
 * contributes no screening facts and triggers no FAQ/objection branch — the turn
 * simply keeps the flow moving by re-asking the pending screening question,
 * rather than acting on a guess.
 */
export const CONFIDENCE_THRESHOLD = 0.5;

/**
 * Whether to screen all four questions (spec §3).
 *
 * A Meta-lead-form lead answered Q1 (intent) and Q3 (timeline) on the form, so
 * the bot re-asks neither — only Q2 and Q4. Any other origin (a direct WhatsApp
 * message, a click-to-chat ad, an unknown source) has answered nothing, so all
 * four are screened. Defaults to the form path so a caller that omits the origin
 * keeps the narrower, less-intrusive flow.
 */
export function screensAllQuestions(entryPoint: string | null | undefined): boolean {
  return entryPoint !== 'meta_lead_form';
}

export function decideTransition(
  current: ConversationStage,
  analysis: Analysis,
  known: KnownFacts = {},
  screenAll = false,
): Decision {
  // Whether the reply needs the stronger model. Frustration pushes to Sonnet;
  // screening answers stay on Haiku (§7).
  const escalate = analysis.needsEscalation;

  // 1. Opt-out wins from any stage, before any other consideration. It is a
  //    legal and trust obligation, not a conversational branch.
  if (analysis.intent === 'OPT_OUT') {
    return { nextStage: 'opted_out', action: 'acknowledge_opt_out', escalate: false };
  }

  // A shaky read (unclear, or below the confidence threshold) contributes no
  // facts and no bespoke branch: rather than stall the person on "please
  // rephrase", the turn falls through to the screening flow and re-asks the
  // pending question. Only a confident read advances screening or answers an
  // FAQ/objection.
  const confident =
    analysis.intent !== 'UNCLEAR' && analysis.confidence >= CONFIDENCE_THRESHOLD;
  const facts: KnownFacts = confident ? { ...known, ...analysis.extracted } : known;

  // 2. Marketed through another agent, then disqualification — the highest
  //    business priority after opt-out. Checked on the merged facts so an answer
  //    given earlier still applies even when this turn is about something else.
  const blocked = exclusivityOrDisqualification(facts, escalate);
  if (blocked) return blocked;

  // 3. A confident objection or FAQ gets a bespoke reply, without advancing
  //    screening. An objection reaches for the stronger model to handle it.
  if (confident && analysis.intent === 'OBJECTION') {
    return { nextStage: holdStage(current), action: 'handle_objection', escalate: true };
  }
  if (confident && analysis.intent === 'FAQ') {
    return { nextStage: holdStage(current), action: 'answer_faq', escalate };
  }

  // 4. Already qualified: the conversation stays open for more property details,
  //    which are appended to the lead. Don't re-run screening or re-send the
  //    handoff — just acknowledge.
  if (current === 'qualified') {
    return { nextStage: 'qualified', action: 'acknowledge_additional_info', escalate };
  }

  // 5. Screening flow — the default. A greeting, filler ("יאללה"), an unclear or
  //    off-topic message, or an actual answer all funnel here: ask the next
  //    pending question (or qualify). An unparseable answer simply re-asks the
  //    same question, whose buttons are already in front of the person — the flow
  //    never dead-ends on "rephrase".
  return nextScreeningStep(current, facts, screenAll, escalate);
}

/**
 * Routes a main-menu selection (spec §8) — deterministic, no model call, since
 * the choice is a known button, not free text.
 *
 * `check_fit` starts the screening (after the same disqualification check the
 * normal flow applies); `testimonials` sends social proof; `learn_more` answers
 * about the service; `book_meeting` and `talk_to_human` both hand off to Lidor
 * (booking itself is a later milestone, so high intent goes straight to a human).
 */
export function decideMainMenu(
  choice: MainMenuChoice,
  current: ConversationStage,
  known: KnownFacts = {},
  screenAll = false,
): Decision {
  switch (choice) {
    case 'check_fit': {
      const blocked = exclusivityOrDisqualification(known, false);
      if (blocked) return blocked;
      return nextScreeningStep(current, known, screenAll, false);
    }
    case 'testimonials':
      return {
        nextStage: holdStage(current),
        action: 'send_social_proof',
        escalate: false,
      };
    case 'learn_more':
      return { nextStage: holdStage(current), action: 'answer_faq', escalate: false };
    case 'book_meeting':
    case 'talk_to_human':
      return { nextStage: 'handed_off', action: 'handoff_to_human', escalate: false };
  }
}

/**
 * The next screening question to ask, one at a time in spec order (Q1 → Q2 → Q3 →
 * Q4), then a brief intent check, then the qualified handoff. Q1/Q3 are asked
 * only for a lead that did not come through the form (`screenAll`).
 *
 * The intent check (the bot must gauge seriousness before spending Lidor's time)
 * asks ONE natural question. A price-checker who is not seriously selling is held
 * back rather than forwarded; a genuine seller is handed off. Asked at most once —
 * if the read is still unclear after asking, give the benefit of the doubt.
 */
function nextScreeningStep(
  current: ConversationStage,
  facts: KnownFacts,
  screenAll: boolean,
  escalate: boolean,
): Decision {
  if (screenAll && facts.sellIntent === undefined) {
    return { nextStage: 'screening_sell_intent', action: 'ask_sell_intent', escalate };
  }
  if (facts.neighborhood === undefined) {
    return { nextStage: 'screening_neighborhood', action: 'ask_neighborhood', escalate };
  }
  if (screenAll && facts.timeline === undefined) {
    return { nextStage: 'screening_timeline', action: 'ask_timeline', escalate };
  }
  if (facts.currentlyMarketed === undefined) {
    return {
      nextStage: 'screening_currently_marketed',
      action: 'ask_currently_marketed',
      escalate,
    };
  }
  // Intent check — asked only if we have not asked it yet.
  if (facts.seriousSeller === undefined && current !== 'assessing_intent') {
    return { nextStage: 'assessing_intent', action: 'ask_intent', escalate };
  }
  // Clearly just price-checking → do not forward to Lidor; leave the door open.
  if (facts.seriousSeller === false) {
    return { nextStage: 'engaged', action: 'low_intent_hold', escalate };
  }
  return {
    nextStage: 'qualified',
    action: 'proceed_qualified',
    qualified: true,
    escalate,
  };
}

/**
 * Removes the most recently answered screening fact — the "go back" command.
 *
 * Walks the spec question order (Q1 → Q2 → Q3 → Q4, minus Q1/Q3 for a form lead)
 * from the end and clears the last one that is set, so the flow re-asks exactly
 * that question. With nothing answered yet it is a no-op.
 */
export function undoLastAnswer(facts: KnownFacts, screenAll: boolean): KnownFacts {
  const order: (keyof KnownFacts)[] = [];
  if (screenAll) order.push('sellIntent');
  order.push('neighborhood');
  if (screenAll) order.push('timeline');
  order.push('currentlyMarketed');

  const next: KnownFacts = { ...facts };
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const key = order[i]!;
    if (next[key] !== undefined) {
      delete next[key];
      break;
    }
  }
  return next;
}

/**
 * Handles a lead already marketed through another agent, then disqualification.
 *
 * When the property is marketed *with another agent*, that is normally a
 * disqualifier — but first the bot asks when the exclusivity ends and whether
 * they want a follow-up then (a nurture opportunity, not a dead end). Only once
 * that is captured does the exclusivity become a disqualification. Returns the
 * decision to take, or `undefined` to continue the normal flow.
 */
function exclusivityOrDisqualification(
  facts: KnownFacts,
  escalate: boolean,
): Decision | undefined {
  if (
    facts.currentlyMarketed === 'with_agent' &&
    facts.exclusivityEndsAt === undefined &&
    facts.wantsExclusivityFollowup === undefined
  ) {
    return { nextStage: 'screening_exclusivity', action: 'ask_exclusivity', escalate };
  }

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
  return undefined;
}

/**
 * The disqualifiers, mapped from screening facts. First match wins.
 *
 * Timeline is deliberately NOT here: "no urgency" does not disqualify — it only
 * lowers the lead's priority (see {@link leadPriorityScore}) while the
 * conversation continues to qualification. Only not-selling and being exclusive
 * with another agent close the door.
 */
function disqualifyingReason(facts: KnownFacts): DisqualificationReason | undefined {
  if (facts.sellIntent === 'not_selling') return 'not_selling';
  if (facts.currentlyMarketed === 'with_agent') return 'exclusive_with_other_agent';
  return undefined;
}

/**
 * A lead's priority from how soon they want to sell (spec Q3) — higher is more
 * urgent. It only orders Lidor's queue; it never gates qualification. `undefined`
 * until the timeline is known (a form lead answers Q3 on the form, not the bot).
 */
export function leadPriorityScore(facts: KnownFacts): number | undefined {
  switch (facts.timeline) {
    case 'immediate':
      return 100;
    case 'within_month':
      return 75;
    case 'still_checking':
      return 50;
    case 'no_urgency':
      return 25;
    default:
      return undefined;
  }
}

/**
 * The stage to hold when a turn doesn't advance screening (an objection or an
 * FAQ). A first inbound must not linger in `new`; everything else stays put.
 */
function holdStage(current: ConversationStage): ConversationStage {
  return current === 'new' || current === 'awaiting_first_contact' ? 'engaged' : current;
}
