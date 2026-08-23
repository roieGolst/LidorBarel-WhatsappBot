import { describe, expect, it } from 'vitest';
import {
  decideConsent,
  mapLeadFields,
  mapScreeningAnswers,
  toAnswerMap,
} from './fieldMapping.js';
import type { LeadFieldDatum } from './graphLeads.js';

function fields(entries: Record<string, string | string[]>): LeadFieldDatum[] {
  return Object.entries(entries).map(([name, values]) => ({
    name,
    values: Array.isArray(values) ? values : [values],
  }));
}

describe('mapLeadFields', () => {
  it('maps the standard contact questions', () => {
    const mapped = mapLeadFields(
      fields({
        full_name: 'ישראל ישראלי',
        phone_number: '+972501234567',
        email: 'israel@example.com',
      }),
    );

    expect(mapped.name).toBe('ישראל ישראלי');
    expect(mapped.phone).toBe('+972501234567');
    expect(mapped.email).toBe('israel@example.com');
  });

  it('composes a name from a form that asks for it in two parts', () => {
    const mapped = mapLeadFields(fields({ first_name: 'ישראל', last_name: 'ישראלי' }));

    expect(mapped.name).toBe('ישראל ישראלי');
  });

  it('prefers a full name over the composed parts', () => {
    const mapped = mapLeadFields(
      fields({ full_name: 'שם מלא', first_name: 'ישראל', last_name: 'ישראלי' }),
    );

    expect(mapped.name).toBe('שם מלא');
  });

  it('matches field names case-insensitively', () => {
    expect(mapLeadFields(fields({ Phone_Number: '0501234567' })).phone).toBe(
      '0501234567',
    );
  });

  it('keeps every answer verbatim, including the form-specific questions', () => {
    // The custom question keys differ per form, so they are preserved rather
    // than guessed at — the qualification flow reads them once confirmed.
    const mapped = mapLeadFields(
      fields({ phone_number: '0501234567', when_are_you_selling: 'מיידי' }),
    );

    expect(mapped.answers['when_are_you_selling']).toEqual(['מיידי']);
  });

  it('treats a blank answer as absent', () => {
    expect(
      mapLeadFields(fields({ phone_number: '   ', email: '' })).phone,
    ).toBeUndefined();
  });

  it('maps the Hebrew contact keys some forms use', () => {
    // Form 2080005129480041 asks for these as custom questions, so the keys are
    // Hebrew. Without these aliases its leads are dropped as having no phone.
    const mapped = mapLeadFields(
      fields({ שם_מלא: 'ישראל', מספר_טלפון: '0501234567', 'דוא"ל': 'a@b.c' }),
    );

    expect(mapped.name).toBe('ישראל');
    expect(mapped.phone).toBe('0501234567');
    expect(mapped.email).toBe('a@b.c');
  });

  it('survives a field with no name or values', () => {
    expect(() => mapLeadFields([{ values: ['x'] }, { name: 'email' }])).not.toThrow();
  });
});

describe('toAnswerMap', () => {
  it('lowercases keys so casing differences do not lose an answer', () => {
    expect(toAnswerMap(fields({ FULL_NAME: 'x' }))).toEqual({ full_name: ['x'] });
  });
});

/**
 * Compliance tests for requirement NN-2. A regression here means messaging
 * someone who never agreed to be messaged — up to ₪1,000 per message under
 * Amendment 40, plus Meta policy exposure. Every ambiguous case must land on the
 * status that *cannot* be proactively contacted.
 */
