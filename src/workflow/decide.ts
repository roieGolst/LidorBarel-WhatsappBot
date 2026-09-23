import type { OfferStrategy } from '../appointments/availability.js';
import type {
  Conversation,
  ConversationStage,
} from '../db/repositories/conversations.js';
import type { Analysis } from './classify.js';
import type { MainMenuChoice, PendingFactChange } from './interactive.js';

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
  | 'clarify_neighborhood' // Q2 answer looked like an address → ask which neighbourhood
  | 'ask_timeline' // spec Q3 (direct-message leads only)
  | 'ask_currently_marketed' // spec Q4
  | 'ask_exclusivity' // Q4 = with another agent: capture exclusivity end + follow-up
  | 'ask_intent' // gauge seriousness/motivation before handing off
  | 'low_intent_hold' // just price-checking → don't forward to Lidor
  | 'proceed_qualified'
  | 'offer_slots' // qualified AND asked to book → offer real free times
  | 'assist_booking' // a question/comment instead of a pick → answered with the real times in view
  | 'decline_slots' // the offered times turned down → honest handoff, no re-offer
  | 'confirm_fact_change' // a changed answer after the details are with Lidor → check first
  | 'fact_change_applied' // …confirmed, and nothing else follows from it
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
  | 'answer_aside' // answer a question asked alongside an answer, before continuing
  | 'confirm_restart' // already-complete lead re-opened a flow → confirm before redoing it
  | 'offer_reschedule'; // a booked lead asked for a meeting → offer to MOVE the one they have

export interface Decision {
  nextStage: ConversationStage;
  action: TurnAction;
  /** Generate the reply with the stronger model (§7). */
  escalate: boolean;
  /** Set only at the qualified/disqualified fork. */
  qualified?: boolean;
  disqualificationReason?: DisqualificationReason;
  /**
   * A reply to send BEFORE the action's own message, when the person asked
   * something while also answering the pending question. Without it the bot reads
   * as a form that ignores whatever it was not expecting: it takes the answer and
   * moves on. With it the turn answers them first, then continues the flow.
   */
  addressFirst?: 'answer_aside' | 'handle_objection';
  /** Set with `confirm_fact_change`: the answer awaiting the person's yes. */
  pendingChange?: PendingFactChange;
  /**
   * Set with `offer_slots` when the lead did not ask for a meeting: the times
   * are a suggestion made on the strength of their score, and the offer is
   * worded as one.
   */
  bookingSuggested?: true;
}

/**
 * The score from which a qualified lead is offered a consultation without
 * asking for one. The bot's purpose is to get Lidor talking to the leads worth
 * his time; a lead who is ready to sell within the month (ready 30 + within a
 * month 30, or immediate 40) has said as much, and "Lidor will call you" is
 * where that intent cools. Below it the handoff stands — the lead is Lidor's
 * to call when he judges. See leadPriorityScore for the model.
 */
export const HIGH_PRIORITY_SCORE = 60;

export function isHighPriority(facts: KnownFacts): boolean {
  return (leadPriorityScore(facts) ?? 0) >= HIGH_PRIORITY_SCORE;
}

/**
 * The score from which a lead is offered Lidor's *soonest* free times rather
 * than a spread of the week. Reaching 80 takes an immediate timeline (40) plus a
 * property ready to list (30) plus either booking intent or a finished
 * screening — someone who has said, in every way the flow can ask, that they
 * are selling now. For them the earliest slot is the right offer: each day
 * before the meeting is a day for that to cool, and a selection of evenings
 * next week reads as if there were no hurry. Everyone else gets the spread,
 * which is about fitting the meeting into *their* week.
 */
export const URGENT_OFFER_SCORE = 80;

/** A lead who has said, in every way the flow asks, that they are selling now. */
export function isReadyNow(facts: KnownFacts): boolean {
  return (leadPriorityScore(facts) ?? 0) >= URGENT_OFFER_SCORE;
}

/**
 * The most discovery questions asked after screening. Three is a conversation;
 * more is an interrogation, and every one is a chance for the lead to go quiet.
 */
export const DISCOVERY_MAX = 3;

/**
 * The cap for a lead who asked for a meeting. They have said what they want;
 * what remains is enough context for the call — the property, the reason —
 * asked as preparation, never as a further sell. Two, and fewer when they are
 * terse or have already said it.
 */
export const DISCOVERY_MAX_BOOKING = 2;

