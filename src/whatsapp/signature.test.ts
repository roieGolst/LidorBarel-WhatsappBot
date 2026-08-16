import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isValidSignature, verifySubscription } from './signature.js';

const APP_SECRET = 'test_app_secret_value';

function sign(body: Buffer | string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('isValidSignature', () => {
  it('accepts a correctly signed body', () => {
    const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
    expect(isValidSignature(body, sign(body), APP_SECRET)).toBe(true);
  });

  it('rejects a body signed with a different secret', () => {
    const body = Buffer.from('{"a":1}');
    expect(isValidSignature(body, sign(body, 'wrong_secret'), APP_SECRET)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const original = Buffer.from('{"amount":100}');
    const signature = sign(original);
    const tampered = Buffer.from('{"amount":999}');

    expect(isValidSignature(tampered, signature, APP_SECRET)).toBe(false);
  });

  it.each([
    ['missing header', undefined],
    ['empty string', ''],
    ['missing sha256 prefix', 'abc123'],
    ['wrong algorithm prefix', 'sha1=abc123'],
    ['prefix with no digest', 'sha256='],
  ])('rejects %s', (_label, header) => {
    const body = Buffer.from('{}');
    expect(isValidSignature(body, header, APP_SECRET)).toBe(false);
  });

  // Buffer.from(..., 'hex') stops at the first invalid character rather than
  // failing. Without an explicit hex check, a header like "ab!!!..." would decode
  // to just [0xab] and could be compared against a truncated expectation.
  it('rejects a non-hex digest instead of silently truncating it', () => {
    const body = Buffer.from('{}');
    const valid = sign(body).slice('sha256='.length);
    const poisoned = `sha256=${valid.slice(0, 2)}${'!'.repeat(62)}`;

    expect(isValidSignature(body, poisoned, APP_SECRET)).toBe(false);
  });

  it('rejects a digest of the wrong length', () => {
    const body = Buffer.from('{}');
    expect(isValidSignature(body, 'sha256=abcd', APP_SECRET)).toBe(false);
  });

  it('rejects uppercase hex, which Meta never sends', () => {
    const body = Buffer.from('{}');
    const upper = sign(body).slice('sha256='.length).toUpperCase();
    expect(isValidSignature(body, `sha256=${upper}`, APP_SECRET)).toBe(false);
  });

  // The signature covers the exact bytes Meta sent. Verifying against a
  // re-serialized object would fail on key order and whitespace alone, so this
  // pins the raw-buffer contract.
  it('is sensitive to byte-level formatting differences', () => {
    const compact = Buffer.from('{"a":1,"b":2}');
    const spaced = Buffer.from('{"a": 1, "b": 2}');

    expect(isValidSignature(compact, sign(compact), APP_SECRET)).toBe(true);
    expect(isValidSignature(spaced, sign(compact), APP_SECRET)).toBe(false);
  });

  it('handles unicode bodies correctly', () => {
    const body = Buffer.from(JSON.stringify({ text: 'שלום, אני רוצה למכור דירה' }));
    expect(isValidSignature(body, sign(body), APP_SECRET)).toBe(true);
  });

  it('handles an empty body', () => {
    const body = Buffer.from('');
    expect(isValidSignature(body, sign(body), APP_SECRET)).toBe(true);
  });
});

describe('verifySubscription', () => {
  const TOKEN = 'my_verify_token';

  it('echoes the challenge when mode and token match', () => {
    const challenge = verifySubscription(
      {
        'hub.mode': 'subscribe',
        'hub.verify_token': TOKEN,
        'hub.challenge': '1234567890',
      },
      TOKEN,
    );

    expect(challenge).toBe('1234567890');
  });

  it.each([
    ['wrong token', { 'hub.verify_token': 'wrong', 'hub.challenge': 'c' }],
    ['wrong mode', { 'hub.mode': 'unsubscribe', 'hub.challenge': 'c' }],
    ['missing challenge', { 'hub.verify_token': TOKEN }],
    ['missing token', { 'hub.mode': 'subscribe', 'hub.challenge': 'c' }],
    ['empty query', {}],
  ])('rejects %s', (_label, query) => {
    const withMode = { 'hub.mode': 'subscribe', ...query };
    expect(verifySubscription(withMode, TOKEN)).toBeUndefined();
  });

  it('rejects a token that is a prefix of the expected one', () => {
    expect(
      verifySubscription(
        {
          'hub.mode': 'subscribe',
          'hub.verify_token': TOKEN.slice(0, 5),
          'hub.challenge': 'c',
        },
        TOKEN,
      ),
    ).toBeUndefined();
  });

  it('rejects non-string challenge values', () => {
    expect(
      verifySubscription(
        { 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': 12345 },
        TOKEN,
      ),
    ).toBeUndefined();
  });
});
