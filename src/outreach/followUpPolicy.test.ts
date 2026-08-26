import { describe, expect, it } from 'vitest';
import {
  decideFollowUp,
  isWithinBusinessHours,
  nextSendableTime,
  scheduleNextFollowUp,
  type FollowUpLimits,
  type FollowUpState,
} from './followUpPolicy.js';

const TZ = 'Asia/Jerusalem';
const DAY = 24 * 60 * 60 * 1000;

const LIMITS: FollowUpLimits = {
  intervalMs: DAY,
  maxFollowUps: 5,
  maxAgeMs: 5 * DAY,
};

function state(overrides: Partial<FollowUpState> = {}): FollowUpState {
  return {
    followupCount: 0,
    silenceSince: new Date('2026-08-23T07:00:00Z'),
    stageAllowsFollowUp: true,
    lastInboundAt: null,
    lastOutboundAt: new Date('2026-08-23T07:00:00Z'),
    ...overrides,
  };
}

/**
 * The stop conditions carry legal weight (NN-3, requirement §2.6/§2.7), so each
 * is asserted on its own rather than inferred from the sender's behaviour.
 */
describe('decideFollowUp', () => {
  const now = new Date('2026-08-24T07:00:00Z');

  it('follows up on a quiet, in-progress lead', () => {
    expect(decideFollowUp(state(), LIMITS, now)).toEqual({ follow: true });
  });

  it('stops once the lead answers our latest message', () => {
    const replied = state({
      lastInboundAt: now,
      lastOutboundAt: new Date(now.getTime() - 1000),
    });

    expect(decideFollowUp(replied, LIMITS, now)).toEqual({
      follow: false,
      stop: 'lead_replied',
    });
  });

  it('still nudges a lead who replied earlier but not to our latest message', () => {
    // The mid-qualification case (requirement §2.3): they have spoken many
    // times, then went quiet after the bot's last question.
    const quietMidFlow = state({
      lastInboundAt: new Date('2026-08-23T07:00:00Z'),
      lastOutboundAt: new Date('2026-08-23T07:05:00Z'),
    });

    expect(decideFollowUp(quietMidFlow, LIMITS, now)).toEqual({ follow: true });
  });

  it('stops in a stage that no longer wants a nudge', () => {
    // Qualified, opted out, disqualified, blocked, or a confirmed appointment.
    expect(decideFollowUp(state({ stageAllowsFollowUp: false }), LIMITS, now)).toEqual({
      follow: false,
      stop: 'stage_terminal',
    });
  });

  it('stops at the message cap', () => {
    expect(decideFollowUp(state({ followupCount: 5 }), LIMITS, now)).toEqual({
      follow: false,
      stop: 'max_followups_reached',
    });
  });

  it('never exceeds the cap even if the count somehow overshoots', () => {
    expect(decideFollowUp(state({ followupCount: 99 }), LIMITS, now).follow).toBe(false);
  });

  it('stops at five days regardless of how few were sent', () => {
    // The two caps are independent: a slow cadence must not buy extra days.
    const sixDaysOn = new Date('2026-08-29T08:00:00Z');

    expect(decideFollowUp(state({ followupCount: 1 }), LIMITS, sixDaysOn)).toEqual({
      follow: false,
      stop: 'max_age_reached',
    });
  });

  it('treats a reply as decisive even at the cap', () => {
    const decision = decideFollowUp(
      state({
        lastInboundAt: now,
        lastOutboundAt: new Date(now.getTime() - 1000),
        followupCount: 5,
      }),
      LIMITS,
      now,
    );

    expect(decision).toEqual({ follow: false, stop: 'lead_replied' });
  });
});