/**
 * How many written replies in a row the bot gives while times are on offer
 * and the person keeps not picking one. Live, the writer proposed a time and
 * asked for a confirmation four times running. After this many, the reply is
 * the list and a plain ask to tap — no model.
 */
export const ASSIST_BOOKING_MAX = 2;

/**
 * A message of a few words. Screening answers are button taps and always
 * short, so this is only read where free text is expected — the discovery
 * answers — as the signal that this person does not want to type.
 */
export const TERSE_WORDS = 5;

export function isTerseAnswer(text: string): boolean {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return words.length > 0 && words.length <= TERSE_WORDS;
}

/**
 * What the discovery question-writer is told: which question this is, of how
 * many, in what mode; what is already known; and what is still missing — so it
 * asks for the most useful gap rather than a fixed script, and prepares a call
 * rather than qualifies when the person has already asked for the meeting.
 * The answers themselves stay in Hebrew.
 */
export function discoveryContext(facts: KnownFacts): string {
  const booking = facts.bookingIntent === true;
  const number = (facts.discoveryCount ?? 0) + 1;
  const cap = booking ? DISCOVERY_MAX_BOOKING : DISCOVERY_MAX;
  const known = [
    facts.neighborhood ? `neighbourhood: ${facts.neighborhood}` : undefined,
    facts.additionalNotes ? `property details: ${facts.additionalNotes}` : undefined,
    facts.sellMotivation ? `reason for selling: ${facts.sellMotivation}` : undefined,
    facts.timeline
      ? booking
        ? `timeline: ${facts.timeline} (assumed from the meeting request — confirm only in passing, if at all)`
        : `timeline: ${facts.timeline}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
  const missing = [
    facts.additionalNotes
      ? undefined
      : 'property specifics (address, rooms, floor, condition, asking price)',
    facts.sellMotivation ? undefined : 'the reason for selling and any timing constraint',
    'any constraint or concern Lidor should know before the call (who else decides, what matters most)',
  ].filter((line): line is string => line !== undefined);
  return (
    `Discovery question ${number} of at most ${cap}. ` +
    (booking
      ? 'Mode: PREPARATION — this person already asked for a meeting; meeting times are offered right after this. Brief and practical, framed as preparing Lidor for the call, never as qualification, persuasion or a pitch. '
      : 'Mode: DISCOVERY. ') +
    `Known: ${known.length > 0 ? known.join('; ') : 'nothing beyond the four screening answers'}. ` +
    `Still missing, most useful first: ${missing.join('; ')}.`
  );
}

/** Which free times to offer this lead, from what the flow knows of them. */
export function offerStrategyFor(facts: KnownFacts): OfferStrategy {
  return isReadyNow(facts) ? 'earliest' : 'spread';
}

/**
 * Stages past screening: the answers are complete and with Lidor (or a meeting
 * is being arranged on their strength). From here a screening answer is never
 * silently replaced — see {@link changedScreeningFact} — and a message is
 * answered as an assistant would, never by re-running the questionnaire.
 */
export const POST_SCREENING_STAGES: readonly ConversationStage[] = [
  'qualified',
  'handed_off',
  'appointment_proposed',
  'appointment_confirmed',
];

const SCREENING_FIELDS = [
  'sellIntent',
  'neighborhood',
  'timeline',
  'currentlyMarketed',
] as const;

/**
 * A screening answer this message would CHANGE — a value that differs from the
 * one already known. Only a confident read counts, and only a real difference:
 * the classifier re-emits known facts every turn, which is not a change.
 *
 * Why it exists: after a meeting was booked, one stray "כן, עם מתווך" tap was
 * taken at face value and closed the lead as exclusive with another agent. A
 * changed answer after qualification is a decision the person makes, so they
 * are asked — once — before it is applied.
 */
export function changedScreeningFact(
  known: KnownFacts,
  extracted: KnownFacts,
  confident: boolean,
): PendingFactChange | undefined {
  if (!confident) return undefined;
  for (const field of SCREENING_FIELDS) {
    const before = known[field];
    const after = extracted[field];
    if (before !== undefined && after !== undefined && after !== before) {
      return { field, value: after };
    }
  }
  return undefined;
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
  canBook = false,
  /**
   * Whether the latest message was a short one — a few words. Judged by the
   * turn (the decision never sees text). A terse, ready-now lead is closed,
   * not questioned further; see `nextScreeningStep`.
   */
  terseAnswer = false,
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

  // 1b. Past screening, a DIFFERENT answer to a screening question is checked
  //     with the person before anything acts on it — before the disqualifiers
  //     below get to see it. The stage holds; nothing is merged.
  if (POST_SCREENING_STAGES.includes(current)) {
    const change = changedScreeningFact(known, analysis.extracted, confident);
    if (change) {
      return {
        nextStage: current,
        action: 'confirm_fact_change',
        escalate: false,
        pendingChange: change,
      };
    }
  }

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

  // 2a. Waiting on a choice of meeting time. A tapped time never reaches here —
  //     the turn books it before classifying — so this is everything else a
  //     person says with a list of times in front of them: a question about
  //     them ("אין מוקדם יותר?"), an aside, or a no. It is answered WITH the
  //     times in view, never by the generic flow, which once replied "I have no
  //     calendar to schedule with" seconds after offering three slots and then
  //     re-asked the intent question.
  if (current === 'appointment_proposed') {
    if (confident && analysis.declinesOfferedTimes) {
      return { nextStage: 'qualified', action: 'decline_slots', escalate: false };
    }
    if (confident && analysis.intent === 'OFF_TOPIC') {
      return { nextStage: current, action: 'stay_on_topic', escalate: false };
    }
    if (confident && analysis.wantsSocialProof) {
      return { nextStage: current, action: 'send_social_proof', escalate: false };
    }
    return { nextStage: current, action: 'assist_booking', escalate: true };
  }

  // 2b. Explicit intent to book a meeting / proceed with selling runs the same
  //     screening flow (a call is booked only after a few quick details), even if
  //     the message reads like an FAQ. Booking intent also boosts the weighted
  //     priority (see leadPriorityScore).
  //
  //     This fires ONLY on a booking intent expressed by THIS message. Reading it
  //     off the merged facts made the rule permanent: once someone tapped
  //     "קביעת פגישה", every later message was funnelled into screening, so their
  //     questions, objections and requests for testimonials were silently ignored
  //     for the rest of the conversation. Screening answers from a booking lead
  //     still continue the flow — they fall through to the screening rule below.
  if (
    confident &&
    analysis.extracted.bookingIntent === true &&
    !POST_SCREENING_STAGES.includes(current)
  ) {
    return alsoAnswering(
      nextScreeningStep(current, bookingFacts(facts), screenAll, escalate, true, canBook),
      analysis,
    );
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

  // 2d. Past screening, a wish to book is honoured before anything else is
  //     read into the message. "למה אתה לא קובע לי פגישה?" is an objection in
  //     form and a booking request in substance; routed by its form it drew an
  //     apology that Lidor would call — from a bot that could have offered his
  //     real times. Only when booking is wired, and never to a lead whose
  //     meeting is already set.
  if (
    canBook &&
    confident &&
    analysis.extracted.bookingIntent === true &&
    POST_SCREENING_STAGES.includes(current) &&
    current !== 'appointment_confirmed'
  ) {
    return { nextStage: 'appointment_proposed', action: 'offer_slots', escalate };
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

  // 4. Past screening (qualified, handed off, or a meeting booked): the
  //    conversation stays OPEN and behaves like a real assistant (a request to
  //    book was already honoured in 2d). New property details volunteered are
  //    appended to the lead with a brief ack;
  //    ANYTHING ELSE — a question, a clarification ("את מה?"), a comment — is
  //    answered by the model, not brushed off with the same canned ack. Never
  //    re-run screening or re-send the handoff. (The dismissive "I already have
  //    everything, no more needed" line is reserved for the rate-limit window; see
  //    THROTTLE_MESSAGE — it must not be how the bot replies to a normal message.)
  if (POST_SCREENING_STAGES.includes(current)) {
    // New details get a brief ack — unless the message also asks something:
    // "what did you record, so I can check?" re-emitted the consolidated
    // notes and was answered "got it, I'll pass it on", which is not an answer.
    if (
      confident &&
      analysis.extracted.additionalNotes !== undefined &&
      !analysis.asksQuestion
    ) {
      return { nextStage: current, action: 'acknowledge_additional_info', escalate };
    }
    return { nextStage: current, action: 'assist_qualified', escalate: true };
  }

  // 5. Screening flow — the default. A greeting, filler ("יאללה"), an unclear or
  //    off-topic message, or an actual answer all funnel here: ask the next
  //    pending question (or qualify). An unparseable answer simply re-asks the
  //    same question, whose buttons are already in front of the person — the flow
  //    never dead-ends on "rephrase".
  return alsoAnswering(
    nextScreeningStep(
      current,
      facts,
      screenAll,
      escalate,
      intentSubstance,
      canBook,
      terseAnswer,
    ),
    analysis,
  );
}

/**
 * Attaches a reply to the person's own question to a screening decision.
 *
 * The screening flow's job is to ask the next question; on its own it happily
 * takes an answer and moves on, which is how a genuine question asked in the same
 * breath ("בשכונת נווה זאב, לידור יודע למכור שם?") ended up silently ignored. When
 * the classifier reports the message also asked something, the turn answers that
 * first and then asks its question — a conversation, not a form.
 */
function alsoAnswering(decision: Decision, analysis: Analysis): Decision {
  if (!analysis.asksQuestion) return decision;
  return {
    ...decision,
    addressFirst: analysis.intent === 'OBJECTION' ? 'handle_objection' : 'answer_aside',
  };
}

/**
 * Stages where the lead has already been through the whole flow and their
 * details are with Lidor. Re-opening a screening flow from here would re-ask
 * everything, so it is confirmed first (see {@link decideMainMenu}).
 */
const COMPLETED_STAGES = POST_SCREENING_STAGES;

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
  canBook = false,
): Decision {
  switch (choice) {
    case 'check_fit':
    case 'book_meeting': {
      // Already done. A meeting request from a lead whose details are complete
      // is simply honoured — real times, no questionnaire — and one from a lead
      // whose meeting is already set is answered as such. A fit check would
      // redo everything, so it is confirmed first; the workflow records which
      // flow was asked for, so an explicit yes resumes exactly this choice.
      if (COMPLETED_STAGES.includes(current)) {
        if (choice === 'book_meeting') {
          return canBook && current !== 'appointment_confirmed'
            ? {
                nextStage: 'appointment_proposed',
                action: 'offer_slots',
                escalate: false,
              }
            : { nextStage: current, action: 'assist_qualified', escalate: true };
        }
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
        canBook,
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
  canBook = false,
  terseAnswer = false,
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
  // Discovery — after the four questions, a short conversation (a few
  // model-written questions) so Lidor walks into the call knowing the property,
  // the reason for selling and what this person cares about, not just four
  // button taps. `seriousSeller` is evaluated ONLY here: a value the classifier
  // may have set earlier (e.g. from a screening-button answer) must not
  // short-circuit the flow before a question is even asked.
  //
  // It is a conversation, not a form: it ends as soon as it has done its job
  // (the property and the reason are known), and it is not run at all when the
  // person already said those things unprompted. A lead who asked for a meeting
  // still gets it — a meeting request is intent, not context — but shortened
  // and framed as preparing the call rather than qualifying them, and cut to a
  // single question when they answer in a few words: every further question is
  // a chance for that to cool, and a person who writes "כן" is telling you how
  // much they want to type. So is a lead who is plainly ready now. A lead who
  // writes at length is given room: they are sharing.
  //
  // Once passed it stays passed (`intentAssessed`): a lead who comes back, or
  // re-answers one screening question, is not asked for their details again.
  const asked = facts.discoveryCount ?? 0;
  const cap = facts.bookingIntent === true ? DISCOVERY_MAX_BOOKING : DISCOVERY_MAX;
  const essentialsKnown =
    facts.additionalNotes !== undefined && facts.sellMotivation !== undefined;
  if (current !== 'assessing_intent') {
    if (facts.intentAssessed !== true && !essentialsKnown) {
      return { nextStage: 'assessing_intent', action: 'ask_intent', escalate: true };
    }
    // They said it all unprompted. Clearly just price-checking is still held;
    // otherwise nothing is asked twice.
    if (facts.intentAssessed !== true && facts.seriousSeller === false) {
      return { nextStage: 'engaged', action: 'low_intent_hold', escalate };
    }
  } else {
    // Clearly just price-checking → do not forward to Lidor; leave the door open.
    if (facts.seriousSeller === false) {
      return { nextStage: 'engaged', action: 'low_intent_hold', escalate };
    }
    const closeNow = terseAnswer && (facts.bookingIntent === true || isReadyNow(facts));
    if (!intentHasSubstance) {
      // A bare "כן", filler, an acknowledgement: not forwarded as "got your
      // details". Asked again — a fresh, context-aware question, not a repeat —
      // while there are questions left; then the flow proceeds with what it has
      // rather than nagging.
      if (asked < cap) {
        return { nextStage: 'assessing_intent', action: 'ask_intent', escalate: true };
      }
    } else if (!closeNow && !essentialsKnown && asked < cap) {
      return { nextStage: 'assessing_intent', action: 'ask_intent', escalate: true };
    }
  }
  // A qualified lead who asked for a meeting is offered real times rather than a
  // promise that Lidor will call: they have already said yes, and making them
  // wait for a callback is where that intent goes cold. So is a lead who did
  // not ask but scores high — the offer is then worded as a suggestion, and a
  // "none suits" ends it honestly. Only when booking is actually wired up —
  // otherwise the handoff is still the honest answer.
  if (canBook && (facts.bookingIntent === true || isHighPriority(facts))) {
    return {
      nextStage: 'appointment_proposed',
      action: 'offer_slots',
      qualified: true,
      escalate,
      ...(facts.bookingIntent === true ? {} : { bookingSuggested: true }),
    };
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

const TIMELINE_POINTS: Record<NonNullable<KnownFacts['timeline']>, number> = {
  immediate: 40,
  within_month: 30,
  still_checking: 15,
  no_urgency: 5,
};

const READINESS_POINTS: Record<NonNullable<KnownFacts['sellIntent']>, number> = {
  ready: 30,
  not_sure: 12,
  // Disqualifies anyway; scored at zero so an inconsistent state cannot inflate.
  not_selling: 0,
};

const BOOKING_POINTS = 15;

// Engagement, 15 points split three ways. Deliberately the smallest factor:
// these are proxies for seriousness, not statements of it, and a chatty lead
// with no urgency must never outrank a terse one selling next week.
const SCREENING_COMPLETE_POINTS = 8;
const PHOTOS_POINTS = 4;
const SERIOUS_SELLER_POINTS = 3;

/**
 * How worth calling this lead is, 0–100.
 *
 * This is the product's output as far as Lidor is concerned: he works a queue,
 * and the score decides its order. It is written to `ציון רצינות` on the לידים
 * board.
 *
 * Four factors, weighted as Lidor approved:
 *
 * | Factor | Max | Why |
 * |---|---|---|
 * | Timeline | 40 | when they will sell — the strongest predictor of a deal |
 * | Sell readiness | 30 | whether the property is actually ready to list |
 * | Booking intent | 15 | they asked for a meeting; rare and decisive |
 * | Engagement | 15 | weak proxies: finished screening, sent photos, reads as serious |
 *
 * The previous version scored on timeline alone and produced five possible
 * values, so a queue of forty leads tied eight ways at every level — a sort key
 * that does not sort is not a prioritisation layer.
 *
 * Returns `undefined` while nothing is known, so an unscored lead is visibly
 * unscored rather than sitting at the bottom of the queue looking rejected.
 */
export function leadPriorityScore(facts: KnownFacts): number | undefined {
  let score = 0;
  let known = false;

  if (facts.timeline) {
    score += TIMELINE_POINTS[facts.timeline];
    known = true;
  } else if (facts.bookingIntent) {
    // Asking for a meeting is itself an urgency signal. Without it, a lead who
    // says "book me in" before answering Q3 would score below someone with no
    // urgency at all.
    score += TIMELINE_POINTS.immediate;
    known = true;
  }

  if (facts.sellIntent) {
    score += READINESS_POINTS[facts.sellIntent];
    known = true;
  }

  if (facts.bookingIntent) {
    score += BOOKING_POINTS;
    known = true;
  }

  // Answering Q4 is the last screening step, so knowing it means the lead saw
  // the flow through rather than dropping halfway.
  if (facts.currentlyMarketed !== undefined) {
    score += SCREENING_COMPLETE_POINTS;
    known = true;
  }
  if ((facts.photoCount ?? 0) > 0) {
    score += PHOTOS_POINTS;
    known = true;
  }
  if (facts.seriousSeller === true) {
    score += SERIOUS_SELLER_POINTS;
    known = true;
  }

  if (!known) return undefined;
  return Math.max(0, Math.min(100, score));
}

/**
 * The stage to hold when a turn doesn't advance screening (an objection or an
 * FAQ). A first inbound must not linger in `new`; everything else stays put.
 */
function holdStage(current: ConversationStage): ConversationStage {
  return current === 'new' ||
    current === 'awaiting_first_contact' ||
    current === 'awaiting_reply'
    ? 'engaged'
    : current;
}
