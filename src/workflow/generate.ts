import {
  CLASSIFIER_MODEL,
  ESCALATION_MODEL,
  type LlmClient,
  type LlmMessage,
  type LlmModel,
  type LlmUsage,
} from '../llm/client.js';
import type { TurnAction } from './decide.js';
import { validateReply, type ValidateOptions } from './validate.js';

/**
 * Actions whose reply must end with exactly one forward question — the engaging
 * replies that keep an active conversation moving toward the consultation call.
 * Terminal closes (qualified handoff, disqualification, opt-out, human handoff)
 * are deliberately not here: they end the conversation and take no question.
 */
const ENGAGING_ACTIONS: ReadonlySet<TurnAction> = new Set([
  'answer_faq',
  'handle_objection',
  'send_social_proof',
  'ask_exclusivity',
]);

/**
 * `generateReply` — writes the actual reply, in Lidor's voice (§5.5).
 *
 * `decideTransition` has already chosen what this turn should accomplish (its
 * {@link TurnAction}); this step only phrases it. Every draft passes through
 * {@link validateReply} before it can be sent. On a violation the workflow
 * regenerates once — on the stronger model, with the specific violation named —
 * and if that still fails, falls back to a pre-written safe variant. A real
 * customer never receives an unvalidated reply.
 */

/**
 * Stable spec voice + knowledge — cached across turns (§7). Directives ride in
 * the per-turn messages; everything that doesn't change between turns (voice,
 * FAQs, objection scripts, social proof) lives here so it's cached, not re-sent.
 *
 * The content is the Champions questionnaire spec, in Lidor's own words. The
 * model phrases the turn; it does not invent business facts — every FAQ answer,
 * statistic and story below is verbatim from the spec.
 */
const VOICE_PROMPT = `You are "צוות לידור בראל" — the voice of Lidor Barel's real estate agency in Beer Sheva. You message property-sellers on WhatsApp, in Hebrew. Lidor himself is the person leads are eventually handed to.

Voice: professional, warm, and sharp (מקצועי, ידידותי, חד). Sound like a senior Beer Sheva agent who leads the conversation with confidence, screens out unsuitable properties, and makes owners feel they are in good hands from the first message. Formality 3/5, medium-length messages, moderate emoji use.

Sound like: an experienced, trustworthy professional running a focused, efficient conversation — clear, sharp, and moving toward booking a consultation call with Lidor.
Never sound like: a bot or automated system; a pushy salesperson closing at any cost; an interrogator flooding questions; an agent who promises before checking; a robot with long, formal, repetitive answers; someone condescending or judgmental; a chatty friend.

Your job: collect the relevant details, answer questions, qualify the lead, and prepare them for the consultation call — nothing else.

Hard rules:
- Write in Hebrew. Be brief and precise — one or two short lines, one idea. No rich small talk, no tangents; steer politely back to the property and the next step. Keep a professional distance — helpful, not a buddy.
- End with exactly ONE question or a clear next step that moves toward the call. Never leave the lead without a next move, and never ask more than one question at a time. Build trust; never pressure.
- Never promise what you cannot guarantee, and never use pressure or over-certainty words: בטוח, בוודאות, מאה אחוז, אין סיכוי, חייב, דחוף, רק היום, מבצע, מציאה, זול, "יקר מדי" (about the property), אי אפשר, אין מה לעשות, נסגור, תתחייב, "מקסימום מחיר", "אני מבטיח". Prefer instead: אבדוק, אעריך, על סמך הנתונים, לפי מצב השוק, המטרה היא, אסטרטגיית מכירה, חשיפה רחבה, הערכת שווי, "המחיר הגבוה ביותר שהשוק מאפשר".
- Open gender-neutral; do not assume the lead's gender.
- Output ONLY the message text to send. No quotes, no preamble, no explanation.

KNOWLEDGE (draw on this only when the instruction calls for it — do not volunteer it):

FAQ answers (paraphrase in your own words, keep the substance):
- "כמה שווה הדירה שלי?" → To give an accurate valuation I need a few details on the property; then we assess based on comparable deals, the property's condition, and local demand.
- "כמה זמן לוקח למכור נכס?" → It depends on price, location, condition and demand; the goal is a sound sales strategy that sells at the best price within a reasonable time — at most 3 months, at minimum a day (yes, some deals have closed within a day).
- "למה כדאי לעבוד איתך?" → I specialise in marketing Beer Sheva properties, work with an active database of buyers and investors, advertise on social media, collaborate with other agents, and accompany the process from valuation to signing — minimum time, best price.
- "יש לך כבר קונים שיכולים להתאים לנכס שלי?" → Possibly. I work with an active database of buyers and investors, and if the property fits what they want it's exposed to them too, on top of the wide marketing.
- "מה קורה אחרי שאני משאיר פרטים?" → After we gather the property details we do an initial valuation, assess the sales potential, and get in touch to explain the options that suit you.

Objection handling:
- "I need to think about it" → "בטח, זה לגמרי מובן. מה ההתלבטות העיקרית שלך כרגע?" — then engage with the real hesitation.
- A bad past experience with an agent → acknowledge it with empathy, don't dismiss it, and briefly show what's different here. You may offer social proof if it fits.

Social proof (use ONLY when asked or handling an objection — never proactively): over 4 years in Beer Sheva; 124 properties sold; an active investor/buyer database (a group of 800+); paid advertising and agent collaborations; over 100k followers; 82% of properties sold in under two months. Success stories: Moti (a property stuck for months, sold within a week to a waiting buyer); Orli (right pricing, sold ₪70,000 above her expectation); Daniel (sold in under 48 hours).

The conversation so far is below. The final turn is a bracketed instruction telling you what to say next — it is your director, not the customer speaking. Follow it and write the reply.`;

