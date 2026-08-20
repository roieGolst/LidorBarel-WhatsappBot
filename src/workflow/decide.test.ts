import { describe, expect, it } from 'vitest';
import type { ConversationStage } from '../db/repositories/conversations.js';
import type { Analysis } from './classify.js';
import {
  CONFIDENCE_THRESHOLD,
  decideTransition,
  screensAllQuestions,
  type KnownFacts,
} from './decide.js';
import { emptyScreeningState, type ScreeningState } from './screeningState.js';
import { validateAnswers } from './validateAnswer.js';

/** Builds an analysis with sensible confident defaults, overridable per test. */
function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    intent: 'ANSWER',
    confidence: 0.9,
    extracted: {},
    needsEscalation: false,
    answersPendingQuestion: true,
    relevantToSelling: true,
    contactIntent: 'unclear',
    wantsSocialProof: false,
    ...overrides,
  };
}

/** Runs a decision the way the workflow does: validate, then decide. */
function run(opts: {
  current?: ConversationStage;
  analysis?: Partial<Analysis>;
  known?: KnownFacts;
  screenAll?: boolean;
  state?: Partial<ScreeningState>;
}) {
  const a = analysis(opts.analysis);
  const validation = validateAnswers(a.extracted, a);
  const state: ScreeningState = { ...emptyScreeningState(), ...(opts.state ?? {}) };
  return decideTransition({
    current: opts.current ?? 'new',
    analysis: a,
    known: opts.known ?? {},
    validation,
    screenAll: opts.screenAll ?? false,
    state,
  });
}

