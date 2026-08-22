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
  | 'stay_on_topic' // off-topic chatter → keep the conversation on the property
  | 'acknowledge_additional_info' // extra details after the lead already qualified
  | 'assist_qualified' // a question/comment after qualifying → a real reply, not an ack
  | 'about_lidor' // main-menu "about me" → introduce Lidor, ask nothing
  | 'confirm_restart'; // already-complete lead re-opened a flow → confirm before redoing it

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

  // Whether THIS message actually carried NEW intent/detail — used at the
  // intent-check gate so a bare "כן"/filler is not forwarded as "got your
  // details". The classifier re-emits merged facts every turn, so a value only
  // counts as substance when it is NEW relative to what is already known: fresh
  // property notes, a newly-serious signal, a new booking ask, or a new stated
  // motivation. (additionalNotes is emitted only when the message adds a detail —
  // see classify.ts — so its presence marks genuinely new content.)
  const e = analysis.extracted;
  const intentSubstance =
    confident &&
    (e.additionalNotes !== undefined ||
      (e.seriousSeller === true && known.seriousSeller !== true) ||
      (e.bookingIntent === true && known.bookingIntent !== true) ||
      (e.sellMotivation !== undefined && known.sellMotivation === undefined));

  // 2. Marketed through another agent, then disqualification — the highest
  //    business priority after opt-out. Checked on the merged facts so an answer
  //    given earlier still applies even when this turn is about something else.
  const blocked = exclusivityOrDisqualification(facts, escalate);
  if (blocked) return blocked;

  // 2b. Explicit intent to book a meeting / proceed with selling runs the same
  //     screening flow (a call is booked only after a few quick details), even if
  //     the message reads like an FAQ. Booking intent also boosts the weighted
  //     priority (see leadPriorityScore). Not for an already-qualified lead —
  //     they are handled below.
  if (confident && facts.bookingIntent && current !== 'qualified') {
    return nextScreeningStep(current, bookingFacts(facts), screenAll, escalate, true);
  }

  // 2c. An explicit request for testimonials / recommendations / reviews of past
  //     clients — from free text, not only the menu button — sends social proof
  //     (a matching testimonial video + a short line), without advancing
  //     screening. Placed before FAQ so "יש ממליצים?" / "תציג לי המלצות" routes to
  //     the video rather than a text-only FAQ answer that re-asks for details.
  //   `wantsSocialProof` is a per-message signal (the latest message's own
  //     words ask for testimonials), so it is trusted directly: the classifier
  //     re-emits merged screening facts every turn, which makes any "does this
  //     message carry facts?" guard useless here.
  if (confident && analysis.wantsSocialProof) {
    return {
      nextStage: holdStage(current),
      action: 'send_social_proof',
      escalate: false,
    };
  }

  // 3. A confident objection or FAQ gets a bespoke reply, without advancing
  //    screening. An objection reaches for the stronger model to handle it.
  if (confident && analysis.intent === 'OBJECTION') {
    return { nextStage: holdStage(current), action: 'handle_objection', escalate: true };
  }
  if (confident && analysis.intent === 'FAQ') {
    return { nextStage: holdStage(current), action: 'answer_faq', escalate };
  }

  // 3b. A confident off-topic message — a recipe, a shopping list, "read the
  //     codebase", general chit-chat — is never property info. Redirect it so the
  //     person knows this is not the place, keeping the conversation on the
  //     property. Placed BEFORE the qualified branch so a qualified lead's
  //     off-topic message is redirected, not acknowledged as "details for Lidor".
  if (confident && analysis.intent === 'OFF_TOPIC') {
    return { nextStage: holdStage(current), action: 'stay_on_topic', escalate: false };
  }

  // 4. Already qualified: the conversation stays OPEN and behaves like a real
  //    assistant. New property details volunteered are appended to the lead with a
  //    brief ack; ANYTHING ELSE — a question, a clarification ("את מה?"), a comment
  //    — is answered by the model, not brushed off with the same canned ack. Never
  //    re-run screening or re-send the handoff. (The dismissive "I already have
  //    everything, no more needed" line is reserved for the rate-limit window; see
  //    THROTTLE_MESSAGE — it must not be how the bot replies to a normal message.)
  if (current === 'qualified') {
    if (confident && analysis.extracted.additionalNotes !== undefined) {
      return { nextStage: 'qualified', action: 'acknowledge_additional_info', escalate };
    }
    return { nextStage: 'qualified', action: 'assist_qualified', escalate: true };
  }

  // 5. Screening flow — the default. A greeting, filler ("יאללה"), an unclear or
  //    off-topic message, or an actual answer all funnel here: ask the next
  //    pending question (or qualify). An unparseable answer simply re-asks the
  //    same question, whose buttons are already in front of the person — the flow
  //    never dead-ends on "rephrase".
  return nextScreeningStep(current, facts, screenAll, escalate, intentSubstance);
}

