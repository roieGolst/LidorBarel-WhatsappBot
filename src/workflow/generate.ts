import {
  CLASSIFIER_MODEL,
  ESCALATION_MODEL,
  type LlmClient,
  type LlmMessage,
  type LlmModel,
  type LlmUsage,
} from '../llm/client.js';
import type { TurnAction } from './decide.js';
import { validateReply } from './validate.js';

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

Sound like: an experienced, trustworthy professional holding a natural, focused, pleasant conversation — someone whose goal is to understand the property and offer a solution, not to sell by force.
Never sound like: a bot or automated system; a pushy salesperson closing at any cost; an interrogator flooding questions; an agent who promises before checking; a robot with long, formal, repetitive answers; someone condescending or judgmental.

Hard rules:
- Write in Hebrew. Keep it short — usually one or two lines. One idea per message.
- Ask at most ONE question per message, and only when the instruction calls for it. Build trust; never pressure.
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
  ask_sell_intent:
    'Ask whether they are actually thinking of selling the property or just want a price estimate. One short, easy question.',
  ask_neighborhood:
    'Ask which Beer Sheva neighborhood the property is in. One short question.',
  ask_timeline:
    'Ask, if they got an offer matching their expectations, how soon they would want to sell. One short question.',
  ask_currently_marketed:
    'Ask whether the property is currently being marketed — privately, through another agent, or not at all. One short question.',
  proceed_qualified:
    'You have everything you need. Warmly thank them for the details and tell them you are now passing everything to Lidor, who will review it and get back to them shortly. Do not ask a question.',
  send_disqualification:
    'Politely close the conversation: thank them for their time, leave the door open for the future if they decide to sell or want advice, apply no pressure, wish them well. Do not ask a question.',
  acknowledge_opt_out:
    'Acknowledge their request to stop, once and politely, and confirm they will not be contacted again. Do not ask a question.',
  answer_faq:
    'Answer their question briefly and helpfully in Lidor’s voice, using the KNOWLEDGE above. Do not over-explain.',
  handle_objection:
    'Acknowledge their concern with empathy and address it briefly, using the objection guidance above. You may ask one gentle follow-up.',
  clarify: 'You did not fully understand. Ask them to rephrase. One short question.',
};

/**
 * Pre-written safe replies, used only when two generation attempts both fail the
 * validator. Deliberately plain and spec-clean — every one passes
 * {@link validateReply} (asserted in the tests).
 */
export const SAFE_VARIANTS: Record<TurnAction, string> = {
  ask_sell_intent: 'האם חשבת למכור את הדירה או רק לקבל הערכת מחיר?',
  ask_neighborhood: 'באיזו שכונה נמצא הנכס?',
  ask_timeline: 'אם תקבל הצעה שמתאימה לציפיות שלך, תוך כמה זמן תרצה למכור?',
  ask_currently_marketed: 'האם הנכס משווק כרגע?',
  proceed_qualified:
    'מעולה, תודה רבה על כל הפרטים. אני מעביר עכשיו הכול ללידור, שיעבור על הנתונים ויחזור אליך בהקדם עם המשך התהליך.',
  send_disqualification:
    'תודה רבה על הזמן שלך. אם בעתיד תחליט שהגיע הזמן למכור, או שתרצה להתייעץ, הדלת שלנו תמיד פתוחה ונשמח לעזור. בהצלחה ויום נפלא 😊',
  acknowledge_opt_out: 'קיבלתי, לא נפנה אליך יותר. תודה.',
  answer_faq: 'אשמח לעזור. מה תרצה לדעת?',
  handle_objection: 'בטח, זה לגמרי מובן. מה ההתלבטות העיקרית שלך כרגע?',
  clarify: 'לא הבנתי עד הסוף. אפשר לנסח שוב?',
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

  const first = await draft(
    llm,
    input.escalate ? ESCALATION_MODEL : CLASSIFIER_MODEL,
    baseMessages,
  );
  const firstCheck = validateReply(first.text);
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
  const retryCheck = validateReply(retry.text);
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
