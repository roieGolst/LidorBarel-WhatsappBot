import pino from 'pino';
import { getConfig } from './config.js';

/**
 * Application logger.
 *
 * Conversation transcripts and contact details are personal data, so message
 * bodies and phone numbers are redacted by default. Anything that needs to see
 * a transcript reads it from the database through the admin panel, where access
 * is authenticated and auditable — not from log output.
 */
function createLogger(): pino.Logger {
  const config = getConfig();
  const isDevelopment = config.nodeEnv === 'development';

  return pino({
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
    ...(isDevelopment
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  });
}

let cached: pino.Logger | undefined;

/** Returns the shared logger, creating it on first use. */
export function getLogger(): pino.Logger {
  cached ??= createLogger();
  return cached;
}