/** What to tell the model to produce, per decided action. */
const DIRECTIVES: Record<TurnAction, string> = {
  // Deterministic actions (menu, screening) never reach the generator; their
  // entries exist only to keep this map exhaustive over TurnAction.
  show_main_menu: 'Present the opening options.',
  ask_sell_intent:
    'Ask whether they are actually thinking of selling the property or just want a price estimate. One short, easy question.',
  ask_neighborhood:
    'Ask which Beer Sheva neighborhood the property is in. One short question.',
  ask_timeline:
    'Ask, if they got an offer matching their expectations, how soon they would want to sell. One short question.',
  ask_currently_marketed:
    'Ask whether the property is currently being marketed — privately, through another agent, or not at all. One short question.',
  ask_exclusivity:
    'They said the property is marketed through another agent. In one message, ask when that agent’s exclusivity ends AND whether they would like a follow-up when it does. End with a single question mark.',
  proceed_qualified:
    'You have everything you need. Briefly thank them and tell them you are passing the details to Lidor, who will reach out to arrange the consultation call shortly. Sharp and warm, no fluff.',
  send_disqualification:
    'Politely close: thank them, leave the door open for the future, no pressure. If they are exclusive with another agent and asked for a follow-up, add that you will reach out when the exclusivity ends. Do not ask a question.',
  acknowledge_opt_out:
    'Acknowledge their request to stop, once and politely, and confirm they will not be contacted again. Do not ask a question.',
  answer_faq:
    'Answer briefly and precisely in Lidor’s voice, using the KNOWLEDGE above — no over-explaining. Then end with one question that moves toward the consultation call (e.g. offer to continue the quick fit check).',
  handle_objection:
    'Acknowledge the concern briefly using the objection guidance above, then end with one question that moves the conversation forward.',
  send_social_proof:
    'They asked for proof/testimonials. Share one or two of the strongest stats and one short success story from the KNOWLEDGE — concise, no pressure — then end with one question that moves toward the fit check or the call.',
  handoff_to_human:
    'They want to speak with Lidor. Warmly tell them you are connecting them now and that Lidor will reach out shortly. Do not ask a question.',
};

/**
 * Pre-written safe replies, used only when two generation attempts both fail the
 * validator. Deliberately plain and spec-clean — every one passes
 * {@link validateReply} (asserted in the tests).
 */
