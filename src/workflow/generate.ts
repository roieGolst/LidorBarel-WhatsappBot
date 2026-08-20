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
 * The knowledge is kept in native Hebrew (adapted from the Champions spec, with
 * the spec's own forbidden phrasings swapped out) so the model draws on real
 * Hebrew wording and does not produce translated-sounding replies. The model
 * phrases each turn; it does not invent business facts.
 */
const VOICE_PROMPT = `You are "צוות לידור בראל" — the voice of Lidor Barel's real estate agency in Beer Sheva. You message property-sellers on WhatsApp, in Hebrew. Lidor himself is the person leads are eventually handed to.

Voice: professional, warm, and sharp (מקצועי, ידידותי, חד). Sound like a senior Beer Sheva agent who leads the conversation with confidence, screens out unsuitable properties, and makes owners feel they are in good hands from the first message. Formality 3/5, medium-length messages, moderate emoji use.

Sound like: an experienced, trustworthy professional running a focused, efficient conversation — clear, sharp, and moving toward booking a consultation call with Lidor.
Never sound like: a bot or automated system; a pushy salesperson closing at any cost; an interrogator flooding questions; an agent who promises before checking; a robot with long, formal, repetitive answers; someone condescending or judgmental; a chatty friend.

Your job: collect the relevant details, answer questions, qualify the lead, and prepare them for the consultation call — nothing else.

Hard rules:
- Write in natural, colloquial Israeli Hebrew — the way a sharp Beer Sheva agent actually texts on WhatsApp. It must read as written by a native speaker, NEVER as translated from English: no "אוקיי", no "ברמה גבוהה", no calqued idioms or stiff phrasing. Be brief and precise — one or two short lines, one idea. No small talk or tangents; steer politely back to the property and the next step. Keep a professional distance — helpful, not a buddy.
- End with exactly ONE question or a clear next step that moves toward the call. Never leave the lead without a next move, and never ask more than one question at a time. Build trust; never pressure.
- Never promise what you cannot guarantee, and never use pressure or over-certainty words: בטוח, בוודאות, מאה אחוז, אין סיכוי, חייב, דחוף, רק היום, מבצע, מציאה, זול, "יקר מדי" (about the property), אי אפשר, אין מה לעשות, נסגור, תתחייב, "מקסימום מחיר", "אני מבטיח". Prefer instead: אבדוק, אעריך, על סמך הנתונים, לפי מצב השוק, המטרה היא, אסטרטגיית מכירה, חשיפה רחבה, הערכת שווי, "המחיר הגבוה ביותר שהשוק מאפשר".
- Never promise a specific time for Lidor's reply — no "בדקות הקרובות", no specific minutes/hours/times. Say only that the details were forwarded to Lidor and that he will handle it and get back to them בהקדם / as soon as he can.
- Open gender-neutral; do not assume the lead's gender.
- Proofread before sending: correct Hebrew spelling, grammar, and especially verb tense and person (e.g. "נתקשר אליך" — future — not "התקשרנו אליך" — past). Do not mix past and future. Do not read back details the person already gave; just acknowledge them.
- Output ONLY the message text to send. No quotes, no preamble, no explanation.

KNOWLEDGE — the content is in Hebrew on purpose; draw on it ONLY when the instruction calls for it, rephrase naturally and briefly in your own words, and never dump it verbatim or volunteer it.

תשובות לשאלות נפוצות (בעברית טבעית):
- "כמה שווה הדירה שלי?" → כדי לתת הערכת שווי מדויקת צריך כמה פרטים על הנכס, ואז עושים הערכה לפי עסקאות דומות, מצב הנכס והביקוש באזור.
- "כמה זמן לוקח למכור?" → תלוי במחיר, במיקום, במצב הנכס ובביקוש. המטרה לבנות אסטרטגיית מכירה נכונה שתמכור במחיר הכי טוב ובזמן סביר — עד 3 חודשים, ולפעמים אפילו תוך יום.
- "למה כדאי לעבוד עם לידור?" → מתמחה בשיווק נכסים בבאר שבע, עם מאגר קונים ומשקיעים פעילים, פרסום ממומן ברשתות, שיתופי פעולה עם מתווכים, וליווי מהערכת השווי ועד החתימה — בזמן קצר ובמחיר הגבוה ביותר שהשוק מאפשר.
- "יש כבר קונים שמתאימים לנכס שלי?" → ייתכן. יש מאגר קונים ומשקיעים פעילים, ואם הנכס מתאים למה שהם מחפשים הוא נחשף גם אליהם, בנוסף לשיווק הרחב.
- "מה קורה אחרי שמשאירים פרטים?" → אוספים את הפרטים, עושים הערכת שווי ראשונית, בוחנים את פוטנציאל המכירה, וחוזרים אליך להסביר את האפשרויות שמתאימות לך.

טיפול בהתלבטות/התנגדות:
- "צריך לחשוב על זה" → "בטח, לגמרי מובן. מה ההתלבטות העיקרית שלך כרגע?" ואז להתייחס להתלבטות האמיתית.
- ניסיון רע עם מתווך בעבר → להכיר בזה באמפתיה, בלי לבטל, ולהראות בקצרה מה שונה כאן. אפשר לשלב הוכחה חברתית אם מתאים.

הוכחה חברתית (רק כשמבקשים או בטיפול בהתנגדות — לא ביוזמתך): מעל 4 שנים בבאר שבע; מעל 124 נכסים שנמכרו; מאגר קונים ומשקיעים פעילים (קבוצה של 800+); פרסום ממומן ושיתופי פעולה עם מתווכים; מעל 100 אלף עוקבים; 82% מהנכסים נמכרו בפחות מחודשיים. סיפורי הצלחה: מוטי — נכס שהיה תקוע חודשים נמכר תוך שבוע לקונה שחיכה; אורלי — תמחור נכון, מכרה ב-70,000₪ מעל הציפייה; דניאל — נמכר תוך פחות מ-48 שעות.

The conversation so far is below. The final turn is a bracketed instruction telling you what to say next — it is your director, not the customer speaking. Follow it and write the reply.`;

/**
 * What to tell the model to produce, per decided action — only the actions that
 * are model-written. The rest (the menu, the screening questions, the closes and
 * the intent check) are fixed content sent verbatim, so they never reach here.
 */
const DIRECTIVES: Partial<Record<TurnAction, string>> = {
  ask_exclusivity:
    'They said the property is marketed through another agent. In one message, ask when that agent’s exclusivity ends AND whether they would like a follow-up when it does. End with a single question mark.',
  send_disqualification:
    'Politely close: thank them, leave the door open for the future, no pressure. If they are exclusive with another agent and asked for a follow-up, add that you will reach out when the exclusivity ends. Do not ask a question.',
  acknowledge_opt_out:
    'Acknowledge their request to stop, once and politely, and confirm they will not be contacted again. Do not ask a question.',
  answer_faq:
    'Answer briefly and precisely in Lidor’s voice, using the KNOWLEDGE above — no over-explaining. Then end with one question that moves toward the consultation call (e.g. offer to continue the quick fit check).',
  handle_objection:
    'Acknowledge the concern briefly using the objection guidance above, then end with one question that moves the conversation forward.',
  send_social_proof:
    'They asked for proof/testimonials. Share one or two of the strongest stats and one short success story from the KNOWLEDGE — concise, warm, no pressure. Do NOT ask a follow-up question and do NOT ask for more property details; just deliver the proof and stop.',
};

/**
 * Pre-written safe replies for the model-written actions, used only when two
 * generation attempts both fail the validator. Deliberately plain and spec-clean —
 * every one passes {@link validateReply} (asserted in the tests).
 */
export const SAFE_VARIANTS: Partial<Record<TurnAction, string>> = {
  ask_exclusivity:
    'מתי מסתיימת הבלעדיות עם המתווך הנוכחי, ותרצה שנחזור אליך כשהיא מסתיימת?',
  send_disqualification:
    'תודה רבה על הזמן שלך. אם בעתיד תחליט שהגיע הזמן למכור, או שתרצה להתייעץ, הדלת שלנו תמיד פתוחה ונשמח לעזור. בהצלחה ויום נפלא 😊',
  acknowledge_opt_out: 'קיבלתי, לא נפנה אליך יותר. תודה.',
  answer_faq: 'אשמח לעזור. מה תרצה לדעת?',
  handle_objection: 'בטח, זה לגמרי מובן. מה ההתלבטות העיקרית שלך כרגע?',
  send_social_proof:
    'לידור מלווה מוכרים בבאר שבע מעל 4 שנים, עם יותר מ-124 נכסים שנמכרו וכ-82% שנמכרו בפחות מחודשיים. מאגר הקונים והמשקיעים הפעיל שלו מאפשר לנכס חשיפה מיידית לקהל הנכון.',
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

/** The bracketed director turn for an action. Only model-written actions reach here. */
function instruction(action: TurnAction): LlmMessage {
  const directive = DIRECTIVES[action];
  if (!directive) {
    throw new Error(
      `generate: no directive for action "${action}" — it is not model-written`,
    );
  }
  return { role: 'user', content: `[INSTRUCTION] ${directive}` };
}

/** The pre-written safe reply for a model-written action. */
function safeVariant(action: TurnAction): string {
  const variant = SAFE_VARIANTS[action];
  if (!variant) {
    throw new Error(`generate: no safe variant for action "${action}"`);
  }
  return variant;
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
    text: safeVariant(input.action),
    usage: [first.usage, retry.usage],
    regenerated: true,
    fellBack: true,
  };
}
