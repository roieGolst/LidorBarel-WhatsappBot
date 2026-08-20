import { z } from 'zod';
import {
  CLASSIFIER_MODEL,
  ESCALATION_MODEL,
  type LlmClient,
  type LlmModel,
  type LlmUsage,
} from '../llm/client.js';

/**
 * `classifyAndExtract` — the workflow's one LLM classification step (§5.1).
 *
 * The rule this file exists to enforce: **the model returns structured JSON and
 * nothing else.** It never names a stage and never decides a transition;
 * `decideTransition` (plain TypeScript, no model call) owns every transition, so
 * a hallucinated stage is structurally impossible. What the model produces here
 * is an *observation* — an intent, a confidence, and any screening fields it
 * could extract — that pure code then acts on.
 *
 * Anything the model returns is untrusted until it parses against
 * {@link analysisSchema}. Unparseable output is not an error to throw; it is a
 * low-confidence `UNCLEAR` result that routes the conversation to a clarifying
 * question or escalation, exactly as a genuinely ambiguous message would.
 */

/** The intents the classifier may report. */
export const INTENTS = [
  'ANSWER',
  'OBJECTION',
  'FAQ',
  'OPT_OUT',
  'OFF_TOPIC',
  'UNCLEAR',
] as const;

// Screening-answer enums. Values are fixed tokens (not Hebrew label text) so the
// Monday sync can map them to label IDs without depending on wording — matching
// on ID, never text, is correctness-critical (see the plan's column mapping).
const sellIntent = z.enum(['ready', 'not_sure', 'not_selling']); // Q1
const timeline = z.enum(['immediate', 'within_month', 'still_checking', 'no_urgency']); // Q3
const currentlyMarketed = z.enum(['no', 'privately', 'with_agent']); // Q4

/**
 * Screening facts extracted from a message. Every field is optional — the model
 * reports only what the person actually said. Unknown keys are stripped rather
 * than rejected, so a stray field the model invents cannot fail an otherwise
 * good classification.
 */
export const extractedSchema = z.object({
  sellIntent: sellIntent.optional(),
  neighborhood: z.string().min(1).optional(), // Q2, free text; mapped to a dropdown later
  timeline: timeline.optional(),
  currentlyMarketed: currentlyMarketed.optional(),
  // Asked only when the property is marketed through another agent: when that
  // agent's exclusivity ends (free text), and whether they want a follow-up then.
  exclusivityEndsAt: z.string().min(1).optional(),
  wantsExclusivityFollowup: z.boolean().optional(),
  // Any extra property details the person volunteers (rooms, size, floor,
  // condition, price expectation…) — a short note, appended to the lead.
  additionalNotes: z.string().min(1).optional(),
  // The brief intent check after the four questions: their reason for selling
  // (free text) and whether they read as a genuine, serious seller vs. someone
  // mainly checking the price.
  sellMotivation: z.string().min(1).optional(),
  seriousSeller: z.boolean().optional(),
  // True when the person explicitly asks to book a meeting/call or to proceed
  // with selling now — a strong, weighted quality signal.
  bookingIntent: z.boolean().optional(),
});

export const analysisSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  extracted: extractedSchema.default({}),
  needsEscalation: z.boolean().default(false),
  /**
   * True when a seller asks how their property will be marketed, whether there
   * are ready buyers, or what value the agent brings — the questions the
   * investor-tour video answers by showing an active buyer/investor pool.
   */
  wantsBuyerProof: z.boolean().default(false),
});

export type Analysis = z.infer<typeof analysisSchema>;

/**
 * The result when the model's output cannot be parsed.
 *
 * `UNCLEAR` with zero confidence and an escalation flag means `decideTransition`
 * will ask a clarifying question or hand off rather than guess a transition from
 * garbage — the safe reading of "we don't understand this".
 */
export const UNCLEAR_ANALYSIS: Analysis = {
  intent: 'UNCLEAR',
  confidence: 0,
  extracted: {},
  needsEscalation: true,
  wantsBuyerProof: false,
};

