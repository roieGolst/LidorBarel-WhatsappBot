import { describe, expect, it } from 'vitest';
import { CLASSIFIER_MODEL, ESCALATION_MODEL } from '../llm/client.js';
import { FakeLlmClient } from '../llm/fake.js';
import { classifyAndExtract, parseAnalysis, UNCLEAR_ANALYSIS } from './classify.js';

describe('parseAnalysis', () => {
  it('parses a well-formed analysis', () => {
    const analysis = parseAnalysis(
      JSON.stringify({
        intent: 'ANSWER',
        confidence: 0.9,
        extracted: { neighborhood: 'רמות', timeline: 'immediate' },
        needsEscalation: false,
      }),
    );

    expect(analysis).toEqual({
      intent: 'ANSWER',
      confidence: 0.9,
      extracted: { neighborhood: 'רמות', timeline: 'immediate' },
      needsEscalation: false,
      wantsBuyerProof: false,
      wantsSocialProof: false,
      asksQuestion: false,
    });
  });

  it('applies defaults for extracted and needsEscalation', () => {
    const analysis = parseAnalysis('{"intent":"FAQ","confidence":0.6}');
    expect(analysis).toEqual({
      intent: 'FAQ',
      confidence: 0.6,
      extracted: {},
      needsEscalation: false,
      wantsBuyerProof: false,
      wantsSocialProof: false,
      asksQuestion: false,
    });
  });

  it('tolerates a code fence and surrounding prose', () => {
    const raw =
      'Here is the classification:\n```json\n{"intent":"OPT_OUT","confidence":0.95}\n```';
    expect(parseAnalysis(raw)?.intent).toBe('OPT_OUT');
  });

  it('strips unknown keys rather than rejecting the whole object', () => {
    const analysis = parseAnalysis(
      '{"intent":"ANSWER","confidence":0.8,"mood":"cheerful"}',
    );
    expect(analysis?.intent).toBe('ANSWER');
    expect(analysis).not.toHaveProperty('mood');
  });

  it.each([
    ['not JSON at all', 'the customer wants to sell'],
    ['an unknown intent', '{"intent":"MAYBE","confidence":0.5}'],
    ['confidence out of range', '{"intent":"ANSWER","confidence":1.5}'],
    [
      'an invalid enum value',
      '{"intent":"ANSWER","confidence":0.5,"extracted":{"timeline":"someday"}}',
    ],
    ['a missing required field', '{"confidence":0.5}'],
  ])('returns undefined for %s', (_label, raw) => {
    expect(parseAnalysis(raw)).toBeUndefined();
  });
});

describe('classifyAndExtract', () => {
  it('returns the parsed analysis and records usage', async () => {
    const llm = new FakeLlmClient([
      '{"intent":"ANSWER","confidence":0.9,"extracted":{"currentlyMarketed":"no"}}',
    ]);

    const result = await classifyAndExtract(llm, { text: 'עדיין לא שיווקתי' });

    expect(result.fallback).toBe(false);
    expect(result.analysis.intent).toBe('ANSWER');
    expect(result.analysis.extracted.currentlyMarketed).toBe('no');
    expect(result.usage.model).toBe(CLASSIFIER_MODEL);
  });

  it('defaults to the classifier model and puts the message last', async () => {
    const llm = new FakeLlmClient(['{"intent":"FAQ","confidence":0.7}']);

    await classifyAndExtract(llm, {
      text: 'כמה זה עולה?',
      history: [{ role: 'assistant', content: 'שלום, איך אפשר לעזור?' }],
    });

    const request = llm.requests[0]!;
    expect(request.model).toBe(CLASSIFIER_MODEL);
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'כמה זה עולה?' });
    expect(request.messages).toHaveLength(2);
  });

  it('uses the escalation model when asked', async () => {
    const llm = new FakeLlmClient(['{"intent":"OBJECTION","confidence":0.8}']);

    await classifyAndExtract(llm, { text: 'אני לא בטוח שאתם רציניים', escalate: true });

    expect(llm.requests[0]!.model).toBe(ESCALATION_MODEL);
  });

  it('falls back to a safe UNCLEAR analysis when the model output cannot be parsed', async () => {
    const llm = new FakeLlmClient(['I think they want to sell but I am not sure.']);

    const result = await classifyAndExtract(llm, { text: '???' });

    expect(result.fallback).toBe(true);
    expect(result.analysis).toEqual(UNCLEAR_ANALYSIS);
    expect(result.analysis.needsEscalation).toBe(true);
  });
});
