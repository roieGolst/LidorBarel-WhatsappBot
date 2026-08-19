import { describe, expect, it } from 'vitest';
import type { Analysis } from './classify.js';
import {
  CONFIDENCE_THRESHOLD,
  decideMainMenu,
  decideTransition,
  leadPriorityScore,
  screensAllQuestions,
  type KnownFacts,
} from './decide.js';

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

  it('keeps the flow moving instead of guessing when confidence is below the threshold', () => {
    // A shaky read contributes no facts, so the pending question is re-asked
    // rather than the person being told to rephrase. (Form lead → Q2 first.)
    const decision = decideTransition(
      'screening_neighborhood',
      analysis({ confidence: CONFIDENCE_THRESHOLD - 0.01 }),
    );
    expect(decision.action).toBe('ask_neighborhood');
    expect(decision.nextStage).toBe('screening_neighborhood');
  });

  it('asks the pending question on an UNCLEAR intent, never stalling', () => {
    // A greeting or filler ("יאללה") reads as UNCLEAR; a direct-message lead
    // should still be moved to Q1 rather than asked to rephrase.
    const decision = decideTransition(
      'new',
      analysis({ intent: 'UNCLEAR', confidence: 1 }),
      {},
      true,
    );
    expect(decision.action).toBe('ask_sell_intent');
    expect(decision.nextStage).toBe('screening_sell_intent');
  });

  it('disqualifies on not_selling with the mapped reason', () => {
    const decision = decideTransition(
      'screening_currently_marketed',
      analysis({ extracted: { sellIntent: 'not_selling' } }),
    );
    expect(decision.nextStage).toBe('disqualified');
    expect(decision.action).toBe('send_disqualification');
    expect(decision.qualified).toBe(false);
    expect(decision.disqualificationReason).toBe('not_selling');
  });

  it('does NOT disqualify on no urgency — it continues the flow', () => {
    const decision = decideTransition(
      'screening_currently_marketed',
      analysis({ extracted: { timeline: 'no_urgency', currentlyMarketed: 'no' } }),
      { sellIntent: 'ready', neighborhood: 'רמות' },
    );
    // Continues to the intent check rather than disqualifying.
    expect(decision.action).not.toBe('send_disqualification');
    expect(decision.action).toBe('ask_intent');
  });

  describe('intent check before handoff', () => {
    const answered: KnownFacts = {
      sellIntent: 'ready',
      neighborhood: 'רמות',
      timeline: 'within_month',
      currentlyMarketed: 'no',
    };

    it('asks the intent question once all four are answered', () => {
      const decision = decideTransition(
        'screening_currently_marketed',
        analysis(),
        answered,
        true,
      );
      expect(decision.action).toBe('ask_intent');
      expect(decision.nextStage).toBe('assessing_intent');
    });

    it('qualifies a serious seller', () => {
      const decision = decideTransition(
        'assessing_intent',
        analysis({ extracted: { seriousSeller: true } }),
        answered,
        true,
      );
      expect(decision.nextStage).toBe('qualified');
      expect(decision.qualified).toBe(true);
    });

    it('does not forward a price-checker — holds them instead', () => {
      const decision = decideTransition(
        'assessing_intent',
        analysis({ extracted: { seriousSeller: false } }),
        answered,
        true,
      );
      expect(decision.action).toBe('low_intent_hold');
      expect(decision.qualified).toBeUndefined();
    });

    it('gives the benefit of the doubt if intent stays unclear after asking', () => {
      const decision = decideTransition('assessing_intent', analysis(), answered, true);
      expect(decision.action).toBe('proceed_qualified');
    });
  });

  describe('leadPriorityScore', () => {
    it('ranks urgency (higher = sooner), undefined until the timeline is known', () => {
      expect(leadPriorityScore({ timeline: 'immediate' })).toBe(100);
      expect(leadPriorityScore({ timeline: 'within_month' })).toBe(75);
      expect(leadPriorityScore({ timeline: 'still_checking' })).toBe(50);
      expect(leadPriorityScore({ timeline: 'no_urgency' })).toBe(25);
      expect(leadPriorityScore({})).toBeUndefined();
    });
  });

  it('disqualifies on a fact learned in an earlier turn', () => {
    const known: KnownFacts = { sellIntent: 'not_selling' };
    const decision = decideTransition('screening_sell_intent', analysis(), known);
    expect(decision.disqualificationReason).toBe('not_selling');
  });

  describe('marketed through another agent (exclusivity follow-up)', () => {
    it('asks about the exclusivity end + follow-up before disqualifying', () => {
      const decision = decideTransition(
        'screening_currently_marketed',
        analysis({ extracted: { currentlyMarketed: 'with_agent' } }),
      );
      expect(decision.action).toBe('ask_exclusivity');
      expect(decision.nextStage).toBe('screening_exclusivity');
    });

    it('disqualifies once the exclusivity details are captured', () => {
      const decision = decideTransition(
        'screening_exclusivity',
        analysis({ extracted: { exclusivityEndsAt: 'עוד חודשיים' } }),
        { currentlyMarketed: 'with_agent' },
      );
      expect(decision.nextStage).toBe('disqualified');
      expect(decision.disqualificationReason).toBe('exclusive_with_other_agent');
    });

    it('proceeds to disqualify once the follow-up wish is known even without a date', () => {
      const decision = decideTransition(
        'screening_exclusivity',
        analysis({ extracted: { wantsExclusivityFollowup: true } }),
        { currentlyMarketed: 'with_agent' },
      );
      expect(decision.nextStage).toBe('disqualified');
    });
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

  it('asks for the neighborhood first when nothing is known (form lead: Q2+Q4 only)', () => {
    // Default screenAll=false is the Meta-form path — Q1/Q3 were answered there.
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

  it('qualifies once both answers are in, none disqualifies, and intent is confirmed', () => {
    const decision = decideTransition(
      'assessing_intent',
      analysis({ extracted: { currentlyMarketed: 'no', seriousSeller: true } }),
      { neighborhood: 'נווה זאב' },
    );
    expect(decision.nextStage).toBe('qualified');
    expect(decision.action).toBe('proceed_qualified');
    expect(decision.qualified).toBe(true);
  });

  it('keeps a qualified conversation open, collecting more details', () => {
    const decision = decideTransition(
      'qualified',
      analysis({ extracted: { additionalNotes: '4 חדרים, קומה 3' } }),
      { sellIntent: 'ready', neighborhood: 'רמות', currentlyMarketed: 'no' },
    );
    expect(decision.action).toBe('acknowledge_additional_info');
    expect(decision.nextStage).toBe('qualified');
  });

  it('escalates the reply when the classifier flags frustration', () => {
    const decision = decideTransition('new', analysis({ needsEscalation: true }));
    expect(decision.escalate).toBe(true);
  });

  describe('direct-message lead (screenAll) — all four questions in order', () => {
    it('asks Q1 (sell intent) first when nothing is known', () => {
      const decision = decideTransition('new', analysis(), {}, true);
      expect(decision.nextStage).toBe('screening_sell_intent');
      expect(decision.action).toBe('ask_sell_intent');
    });

    it('asks Q2 (neighborhood) once sell intent is known', () => {
      const decision = decideTransition(
        'screening_sell_intent',
        analysis({ extracted: { sellIntent: 'ready' } }),
        {},
        true,
      );
      expect(decision.nextStage).toBe('screening_neighborhood');
      expect(decision.action).toBe('ask_neighborhood');
    });

    it('asks Q3 (timeline) once sell intent and neighborhood are known', () => {
      const decision = decideTransition(
        'screening_neighborhood',
        analysis({ extracted: { neighborhood: 'רמות' } }),
        { sellIntent: 'ready' },
        true,
      );
      expect(decision.nextStage).toBe('screening_timeline');
      expect(decision.action).toBe('ask_timeline');
    });

    it('asks Q4 (currently marketed) once the first three are known', () => {
      const decision = decideTransition(
        'screening_timeline',
        analysis({ extracted: { timeline: 'within_month' } }),
        { sellIntent: 'ready', neighborhood: 'רמות' },
        true,
      );
      expect(decision.nextStage).toBe('screening_currently_marketed');
      expect(decision.action).toBe('ask_currently_marketed');
    });

    it('asks the intent check once all four are answered', () => {
      const decision = decideTransition(
        'screening_currently_marketed',
        analysis({ extracted: { currentlyMarketed: 'no' } }),
        { sellIntent: 'ready', neighborhood: 'רמות', timeline: 'within_month' },
        true,
      );
      expect(decision.action).toBe('ask_intent');
    });

    it('disqualifies a direct lead who is not selling (Q1)', () => {
      const decision = decideTransition(
        'screening_sell_intent',
        analysis({ extracted: { sellIntent: 'not_selling' } }),
        {},
        true,
      );
      expect(decision.nextStage).toBe('disqualified');
      expect(decision.disqualificationReason).toBe('not_selling');
    });
  });

  describe('decideMainMenu (§8 opening options)', () => {
    it('check_fit starts screening at the first pending question (form lead → Q2)', () => {
      const decision = decideMainMenu('check_fit', 'engaged');
      expect(decision.action).toBe('ask_neighborhood');
    });

    it('check_fit for a direct lead starts at Q1', () => {
      const decision = decideMainMenu('check_fit', 'engaged', {}, true);
      expect(decision.action).toBe('ask_sell_intent');
    });

    it('check_fit still disqualifies on a fact already known', () => {
      const decision = decideMainMenu('check_fit', 'engaged', {
        sellIntent: 'not_selling',
      });
      expect(decision.nextStage).toBe('disqualified');
      expect(decision.disqualificationReason).toBe('not_selling');
    });

    it('check_fit routes an already-known exclusive lead to the exclusivity ask', () => {
      const decision = decideMainMenu('check_fit', 'engaged', {
        currentlyMarketed: 'with_agent',
      });
      expect(decision.action).toBe('ask_exclusivity');
    });

    it('testimonials sends social proof', () => {
      expect(decideMainMenu('testimonials', 'engaged').action).toBe('send_social_proof');
    });

    it('learn_more answers about the service', () => {
      expect(decideMainMenu('learn_more', 'engaged').action).toBe('answer_faq');
    });

    it('talk_to_human and book_meeting both hand off', () => {
      for (const choice of ['talk_to_human', 'book_meeting'] as const) {
        const decision = decideMainMenu(choice, 'engaged');
        expect(decision.action).toBe('handoff_to_human');
        expect(decision.nextStage).toBe('handed_off');
      }
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