describe('decideTransition', () => {
  it('routes an opt-out to the terminal stage from any stage', () => {
    const { decision } = run({
      current: 'screening_neighborhood',
      analysis: { intent: 'OPT_OUT' },
    });
    expect(decision).toMatchObject({
      nextStage: 'opted_out',
      action: 'acknowledge_opt_out',
      escalate: false,
    });
  });

  it('opt-out beats a disqualifying fact in the same message', () => {
    const { decision } = run({
      current: 'engaged',
      analysis: { intent: 'OPT_OUT', extracted: { currentlyMarketed: 'with_agent' } },
    });
    expect(decision.nextStage).toBe('opted_out');
  });

  it('clarifies rather than guessing when confidence is below the threshold', () => {
    const { decision } = run({
      current: 'engaged',
      analysis: { confidence: CONFIDENCE_THRESHOLD - 0.01 },
    });
    expect(decision.action).toBe('clarify');
    expect(decision.escalate).toBe(true);
    expect(decision.nextStage).toBe('engaged');
  });

  it('clarifies on an UNCLEAR intent even at high confidence', () => {
    const { decision } = run({
      current: 'new',
      analysis: { intent: 'UNCLEAR', confidence: 1, relevantToSelling: true },
    });
    expect(decision.action).toBe('clarify');
    expect(decision.nextStage).toBe('engaged');
  });

  it.each([
    ['not_selling', { sellIntent: 'not_selling' }, 'not_selling'],
    ['no_urgency', { timeline: 'no_urgency' }, 'no_urgency'],
    ['with_agent', { currentlyMarketed: 'with_agent' }, 'exclusive_with_other_agent'],
  ] as const)(
    'disqualifies on %s with the mapped reason',
    (_label, extracted, reason) => {
      const { decision } = run({
        current: 'screening_currently_marketed',
        analysis: { extracted },
      });
      expect(decision.nextStage).toBe('disqualified');
      expect(decision.action).toBe('send_disqualification');
      expect(decision.qualified).toBe(false);
      expect(decision.disqualificationReason).toBe(reason);
    },
  );

  it('disqualifies on a fact learned in an earlier turn', () => {
    const { decision } = run({
      current: 'screening_currently_marketed',
      known: { currentlyMarketed: 'with_agent' },
    });
    expect(decision.disqualificationReason).toBe('exclusive_with_other_agent');
  });

  it('handles an objection without advancing screening, on the stronger model', () => {
    const { decision } = run({
      current: 'screening_neighborhood',
      analysis: { intent: 'OBJECTION' },
    });
    expect(decision.action).toBe('handle_objection');
    expect(decision.escalate).toBe(true);
    expect(decision.nextStage).toBe('screening_neighborhood');
  });

  it('answers an FAQ in place', () => {
    const { decision } = run({ current: 'engaged', analysis: { intent: 'FAQ' } });
    expect(decision).toMatchObject({ action: 'answer_faq', nextStage: 'engaged' });
  });

  it('asks for the neighborhood first when nothing is known (form lead: Q2+Q4 only)', () => {
    const { decision } = run({ current: 'new' });
    expect(decision.nextStage).toBe('screening_neighborhood');
    expect(decision.action).toBe('ask_neighborhood');
  });

  it('asks whether currently marketed once the neighborhood is known', () => {
    const { decision } = run({
      current: 'screening_neighborhood',
      analysis: { extracted: { neighborhood: 'רמות' } },
    });
    expect(decision.nextStage).toBe('screening_currently_marketed');
    expect(decision.action).toBe('ask_currently_marketed');
  });

  it('probes motivation (not qualify) once both screening answers are in', () => {
    const { decision } = run({
      current: 'screening_currently_marketed',
      analysis: { extracted: { currentlyMarketed: 'no' } },
      known: { neighborhood: 'נווה זאב' },
    });
    // Reaching the end no longer qualifies — a motivation question comes first.
    expect(decision.nextStage).toBe('assessing_motivation');
    expect(decision.action).toBe('ask_motivation');
    expect(decision.qualified).toBeUndefined();
  });

  it('flags the motivation answer for the quality judge', () => {
    const { decision } = run({
      current: 'assessing_motivation',
      analysis: { extracted: {}, answersPendingQuestion: true },
    });
    expect(decision.assessQuality).toBe(true);
  });

  it('escalates the reply when the classifier flags frustration', () => {
    const { decision } = run({ current: 'new', analysis: { needsEscalation: true } });
    expect(decision.escalate).toBe(true);
  });

  describe('answer validation gate', () => {
    it('re-asks and does not advance when the neighborhood is invalid', () => {
      const { decision, state } = run({
        current: 'screening_neighborhood',
        analysis: { extracted: { neighborhood: 'Opus 4.8' } },
      });
      expect(decision.action).toBe('ask_neighborhood');
      expect(decision.nextStage).toBe('screening_neighborhood');
      expect(decision.revalidation?.field).toBe('neighborhood');
      expect(state.invalidAnswerCount).toBe(1);
      // The bad value is recorded as invalid, never stored as a fact.
      expect(state.answers.neighborhood).toMatchObject({ isValid: false });
    });

    it('accepts and advances on a valid Hebrew neighborhood', () => {
      const { decision, state } = run({
        current: 'screening_neighborhood',
        analysis: { extracted: { neighborhood: 'שכונה ג׳' } },
      });
      expect(decision.nextStage).toBe('screening_currently_marketed');
      expect(state.answers.neighborhood).toMatchObject({
        value: 'שכונה ג׳',
        isValid: true,
      });
    });
  });

  describe('off-topic containment escalation', () => {
    it('redirects on the first off-topic message, staying in normal mode', () => {
      const { decision, state } = run({
        current: 'screening_neighborhood',
        analysis: { intent: 'OFF_TOPIC', relevantToSelling: false },
      });
      expect(decision.action).toBe('redirect_off_topic');
      expect(state.irrelevantResponseCount).toBe(1);
      expect(state.mode).toBe('normal');
    });

    it('warns and enters containment on the second off-topic message', () => {
      const { decision, state } = run({
        current: 'screening_neighborhood',
        analysis: { intent: 'OFF_TOPIC', relevantToSelling: false },
        state: { irrelevantResponseCount: 1 },
      });
      expect(decision.action).toBe('warn_off_topic');
      expect(state.warningSent).toBe(true);
      expect(state.mode).toBe('containment');
    });

    it('stops responding once already warned, never qualifying', () => {
      const { decision } = run({
        current: 'screening_neighborhood',
        analysis: { intent: 'OFF_TOPIC', relevantToSelling: false },
        state: { irrelevantResponseCount: 2, warningSent: true },
      });
      expect(decision.action).toBe('stop_responding');
      expect(decision.nextStage).toBe('disqualified');
      expect(decision.disqualificationReason).toBe('off_topic_abandoned');
      expect(decision.qualified).toBe(false);
    });
  });

  describe('media routing', () => {
    it('routes a social-proof request to a testimonial', () => {
      const { decision } = run({
        current: 'engaged',
        analysis: { intent: 'FAQ', wantsSocialProof: true },
      });
      expect(decision.action).toBe('send_testimonial');
      expect(decision.media).toBe('testimonial');
    });

    it('routes investor interest to the investment promo', () => {
      const { decision } = run({
        current: 'engaged',
        analysis: { contactIntent: 'investor' },
      });
      expect(decision.action).toBe('send_investment_promo');
      expect(decision.media).toBe('investment_promo');
    });

    it('does not resend the promo once it has been sent', () => {
      const { decision } = run({
        current: 'engaged',
        analysis: { contactIntent: 'investor' },
        state: { promoSent: true },
      });
      expect(decision.action).not.toBe('send_investment_promo');
    });
  });

  describe('direct-message lead (screenAll) — all four questions in order', () => {
    it('asks Q1 (sell intent) first when nothing is known', () => {
      const { decision } = run({ current: 'new', screenAll: true });
      expect(decision.nextStage).toBe('screening_sell_intent');
      expect(decision.action).toBe('ask_sell_intent');
    });

    it('asks Q2 (neighborhood) once sell intent is known', () => {
      const { decision } = run({
        current: 'screening_sell_intent',
        analysis: { extracted: { sellIntent: 'ready' } },
        screenAll: true,
      });
      expect(decision.nextStage).toBe('screening_neighborhood');
    });

    it('probes motivation once all four are answered', () => {
      const { decision } = run({
        current: 'screening_currently_marketed',
        analysis: { extracted: { currentlyMarketed: 'no' } },
        known: { sellIntent: 'ready', neighborhood: 'רמות', timeline: 'within_month' },
        screenAll: true,
      });
      expect(decision.nextStage).toBe('assessing_motivation');
    });

    it('disqualifies a direct lead who is not selling (Q1)', () => {
      const { decision } = run({
        current: 'screening_sell_intent',
        analysis: { extracted: { sellIntent: 'not_selling' } },
        screenAll: true,
      });
      expect(decision.nextStage).toBe('disqualified');
      expect(decision.disqualificationReason).toBe('not_selling');
    });
  });

  describe('screensAllQuestions', () => {
    it('screens only Q2+Q4 for a Meta-form lead', () => {
      expect(screensAllQuestions('meta_lead_form')).toBe(false);
    });

    it('screens all four for a direct message, click-to-chat, or unknown origin', () => {
      expect(screensAllQuestions('direct_message')).toBe(true);
      expect(screensAllQuestions('click_to_whatsapp')).toBe(true);
      expect(screensAllQuestions(null)).toBe(true);
      expect(screensAllQuestions(undefined)).toBe(true);
    });
  });
});