/** Israel local hours. August 2026 is IDT, so Jerusalem is UTC+3. */
describe('isWithinBusinessHours', () => {
  it('never sends on Shabbat', () => {
    // Saturday midday.
    expect(isWithinBusinessHours(new Date('2026-08-22T09:00:00Z'), TZ)).toBe(false);
  });

  it('stops early on Friday', () => {
    // 15:00 local, after the 14:00 close.
    expect(isWithinBusinessHours(new Date('2026-08-21T12:00:00Z'), TZ)).toBe(false);
  });

  it('sends on a Friday morning', () => {
    // 11:00 local.
    expect(isWithinBusinessHours(new Date('2026-08-21T08:00:00Z'), TZ)).toBe(true);
  });

  it('sends during a weekday', () => {
    // Sunday 10:00 local.
    expect(isWithinBusinessHours(new Date('2026-08-23T07:00:00Z'), TZ)).toBe(true);
  });

  it('does not send late in the evening', () => {
    // Sunday 21:00 local, after the 20:00 close.
    expect(isWithinBusinessHours(new Date('2026-08-23T18:00:00Z'), TZ)).toBe(false);
  });

  it('is evaluated in Israel time, not the server timezone', () => {
    // 09:00 UTC on a Saturday is 12:00 in Jerusalem — a server reading UTC hours
    // would happily send on Shabbat.
    expect(isWithinBusinessHours(new Date('2026-08-22T09:00:00Z'), TZ)).toBe(false);
  });
});

describe('nextSendableTime', () => {
  it('returns the same instant when already sendable', () => {
    const at = new Date('2026-08-23T07:00:00Z');

    expect(nextSendableTime(at, TZ)).toEqual(at);
  });

  it('pushes a Shabbat send to Sunday morning', () => {
    const saturdayNoon = new Date('2026-08-22T09:00:00Z');

    const next = nextSendableTime(saturdayNoon, TZ);

    expect(isWithinBusinessHours(next, TZ)).toBe(true);
    expect(next.getTime()).toBeGreaterThan(saturdayNoon.getTime());
  });

  it('pushes a Friday afternoon send past Shabbat entirely', () => {
    const fridayAfternoon = new Date('2026-08-21T12:00:00Z');

    const next = nextSendableTime(fridayAfternoon, TZ);

    // Must clear all of Saturday, not merely the next hour.
    expect(next.getTime()).toBeGreaterThan(new Date('2026-08-22T21:00:00Z').getTime());
    expect(isWithinBusinessHours(next, TZ)).toBe(true);
  });

  it('pushes a late-evening send to the next morning', () => {
    const next = nextSendableTime(new Date('2026-08-23T18:00:00Z'), TZ);

    expect(isWithinBusinessHours(next, TZ)).toBe(true);
  });

  it('works in winter, when Israel is on standard time', () => {
    // The offset changes; the rule does not.
    const next = nextSendableTime(new Date('2026-01-17T10:00:00Z'), TZ);

    expect(isWithinBusinessHours(next, TZ)).toBe(true);
  });
});

describe('scheduleNextFollowUp', () => {
  it('schedules one interval out, inside business hours', () => {
    const now = new Date('2026-08-23T07:00:00Z');

    const next = scheduleNextFollowUp(state(), LIMITS, TZ, now);

    expect(next).not.toBeNull();
    expect(isWithinBusinessHours(next!, TZ)).toBe(true);
    expect(next!.getTime()).toBeGreaterThanOrEqual(now.getTime() + DAY);
  });

  it('returns null when the sequence has stopped', () => {
    const now = new Date('2026-08-23T07:00:00Z');

    expect(scheduleNextFollowUp(state({ followupCount: 5 }), LIMITS, TZ, now)).toBeNull();
  });

  it('returns null rather than scheduling past the five-day cap', () => {
    // Shifting into business hours may push a send over the line. Moving a
    // message within the window is allowed; extending the sequence is not.
    const silenceSince = new Date('2026-08-20T07:00:00Z');
    const now = new Date('2026-08-24T07:00:00Z'); // day four

    const next = scheduleNextFollowUp(state({ silenceSince }), LIMITS, TZ, now);

    expect(next).toBeNull();
  });

  it('never schedules onto Shabbat', () => {
    // Thursday evening + one day lands on Friday evening, which must move on.
    const now = new Date('2026-08-20T15:00:00Z');

    const next = scheduleNextFollowUp(
      state({ silenceSince: now }),
      { ...LIMITS, maxAgeMs: 30 * DAY },
      TZ,
      now,
    );

    expect(next).not.toBeNull();
    expect(isWithinBusinessHours(next!, TZ)).toBe(true);
  });
});