describe('decideConsent', () => {
  const answers = (entries: Record<string, string | string[]>) =>
    toAnswerMap(fields(entries));

  it('refuses when nothing is configured', () => {
    expect(decideConsent(answers({ phone_number: '05' }), {}).status).toBe(
      'privacy_policy_only',
    );
  });

  describe('per-lead field', () => {
    it('grants opt-in for an affirmative answer', () => {
      const decision = decideConsent(answers({ wa: 'true' }), { fieldName: 'wa' });

      expect(decision).toMatchObject({
        status: 'whatsapp_opt_in',
        evidence: 'true',
        basis: 'field',
      });
    });

    it.each(['true', 'yes', '1', 'on', 'checked', 'כן', 'מאשר', 'מאשרת'])(
      'accepts %s as affirmative',
      (value) => {
        expect(decideConsent(answers({ wa: value }), { fieldName: 'wa' }).status).toBe(
          'whatsapp_opt_in',
        );
      },
    );

    it('refuses an explicit negative', () => {
      const decision = decideConsent(answers({ wa: 'false' }), { fieldName: 'wa' });

      expect(decision.status).toBe('privacy_policy_only');
      expect(decision.evidence).toBe('false');
    });

    it('matches an exact expected value when configured', () => {
      const label = 'אני מאשר/ת לקבל הודעות וואטסאפ מלידור בראל';

      expect(
        decideConsent(answers({ wa: label }), { fieldName: 'wa', expectedValue: label })
          .status,
      ).toBe('whatsapp_opt_in');
    });

    it('refuses anything other than the exact expected value', () => {
      expect(
        decideConsent(answers({ wa: 'true' }), {
          fieldName: 'wa',
          expectedValue: 'הסכמה מפורשת',
        }).status,
      ).toBe('privacy_policy_only');
    });
  });

  describe('per-form', () => {
    // Meta does not return privacy-step disclaimer checkboxes in field_data, even
    // when required, so the live seller form has no per-lead consent answer.

    it('grants opt-in for a form declared as gating on consent', () => {
      const decision = decideConsent(answers({ phone_number: '05' }), {
        formId: 'F1',
        consentForms: ['F1'],
      });

      expect(decision).toMatchObject({ status: 'whatsapp_opt_in', basis: 'form' });
    });

    it('records the configured wording as evidence', () => {
      const text = 'אני מאשר/ת את מדיניות הפרטיות ומסכים/ה לקבלת הודעת אישור בוואטסאפ';

      const decision = decideConsent(answers({}), {
        formId: 'F1',
        consentForms: ['F1'],
        formConsentText: text,
      });

      expect(decision.evidence).toBe(text);
    });

    it('falls back to the form id when no wording is configured', () => {
      expect(
        decideConsent(answers({}), { formId: 'F1', consentForms: ['F1'] }).evidence,
      ).toBe('form:F1');
    });

    it('refuses a form that is not declared', () => {
      expect(
        decideConsent(answers({}), { formId: 'OTHER', consentForms: ['F1'] }).status,
      ).toBe('privacy_policy_only');
    });

    it('refuses when the lead carries no form id', () => {
      expect(decideConsent(answers({}), { consentForms: ['F1'] }).status).toBe(
        'privacy_policy_only',
      );
    });
  });

  describe('precedence', () => {
    it('lets an explicit refusal override a consent-gated form', () => {
      // The person answered "no". The form-level rule must never overrule them.
      const decision = decideConsent(answers({ wa: 'false' }), {
        fieldName: 'wa',
        formId: 'F1',
        consentForms: ['F1'],
      });

      expect(decision.status).toBe('privacy_policy_only');
      expect(decision.basis).toBe('field');
    });

    it('falls back to the form when the field is absent', () => {
      // Test-tool leads omit disclaimer checkboxes; real ones may include them.
      const decision = decideConsent(answers({ phone_number: '05' }), {
        fieldName: 'wa',
        formId: 'F1',
        consentForms: ['F1'],
      });

      expect(decision).toMatchObject({ status: 'whatsapp_opt_in', basis: 'form' });
    });

    it('prefers the field when both would grant', () => {
      const decision = decideConsent(answers({ wa: 'true' }), {
        fieldName: 'wa',
        formId: 'F1',
        consentForms: ['F1'],
      });

      expect(decision.basis).toBe('field');
    });
  });
});

/**
 * Values are the form's option *keys*, verified against a real lead from the live
 * seller form. A form cannot be edited after creation, so these cannot drift —
 * only a new form id can bring new options.
 */
describe('mapScreeningAnswers', () => {
  const Q1 = 'הנכס_שלך_כבר_מוכן_לשיווק,_או_שאתה_עדיין_בשלב_בדיקה/התלבטות?';
  const Q3 = 'תוך_כמה_זמן_אתה_מתכנן_למכור?';

  it('maps a real submission onto the screening facts', () => {
    const facts = mapScreeningAnswers(
      toAnswerMap(fields({ [Q1]: 'מוכן_לשיווק', [Q3]: 'מיידי' })),
    );

    expect(facts).toEqual({ sellIntent: 'ready', timeline: 'immediate' });
  });

  it.each([
    ['מוכן_לשיווק', 'ready'],
    ['עדיין_בודק_/_לא_סגור', 'not_sure'],
  ])('maps sell intent %s', (option, expected) => {
    expect(mapScreeningAnswers(toAnswerMap(fields({ [Q1]: option }))).sellIntent).toBe(
      expected,
    );
  });

  it.each([
    ['מיידי', 'immediate'],
    ['בתוך_חודש', 'within_month'],
    ['עדיין_בודק_מחירים', 'still_checking'],
  ])('maps timeline %s', (option, expected) => {
    expect(mapScreeningAnswers(toAnswerMap(fields({ [Q3]: option }))).timeline).toBe(
      expected,
    );
  });

  it('leaves an unrecognised option unset so the bot asks instead', () => {
    // Recording an answer the person never gave is worse than asking again.
    expect(mapScreeningAnswers(toAnswerMap(fields({ [Q1]: 'משהו_חדש' })))).toEqual({});
  });

  it('returns nothing for a form without the screening questions', () => {
    expect(mapScreeningAnswers(toAnswerMap(fields({ full_name: 'x' })))).toEqual({});
  });
});
