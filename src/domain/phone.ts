import { parsePhoneNumberWithError, type CountryCode } from 'libphonenumber-js';

/**
 * Phone number normalization.
 *
 * Every contact is identified by phone number. The same person reaches us in
 * several different formats:
 *
 *   - Meta lead form:  "053-337-4203" or "0533374203" (whatever they typed)
 *   - WhatsApp webhook: "972533374203" (no plus, no separators)
 *   - Manual entry:     "+972 53-337-4203"
 *
 * All of those are one person. If normalization disagrees across entry points we
 * create duplicate contacts, message someone twice, and — worst of all — miss an
 * opt-out because it was recorded against a different spelling of the same
 * number. That makes this module correctness-critical rather than cosmetic.
 *
 * Parsing is delegated to libphonenumber-js rather than hand-rolled: real phone
 * numbering is full of exceptions, and getting it subtly wrong here fails
 * silently.
 */

/** A phone number in E.164 form, e.g. `+972533374203`. */
export type E164 = string & { readonly __brand: 'E164' };

/** Israel. Bare local numbers such as `0533374203` are interpreted in this region. */
const DEFAULT_REGION: CountryCode = 'IL';

export class InvalidPhoneNumberError extends Error {
  constructor(reason: string) {
    // The number itself is personal data and is deliberately not included.
    super(`Invalid phone number: ${reason}`);
    this.name = 'InvalidPhoneNumberError';
  }
}

/**
 * Characters that carry no dial information but routinely appear in numbers
 * pasted from Hebrew-language forms and spreadsheets: RTL/LTR marks, zero-width
 * characters, and non-breaking spaces.
 *
 * libphonenumber-js does not strip these, and a stray U+200E is enough to make
 * two identical numbers compare unequal.
 */
const INVISIBLE_CHARS = new RegExp(
  '[' +
    [
      '\\u200B-\\u200F', // zero-width space/non-joiner/joiner, LTR & RTL marks
      '\\u202A-\\u202E', // bidirectional embedding and override
      '\\u2066-\\u2069', // bidirectional isolates
      '\\uFEFF', // zero-width no-break space (BOM)
      '\\u00A0', // non-breaking space
    ].join('') +
    ']',
  'g',
);

/**
 * Normalizes a phone number to E.164.
 *
 * Accepts local Israeli formats, international formats with or without `+`, and
 * `00`-prefixed international dialling.
 *
 * @throws {InvalidPhoneNumberError} if the number cannot be parsed or is not a
 * valid number for its region. The offending value is never included in the
 * error, since it is personal data.
 */
export function normalizePhone(
  input: string,
  region: CountryCode = DEFAULT_REGION,
): E164 {
  const cleaned = input.replace(INVISIBLE_CHARS, '').trim();

  if (cleaned === '') {
    throw new InvalidPhoneNumberError('empty');
  }

  // "00" is the international dialling prefix in Israel and much of the world.
  // libphonenumber-js only understands it in some contexts, so normalize it up
  // front: 00972533374203 -> +972533374203
  const withPlus = cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned;

  // A bare international number with no plus — the form WhatsApp's webhook uses.
  // Without the plus this would otherwise be read as a local number.
  const candidate =
    !withPlus.startsWith('+') && /^\d{11,15}$/.test(withPlus.replace(/\D/g, ''))
      ? `+${withPlus.replace(/\D/g, '')}`
      : withPlus;

  let parsed;
  try {
    parsed = parsePhoneNumberWithError(candidate, region);
  } catch (error) {
    throw new InvalidPhoneNumberError(
      error instanceof Error ? error.message : 'could not be parsed',
    );
  }

  if (!parsed.isValid()) {
    throw new InvalidPhoneNumberError('not a valid number for its region');
  }

  return parsed.number as E164;
}

/**
 * Normalizes a phone number, returning `undefined` instead of throwing.
 *
 * Used where invalid input is expected and survivable — importing a lead batch,
 * for instance, where one bad row should not abort the run.
 */
export function tryNormalizePhone(
  input: string | null | undefined,
  region: CountryCode = DEFAULT_REGION,
): E164 | undefined {
  if (input == null) return undefined;
  try {
    return normalizePhone(input, region);
  } catch {
    return undefined;
  }
}

/** Type guard for values already known to be E.164. */
export function isE164(value: string): value is E164 {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/**
 * Formats a number for display to staff in the admin panel.
 *
 * Israeli numbers render in familiar national form (`053-337-4203`); everything
 * else renders international.
 */
export function formatPhoneForDisplay(phone: E164): string {
  try {
    const parsed = parsePhoneNumberWithError(phone);
    return parsed.country === DEFAULT_REGION
      ? parsed.formatNational()
      : parsed.formatInternational();
  } catch {
    return phone;
  }
}
