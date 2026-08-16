import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verification of Meta's `X-Hub-Signature-256` webhook header.
 *
 * This is the only thing standing between the public internet and the
 * conversation engine. Without it, anyone who learns the webhook URL can inject
 * arbitrary inbound messages — impersonating a lead, driving the bot's replies,
 * and writing whatever they like into the CRM.
 */

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Whether `signatureHeader` is a valid signature for `rawBody`.
 *
 * The signature is computed by Meta over the **exact bytes** of the request
 * body. It must therefore be verified against the raw buffer, never against a
 * re-serialized object: `JSON.parse` followed by `JSON.stringify` changes key
 * order, whitespace, and unicode escaping, and the signature would never match.
 *
 * Comparison is constant-time. A byte-by-byte early exit leaks, through timing,
 * how much of a guessed signature was correct, which is enough to forge one.
 */
export function isValidSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const provided = signatureHeader.slice(SIGNATURE_PREFIX.length);

  // Reject anything that is not lowercase hex before decoding: Buffer.from with
  // 'hex' silently truncates at the first invalid character, which would make
  // "ab!!!!..." compare equal to a signature starting "ab".
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return false;
  }

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const providedBuffer = Buffer.from(provided, 'hex');

  // Lengths are equal by construction here (both SHA-256), but timingSafeEqual
  // throws on a mismatch, so this stays defensive.
  if (providedBuffer.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expected);
}

/**
 * Answers Meta's webhook subscription handshake.
 *
 * Meta issues a GET with `hub.mode`, `hub.verify_token` and `hub.challenge`, and
 * expects the challenge echoed back when the token matches the one configured in
 * the App dashboard.
 *
 * @returns the challenge to echo, or `undefined` if the request should be rejected.
 */
export function verifySubscription(
  query: Record<string, unknown>,
  expectedToken: string,
): string | undefined {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (
    mode !== 'subscribe' ||
    typeof token !== 'string' ||
    typeof challenge !== 'string'
  ) {
    return undefined;
  }

  // Constant-time comparison: this token is a shared secret, and the handshake
  // endpoint is publicly reachable.
  const provided = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  if (provided.length !== expected.length) {
    return undefined;
  }

  return timingSafeEqual(provided, expected) ? challenge : undefined;
}
