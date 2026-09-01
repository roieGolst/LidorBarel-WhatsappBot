import { describe, expect, it } from 'vitest';
import { BEER_SHEVA_NEIGHBORHOODS } from '../domain/neighborhoods.js';
import {
  LEAD_COLUMNS,
  LEAD_STATUS,
  leadColumnValues,
  needsGroupMove,
  neighborhoodLabelId,
  statusLabelFor,
} from './leadMapping.js';

/**
 * These assert *ids*, not labels. Monday matches on id, a rename is harmless,
 * and several of the ids are counter-intuitive — `מועד מכירה רצוי` numbers
 * immediate as 2 and within-a-month as 0. A wrong id here writes a plausible but
 * false answer onto Lidor's board, which is worse than writing nothing.
 */
describe('statusLabelFor', () => {
  it.each([
    ['qualified', LEAD_STATUS.awaitingCall],
    ['handed_off', LEAD_STATUS.awaitingCall],
    ['appointment_confirmed', LEAD_STATUS.awaitingMeeting],
    ['closed_no_response', LEAD_STATUS.noResponse],
    ['opted_out', LEAD_STATUS.askedToStop],
    ['blocked', LEAD_STATUS.askedToStop],
    ['engaged', LEAD_STATUS.new],
    ['awaiting_first_contact', LEAD_STATUS.new],
  ] as const)('maps %s', (stage, expected) => {
    expect(statusLabelFor(stage, null)).toBe(expected);
  });

  it.each([
    ['not_selling', LEAD_STATUS.notSelling],
    ['no_urgency', LEAD_STATUS.noUrgency],
    ['exclusive_with_other_agent', LEAD_STATUS.exclusiveWithAgent],
    ['uncooperative', LEAD_STATUS.uncooperative],
  ] as const)('reports why a lead was disqualified: %s', (reason, expected) => {
    // The reason is what tells Lidor whether the lead is worth revisiting.
    expect(statusLabelFor('disqualified', reason)).toBe(expected);
  });

  it('falls back to a generic unsuitable when no reason was recorded', () => {
    expect(statusLabelFor('disqualified', null)).toBe(LEAD_STATUS.unsuitable);
  });

  it("never writes the won status — that is Lidor's to set", () => {
    const everyStage = [
      'new',
      'engaged',
      'qualified',
      'handed_off',
      'disqualified',
      'opted_out',
      'blocked',
      'closed_no_response',
      'appointment_confirmed',
    ] as const;

    for (const stage of everyStage) {
      expect(statusLabelFor(stage, null)).not.toBe(LEAD_STATUS.won);
    }
  });
});

describe('needsGroupMove', () => {
  it.each([
    LEAD_STATUS.unsuitable,
    LEAD_STATUS.askedToStop,
    LEAD_STATUS.exclusiveWithAgent,
    LEAD_STATUS.uncooperative,
    LEAD_STATUS.noUrgency,
    LEAD_STATUS.notSelling,
  ])('moves %i, which no automation files', (label) => {
    expect(needsGroupMove(label)).toBe(true);
  });

  it.each([
    LEAD_STATUS.new,
    LEAD_STATUS.awaitingCall,
    LEAD_STATUS.awaitingMeeting,
    LEAD_STATUS.noResponse,
  ])('leaves %i to the board automation', (label) => {
    // Moving these from code would race the automation and make the board flap.
    expect(needsGroupMove(label)).toBe(false);
  });
});

describe('neighborhoodLabelId', () => {
  it('is the domain list index plus one', () => {
    expect(neighborhoodLabelId(BEER_SHEVA_NEIGHBORHOODS[0])).toBe(1);
    expect(neighborhoodLabelId('רמות')).toBe(18);
  });

  it('covers every neighbourhood the domain knows', () => {
    // The dropdown was rebuilt from this list; a gap means a lead's answer would
    // silently fail to reach the board.
    for (const name of BEER_SHEVA_NEIGHBORHOODS) {
      expect(neighborhoodLabelId(name)).toBeDefined();
    }
  });

  it('returns nothing for an unknown place', () => {
    // "אהרון מסקין" is a street. Writing it would create a permanent bogus label.
    expect(neighborhoodLabelId('אהרון מסקין')).toBeUndefined();
  });
});

const contact = (over = {}) =>
  ({
    phone: '+972501234567',
    name: 'ישראל',
    email: null,
    entryPoint: 'meta_lead_form',
    ...over,
  }) as never;

