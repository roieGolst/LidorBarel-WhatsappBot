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

/** Who the contact is, for media selection only — the seller flow is unchanged. */
const contactIntent = z.enum(['seller', 'buyer', 'investor', 'unclear']);

/**
 * Screening facts extracted from a message. Every field is optional — the model
 * reports only what the person actually said. Unknown keys are stripped rather
 * than rejected, so a stray field the model invents cannot fail an otherwise
 * good classification.
 *
 * `neighborhood` is the customer's *exact words* (validated and normalized by
 * `validateAnswer.ts`, never overwritten with a nearest match). `city` is set
 * only when the property is outside Be'er Sheva. `notes` is a short summary of any
 * extra property details volunteered beyond the four questions.
 */
export const extractedSchema = z.object({
  sellIntent: sellIntent.optional(),
  neighborhood: z.string().min(1).optional(), // Q2, free text
  city: z.string().min(1).optional(), // set only when not Be'er Sheva
  timeline: timeline.optional(),
  currentlyMarketed: currentlyMarketed.optional(),
  notes: z.string().min(1).optional(), // summarized extra details (req #6)
});

export type ExtractedFacts = z.infer<typeof extractedSchema>;

/**
 * Facts as stored on `conversations.extracted`: the model-extracted fields plus
 * two values derived by code (never by the model) — the canonical neighborhood
 * name and whether the property is outside the service area.
 */
export interface StoredFacts extends ExtractedFacts {
  /** Canonical neighborhood name when recognised; null when unknown-but-valid. */
  neighborhoodCanonical?: string | null;
  /** True when the property is outside Be'er Sheva (service-area handling). */
  outsideServiceArea?: boolean;
}

export const analysisSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  extracted: extractedSchema.default({}),
  needsEscalation: z.boolean().default(false),
  /** True when the message actually answers the question the bot just asked. */
  answersPendingQuestion: z.boolean().default(false),
  /** False when the message is off-topic — unrelated to selling the property. */
  relevantToSelling: z.boolean().default(true),
  /** Whether the person is a seller, a buyer, an investor, or not yet clear. */
  contactIntent: contactIntent.default('unclear'),
  /** True when they ask to hear from past customers / see recommendations. */
  wantsSocialProof: z.boolean().default(false),
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
  answersPendingQuestion: false,
  relevantToSelling: false,
  contactIntent: 'unclear',
  wantsSocialProof: false,
};

const SYSTEM_PROMPT = `You are the classification stage of an inbound WhatsApp bot for a real estate agent in Beer Sheva, Israel. Leads write in Hebrew, often informally, with typos, slang, or voice-to-text artifacts.

Your ONLY job is to read the latest message (with the conversation as context) and return a single JSON object describing it. You do not reply to the person and you do not decide what happens next — you only observe.

Return JSON with exactly these fields:
- "intent": one of "ANSWER" (answering a screening question or giving property info), "OBJECTION" (pushback, doubt, or a concern — e.g. "אני צריך לחשוב", "היה לי ניסיון רע עם מתווך"), "FAQ" (a general question about the service, value, fees, or process — e.g. "כמה שווה הדירה שלי?", "למה כדאי לעבוד איתך?"), "OPT_OUT" (any request to stop, unsubscribe, or not be contacted — including indirect phrasings like "תפסיקו", "אל תפנו אליי", "מוריד אתכם"), "OFF_TOPIC" (unrelated to selling this property — chit-chat, jokes, tests, nonsense, or a different subject), or "UNCLEAR" (you cannot tell).
- "confidence": a number from 0 to 1.
- "extracted": an object with any of these you can determine from the message, omitting the rest. The person is answering the questionnaire's fixed options; map their words onto the tokens:
    - "sellIntent" (Q1 — "האם חשבת למכור או רק לקבל הערכת מחיר?"): "ready" (רוצה למכור) | "not_sure" (מתלבט, רוצה לדעת מחיר) | "not_selling" (לא מעוניין למכור)
    - "neighborhood" (Q2 — "באיזו שכונה נמצא הנכס?"): the neighborhood the property is in, as the person's EXACT words (do not translate, correct, or swap it for a similar name). Known Be'er Sheva neighborhoods include נווה זאב, נחל עשן, נחל בקע, רמות, נאות לון, נווה נוי, נאות אברהם, העיר העתיקה, and שכונות א׳/ב׳/ג׳/ד׳/ה׳/ו׳/ט׳ — but ANY real place name is acceptable, not only these. Extract "neighborhood" ONLY when the message is genuinely naming a place; never map an unrelated word, a product/model name, or nonsense to it.
    - "city": set ONLY if the property is stated to be in a city other than Be'er Sheva (as free text). Omit for Be'er Sheva.
    - "timeline" (Q3 — "תוך כמה זמן תרצה למכור אם תקבל הצעה מתאימה?"): "immediate" (מיד) | "within_month" (בחודש הקרוב) | "still_checking" (בחודשים הקרובים) | "no_urgency" (אין דחיפות)
    - "currentlyMarketed" (Q4 — "האם הנכס משווק כרגע?"): "no" (לא) | "privately" (כן, באופן פרטי) | "with_agent" (כן, עם מתווך)
    - "notes": a SHORT Hebrew summary of any extra property details the person volunteered beyond the four questions (rooms, size, floor, price expectation, condition, etc.). Omit if none.
- "needsEscalation": true if the message shows anger, frustration, or something a bot should not handle alone.
- "answersPendingQuestion": true only if this message actually and plausibly answers the specific question the bot last asked. A nonsensical, evasive, off-topic, or unrelated reply is false.
- "relevantToSelling": false if the message is unrelated to selling this property (chit-chat, jokes, tests, provocation, another topic); true otherwise.
- "contactIntent": "seller" (wants to sell a property) | "buyer" (wants to buy to live in) | "investor" (wants to buy for investment) | "unclear". Default to "unclear" unless the message makes it clear.
- "wantsSocialProof": true if they ask to hear from past customers, see recommendations/testimonials, or ask for proof of results.

Rules:
- Output ONLY the JSON object. No prose, no code fences, no explanation.
- Never invent extracted values. If the message does not clearly state a field, omit it.
- A reply that does not actually answer the pending question must have "answersPendingQuestion": false and must NOT carry a made-up "extracted" value.
- Prefer "UNCLEAR" with low confidence over guessing.`;

