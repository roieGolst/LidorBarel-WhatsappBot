import { describe, expect, it } from 'vitest';
import { parseAnalysis } from '../workflow/classify.js';
import { validateReply } from '../workflow/validate.js';
import type { CompletionRequest } from './client.js';
import { StubLlmClient } from './stubClient.js';

const CLASSIFY_SYSTEM = 'You are the classification stage of an inbound WhatsApp bot.';
const GENERATE_SYSTEM = 'You are the voice of Lidor Barel.';

function request(system: string, content: string): CompletionRequest {
  return {
    model: 'claude-haiku-4-5',
    system,
    messages: [{ role: 'user', content }],
    maxTokens: 300,
  };
}

describe('StubLlmClient', () => {
  const stub = new StubLlmClient();

  it('never reports token usage — it makes no API call', async () => {
    const { usage } = await stub.complete(request(CLASSIFY_SYSTEM, 'שלום'));
    expect(usage).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    expect(usage.model).toContain('stub');
  });

  it('classifies an ordinary message as a parseable ANSWER', async () => {
    const { text } = await stub.complete(request(CLASSIFY_SYSTEM, 'יש לי דירה למכירה'));
    expect(parseAnalysis(text)?.intent).toBe('ANSWER');
  });

  it('classifies an opt-out message as OPT_OUT', async () => {
    const { text } = await stub.complete(
      request(CLASSIFY_SYSTEM, 'תפסיקו לשלוח לי הודעות'),
    );
    expect(parseAnalysis(text)?.intent).toBe('OPT_OUT');
  });

  it('extracts a known neighborhood', async () => {
    const { text } = await stub.complete(request(CLASSIFY_SYSTEM, 'הדירה בשכונת רמות'));
    expect(parseAnalysis(text)?.extracted.neighborhood).toBe('רמות');
  });

  it.each([
    ['Ask which Beer Sheva neighborhood the property is in.', 'שכונה'],
    ['Ask whether the property is currently being marketed.', 'משווק'],
    ['Acknowledge their request to stop, once and politely.', 'לא נפנה'],
  ])('generates a valid reply for the %s directive', async (directive, expected) => {
    const { text } = await stub.complete(
      request(GENERATE_SYSTEM, `[INSTRUCTION] ${directive}`),
    );
    expect(text).toContain(expected);
    expect(validateReply(text).ok).toBe(true);
  });
});
