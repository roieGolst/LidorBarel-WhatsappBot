import { describe, expect, it } from 'vitest';
import { MAX_REPLY_LENGTH, findBannedTerms } from '../workflow/validate.js';
import { FOLLOW_UP_MESSAGES, followUpMessage } from './followUpMessages.js';

/**
 * Follow-ups bypass the model, so they also bypass the validator that guards
 * everything the model writes. These tests put them through the same rules, so
 * hand-written copy cannot drift off-voice where generated copy could not.
 */
describe('follow-up wording', () => {
  it.each(FOLLOW_UP_MESSAGES)('uses no banned term: %s', (message) => {
    expect(findBannedTerms(message)).toEqual([]);
  });

  it.each(FOLLOW_UP_MESSAGES)('stays within the reply length limit', (message) => {
    expect(message.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
  });

  it('tells an unresponsive lead how to stop before the cap does', () => {
    // Someone who has ignored several messages should be given the word, not
    // just quietly dropped once the counter runs out.
    expect(FOLLOW_UP_MESSAGES.some((m) => m.includes('עצור'))).toBe(true);
  });

  it('ends the ladder by closing the loop rather than asking again', () => {
    const last = FOLLOW_UP_MESSAGES.at(-1)!;
    expect(last).not.toContain('?');
  });
});

describe('followUpMessage', () => {
  it('returns the ladder in order', () => {
    expect(followUpMessage(1)).toBe(FOLLOW_UP_MESSAGES[0]);
    expect(followUpMessage(2)).toBe(FOLLOW_UP_MESSAGES[1]);
  });

  it('clamps past the end so raising the cap cannot send an empty message', () => {
    expect(followUpMessage(99)).toBe(FOLLOW_UP_MESSAGES.at(-1));
  });

  it('clamps below one', () => {
    expect(followUpMessage(0)).toBe(FOLLOW_UP_MESSAGES[0]);
  });
});