/**
 * Stages where the lead has already been through the whole flow and their
 * details are with Lidor. Re-opening a screening flow from here would re-ask
 * everything, so it is confirmed first (see {@link decideMainMenu}).
 */
const COMPLETED_STAGES: readonly ConversationStage[] = ['qualified', 'handed_off'];

/**
 * Routes a main-menu selection (spec §8) — deterministic, no model call, since
 * the choice is a known button, not free text.
 *
 * `check_fit` and `book_meeting` both run the same screening flow — a meeting is
 * booked only after a few quick details, and booking intent is a strong signal
 * that boosts the lead's weighted priority (see `bookingIntent` /
 * {@link leadPriorityScore}). For a lead who has ALREADY completed the flow,
 * neither restarts it outright: the bot says it already has everything and asks
 * whether they really want to start over (`confirm_restart`), and only an explicit
 * yes re-runs it.
 *
 * `testimonials` and `about_lidor` never touch the screening flow at all — they
 * answer and stop, asking nothing.
 */
export function decideMainMenu(
  choice: MainMenuChoice,
  current: ConversationStage,
  known: KnownFacts = {},
  screenAll = false,
): Decision {
  switch (choice) {
    case 'check_fit':
    case 'book_meeting': {
      // Already done: confirm before redoing anything. The workflow records which
      // flow was asked for, so an explicit yes resumes exactly this choice.
      if (COMPLETED_STAGES.includes(current)) {
        return { nextStage: current, action: 'confirm_restart', escalate: false };
      }
      const blocked = exclusivityOrDisqualification(known, false);
      if (blocked) return blocked;
      // Booking a meeting is top-urgency intent: mark it and skip Q3 (timeline).
      const facts =
        choice === 'book_meeting'
          ? bookingFacts({ ...known, bookingIntent: true })
          : known;
      // Booking is itself a strong intent signal, so it satisfies the substance
      // gate if the flow reaches the intent check.
      return nextScreeningStep(
        current,
        facts,
        screenAll,
        false,
        choice === 'book_meeting',
      );
    }
    case 'testimonials':
      return {
        nextStage: holdStage(current),
        action: 'send_social_proof',
        escalate: false,
      };
    case 'learn_more':
      // "About me" — introduce Lidor and stop. Never re-runs screening, never asks
      // a follow-up question, whatever stage the conversation is in.
      return { nextStage: holdStage(current), action: 'about_lidor', escalate: false };
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
  intentHasSubstance = false,
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
  // Intent check — asked once after the four questions. `seriousSeller` is
  // evaluated ONLY here, at the intent stage: a value the classifier may have set
  // earlier (e.g. from a screening-button answer) must not short-circuit the flow
  // before the question is even asked. Escalated to the stronger model so the
  // question is context-aware — it acknowledges what the seller already shared and
  // only asks for what is genuinely missing, rather than a blind fixed script.
  if (current !== 'assessing_intent') {
    return { nextStage: 'assessing_intent', action: 'ask_intent', escalate: true };
  }
  // Evaluating the intent-check answer. Clearly just price-checking → do not
  // forward to Lidor; leave the door open.
  if (facts.seriousSeller === false) {
    return { nextStage: 'engaged', action: 'low_intent_hold', escalate };
  }
  // The answer carried no real detail or intent (a bare "כן", filler, an
  // acknowledgement) — do NOT forward an empty "got your details" handoff. Ask
  // once more for the specifics that help Lidor prepare; the model-written
  // question is context-aware, so this is a fresh, natural nudge, not a repeat.
  if (!intentHasSubstance) {
    return { nextStage: 'assessing_intent', action: 'ask_intent', escalate: true };
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
/**
 * Booking a meeting is top-urgency intent, so the timeline is taken as immediate:
 * Q3 is skipped and the weighted priority is maxed. Only fills a timeline that is
 * not already known, so a stated timeline is never overwritten.
 */
function bookingFacts(facts: KnownFacts): KnownFacts {
  return facts.bookingIntent && facts.timeline === undefined
    ? { ...facts, timeline: 'immediate' }
    : facts;
}

export function leadPriorityScore(facts: KnownFacts): number | undefined {
  const base =
    facts.timeline === 'immediate'
      ? 100
      : facts.timeline === 'within_month'
        ? 75
        : facts.timeline === 'still_checking'
          ? 50
          : facts.timeline === 'no_urgency'
            ? 25
            : undefined;

  // Explicit intent to book a meeting / proceed is a strong quality signal: it
  // lifts the weighted score (+25, capped at 100) and gives a solid floor even
  // before the timeline is known, so a booking lead ranks ahead of a passive one.
  if (facts.bookingIntent) {
    return base === undefined ? 60 : Math.min(100, base + 25);
  }
  return base;
}

/**
 * The stage to hold when a turn doesn't advance screening (an objection or an
 * FAQ). A first inbound must not linger in `new`; everything else stays put.
 */
function holdStage(current: ConversationStage): ConversationStage {
  return current === 'new' || current === 'awaiting_first_contact' ? 'engaged' : current;
}
