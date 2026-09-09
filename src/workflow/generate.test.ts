import { describe, expect, it } from 'vitest';
import { CLASSIFIER_MODEL, ESCALATION_MODEL } from '../llm/client.js';
import { FakeLlmClient } from '../llm/fake.js';
import { generateReply, generateValidatedReply, SAFE_VARIANTS } from './generate.js';
import { validateReply } from './validate.js';

const SAFE_ENTRIES = Object.entries(SAFE_VARIANTS);

describe('SAFE_VARIANTS', () => {
  it.each(SAFE_ENTRIES)(
    'the safe variant for %s passes validation',
    (_action, variant) => {
      expect(validateReply(variant).ok).toBe(true);
    },
  );
});

describe('generateReply', () => {
  it('uses the classifier model and ends with the action instruction', async () => {
    const llm = new FakeLlmClient(['באיזו שכונה נמצא הנכס?']);

    await generateReply(llm, {
      action: 'answer_faq',
      escalate: false,
      history: [{ role: 'user', content: 'שלום' }],
    });

    const request = llm.requests[0]!;
    expect(request.model).toBe(CLASSIFIER_MODEL);
    expect(request.messages.at(-1)?.content).toContain('[INSTRUCTION]');
    expect(request.messages).toHaveLength(2);
  });

  it('uses the escalation model when asked', async () => {
    const llm = new FakeLlmClient(['אני מבין אותך, אפשר לספר לי עוד?']);
    await generateReply(llm, { action: 'handle_objection', escalate: true });
    expect(llm.requests[0]!.model).toBe(ESCALATION_MODEL);
  });
});

describe('generateValidatedReply', () => {
  it('returns a clean first draft without regenerating', async () => {
    const llm = new FakeLlmClient(['תודה, קיבלתי את הפרטים.']);

    const result = await generateValidatedReply(llm, {
      action: 'about_lidor',
      escalate: false,
    });

    expect(result.text).toBe('תודה, קיבלתי את הפרטים.');
    expect(result.regenerated).toBe(false);
    expect(result.fellBack).toBe(false);
    expect(result.usage).toHaveLength(1);
  });

  it('regenerates once on the stronger model when the first draft is invalid', async () => {
    // First draft uses a banned word; the retry is clean.
    const llm = new FakeLlmClient([
      'יש לנו מבצע מיוחד בשבילך!',
      'שמחתי לשמוע, באיזו שכונה הנכס?',
    ]);

    const result = await generateValidatedReply(llm, {
      action: 'answer_faq',
      escalate: false,
    });

    expect(result.regenerated).toBe(true);
    expect(result.fellBack).toBe(false);
    expect(result.text).toBe('שמחתי לשמוע, באיזו שכונה הנכס?');
    expect(result.usage).toHaveLength(2);

    // The retry ran on the escalation model and was told which term to avoid.
    const retryRequest = llm.requests[1]!;
    expect(retryRequest.model).toBe(ESCALATION_MODEL);
    expect(retryRequest.messages.at(-1)?.content).toContain('מבצע');
  });

  it('falls back to a safe variant when both attempts fail validation', async () => {
    const llm = new FakeLlmClient(['מבצע דחוף!', 'בטוח שזה זול!']);

    const result = await generateValidatedReply(llm, {
      action: 'about_lidor',
      escalate: false,
    });

    expect(result.fellBack).toBe(true);
    expect(result.text).toBe(SAFE_VARIANTS.about_lidor);
    expect(validateReply(result.text).ok).toBe(true);
    expect(result.usage).toHaveLength(2);
  });
});

describe('context', () => {
  it('hands the reply-writer facts that are not in the transcript', async () => {
    // The times offered live in a list message whose rows are never stored, so
    // the generator is told them explicitly — as [CONTEXT] after the directive.
    const llm = new FakeLlmClient([
      'המועד הראשון הוא הכי מוקדם שפנוי. איזה מהם מתאים לך?',
    ]);

    await generateValidatedReply(llm, {
      action: 'assist_booking',
      escalate: false,
      context: "Lidor's free times currently offered: 1) יום שלישי 19:00",
    });

    const last = llm.requests[0]!.messages.at(-1)!;
    expect(last.content).toContain('[INSTRUCTION]');
    expect(last.content).toContain(
      "[CONTEXT] Lidor's free times currently offered: 1) יום שלישי 19:00",
    );
  });
});
