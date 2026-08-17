import { describe, expect, it } from 'vitest';
import type { Analysis } from './classify.js';
import { CONFIDENCE_THRESHOLD, decideTransition, type KnownFacts } from './decide.js';

/** Builds an analysis with sensible confident defaults, overridable per test. */
function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    intent: 'ANSWER',
    confidence: 0.9,
    extracted: {},
    needsEscalation: false,
    ...overrides,
  };
}

describe('decideTransition', () => {
  it('routes an opt-out to the terminal stage from any stage', () => {
    const decision = decideTransition(
      'screening_neighborhood',
      analysis({ intent: 'OPT_OUT' }),
    );
    expect(decision).toEqual({
      nextStage: 'opted_out',
      action: 'acknowledge_opt_out',
      escalate: false,
    });
  });

  it('opt-out beats a disqualifying fact in the same message', () => {
    const decision = decideTransition(
      'engaged',
      analysis({ intent: 'OPT_OUT', extracted: { currentlyMarketed: 'with_agent' } }),
    );
    expect(decision.nextStage).toBe('opted_out');
  });

  it('clarifies rather than guessing when confidence is below the threshold', () => {
    const decision = decideTransition(
      'engaged',
      analysis({ confidence: CONFIDENCE_THRESHOLD - 0.01 }),
    );
    expect(decision.action).toBe('clarify');
    expect(decision.escalate).toBe(true);
    expect(decision.nextStage).toBe('engaged');
  });

  it('clarifies on an UNCLEAR intent even at high confidence', () => {
    const decision = decideTransition(
      'new',
      analysis({ intent: 'UNCLEAR', confidence: 1 }),
    );
    expect(decision.action).toBe('clarify');
    // A first inbound must not linger in `new`.
    expect(decision.nextStage).toBe('engaged');
  });

  it.each([
    ['not_selling', { sellIntent: 'not_selling' }, 'not_selling'],
    ['no_urgency', { timeline: 'no_urgency' }, 'no_urgency'],
    ['with_agent', { currentlyMarketed: 'with_agent' }, 'exclusive_with_other_agent'],
  ] as const)(
    'disqualifies on %s with the mapped reason',
    (_label, extracted, reason) => {
      const decision = decideTransition(
        'screening_currently_marketed',
        analysis({ extracted }),
      );
      expect(decision.nextStage).toBe('disqualified');
      expect(decision.action).toBe('send_disqualification');
      expect(decision.qualified).toBe(false);
      expect(decision.disqualificationReason).toBe(reason);
    },
  );

  it('disqualifies on a fact learned in an earlier turn', () => {
    const known: KnownFacts = { currentlyMarketed: 'with_agent' };
    const decision = decideTransition('screening_currently_marketed', analysis(), known);
    expect(decision.disqualificationReason).toBe('exclusive_with_other_agent');
  });

  it('handles an objection without advancing screening, on the stronger model', () => {
    const decision = decideTransition(
      'screening_neighborhood',
      analysis({ intent: 'OBJECTION' }),
    );
    expect(decision.action).toBe('handle_objection');
    expect(decision.escalate).toBe(true);
    expect(decision.nextStage).toBe('screening_neighborhood');
  });

  it('answers an FAQ in place', () => {
    const decision = decideTransition('engaged', analysis({ intent: 'FAQ' }));
    expect(decision).toMatchObject({ action: 'answer_faq', nextStage: 'engaged' });
  });

  it('asks for the neighborhood first when nothing is known', () => {
    const decision = decideTransition('new', analysis());
    expect(decision.nextStage).toBe('screening_neighborhood');
    expect(decision.action).toBe('ask_neighborhood');
  });

  it('asks whether currently marketed once the neighborhood is known', () => {
    const decision = decideTransition(
      'screening_neighborhood',
      analysis({ extracted: { neighborhood: 'רמות' } }),
    );
    expect(decision.nextStage).toBe('screening_currently_marketed');
    expect(decision.action).toBe('ask_currently_marketed');
  });

  it('qualifies once both screening answers are in and none disqualifies', () => {
    const decision = decideTransition(
      'screening_currently_marketed',
      analysis({ extracted: { currentlyMarketed: 'no' } }),
      { neighborhood: 'נווה זאב' },
    );
    expect(decision.nextStage).toBe('qualified');
    expect(decision.action).toBe('proceed_qualified');
    expect(decision.qualified).toBe(true);
  });

  it('escalates the reply when the classifier flags frustration', () => {
    const decision = decideTransition('new', analysis({ needsEscalation: true }));
    expect(decision.escalate).toBe(true);
  });
});
