import { describe, expect, it } from 'vitest';
import { decideConsent, mapLeadFields, toAnswerMap } from './fieldMapping.js';
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
 * These are the compliance tests for requirement NN-2. A regression here means
 * messaging someone who never agreed to be messaged — up to ₪1,000 per message
 * under Israeli Amendment 40, plus Meta policy exposure. The default in every
 * ambiguous case must be the status that *cannot* be proactively contacted.
 */
describe('decideConsent', () => {
  const answers = (entries: Record<string, string | string[]>) =>
    toAnswerMap(fields(entries));

  it('refuses consent when the form has no configured consent field', () => {
    // Submitting a lead form is not, by itself, agreement to receive WhatsApp
    // messages from this business.
    const decision = decideConsent(answers({ phone_number: '05' }), {});

    expect(decision.status).toBe('privacy_policy_only');
  });

  it('grants opt-in for an affirmative answer', () => {
    const decision = decideConsent(answers({ whatsapp_consent: 'true' }), {
      fieldName: 'whatsapp_consent',
    });

    expect(decision.status).toBe('whatsapp_opt_in');
    expect(decision.evidence).toBe('true');
  });

  it.each(['true', 'yes', '1', 'on', 'checked', 'כן', 'מאשר', 'מאשרת'])(
    'accepts %s as affirmative',
    (value) => {
      expect(decideConsent(answers({ c: value }), { fieldName: 'c' }).status).toBe(
        'whatsapp_opt_in',
      );
    },
  );

  it('refuses an explicit negative', () => {
    const decision = decideConsent(answers({ c: 'false' }), { fieldName: 'c' });

    expect(decision.status).toBe('privacy_policy_only');
    expect(decision.evidence).toBe('false');
  });

  it('flags a configured consent field that the form no longer sends', () => {
    // Usually means the form was edited. The lead is still captured; it just
    // cannot be messaged.
    const decision = decideConsent(answers({ phone_number: '05' }), { fieldName: 'c' });

    expect(decision.status).toBe('privacy_policy_only');
    expect(decision.missingConsentField).toBe(true);
  });

  it('matches an exact expected value when one is configured', () => {
    const label = 'אני מאשר/ת לקבל הודעות וואטסאפ מלידור בראל תיווך נדל״ן';
    const config = { fieldName: 'c', expectedValue: label };

    expect(decideConsent(answers({ c: label }), config).status).toBe('whatsapp_opt_in');
  });

  it('refuses anything other than the exact expected value', () => {
    // A checkbox echoing a *different* label is not the consent we asked for.
    const config = { fieldName: 'c', expectedValue: 'הסכמה מפורשת' };

    expect(decideConsent(answers({ c: 'true' }), config).status).toBe(
      'privacy_policy_only',
    );
  });

  it('ignores blank values and keeps looking', () => {
    const decision = decideConsent(answers({ c: ['', 'כן'] }), { fieldName: 'c' });

    expect(decision.status).toBe('whatsapp_opt_in');
  });

  it('refuses when the consent field is present but empty', () => {
    expect(decideConsent(answers({ c: [''] }), { fieldName: 'c' }).status).toBe(
      'privacy_policy_only',
    );
  });
});
