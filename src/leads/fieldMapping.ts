import type { ConsentStatus } from '../db/repositories/contacts.js';
import type { KnownFacts } from '../workflow/decide.js';
import type { LeadFieldDatum } from './graphLeads.js';

/**
 * Mapping of a Meta lead form's `field_data` onto the fields we store.
 *
 * Meta returns answers as an array of `{ name, values }`, where `name` is the
 * form field's key. Standard contact questions use documented keys — but only
 * when the form was built with Meta's *standard* fields. A form that asks for the
 * same details as custom questions gets keys derived from the Hebrew label
 * instead, so both spellings are recognised.
 *
 * Custom questions always produce a label-derived key, and their answers are
 * option keys rather than display text (`מיידי`, not "immediately"). Those are
 * mapped explicitly in {@link mapScreeningAnswers}; everything unrecognised is
 * preserved verbatim rather than guessed at.
 */

/**
 * Keys for the standard contact questions, in both spellings.
 *
 * The Hebrew variants are not hypothetical: form `2080005129480041` asks for the
 * phone as `מספר_טלפון`, and a lead from it would otherwise be dropped as having
 * no usable phone number.
 */
const PHONE_KEYS = ['phone_number', 'phone', 'מספר_טלפון', 'טלפון'] as const;
const EMAIL_KEYS = ['email', 'דוא"ל', 'דואל', 'אימייל'] as const;
const FULL_NAME_KEYS = ['full_name', 'name', 'שם_מלא', 'שם'] as const;
const FIRST_NAME_KEYS = ['first_name', 'שם_פרטי'] as const;
const LAST_NAME_KEYS = ['last_name', 'שם_משפחה'] as const;

/** The contact details and raw answers extracted from one submission. */
export interface LeadFormFields {
  phone?: string;
  name?: string;
  email?: string;
  /**
   * Every answer exactly as Meta delivered it, keyed by field name. Stored on
   * `campaign_referrals.raw_payload` so a form whose question keys we do not yet
   * know still has its answers captured.
   */
  answers: Record<string, string[]>;
}

/** First non-empty value for the first matching key. */
function pick(
  answers: Record<string, string[]>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = answers[key]?.find((v) => v.trim().length > 0);
    if (value) return value.trim();
  }
  return undefined;
}

/**
 * Indexes answers by field name.
 *
 * Names are lowercased so a form authored with different casing still matches.
 * Hebrew has no case, so this only affects the Latin-keyed fields.
 */
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

  const composed = [pick(answers, FIRST_NAME_KEYS), pick(answers, LAST_NAME_KEYS)]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .trim();

  const name =
    pick(answers, FULL_NAME_KEYS) ?? (composed.length > 0 ? composed : undefined);
  const phone = pick(answers, PHONE_KEYS);
  const email = pick(answers, EMAIL_KEYS);

  return {
    ...(phone ? { phone } : {}),
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    answers,
  };
}

// ---------------------------------------------------------------------------
// Screening answers (spec Q1 and Q3, pre-answered on the form)
// ---------------------------------------------------------------------------

/**
 * The seller form's Q1 and Q3 question keys.
 *
 * Identical across all three seller forms, and stable: a Meta form cannot be
 * edited after creation, so a key can never change under us — a *new* form is
 * the only way a question changes, and that arrives with a new form id.
 */
const Q1_SELL_INTENT_KEY = 'הנכס_שלך_כבר_מוכן_לשיווק,_או_שאתה_עדיין_בשלב_בדיקה/התלבטות?';
const Q3_TIMELINE_KEY = 'תוך_כמה_זמן_אתה_מתכנן_למכור?';

/**
 * Option key → fact. Meta sends the option's *key*, not its display text.
 *
 * Deliberately exhaustive rather than fuzzy: an unrecognised option must leave
 * the fact unset so the bot asks the question itself, which is always safe. A
 * loose match risks recording an answer the person never gave.
 */
const SELL_INTENT_BY_OPTION: Record<string, KnownFacts['sellIntent']> = {
  מוכן_לשיווק: 'ready',
  'עדיין_בודק_/_לא_סגור': 'not_sure',
};

const TIMELINE_BY_OPTION: Record<string, KnownFacts['timeline']> = {
  מיידי: 'immediate',
  בתוך_חודש: 'within_month',
  עדיין_בודק_מחירים: 'still_checking',
};

