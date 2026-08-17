import type { CompletionRequest, CompletionResult, LlmClient } from './client.js';

/**
 * A local, deterministic LLM stand-in for development (config `LLM_MODE=stub`).
 *
 * It answers the same two prompt shapes the workflow sends — classification and
 * reply generation — with plausible, rule-based output, and **never calls the
 * Anthropic API**. The point is to exercise the full WhatsApp round trip
 * (webhook → queue → worker → reply) as many times as you like without spending
 * tokens on every test message.
 *
 * It is intentionally dumb: keyword matching, not understanding. It is not a
 * substitute for the real model and is never selected outside `stub` mode.
 */
export class StubLlmClient implements LlmClient {
  complete(request: CompletionRequest): Promise<CompletionResult> {
    const lastUser =
      [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    // The classifier and the reply generator send distinct system prompts; the
    // classifier's names itself. That is enough to route to the right stub.
    const text = request.system.includes('classification stage')
      ? stubAnalysis(lastUser)
      : stubReply(lastUser);

    return Promise.resolve({
      text,
      usage: {
        model: `stub:${request.model}`,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      },
    });
  }
}

/** Opt-out phrasings a keyword classifier can catch without the LLM. */
const OPT_OUT = /תפסיק|תפסיקו|להסיר|הסירו|אל תפנ|לא מעוניין לקבל|stop|unsubscribe/i;

/** The named Beer Sheva neighborhoods from the spec (multi-character only). */
const NEIGHBORHOODS = ['נווה זאב', 'נחל עשן', 'רמות'];

/** Produces a classification JSON string that satisfies `analysisSchema`. */
function stubAnalysis(message: string): string {
  if (OPT_OUT.test(message)) {
    return JSON.stringify({ intent: 'OPT_OUT', confidence: 0.95 });
  }

  const extracted: Record<string, string> = {};

  const neighborhood = NEIGHBORHOODS.find((name) => message.includes(name));
  if (neighborhood) extracted.neighborhood = neighborhood;

  if (/עם מתווך/.test(message)) extracted.currentlyMarketed = 'with_agent';
  else if (/באופן פרטי/.test(message)) extracted.currentlyMarketed = 'privately';

  return JSON.stringify({ intent: 'ANSWER', confidence: 0.9, extracted });
}

/**
 * Produces a reply for the action named in the trailing `[INSTRUCTION]` turn.
 *
 * The strings mirror the workflow's own safe variants, so every one passes the
 * send-time validator — a stub reply can never be the thing that ships a bad
 * message during a test.
 */
function stubReply(directive: string): string {
  if (directive.includes('neighborhood')) return 'באיזו שכונה נמצא הנכס?';
  if (directive.includes('currently being marketed')) return 'האם הנכס משווק כרגע?';
  if (directive.includes('good fit')) {
    return 'תודה, קיבלתי את הפרטים. לידור יחזור אליך בהקדם.';
  }
  if (directive.includes('close the conversation')) {
    return 'תודה על הזמן. נשמח לעמוד לרשותך בעתיד.';
  }
  if (directive.includes('request to stop')) return 'קיבלתי, לא נפנה אליך יותר. תודה.';
  if (directive.includes('concern')) return 'אני מבין אותך. אפשר לספר לי עוד?';
  if (directive.includes('rephrase')) return 'לא הבנתי עד הסוף. אפשר לנסח שוב?';
  return 'אשמח לעזור. מה תרצה לדעת?';
}
