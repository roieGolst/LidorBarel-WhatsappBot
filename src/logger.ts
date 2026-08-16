import pino from 'pino';
import { getConfig } from './config.js';

/**
 * Builds shared pino options.
 *
 * Conversation transcripts and contact details are personal data. Message
 * bodies and phone numbers are redacted by default; anything that needs to read
 * a transcript does so through the authenticated admin panel, where access is
 * auditable — not from log output.
 *
 * Exported as options rather than only as an instance so Fastify can build its
 * own logger with identical redaction. Request logging is where a phone number
 * is most likely to leak.
 */
export function buildLoggerOptions(): pino.LoggerOptions {
  const config = getConfig();

  return {
    level: config.logLevel,
    redact: {
      paths: [
        'body',
        '*.body',
        'phone',
        '*.phone',
        'to',
        '*.to',
        'text',
        '*.text',
        'req.headers.authorization',
        'req.headers["x-hub-signature-256"]',
      ],
      censor: '[redacted]',
    },
    ...(config.nodeEnv === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  };
}

let cached: pino.Logger | undefined;

/** Returns the shared logger for code outside the HTTP request lifecycle. */
export function getLogger(): pino.Logger {
  cached ??= pino(buildLoggerOptions());
  return cached;
}
