import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildLoggerOptions } from './logger.js';

/** A pino destination that keeps what was written. */
function capture(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, lines: () => chunks.join('').trim().split('\n') };
}

describe('logger redaction — "transcripts and phone numbers never reach logs"', () => {
  it('redacts message bodies, texts, phone numbers and recipients, at any depth', () => {
    const { stream, lines } = capture();
    const logger = pino({ ...buildLoggerOptions(), level: 'info' }, stream);

    logger.info(
      {
        phone: '+972501234567',
        to: '+972501234567',
        body: 'אני רוצה למכור את הדירה ברגר 15',
        text: 'הודעה',
        nested: {
          phone: '+972501234567',
          body: 'תוכן',
          text: 'עוד',
          to: '+972501234567',
        },
        conversationId: 'keep-me',
      },
      'a turn',
    );

    const [line] = lines();
    expect(line).toBeDefined();
    expect(line).not.toContain('972501234567');
    expect(line).not.toContain('רגר');
    expect(line).not.toContain('תוכן');
    expect(line).toContain('[redacted]');
    // Operational identifiers are kept — redaction is targeted, not blanket.
    expect(line).toContain('keep-me');
  });
});