export const SAFE_VARIANTS: Record<TurnAction, string> = {
  show_main_menu: 'איך תרצה להתחיל?',
  ask_sell_intent: 'האם חשבת למכור את הדירה או רק לקבל הערכת מחיר?',
  ask_neighborhood: 'באיזו שכונה נמצא הנכס?',
  ask_timeline: 'אם תקבל הצעה שמתאימה לציפיות שלך, תוך כמה זמן תרצה למכור?',
  ask_currently_marketed: 'האם הנכס משווק כרגע?',
  ask_exclusivity:
    'מתי מסתיימת הבלעדיות עם המתווך הנוכחי, ותרצה שנחזור אליך כשהיא מסתיימת?',
  proceed_qualified:
    'מעולה, תודה רבה על כל הפרטים. אני מעביר עכשיו הכול ללידור, שיעבור על הנתונים ויחזור אליך בהקדם עם המשך התהליך.',
  send_disqualification:
    'תודה רבה על הזמן שלך. אם בעתיד תחליט שהגיע הזמן למכור, או שתרצה להתייעץ, הדלת שלנו תמיד פתוחה ונשמח לעזור. בהצלחה ויום נפלא 😊',
  acknowledge_opt_out: 'קיבלתי, לא נפנה אליך יותר. תודה.',
  answer_faq: 'אשמח לעזור. מה תרצה לדעת?',
  handle_objection: 'בטח, זה לגמרי מובן. מה ההתלבטות העיקרית שלך כרגע?',
  send_social_proof:
    'לידור מלווה מוכרים בבאר שבע מעל 4 שנים, עם יותר מ-124 נכסים שנמכרו וכ-82% שנמכרו בפחות מחודשיים. נמשיך לבדיקת התאמה קצרה?',
  handoff_to_human: 'מעולה, אני מחבר אותך עכשיו ללידור. הוא יחזור אליך בהקדם להמשך.',
};

export interface GenerateInput {
  action: TurnAction;
  /** Use the stronger model for the first attempt (§7). */
  escalate: boolean;
  /** Prior turns, oldest first. */
  history?: LlmMessage[];
}

export interface GeneratedReply {
  text: string;
  usage: LlmUsage;
}

export interface ValidatedReply {
  text: string;
  /** Token usage per attempt, so every model call is accounted for (§7). */
  usage: LlmUsage[];
  /** True when the first draft failed validation and a second was generated. */
  regenerated: boolean;
  /** True when both attempts failed and a pre-written safe variant was sent. */
  fellBack: boolean;
}

/** The bracketed director turn for an action. */
function instruction(action: TurnAction): LlmMessage {
  return { role: 'user', content: `[INSTRUCTION] ${DIRECTIVES[action]}` };
}

/** Names a failed draft's violations so the regeneration can avoid them. */
function correctionNote(bannedTerms: string[]): string {
  const avoid = bannedTerms.length > 0 ? ` Do not use: ${bannedTerms.join(', ')}.` : '';
  return `[INSTRUCTION] That reply broke the rules and was rejected. Rewrite it: one short Hebrew message, at most one question, no pressure or over-promising language.${avoid}`;
}

async function draft(
  llm: LlmClient,
  model: LlmModel,
  messages: LlmMessage[],
): Promise<GeneratedReply> {
  const { text, usage } = await llm.complete({
    model,
    system: VOICE_PROMPT,
    messages,
    maxTokens: 300,
  });
  return { text: text.trim(), usage };
}

/** Generates a single reply draft for the given action. */
export function generateReply(
  llm: LlmClient,
  input: GenerateInput,
): Promise<GeneratedReply> {
  const model = input.escalate ? ESCALATION_MODEL : CLASSIFIER_MODEL;
  return draft(llm, model, [...(input.history ?? []), instruction(input.action)]);
}

/**
 * Generates a reply and guarantees it satisfies the validator, by regenerating
 * once and then falling back to a safe variant (§5.5).
 */
export async function generateValidatedReply(
  llm: LlmClient,
  input: GenerateInput,
): Promise<ValidatedReply> {
  const baseMessages: LlmMessage[] = [
    ...(input.history ?? []),
    instruction(input.action),
  ];
  const checkOptions: ValidateOptions = {
    requireQuestion: ENGAGING_ACTIONS.has(input.action),
  };

  const first = await draft(
    llm,
    input.escalate ? ESCALATION_MODEL : CLASSIFIER_MODEL,
    baseMessages,
  );
  const firstCheck = validateReply(first.text, checkOptions);
  if (firstCheck.ok) {
    return {
      text: first.text,
      usage: [first.usage],
      regenerated: false,
      fellBack: false,
    };
  }

  // One retry, on the stronger model, with the violation named.
  const retry = await draft(llm, ESCALATION_MODEL, [
    ...baseMessages,
    { role: 'assistant', content: first.text },
    { role: 'user', content: correctionNote(firstCheck.bannedTerms) },
  ]);
  const retryCheck = validateReply(retry.text, checkOptions);
  if (retryCheck.ok) {
    return {
      text: retry.text,
      usage: [first.usage, retry.usage],
      regenerated: true,
      fellBack: false,
    };
  }

  // Both attempts failed the spec: send something we wrote and trust.
  return {
    text: SAFE_VARIANTS[input.action],
    usage: [first.usage, retry.usage],
    regenerated: true,
    fellBack: true,
  };
}
