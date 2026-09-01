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
    wantsBuyerProof: false,
    wantsSocialProof: false,
    asksQuestion: false,
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

    it('qualifies when the intent answer adds real property detail', () => {
      const decision = decideTransition(
        'assessing_intent',
        analysis({ extracted: { additionalNotes: 'רחוב רגר 5, קומה 2, 4 חדרים' } }),
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

    it('does NOT forward an empty intent answer — re-asks for the specifics', () => {
      // A contentless reply at the intent check (a bare "כן"/filler) carries no
      // property detail or intent signal. It must not be forwarded as "got your
      // details"; the bot asks once more for the specifics instead.
      const decision = decideTransition('assessing_intent', analysis(), answered, true);
      expect(decision.action).toBe('ask_intent');
      expect(decision.nextStage).toBe('assessing_intent');
      expect(decision.qualified).toBeUndefined();
    });

    it('still asks the intent question when seriousSeller was set before it was asked', () => {
      // Regression: a Q4 answer ("כן, באופן פרטי") the classifier mis-tagged as
      // seriousSeller:false must not short-circuit to low_intent_hold before the
      // intent question is even asked.
      const decision = decideTransition(
        'screening_currently_marketed',
        analysis({ extracted: { currentlyMarketed: 'privately', seriousSeller: false } }),
        { sellIntent: 'ready', neighborhood: 'רמות', timeline: 'within_month' },
        true,
      );
      expect(decision.action).toBe('ask_intent');
      expect(decision.action).not.toBe('low_intent_hold');
    });
  });

  describe('a booking lead can still ask things (regression)', () => {
    // Tapping "קביעת פגישה" stored bookingIntent, and the booking rule then read
    // it off the merged facts on EVERY later turn — funnelling every message into
    // screening, so questions, objections and testimonial requests were ignored
    // for the rest of the conversation.
    const booked: KnownFacts = { bookingIntent: true, timeline: 'immediate' };

    it('answers a testimonial request instead of marching on with screening', () => {
      const decision = decideTransition(
        'assessing_intent',
        analysis({ intent: 'FAQ', wantsSocialProof: true }),
        {
          ...booked,
          sellIntent: 'ready',
          neighborhood: 'נווה זאב',
          currentlyMarketed: 'no',
        },
        true,
      );
      expect(decision.action).toBe('send_social_proof');
    });

    it('answers an FAQ instead of marching on with screening', () => {
      const decision = decideTransition(
        'screening_currently_marketed',
        analysis({ intent: 'FAQ' }),
        { ...booked, sellIntent: 'ready', neighborhood: 'נווה זאב' },
        true,
      );
      expect(decision.action).toBe('answer_faq');
    });

    it('still advances the flow on an actual screening answer', () => {
      const decision = decideTransition(
        'screening_currently_marketed',
        analysis({ extracted: { currentlyMarketed: 'no' } }),
        { ...booked, sellIntent: 'ready', neighborhood: 'נווה זאב' },
        true,
      );
      expect(decision.action).toBe('ask_intent');
    });
  });

  describe('answering a question asked alongside a screening answer', () => {
    it('attaches a reply to the question, then continues the flow', () => {
      // "בשכונת נווה זאב, לידור יודע למכור שם?" — both an answer and a question.
      const decision = decideTransition(
        'screening_neighborhood',
        analysis({ extracted: { neighborhood: 'נווה זאב' }, asksQuestion: true }),
        { sellIntent: 'ready' },
        true,
      );
      expect(decision.action).toBe('ask_timeline'); // the flow still moves
      expect(decision.addressFirst).toBe('answer_aside'); // and they get an answer
    });

    it('gives a raised concern the full objection handler, not a brief aside', () => {
      // A concern deserves real engagement, so it takes the dedicated handler and
      // the flow waits a turn. The answer it carried is still merged into the facts.
      const decision = decideTransition(
        'screening_neighborhood',
        analysis({
          intent: 'OBJECTION',
          extracted: { neighborhood: 'נווה זאב' },
          asksQuestion: true,
        }),
        { sellIntent: 'ready' },
        true,
      );
      expect(decision.action).toBe('handle_objection');
    });

    it('adds nothing when the message only answers', () => {
      const decision = decideTransition(
        'screening_neighborhood',
        analysis({ extracted: { neighborhood: 'נווה זאב' } }),
        { sellIntent: 'ready' },
        true,
      );
      expect(decision.addressFirst).toBeUndefined();
    });
  });

  describe('leadPriorityScore', () => {
    // Weights approved by Lidor: timeline 40, readiness 30, booking 15,
    // engagement 15. The score sets the order he works his queue in, so the
    // ordering assertions matter more than any individual number.
    it('weights the timeline, the strongest predictor', () => {
      expect(leadPriorityScore({ timeline: 'immediate' })).toBe(40);
      expect(leadPriorityScore({ timeline: 'within_month' })).toBe(30);
      expect(leadPriorityScore({ timeline: 'still_checking' })).toBe(15);
      expect(leadPriorityScore({ timeline: 'no_urgency' })).toBe(5);
    });

    it('weights readiness to list', () => {
      expect(leadPriorityScore({ sellIntent: 'ready' })).toBe(30);
      expect(leadPriorityScore({ sellIntent: 'not_sure' })).toBe(12);
      expect(leadPriorityScore({ sellIntent: 'not_selling' })).toBe(0);
    });

    it('adds engagement, the weakest factor', () => {
      expect(leadPriorityScore({ currentlyMarketed: 'no' })).toBe(8);
      expect(leadPriorityScore({ photoCount: 3 })).toBe(4);
      expect(leadPriorityScore({ seriousSeller: true })).toBe(3);
      expect(leadPriorityScore({ photoCount: 0 })).toBeUndefined();
    });

    it('reaches exactly 100 for the best possible lead', () => {
      expect(
        leadPriorityScore({
          timeline: 'immediate',
          sellIntent: 'ready',
          bookingIntent: true,
          currentlyMarketed: 'no',
          photoCount: 2,
          seriousSeller: true,
        }),
      ).toBe(100);
    });

    it('is undefined while nothing is known', () => {
      // An unscored lead should look unscored, not rejected.
      expect(leadPriorityScore({})).toBeUndefined();
    });

    it('orders a realistic queue the way Lidor should work it', () => {
      const wantsMeeting = leadPriorityScore({
        timeline: 'immediate',
        sellIntent: 'ready',
        bookingIntent: true,
        currentlyMarketed: 'no',
      })!;
      const readyNow = leadPriorityScore({
        timeline: 'immediate',
        sellIntent: 'ready',
        currentlyMarketed: 'no',
      })!;
      const thinkingSoon = leadPriorityScore({
        timeline: 'within_month',
        sellIntent: 'not_sure',
        currentlyMarketed: 'no',
      })!;
      const browsing = leadPriorityScore({
        timeline: 'no_urgency',
        sellIntent: 'not_sure',
      })!;

      expect(wantsMeeting).toBeGreaterThan(readyNow);
      expect(readyNow).toBeGreaterThan(thinkingSoon);
      expect(thinkingSoon).toBeGreaterThan(browsing);
    });

    it('separates leads the old one-dimensional score tied together', () => {
      // Timeline alone produced five possible values, so a queue of forty tied
      // eight ways at every level. These four share a timeline and must differ.
      const scores = [
        leadPriorityScore({
          timeline: 'immediate',
          sellIntent: 'ready',
          bookingIntent: true,
        }),
        leadPriorityScore({ timeline: 'immediate', sellIntent: 'ready' }),
        leadPriorityScore({ timeline: 'immediate', sellIntent: 'not_sure' }),
        leadPriorityScore({ timeline: 'immediate' }),
      ];

      expect(new Set(scores).size).toBe(scores.length);
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

  it('routes a free-text testimonials request to social proof, not a text FAQ', () => {
    // "יש ממליצים?" classifies as FAQ but carries wantsSocialProof — it should
    // send the testimonial video, not a text-only FAQ answer that re-asks details.
    const decision = decideTransition(
      'assessing_intent',
      analysis({ intent: 'FAQ', wantsSocialProof: true }),
      { neighborhood: 'רמות', currentlyMarketed: 'no' },
    );
    expect(decision.action).toBe('send_social_proof');
    expect(decision.action).not.toBe('answer_faq');
  });

  it('redirects a confident off-topic message instead of engaging with it', () => {
    const decision = decideTransition('engaged', analysis({ intent: 'OFF_TOPIC' }));
    expect(decision.action).toBe('stay_on_topic');
  });

  it('redirects off-topic chatter from a qualified lead (not an "info for Lidor" ack)', () => {
    // The reported bug: a recipe/shopping-list request after qualifying was
    // acknowledged as new details for Lidor.
    const decision = decideTransition('qualified', analysis({ intent: 'OFF_TOPIC' }));
    expect(decision.action).toBe('stay_on_topic');
    expect(decision.action).not.toBe('acknowledge_additional_info');
    expect(decision.nextStage).toBe('qualified');
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

  it('answers a question from a qualified lead instead of brushing it off', () => {
    // Roie asked a clarifying "את מה?" after qualifying and got the canned ack.
    // A message with no new property details must get a real model reply.
    const decision = decideTransition(
      'qualified',
      analysis({ intent: 'UNCLEAR', confidence: 0.3 }),
      { sellIntent: 'ready', neighborhood: 'רמות', currentlyMarketed: 'no' },
    );
    expect(decision.action).toBe('assist_qualified');
    expect(decision.action).not.toBe('acknowledge_additional_info');
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

    it('learn_more ("about me") introduces Lidor', () => {
      expect(decideMainMenu('learn_more', 'engaged').action).toBe('about_lidor');
    });

    describe('after the lead has already completed the flow', () => {
      it('confirms before redoing the flow instead of restarting it', () => {
        const answered: KnownFacts = {
          sellIntent: 'ready',
          neighborhood: 'רמות',
          currentlyMarketed: 'no',
        };
        for (const choice of ['check_fit', 'book_meeting'] as const) {
          const decision = decideMainMenu(choice, 'qualified', answered);
          expect(decision.action).toBe('confirm_restart');
          // Nothing moves until they say yes — no question is re-asked.
          expect(decision.nextStage).toBe('qualified');
          expect(decision.qualified).toBeUndefined();
        }
      });

      it('still answers "about me" and testimonials without touching the flow', () => {
        expect(decideMainMenu('learn_more', 'qualified').action).toBe('about_lidor');
        expect(decideMainMenu('testimonials', 'qualified').action).toBe(
          'send_social_proof',
        );
        // Neither re-opens screening.
        expect(decideMainMenu('learn_more', 'qualified').nextStage).toBe('qualified');
        expect(decideMainMenu('testimonials', 'qualified').nextStage).toBe('qualified');
      });
    });

    it('book_meeting runs the screening flow (a call is booked after a few details)', () => {
      const decision = decideMainMenu('book_meeting', 'engaged');
      expect(decision.action).toBe('ask_neighborhood');
      const direct = decideMainMenu('book_meeting', 'engaged', {}, true);
      expect(direct.action).toBe('ask_sell_intent');
    });
  });

  describe('booking intent', () => {
    it('treats asking for a meeting as urgency plus intent', () => {
      // Without the urgency proxy, "book me in" before Q3 would score below
      // someone who has just said they have no urgency at all.
      expect(leadPriorityScore({ bookingIntent: true })).toBe(55);
    });

    it('does not let the booking proxy override a stated timeline', () => {
      expect(leadPriorityScore({ timeline: 'no_urgency', bookingIntent: true })).toBe(20);
      expect(leadPriorityScore({ timeline: 'immediate', bookingIntent: true })).toBe(55);
      expect(leadPriorityScore({ timeline: 'no_urgency' })).toBe(5);
    });

    it('runs the screening flow even when the message reads like an FAQ', () => {
      const decision = decideTransition(
        'engaged',
        analysis({ intent: 'FAQ', extracted: { bookingIntent: true } }),
      );
      expect(decision.action).toBe('ask_neighborhood');
    });

    it('skips Q3 (timeline) for a booking lead — treated as immediate', () => {
      // Direct lead (screenAll) with Q1+Q2 answered: normally Q3 is next, but a
      // booking lead jumps straight to Q4.
      const decision = decideMainMenu(
        'book_meeting',
        'engaged',
        { sellIntent: 'ready', neighborhood: 'רמות' },
        true,
      );
      expect(decision.action).toBe('ask_currently_marketed');
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
