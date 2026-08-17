import { describe, expect, it } from 'vitest';
import { canSendFreeForm, sendWindow } from './window.js';

const NOW = new Date('2026-08-17T12:00:00Z');

describe('sendWindow', () => {
  it('is CLOSED when no window has ever opened', () => {
    expect(sendWindow({ windowExpiresAt: null }, NOW)).toBe('CLOSED');
  });

  it('is SERVICE while the 24-hour window is still open', () => {
    const oneHourLeft = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(sendWindow({ windowExpiresAt: oneHourLeft }, NOW)).toBe('SERVICE');
  });

  it('is CLOSED once the window has expired', () => {
    const expiredAMinuteAgo = new Date(NOW.getTime() - 60 * 1000);
    expect(sendWindow({ windowExpiresAt: expiredAMinuteAgo }, NOW)).toBe('CLOSED');
  });

  it('is CLOSED exactly at the expiry instant (window is strictly open-before)', () => {
    // isWithinServiceWindow uses `> now`, so the boundary itself is closed.
    expect(sendWindow({ windowExpiresAt: NOW }, NOW)).toBe('CLOSED');
  });

  it('transitions SERVICE -> CLOSED as the clock crosses the expiry', () => {
    const expiry = new Date(NOW.getTime() + 10 * 60 * 1000);
    const justBefore = new Date(expiry.getTime() - 1);
    const justAfter = new Date(expiry.getTime() + 1);

    expect(sendWindow({ windowExpiresAt: expiry }, justBefore)).toBe('SERVICE');
    expect(sendWindow({ windowExpiresAt: expiry }, justAfter)).toBe('CLOSED');
  });
});

describe('canSendFreeForm', () => {
  it('permits free-form in an open window and forbids it when closed', () => {
    expect(canSendFreeForm('SERVICE')).toBe(true);
    expect(canSendFreeForm('FREE_ENTRY')).toBe(true);
    expect(canSendFreeForm('CLOSED')).toBe(false);
  });
});