/**
 * Maps the form's screening answers onto the facts the qualification flow reads.
 *
 * This is not an optimisation. A `meta_lead_form` lead is screened on Q2 and Q4
 * only (`screensAllQuestions`), on the premise that Q1 and Q3 were answered on
 * the form. Without this mapping those two answers would be neither asked nor
 * known, and the lead would be qualified on incomplete information.
 */
export function mapScreeningAnswers(answers: Record<string, string[]>): KnownFacts {
  const facts: KnownFacts = {};

  const sellIntentOption = answers[Q1_SELL_INTENT_KEY]?.[0]?.trim();
  const sellIntent = sellIntentOption
    ? SELL_INTENT_BY_OPTION[sellIntentOption]
    : undefined;
  if (sellIntent) facts.sellIntent = sellIntent;

  const timelineOption = answers[Q3_TIMELINE_KEY]?.[0]?.trim();
  const timeline = timelineOption ? TIMELINE_BY_OPTION[timelineOption] : undefined;
  if (timeline) facts.timeline = timeline;

  return facts;
}

// ---------------------------------------------------------------------------
// Consent (requirement NN-2)
// ---------------------------------------------------------------------------

/** How consent is recognised, for a given form. */
export interface ConsentConfig {
  /**
   * The `field_data` key holding a per-lead WhatsApp opt-in answer, for forms
   * that ask consent as an ordinary question.
   */
  fieldName?: string | undefined;
  /** The exact answer that counts as consent, when the checkbox echoes its label. */
  expectedValue?: string | undefined;
  /** The form this lead came from. */
  formId?: string | undefined;
  /**
   * Forms whose submission itself constitutes WhatsApp opt-in, because the form
   * carries a **required** consent checkbox naming WhatsApp and the business.
   * See {@link decideConsent} for why this is necessary and how it is justified.
   */
  consentForms?: readonly string[] | undefined;
  /** Wording to record as evidence for form-level consent. */
  formConsentText?: string | undefined;
}

/** Values that count as an affirmative answer to a consent question. */
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
  /** What justified the decision, retained as proof. */
  evidence?: string;
  /** How it was established, for the audit trail. */
  basis?: 'field' | 'form';
}

/**
 * Decides how much consent a submission carries.
 *
 * **Fails closed.** Anything short of a positively-identified WhatsApp opt-in is
 * `privacy_policy_only`, which the proactive send path must refuse (NN-2).
 * Submitting a lead form is not by itself agreement to receive WhatsApp messages:
 * Meta's opt-in policy requires the person to have been told, and Amendment 40
 * requires explicit consent for commercial messages, at up to ₪1,000 each.
 *
 * Consent is recognised two ways, in order of evidential strength:
 *
 * 1. **Per-lead field.** The strongest: this person's own recorded answer.
 * 2. **Per-form.** Meta does *not* return privacy-step disclaimer checkboxes in
 *    `field_data`, even when required — the live seller form's checkbox is
 *    `is_required: true` and still absent from every lead. Refusing consent on
 *    that basis would mean no lead is ever contactable, so a form may be declared
 *    as gating on consent. This is sound because the checkbox is required (no
 *    submission exists without it) and not pre-checked (it is an affirmative
 *    act), and because **Meta forms are immutable**: a form id is a permanent,
 *    verifiable reference to the exact wording that was agreed to.
 *
 * An explicit *negative* answer in the field always wins — it is never overridden
 * by the form-level rule.
 */
export function decideConsent(
  answers: Record<string, string[]>,
  config: ConsentConfig,
): ConsentDecision {
  const fieldName = config.fieldName?.toLowerCase();
  const values = fieldName ? answers[fieldName] : undefined;

  if (values && values.length > 0) {
    for (const raw of values) {
      const value = raw.trim();
      if (value.length === 0) continue;

      const matches = config.expectedValue
        ? value === config.expectedValue.trim()
        : AFFIRMATIVE.has(value.toLowerCase());

      if (matches) return { status: 'whatsapp_opt_in', evidence: value, basis: 'field' };

      // Answered, and not affirmatively. An explicit refusal is final.
      return { status: 'privacy_policy_only', evidence: value, basis: 'field' };
    }
  }

  const formId = config.formId;
  if (formId && config.consentForms?.includes(formId)) {
    return {
      status: 'whatsapp_opt_in',
      evidence: config.formConsentText ?? `form:${formId}`,
      basis: 'form',
    };
  }

  return { status: 'privacy_policy_only' };
}
