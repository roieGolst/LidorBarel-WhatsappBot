import { describe, expect, it } from 'vitest';
import {
  extractLeadgenEvents,
  isPageWebhook,
  leadgenEnvelopeSchema,
} from './leadgenPayload.js';

/** A realistic Page webhook carrying one lead-form submission. */
function pageWebhook(value: Record<string, unknown>, field = 'leadgen'): unknown {
  return {
    object: 'page',
    entry: [{ id: '111', time: 1_755_000_000, changes: [{ field, value }] }],
  };
}

const LEAD_VALUE = {
  leadgen_id: '444444444444',
  form_id: '555555555555',
  page_id: '111',
  ad_id: '666666666666',
  adgroup_id: '777777777777',
  created_time: 1_755_000_000,
};

function parse(body: unknown) {
  const parsed = leadgenEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new Error('expected the envelope to parse');
  return parsed.data;
}

describe('isPageWebhook', () => {
  it('recognises a Page webhook', () => {
    expect(isPageWebhook({ object: 'page' })).toBe(true);
  });

  it('does not claim a WhatsApp webhook', () => {
    expect(isPageWebhook({ object: 'whatsapp_business_account' })).toBe(false);
  });

  it.each([null, undefined, 'page', 42, []])('is false for %s', (body) => {
    expect(isPageWebhook(body)).toBe(false);
  });
});

describe('extractLeadgenEvents', () => {
  it('flattens a submission into a lead event', () => {
    const [event] = extractLeadgenEvents(parse(pageWebhook(LEAD_VALUE)));

    expect(event).toEqual({
      leadgenId: '444444444444',
      formId: '555555555555',
      pageId: '111',
      adId: '666666666666',
      adgroupId: '777777777777',
      createdTime: new Date(1_755_000_000 * 1000),
    });
  });

  it('keeps a lead that carries only the id', () => {
    // Attribution metadata is optional; losing a paid lead because `ad_id` was
    // absent would be far worse than an incomplete referral.
    const events = extractLeadgenEvents(parse(pageWebhook({ leadgen_id: 'L1' })));

    expect(events).toEqual([{ leadgenId: 'L1' }]);
  });

  it('ignores Page changes for other fields', () => {
    expect(extractLeadgenEvents(parse(pageWebhook(LEAD_VALUE, 'feed')))).toEqual([]);
  });

  it('skips a malformed lead but keeps the valid ones in the batch', () => {
    // One bad change must not cost the whole batch: Meta would redeliver it
    // forever, and real leads would be stuck behind it.
    const body = {
      object: 'page',
      entry: [
        {
          changes: [
            { field: 'leadgen', value: { form_id: 'no-id-here' } },
            { field: 'leadgen', value: { leadgen_id: 'L2' } },
          ],
        },
      ],
    };

    expect(extractLeadgenEvents(parse(body))).toEqual([{ leadgenId: 'L2' }]);
  });

  it('handles several entries in one delivery', () => {
    const body = {
      object: 'page',
      entry: [
        { changes: [{ field: 'leadgen', value: { leadgen_id: 'A' } }] },
        { changes: [{ field: 'leadgen', value: { leadgen_id: 'B' } }] },
      ],
    };

    expect(extractLeadgenEvents(parse(body)).map((e) => e.leadgenId)).toEqual(['A', 'B']);
  });

  it('returns nothing for an empty envelope', () => {
    expect(extractLeadgenEvents(parse({ object: 'page' }))).toEqual([]);
  });

  it('accepts unknown fields Meta may add without notice', () => {
    const events = extractLeadgenEvents(
      parse(pageWebhook({ ...LEAD_VALUE, some_future_field: 'x' })),
    );

    expect(events[0]?.leadgenId).toBe('444444444444');
  });
});