const SYSTEM_PROMPT = `You are the classification stage of an inbound WhatsApp bot for a real estate agent in Beer Sheva, Israel. Leads write in Hebrew, often informally, with typos, slang, or voice-to-text artifacts.

Your ONLY job is to read the latest message (with the conversation as context) and return a single JSON object describing it. You do not reply to the person and you do not decide what happens next — you only observe.

Return JSON with exactly these fields:
- "intent": one of "ANSWER" (answering a screening question or giving property info), "OBJECTION" (pushback, doubt, or a concern — e.g. "אני צריך לחשוב", "היה לי ניסיון רע עם מתווך"), "FAQ" (a general question about the service, value, fees, or process — e.g. "כמה שווה הדירה שלי?", "למה כדאי לעבוד איתך?"), "OPT_OUT" (any request to stop, unsubscribe, or not be contacted — including indirect phrasings like "תפסיקו", "אל תפנו אליי", "מוריד אתכם"), "OFF_TOPIC" (anything not about this property or selling it — recipes, shopping lists, general tasks or requests, jokes, chit-chat, "read the codebase", etc.), or "UNCLEAR" (you cannot tell).
- "confidence": a number from 0 to 1.
- "extracted": an object with any of these you can determine from the message, omitting the rest. The person is answering the questionnaire's fixed options; map their words onto the tokens:
    - "sellIntent" (Q1 — "האם חשבת למכור או רק לקבל הערכת מחיר?"): "ready" (רוצה למכור) | "not_sure" (מתלבט, רוצה לדעת מחיר) | "not_selling" (לא מעוניין למכור)
    - "neighborhood" (Q2 — "באיזו שכונה נמצא הנכס?"): the Beer Sheva neighborhood, as the person's exact words. Any real Be'er Sheva neighborhood is acceptable (e.g. העיר העתיקה, שכונת דרום, נווה עופר, נאות לון, נווה זאב, נווה נוי, נחל בקע, נחל עשן, רמות, נאות אברהם, נווה אילן, קריית גנים, כלניות, פארק הנחל, נאות הדרים, בית אשל, and the lettered שכונות א׳/ב׳/ג׳/ד׳/ה׳/ו׳/ט׳/י״א). If the person sends a FULL ADDRESS, extract ONLY the neighborhood from it (e.g. from "רחוב רגר 15, נחל עשן, באר שבע" extract "נחל עשן"); put the street + house number into "additionalNotes"; and if the neighborhood is not obvious from the address, omit "neighborhood" rather than guessing. Extract it only when the message genuinely names a place, never a product/model name or nonsense.
    - "timeline" (Q3 — "תוך כמה זמן תרצה למכור אם תקבל הצעה מתאימה?"): "immediate" (מיד) | "within_month" (בחודש הקרוב) | "still_checking" (בחודשים הקרובים) | "no_urgency" (אין דחיפות)
    - "currentlyMarketed" (Q4 — "האם הנכס משווק כרגע?"): "no" (לא) | "privately" (כן, באופן פרטי) | "with_agent" (כן, עם מתווך)
    - "exclusivityEndsAt": when the current agent's exclusivity ends, as free text (e.g. "עוד חודשיים", "בסוף מרץ", "לא יודע") — only when they say it
    - "wantsExclusivityFollowup": true/false if they say whether they want us to follow up once the exclusivity ends
    - "additionalNotes": ONLY when THIS message adds or clarifies property details (rooms, size/מ"ר, floor, condition/renovation, parking, price expectation, etc.), return the FULL consolidated Hebrew summary of ALL property details so far — merge any "פרטי הנכס עד כה" context shown to you with the new details, into ONE concise line with NO duplication and no repeated facts. If this message adds no property details, omit it entirely.
    - "sellMotivation": a short Hebrew note of WHY they are (or are not) looking to sell, when they say it (e.g. "עוברים דירה", "צריך נזילות", "רק בודק מחיר").
    - "seriousSeller": true if they read as a genuine, motivated seller (a real reason, actively planning to sell); false if they are mainly checking the price or not really intending to sell. Set it only once they've indicated their intent/motivation, otherwise omit.
    - "bookingIntent": true when they explicitly ask to schedule a meeting/call or to move forward with selling now (e.g. "תקבע לי פגישה", "אני רוצה למכור את הנכס", "בוא נתקדם", "מתי אפשר להיפגש?"). Omit otherwise.
- "needsEscalation": true if the message shows anger, frustration, or something a bot should not handle alone.
- "wantsBuyerProof": true if the seller is asking how the property will be marketed, whether there are ready/potential buyers, or what value/results the agent brings (e.g. "יש לך קונים?", "איך תשווק את הנכס?", "למה כדאי לעבוד איתך?", "מאיפה יגיעו הקונים?"). Otherwise false.

Rules:
- Output ONLY the JSON object. No prose, no code fences, no explanation.
- Never invent extracted values. If the message does not clearly state a field, omit it.
- Prefer "UNCLEAR" with low confidence over guessing.`;

export interface ClassifyInput {
  /** The inbound message to classify. */
  text: string;
  /** Prior turns for context, oldest first. Omit for the first message. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /**
   * Property details gathered so far. Given to the model so `additionalNotes`
   * comes back as one consolidated, deduplicated summary rather than an
   * ever-growing pile of restatements.
   */
  priorNotes?: string;
  /**
   * Use the stronger model. Set after a low-confidence turn, a detected
   * objection, or a validator rejection — never as the default (§7).
   */
  escalate?: boolean;
}

export interface ClassifyResult {
  analysis: Analysis;
  usage: LlmUsage;
  /** True when the model's output failed to parse and the safe fallback was used. */
  fallback: boolean;
}

/** Classifies one inbound message into an {@link Analysis}. */
export async function classifyAndExtract(
  llm: LlmClient,
  input: ClassifyInput,
): Promise<ClassifyResult> {
  const model: LlmModel = input.escalate ? ESCALATION_MODEL : CLASSIFIER_MODEL;

  // A context line so the model consolidates property notes instead of appending.
  const priorNotesContext =
    input.priorNotes !== undefined && input.priorNotes.length > 0
      ? [{ role: 'user' as const, content: `(פרטי הנכס עד כה: ${input.priorNotes})` }]
      : [];

  const { text, usage } = await llm.complete({
    model,
    system: SYSTEM_PROMPT,
    messages: [
      ...(input.history ?? []),
      ...priorNotesContext,
      { role: 'user', content: input.text },
    ],
    // Classification JSON is tiny; this is a generous ceiling, not a target.
    maxTokens: 512,
  });

  const parsed = parseAnalysis(text);
  return {
    analysis: parsed ?? UNCLEAR_ANALYSIS,
    usage,
    fallback: parsed === undefined,
  };
}

/**
 * Parses model output into an {@link Analysis}, or `undefined` if it cannot.
 *
 * Tolerant of the ways a model wraps JSON — code fences, a leading sentence —
 * but never tolerant of the *shape*: the result must satisfy the schema, or it
 * is treated as unparseable. Exported for direct testing.
 */
export function parseAnalysis(raw: string): Analysis | undefined {
  const json = extractJsonObject(raw);
  if (json === undefined) return undefined;

  const result = analysisSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

/** Extracts the first JSON object from text that may wrap or precede it. */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
