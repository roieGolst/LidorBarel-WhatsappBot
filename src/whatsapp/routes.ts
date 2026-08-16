import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/client.js';
import { ingestEvents } from './ingest.js';
import { extractEvents, webhookEnvelopeSchema } from './payload.js';
import { isValidSignature, verifySubscription } from './signature.js';

/** A request whose raw body was preserved by the content-type parser. */
interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

export interface WebhookRouteOptions {
  db: Database;
  config: Config;
}

/**
 * Registers the WhatsApp webhook endpoints.
 *
 * `GET /webhooks/whatsapp`  — Meta's subscription handshake.
 * `POST /webhooks/whatsapp` — inbound messages and delivery statuses.
 */
export function registerWhatsAppRoutes(
  app: FastifyInstance,
  { db, config }: WebhookRouteOptions,
): void {
  app.get('/webhooks/whatsapp', (request, reply) => {
    if (!config.metaWebhookVerifyToken) {
      request.log.error('webhook verification attempted but no verify token configured');
      return reply.code(503).send();
    }

    const challenge = verifySubscription(
      request.query as Record<string, unknown>,
      config.metaWebhookVerifyToken,
    );

    if (challenge === undefined) {
      request.log.warn('rejected webhook subscription with invalid token');
      return reply.code(403).send();
    }

    // Meta expects the challenge echoed as plain text, not JSON.
    return reply.type('text/plain').send(challenge);
  });

  app.post('/webhooks/whatsapp', async (request, reply) => {
    const rawBody = (request as RawBodyRequest).rawBody;

    if (!config.metaAppSecret) {
      request.log.error('webhook received but no app secret configured');
      return reply.code(503).send();
    }

    if (
      !rawBody ||
      !isValidSignature(
        rawBody,
        request.headers['x-hub-signature-256'] as string | undefined,
        config.metaAppSecret,
      )
    ) {
      // 403 rather than 401: there is no authentication to retry with, and a
      // forged request must not be told which part was wrong.
      request.log.warn('rejected webhook with invalid signature');
      return reply.code(403).send();
    }

    const parsed = webhookEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      // A 200 is deliberate. The signature was valid, so this really did come
      // from Meta — we simply cannot interpret it. Returning an error would
      // make Meta redeliver a payload we will never understand, forever.
      request.log.warn({ issues: parsed.error.issues }, 'unparseable webhook envelope');
      return reply.code(200).send();
    }

    const events = extractEvents(parsed.data);

    // Processed synchronously, before responding. Ingestion is only database
    // writes and takes milliseconds, and doing it here means a failure returns
    // non-2xx so Meta retries — which is safe because ingestion is idempotent.
    // Responding 200 first and working afterwards would silently lose messages
    // on a crash.
    //
    // Generating replies is NOT done here: an LLM call is far too slow for a
    // webhook and belongs on a queue (M3).
    const results = await ingestEvents(db, events);

    const duplicates = results.filter((r) => r.duplicate).length;
    const skipped = results.filter((r) => r.skipped).length;
    request.log.info(
      {
        events: events.length,
        ingested: results.length - duplicates,
        duplicates,
        skipped,
      },
      'processed webhook',
    );

    return reply.code(200).send();
  });
}
