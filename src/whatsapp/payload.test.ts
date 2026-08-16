import { describe, expect, it } from 'vitest';
import {
  extractEvents,
  webhookEnvelopeSchema,
  type InboundMessageEvent,
} from './payload.js';

/** Builds a webhook envelope around one `value` object. */
function envelope(value: Record<string, unknown>) {
  return webhookEnvelopeSchema.parse({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123456',
        changes: [
          { field: 'messages', value: { messaging_product: 'whatsapp', ...value } },
        ],
      },
    ],
  });
}

const METADATA = { display_phone_number: '972533374203', phone_number_id: 'PHONE_ID' };

describe('extractEvents', () => {
  it('extracts a plain text message', () => {
    const events = extractEvents(
      envelope({
        metadata: METADATA,
        contacts: [{ wa_id: '972501234567', profile: { name: 'ישראל ישראלי' } }],
        messages: [
          {
            id: 'wamid.ABC123',
            from: '972501234567',
            timestamp: '1755331200',
            type: 'text',
            text: { body: 'שלום, אני רוצה למכור דירה' },
          },
        ],
      }),
    );

    expect(events).toHaveLength(1);
    const event = events[0] as InboundMessageEvent;
    expect(event.kind).toBe('message');
    expect(event.providerMessageId).toBe('wamid.ABC123');
    expect(event.from).toBe('972501234567');
    expect(event.profileName).toBe('ישראל ישראלי');
    expect(event.text).toBe('שלום, אני רוצה למכור דירה');
    expect(event.phoneNumberId).toBe('PHONE_ID');
    expect(event.timestamp).toEqual(new Date(1755331200 * 1000));
  });

  // A single request can batch messages from different people. Handling only the
  // first would silently drop real conversations.
  it('extracts every message in a batched request', () => {
    const events = extractEvents(
      envelope({
        metadata: METADATA,
        messages: [
          {
            id: 'wamid.1',
            from: '972501111111',
            timestamp: '1755331200',
            type: 'text',
            text: { body: 'one' },
          },
          {
            id: 'wamid.2',
            from: '972502222222',
            timestamp: '1755331201',
            type: 'text',
            text: { body: 'two' },
          },
        ],
      }),
    );

    expect(events).toHaveLength(2);
    expect(events.map((e) => (e as InboundMessageEvent).text)).toEqual(['one', 'two']);
  });

  // The title is what the person actually saw and chose. The engine should reason
  // about that, not the opaque payload id.
  it('uses the button title as the text of an interactive reply', () => {
    const events = extractEvents(
      envelope({
        metadata: METADATA,
        messages: [
          {
            id: 'wamid.BTN',
            from: '972501234567',
            timestamp: '1755331200',
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: 'btn_ready', title: 'מוכן למכור' },
            },
          },
        ],
      }),
    );

    expect((events[0] as InboundMessageEvent).text).toBe('מוכן למכור');
  });

  it('uses the list reply title', () => {
    const events = extractEvents(
      envelope({
        metadata: METADATA,
        messages: [
          {
            id: 'wamid.LIST',
            from: '972501234567',
            timestamp: '1755331200',
            type: 'interactive',
            interactive: {
              type: 'list_reply',
              list_reply: { id: 'nachal_ashan', title: 'נחל עשן' },
            },
          },
        ],
      }),
    );

    expect((events[0] as InboundMessageEvent).text).toBe('נחל עשן');
  });

  it.each([
    ['image', 'image', { id: 'MEDIA_1', mime_type: 'image/jpeg' }],
    ['audio', 'audio', { id: 'MEDIA_2', mime_type: 'audio/ogg', voice: true }],
    ['video', 'video', { id: 'MEDIA_3', mime_type: 'video/mp4' }],
    ['document', 'document', { id: 'MEDIA_4', mime_type: 'application/pdf' }],
    ['sticker', 'sticker', { id: 'MEDIA_5', mime_type: 'image/webp' }],
  ])('extracts %s media', (_label, type, payload) => {
    const events = extractEvents(
      envelope({
        metadata: METADATA,
        messages: [
          {
            id: `wamid.${type}`,
            from: '972501234567',
            timestamp: '1755331200',
            type,
            [type]: payload,
          },
        ],
      }),
    );

    const event = events[0] as InboundMessageEvent;
    expect(event.media?.kind).toBe(type);
    expect(event.media?.id).toBe(payload.id);
  });

  it('treats a media caption as the message text', () => {
    const events = extractEvents(
      envelope({
        metadata: METADATA,
        messages: [
          {
            id: 'wamid.IMG',
            from: '972501234567',
            timestamp: '1755331200',
            type: 'image',
            image: { id: 'MEDIA_1', mime_type: 'image/jpeg', caption: 'זו הדירה שלי' },
          },
        ],
      }),
    );

    const event = events[0] as InboundMessageEvent;
    expect(event.text).toBe('זו הדירה שלי');
    expect(event.media?.id).toBe('MEDIA_1');
  });

  // Referral data is the only reliable attribution for Click-to-WhatsApp leads
  // and arrives on the first message only.
  it('captures Click-to-WhatsApp referral data', () => {
    const events = extractEvents(
      envelope({
        metadata: METADATA,
        messages: [
          {
            id: 'wamid.CTWA',
            from: '972501234567',
            timestamp: '1755331200',
            type: 'text',
            text: { body: 'היי' },
            referral: {
              source_url: 'https://fb.com/ad/123',
              source_id: 'AD_123',
              source_type: 'ad',
              headline: 'מוכר דירה בבאר שבע?',
              ctwa_clid: 'CLID_XYZ',
            },
          },
        ],
      }),
    );

    const event = events[0] as InboundMessageEvent;
    expect(event.referral).toEqual({
      sourceUrl: 'https://fb.com/ad/123',
      sourceId: 'AD_123',
      sourceType: 'ad',
      headline: 'מוכר דירה בבאר שבע?',
      ctwaClid: 'CLID_XYZ',
    });
  });

  it('extracts delivery status events', () => {
    const events = extractEvents(
      envelope({
        metadata: METADATA,
        statuses: [
          {
            id: 'wamid.SENT',
            status: 'delivered',
            timestamp: '1755331200',
            recipient_id: '972501234567',
          },
        ],
      }),
    );

    expect(events[0]).toMatchObject({
      kind: 'status',
      providerMessageId: 'wamid.SENT',
      status: 'delivered',
      recipientId: '972501234567',
    });
  });

  it('captures the error title on a failed status', () => {
    const events = extractEvents(
      envelope({
        metadata: METADATA,
        statuses: [
          {
            id: 'wamid.FAILED',
            status: 'failed',
            timestamp: '1755331200',
            recipient_id: '972501234567',
            errors: [{ code: 131_047, title: 'Re-engagement message' }],
          },
        ],
      }),
    );

    expect(events[0]).toMatchObject({
      status: 'failed',
      errorTitle: 'Re-engagement message',
    });
  });

  // Meta retries any non-2xx response. Throwing on one odd event would cause the
  // whole batch — including valid messages from real people — to redeliver
  // forever.
  it('skips malformed messages without discarding valid ones', () => {
    const events = extractEvents(
      webhookEnvelopeSchema.parse({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: METADATA,
                  messages: [
                    {
                      id: 'wamid.OK',
                      from: '972501234567',
                      timestamp: '1755331200',
                      type: 'text',
                      text: { body: 'valid' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    expect(events).toHaveLength(1);
    expect((events[0] as InboundMessageEvent).text).toBe('valid');
  });

  it('handles an unknown message type without dropping it', () => {
    const events = extractEvents(
      envelope({
        metadata: METADATA,
        messages: [
          {
            id: 'wamid.NEW',
            from: '972501234567',
            timestamp: '1755331200',
            type: 'some_future_type',
            some_future_type: { data: 'whatever' },
          },
        ],
      }),
    );

    expect(events).toHaveLength(1);
    expect((events[0] as InboundMessageEvent).messageType).toBe('some_future_type');
    expect((events[0] as InboundMessageEvent).text).toBeUndefined();
  });

  it.each([
    ['no entry array', { object: 'whatsapp_business_account' }],
    ['empty entry array', { object: 'whatsapp_business_account', entry: [] }],
    [
      'entry with no changes',
      { object: 'whatsapp_business_account', entry: [{ id: '1' }] },
    ],
    [
      'change with empty value',
      { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {} }] }] },
    ],
  ])('returns no events for %s', (_label, raw) => {
    expect(extractEvents(webhookEnvelopeSchema.parse(raw))).toEqual([]);
  });

  it('falls back to the current time on an unparseable timestamp', () => {
    const before = Date.now();
    const events = extractEvents(
      envelope({
        metadata: METADATA,
        messages: [
          {
            id: 'wamid.BAD',
            from: '972501234567',
            timestamp: 'not-a-number',
            type: 'text',
            text: { body: 'x' },
          },
        ],
      }),
    );

    const timestamp = (events[0] as InboundMessageEvent).timestamp.getTime();
    expect(timestamp).toBeGreaterThanOrEqual(before);
  });
});