export interface ClassifyInput {
  /** The inbound message to classify. */
  text: string;
  /** Prior turns for context, oldest first. Omit for the first message. */
  history?: { role: 'user' | 'assistant'; content: string }[];
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

  const { text, usage } = await llm.complete({
    model,
    system: SYSTEM_PROMPT,
    messages: [...(input.history ?? []), { role: 'user', content: input.text }],
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

// ---------------------------------------------------------------------------
// Lead-quality judge
// ---------------------------------------------------------------------------

/**
 * A holistic read of the whole conversation, produced once — after the motivation
 * question — to decide whether a completed lead is worth Lidor's time (review
 * req #2). Like the classifier, the model only *observes*: it returns these
 * signals and `qualify.ts` (plain TypeScript) turns them into the verdict.
 */
export const leadQualitySchema = z.object({
  /** 0–1: how serious and motivated the seller appears. */
  seriousness: z.number().min(0).max(1),
  /** Whether they show a genuine (or genuine potential) intention to sell. */
  genuineIntent: z.boolean(),
  /** Whether the conversation looks like spam, a test, or manipulation/abuse. */
  spam: z.boolean(),
  /** A short Hebrew justification, for the audit trail. */
  reason: z.string().default(''),
});

export type LeadQuality = z.infer<typeof leadQualitySchema>;

/**
 * The conservative fallback when the judge's output cannot be parsed: not spam,
 * but not confidently serious either — which `qualify.ts` resolves to
 * `needs_review` rather than a false qualify or a false disqualify.
 */
export const CONSERVATIVE_QUALITY: LeadQuality = {
  seriousness: 0.4,
  genuineIntent: false,
  spam: false,
  reason: 'assessment unavailable',
};

const JUDGE_SYSTEM_PROMPT = `You are the quality-control stage of an inbound WhatsApp bot for a real estate agent in Beer Sheva. A seller has just finished the screening questions. Your job is to judge, from the WHOLE conversation, whether this is a real, serious lead worth the agent's personal time — not whether they answered every question.

Read the conversation and return a single JSON object:
- "seriousness": number 0 to 1 — how serious, motivated, and cooperative the seller seems.
- "genuineIntent": true if they show a real (or realistically potential) intention to sell a real property; false if they seem to be just poking around, testing, or clearly not going to sell.
- "spam": true if the conversation looks like spam, a test, a prank, abuse, or an attempt to manipulate the bot (nonsensical answers, contradictions, provocation, gibberish).
- "reason": one short Hebrew sentence explaining your call.

Rules:
- Output ONLY the JSON object. No prose, no code fences.
- Base this on the substance and consistency of what was said, not on politeness alone.
- If answers were nonsensical, contradictory, evasive, or clearly not about a real property, lower seriousness and consider "spam".`;

export interface JudgeInput {
  /** The conversation so far, oldest first. */
  history: { role: 'user' | 'assistant'; content: string }[];
}

export interface JudgeResult {
  quality: LeadQuality;
  usage: LlmUsage;
  /** True when the model's output failed to parse and the fallback was used. */
  fallback: boolean;
}

/** Parses judge output into a {@link LeadQuality}, or `undefined` if it cannot. */
export function parseLeadQuality(raw: string): LeadQuality | undefined {
  const json = extractJsonObject(raw);
  if (json === undefined) return undefined;
  const result = leadQualitySchema.safeParse(json);
  return result.success ? result.data : undefined;
}

/**
 * Judges overall lead quality on the stronger model. One call per completed lead
 * (never per turn), and never in containment mode.
 */
export async function judgeLeadQuality(
  llm: LlmClient,
  input: JudgeInput,
): Promise<JudgeResult> {
  const { text, usage } = await llm.complete({
    model: ESCALATION_MODEL,
    system: JUDGE_SYSTEM_PROMPT,
    messages: input.history.length > 0 ? input.history : [{ role: 'user', content: '' }],
    maxTokens: 512,
  });

  const parsed = parseLeadQuality(text);
  return {
    quality: parsed ?? CONSERVATIVE_QUALITY,
    usage,
    fallback: parsed === undefined,
  };
}
