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

/** Stable spec voice — cached across turns (§7). Directives ride in the messages. */
const VOICE_PROMPT = `You are the voice of Lidor Barel, a senior, trusted real estate agent in Beer Sheva. You reply to leads on WhatsApp, in Hebrew.

Voice: professional, warm, and sharp. Sound like an experienced human agent, never like an automated bot or a pushy salesperson.

Hard rules:
- Write in Hebrew. Keep it short — one or two lines.
- Ask at most ONE question per message, and only when the instruction calls for it.
- Never use pressure or over-promising language (no "deal", "cheap", "urgent", "guaranteed", "I promise", "a hundred percent", "must").
- Open gender-neutral; do not assume the lead's gender.
- Output ONLY the message text to send. No quotes, no preamble, no explanation.

The conversation so far is below. The final turn is a bracketed instruction telling you what to say next — it is your director, not the customer speaking. Follow it and write the reply.`;

/** What to tell the model to produce, per decided action. */
const DIRECTIVES: Record<TurnAction, string> = {
  ask_neighborhood:
    'Ask which Beer Sheva neighborhood the property is in. One short question.',
  ask_currently_marketed:
    'Ask whether the property is currently being marketed — privately, through another agent, or not at all. One short question.',
  proceed_qualified:
    'The lead is a good fit. Warmly thank them and say Lidor will be in touch shortly. Do not ask a question.',
  send_disqualification:
    'Politely close the conversation: thank them, leave the door open for the future, apply no pressure. Do not ask a question.',
  acknowledge_opt_out:
    'Acknowledge their request to stop, once and politely, and confirm they will not be contacted again. Do not ask a question.',
  answer_faq: 'Answer their question briefly and helpfully in Lidor’s voice.',
  handle_objection:
    'Acknowledge their concern with empathy and address it briefly. You may ask one gentle follow-up.',
  clarify: 'You did not fully understand. Ask them to rephrase. One short question.',
};

/**
 * Pre-written safe replies, used only when two generation attempts both fail the
 * validator. Deliberately plain and spec-clean — every one passes
 * {@link validateReply} (asserted in the tests).
 */
export const SAFE_VARIANTS: Record<TurnAction, string> = {
  ask_neighborhood: 'באיזו שכונה נמצא הנכס?',
  ask_currently_marketed: 'האם הנכס משווק כרגע?',
  proceed_qualified: 'תודה, קיבלתי את הפרטים. לידור יחזור אליך בהקדם.',
  send_disqualification: 'תודה על הזמן. נשמח לעמוד לרשותך בעתיד.',
  acknowledge_opt_out: 'קיבלתי, לא נפנה אליך יותר. תודה.',
  answer_faq: 'אשמח לעזור. מה תרצה לדעת?',
  handle_objection: 'אני מבין אותך. אפשר לספר לי עוד?',
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
