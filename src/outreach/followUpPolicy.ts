/**
 * When a follow-up may be sent, and when the sequence must stop.
 *
 * Pure functions over clocks and counters — no database, no channel — so the
 * rules that carry legal weight can be tested exhaustively with fake times
 * rather than inferred from integration behaviour.
 *
 * Two independent caps bound the sequence (requirement NN-3). The product
 * requirement says follow-ups run "for up to five days"; the specification says
 * "5 messages, 1 day apart". Those describe the same intent from different
 * angles, so **both** are enforced and whichever is reached first stops the
 * sequence. Reading either one loosely would mean messaging someone on day six.
 */

/** Israel's business hours, per the specification. Never on Shabbat. */
const BUSINESS_HOURS: Record<number, { open: number; close: number } | null> = {
  0: { open: 8, close: 20 }, // Sunday
  1: { open: 8, close: 20 },
  2: { open: 8, close: 20 },
  3: { open: 8, close: 20 },
  4: { open: 8, close: 20 }, // Thursday
  // Friday closes early: the spec's working hours already stop well before
  // sunset, which keeps the bot clear of Shabbat without needing a sunset table.
  5: { open: 8, close: 14 },
  6: null, // Saturday — Shabbat. Never.
};

/** Caps and cadence for a follow-up sequence. */
export interface FollowUpLimits {
  /** Gap between follow-ups. */
  intervalMs: number;
  /** Most follow-ups to send, ever. */
  maxFollowUps: number;
  /** Longest a sequence may run, measured from the first outreach. */
  maxAgeMs: number;
}

/** The clock fields a follow-up decision depends on. */
export interface FollowUpState {
  /** Nudges sent during the current silence. Reset when the person replies. */
  followupCount: number;
  /**
   * When the current silence began — the person's last message, or the bot's
   * first outreach if they have never replied.
   *
   * The five-day cap runs from here, not from the start of the conversation.
   * Requirement §2.3 covers a lead who "stops responding", so someone who
   * answers on day six and then goes quiet is entitled to the same sequence as
   * one who never answered; anchoring on conversation age would deny it to them.
   */
  silenceSince: Date | null;
  /** Whether the conversation is in a stage that still wants a nudge. */
  stageAllowsFollowUp: boolean;
  /** The person's last inbound, ever. */
  lastInboundAt: Date | null;
  /** The bot's last outbound, ever. */
  lastOutboundAt: Date | null;
}

export type FollowUpStop =
  'stage_terminal' | 'max_followups_reached' | 'max_age_reached' | 'lead_replied';

export type FollowUpDecision = { follow: true } | { follow: false; stop: FollowUpStop };

/**
 * Whether this conversation should receive another follow-up.
 *
 * Every negative answer is a *stop*, not a "not yet": the caller clears the
 * schedule on any of them, so a conversation can never sit due forever. The
 * one thing this does not decide is consent or opt-out — those are enforced at
 * the send choke point, where they cannot be skipped.
 */
export function decideFollowUp(
  state: FollowUpState,
  limits: FollowUpLimits,
  now: Date = new Date(),
): FollowUpDecision {
  // A reply to our latest message ends the sequence. Note the comparison: the
  // test is whether they answered what we *last said*, not whether they have
  // ever spoken. Someone mid-qualification has replied many times, and treating
  // that as "engaged, no nudge needed" would exclude exactly the case
  // requirement §2.3 is about.
  //
  // The schedule is already cleared when a message arrives; this is the belt to
  // that braces, for a race between an inbound landing and a sweep picking the
  // conversation up.
  if (
    state.lastInboundAt &&
    (!state.lastOutboundAt || state.lastInboundAt > state.lastOutboundAt)
  ) {
    return { follow: false, stop: 'lead_replied' };
  }

  if (!state.stageAllowsFollowUp) return { follow: false, stop: 'stage_terminal' };

  if (state.followupCount >= limits.maxFollowUps) {
    return { follow: false, stop: 'max_followups_reached' };
  }

  if (state.silenceSince) {
    const age = now.getTime() - state.silenceSince.getTime();
    if (age >= limits.maxAgeMs) return { follow: false, stop: 'max_age_reached' };
  }

  return { follow: true };
}

/** Local weekday and hour for an instant, in the configured timezone. */
function localParts(at: Date, timeZone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(at);

  const weekdayName = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');

  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  // `hour12: false` renders midnight as 24 in some environments.
  return { weekday: weekdays[weekdayName] ?? 0, hour: hour === 24 ? 0 : hour };
}

/** Whether a message may be sent at this instant. */
export function isWithinBusinessHours(at: Date, timeZone: string): boolean {
  const { weekday, hour } = localParts(at, timeZone);
  const window = BUSINESS_HOURS[weekday];
  if (!window) return false;
  return hour >= window.open && hour < window.close;
}

/**
 * The first moment at or after `from` when a message may be sent.
 *
 * Advances hour by hour rather than computing offsets arithmetically, because
 * "one hour later" in a timezone is the only step that stays correct across a
 * DST boundary — Israel shifts its clocks inside the season this bot runs in.
 * A follow-up sequence spans at most a few days, so the loop is bounded tightly.
 */
export function nextSendableTime(from: Date, timeZone: string): Date {
  const HOUR_MS = 60 * 60 * 1000;
  let candidate = from;

  // Eight days is more than one full weekly cycle, so a sendable slot is always
  // found; the bound exists only so a bad timezone cannot spin forever.
  for (let i = 0; i < 24 * 8; i += 1) {
    if (isWithinBusinessHours(candidate, timeZone)) return candidate;
    // Step to the top of the next hour so repeated calls converge on a clean
    // boundary rather than drifting by minutes on every hop.
    const next = new Date(candidate.getTime() + HOUR_MS);
    next.setUTCMinutes(0, 0, 0);
    candidate = next;
  }
  return candidate;
}

/**
 * When the next follow-up is due, shifted into business hours.
 *
 * Returns `null` when the sequence has ended, so the caller clears the schedule
 * rather than leaving a row permanently due.
 */
export function scheduleNextFollowUp(
  state: FollowUpState,
  limits: FollowUpLimits,
  timeZone: string,
  now: Date = new Date(),
): Date | null {
  const decision = decideFollowUp(state, limits, now);
  if (!decision.follow) return null;

  const due = new Date(now.getTime() + limits.intervalMs);

  // A follow-up pushed past the age cap by business hours must not be sent at
  // all — shifting a message into hours is allowed, extending the sequence
  // beyond five days is not.
  const sendable = nextSendableTime(due, timeZone);
  if (state.silenceSince) {
    const age = sendable.getTime() - state.silenceSince.getTime();
    if (age >= limits.maxAgeMs) return null;
  }

  return sendable;
}