const conversation = (over = {}) =>
  ({
    stage: 'engaged',
    disqualificationReason: null,
    priorityScore: null,
    lastInboundAt: new Date('2026-08-26T09:00:00Z'),
    lastOutboundAt: null,
    ...over,
  }) as never;

describe('leadColumnValues', () => {
  it('writes the phone without a plus, with the country', () => {
    const values = leadColumnValues(
      { contact: contact(), conversation: conversation(), facts: {} },
      { includeStatus: false },
    );

    expect(values[LEAD_COLUMNS.phone]).toEqual({
      phone: '972501234567',
      countryShortName: 'IL',
    });
  });

  it('omits status on create, because an automation sets it', () => {
    const values = leadColumnValues(
      { contact: contact(), conversation: conversation(), facts: {} },
      { includeStatus: false },
    );

    expect(values[LEAD_COLUMNS.status]).toBeUndefined();
  });

  it('includes status on update', () => {
    const values = leadColumnValues(
      {
        contact: contact(),
        conversation: conversation({ stage: 'qualified' }),
        facts: {},
      },
      { includeStatus: true },
    );

    expect(values[LEAD_COLUMNS.status]).toEqual({ index: LEAD_STATUS.awaitingCall });
  });

  it('marks a form lead as paid and a direct lead as the bot', () => {
    const form = leadColumnValues(
      { contact: contact(), conversation: conversation(), facts: {} },
      { includeStatus: false },
    );
    const direct = leadColumnValues(
      {
        contact: contact({ entryPoint: 'direct_message' }),
        conversation: conversation(),
        facts: {},
      },
      { includeStatus: false },
    );

    expect(form[LEAD_COLUMNS.source]).toEqual({ index: 0 });
    expect(direct[LEAD_COLUMNS.source]).toEqual({ index: 6 });
  });

  it('maps the screening answers onto their label ids', () => {
    const values = leadColumnValues(
      {
        contact: contact(),
        conversation: conversation(),
        facts: {
          sellIntent: 'ready',
          timeline: 'immediate',
          currentlyMarketed: 'no',
          neighborhood: 'רמות',
        },
      },
      { includeStatus: false },
    );

    expect(values[LEAD_COLUMNS.sellIntent]).toEqual({ index: 1 });
    expect(values[LEAD_COLUMNS.timeline]).toEqual({ index: 2 });
    expect(values[LEAD_COLUMNS.currentlyMarketed]).toEqual({ index: 1 });
    expect(values[LEAD_COLUMNS.neighborhood]).toEqual({ ids: [18] });
  });

  it('omits an unknown fact rather than blanking it', () => {
    // Writing null would erase whatever Lidor had filled in by hand.
    const values = leadColumnValues(
      { contact: contact(), conversation: conversation(), facts: {} },
      { includeStatus: false },
    );

    expect(values).not.toHaveProperty(LEAD_COLUMNS.sellIntent);
    expect(values).not.toHaveProperty(LEAD_COLUMNS.timeline);
    expect(values).not.toHaveProperty(LEAD_COLUMNS.neighborhood);
  });

  it('omits an unrecognised neighbourhood entirely', () => {
    const values = leadColumnValues(
      {
        contact: contact(),
        conversation: conversation(),
        facts: { neighborhood: 'אהרון מסקין' },
      },
      { includeStatus: false },
    );

    expect(values).not.toHaveProperty(LEAD_COLUMNS.neighborhood);
  });

  it("projects the priority score, which orders Lidor's queue", () => {
    const values = leadColumnValues(
      {
        contact: contact(),
        conversation: conversation({ priorityScore: 93 }),
        facts: {},
      },
      { includeStatus: true },
    );

    expect(values[LEAD_COLUMNS.score]).toBe('93');
  });

  it('leaves the score blank while it is unknown', () => {
    // An unscored lead should look unscored, not bottom-of-queue.
    const values = leadColumnValues(
      { contact: contact(), conversation: conversation(), facts: {} },
      { includeStatus: true },
    );

    expect(values).not.toHaveProperty(LEAD_COLUMNS.score);
  });

  it('never syncs gender or a creation date', () => {
    // Gender is for Hebrew grammar and is never filtered on; Monday already
    // records creation time itself.
    const values = leadColumnValues(
      { contact: contact({ gender: 'male' }), conversation: conversation(), facts: {} },
      { includeStatus: true },
    );

    expect(values).not.toHaveProperty('color_mkp8eq7j');
    expect(values).not.toHaveProperty('date_mm6apc14');
  });
});
