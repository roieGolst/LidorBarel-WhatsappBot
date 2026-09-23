import { z } from 'zod';
import {
  CLASSIFIER_MODEL,
  type LlmClient,
  type LlmMessage,
  type LlmUsage,
} from '../llm/client.js';
import { getLogger } from '../logger.js';
import type { KnownFacts } from '../workflow/decide.js';
import type { MeetingBrief } from './meetingNote.js';

/**
 * The model-written part of the meeting note: what the person said about the
 * property, what they asked or worried about, and the one thing Lidor should
 * lead with to close. Written for Lidor, from the transcript, at the moment a
 * consultation is booked or moved — the stored answers alone cannot say what
 * someone was hesitant about.
 *
 * Deliberately tolerant: a booking is a calendar event Lidor will keep whether
 * or not the brief exists, so a model outage, a timeout or unparseable output
 * yields no brief and never an error. The note still carries the facts.
 */

const briefSchema = z.object({
  property: z.string().max(400).default(''),
  concerns: z.array(z.string().min(1).max(200)).max(4).default([]),
  focus: z.string().max(300).default(''),
});

const SYSTEM_PROMPT = `You write a short pre-call brief for Lidor Barel, a real-estate agent in Beer Sheva, before a consultation call with a seller lead. You are given the WhatsApp conversation between Lidor's assistant bot ("assistant") and the lead ("user"), and the property details already on file.

Return ONE JSON object with exactly these fields, all in Hebrew, in a CRM register (concise, factual, not the bot's chatty voice, no emojis):
- "property": one line with everything concrete the person said about the property — street/address if given, neighbourhood, rooms, floor, size, condition/renovation, parking, occupancy, asking price or expectation. Merge with the details on file; no duplication. Empty string if nothing concrete was said.
- "concerns": up to 4 short items — questions the person asked, objections, hesitations, constraints or conditions they raised (fees, timing, another agent or exclusivity, price expectations, a partner who must agree, and so on). The substance of what they said, not the bot's answers. Empty array if none.
- "focus": one sentence for Lidor — the single most useful thing to lead with on the call to move this toward a signed agreement, derived from THIS person's motivation, urgency and concerns. Concrete, never generic ("be professional" is useless).

Rules: never invent facts that are not in the conversation or on file; if unsure, leave it out. Output ONLY the JSON object — no prose, no code fences.`;

export interface MeetingBriefInput {
  /** The transcript so far, oldest first. */
  history: LlmMessage[];
  facts: KnownFacts;
}

export interface MeetingBriefResult {
  brief?: MeetingBrief | undefined;
  usage?: LlmUsage | undefined;
}

/** Writes the brief, or nothing. Never throws. */
export async function generateMeetingBrief(
  llm: LlmClient,
  input: MeetingBriefInput,
): Promise<MeetingBriefResult> {
  const onFile = [
    input.facts.neighborhood ? `שכונה: ${input.facts.neighborhood}` : undefined,
    input.facts.additionalNotes ? `פרטי הנכס: ${input.facts.additionalNotes}` : undefined,
  ].filter((line): line is string => line !== undefined);

  try {
    const { text, usage } = await llm.complete({
      model: CLASSIFIER_MODEL,
      system: SYSTEM_PROMPT,
      messages: [
        ...input.history,
        ...(onFile.length > 0
          ? [{ role: 'user' as const, content: `(על הנכס בקובץ: ${onFile.join(' · ')})` }]
          : []),
        { role: 'user', content: 'כתוב את התקציר לפי ההנחיות. JSON בלבד.' },
      ],
      maxTokens: 500,
    });
    return { brief: parseBrief(text), usage };
  } catch (error) {
    getLogger().warn(
      { error },
      'meeting brief not written — booking continues without it',
    );
    return {};
  }
}

/** The first JSON object in the reply, validated; an empty brief is no brief. */
export function parseBrief(raw: string): MeetingBrief | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const result = briefSchema.safeParse(json);
  if (!result.success) return undefined;
  const brief = {
    property: result.data.property.trim(),
    concerns: result.data.concerns.map((c) => c.trim()).filter((c) => c.length > 0),
    focus: result.data.focus.trim(),
  };
  return brief.property || brief.concerns.length > 0 || brief.focus ? brief : undefined;
}
