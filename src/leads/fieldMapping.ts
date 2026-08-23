import type { ConsentStatus } from '../db/repositories/contacts.js';
import type { LeadFieldDatum } from './graphLeads.js';

/**
 * Mapping of a Meta lead form's `field_data` onto the fields we store.
 *
 * Meta returns answers as an array of `{ name, values }`, where `name` is the
 * form field's key. The contact fields use documented, stable keys; every custom
 * question a form asks gets its own generated key that differs per form. So the
 * known keys are mapped explicitly and **everything else is preserved verbatim**
 * for the audit trail rather than guessed at.
 */

/** Meta's documented keys for the standard contact questions. */
const PHONE_KEYS = ['phone_number', 'phone'] as const;
const EMAIL_KEYS = ['email'] as const;
const FULL_NAME_KEYS = ['full_name', 'name'] as const;

/** The contact details and raw answers extracted from one submission. */
export interface LeadFormFields {
  phone?: string;
  name?: string;
  email?: string;
  /**
   * Every answer exactly as Meta delivered it, keyed by field name. Stored on
   * `campaign_referrals.raw_payload` so a form whose question keys we do not yet
   * know still has its answers captured, retrievable once the keys are confirmed.
   */
  answers: Record<string, string[]>;
}

/** How to recognise explicit WhatsApp consent in a given form. */
export interface ConsentFieldConfig {
  /** The `field_data` key holding the WhatsApp opt-in answer, when the form has one. */
  fieldName?: string | undefined;
  /**
   * The exact answer that counts as consent. When set, only this value is
   * accepted — used when a form's checkbox echoes its full Hebrew label back
   * rather than a boolean.
   */
  expectedValue?: string | undefined;
}

/**
 * Values that count as an affirmative answer to a consent checkbox.
 *
 * Meta returns a checkbox answer inconsistently depending on how the form was
 * authored — sometimes a boolean-ish string, sometimes the label itself. These
 * cover the boolean-ish forms; a label is matched through
 * {@link ConsentFieldConfig.expectedValue}.
 */
const AFFIRMATIVE = new Set([
  'true',
  'yes',
  '1',
  'on',
  'checked',
  'כן',
  'מאשר',
  'מאשרת',
  'מסכים',
  'מסכימה',
]);

/** The consent conclusion for one submission, with the evidence behind it. */
export interface ConsentDecision {
  status: ConsentStatus;
  /** The exact answer that decided it, retained as proof. Absent when nothing matched. */
  evidence?: string;
  /**
   * Set when the form was expected to carry a consent field and did not. Signals
   * that the form changed underneath us — the lead is still captured, but it
   * cannot be messaged proactively.
   */
  missingConsentField?: boolean;
}

/** First non-empty value for the first matching key, compared case-insensitively. */
function pick(
  answers: Record<string, string[]>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const values = answers[key];
    const value = values?.find((v) => v.trim().length > 0);
    if (value) return value.trim();
  }
  return undefined;
}

/** Lowercases field names so a form authored with different casing still maps. */
export function toAnswerMap(
  fieldData: readonly LeadFieldDatum[],
): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  for (const datum of fieldData) {
    if (!datum.name) continue;
    answers[datum.name.toLowerCase()] = [...(datum.values ?? [])];
  }
  return answers;
}

/** Extracts the contact fields, keeping every answer for the audit trail. */
export function mapLeadFields(fieldData: readonly LeadFieldDatum[]): LeadFormFields {
  const answers = toAnswerMap(fieldData);

  const fullName = pick(answers, FULL_NAME_KEYS);
  // Some forms ask for the name in two parts instead of one.
  const composed = [pick(answers, ['first_name']), pick(answers, ['last_name'])]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .trim();

  const name = fullName ?? (composed.length > 0 ? composed : undefined);
  const phone = pick(answers, PHONE_KEYS);
  const email = pick(answers, EMAIL_KEYS);

  return {
    ...(phone ? { phone } : {}),
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    answers,
  };
}

/**
 * Decides how much consent a submission carries.
 *
 * **Fails closed, by design.** Anything short of a positively-identified WhatsApp
 * opt-in is recorded as `privacy_policy_only`, which the proactive send path must
 * refuse (requirement NN-2). Submitting a lead form is not, on its own, agreement
 * to receive WhatsApp messages from this business: Meta's opt-in policy requires
 * the person to have been told, and Israeli Amendment 40 requires explicit
 * consent for commercial messages. Guessing in the permissive direction here
 * would be worth up to ₪1,000 per message.
 *
 * The consequence is deliberate: until the live form carries a visible line
 * naming WhatsApp *and* the business, and that field is configured here, every
 * lead is captured and none is proactively messaged.
 */
export function decideConsent(
  answers: Record<string, string[]>,
  config: ConsentFieldConfig,
): ConsentDecision {
  const fieldName = config.fieldName?.toLowerCase();
  if (!fieldName) {
    // No consent field configured: the form is not known to ask for WhatsApp
    // consent at all, so none can be claimed.
    return { status: 'privacy_policy_only' };
  }

  const values = answers[fieldName];
  if (!values || values.length === 0) {
    return { status: 'privacy_policy_only', missingConsentField: true };
  }

  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0) continue;

    const matches = config.expectedValue
      ? value === config.expectedValue.trim()
      : AFFIRMATIVE.has(value.toLowerCase());

    if (matches) return { status: 'whatsapp_opt_in', evidence: value };
  }

  // The field was present but the answer was not affirmative — an explicit "no".
  const first = values[0];
  return {
    status: 'privacy_policy_only',
    ...(first !== undefined ? { evidence: first } : {}),
  };
}
