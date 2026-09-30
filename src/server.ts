import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import type { LeadIngestDeps } from './leads/ingestLead.js';
import type { TurnProducer } from './queue/conversationQueue.js';
import { buildLoggerOptions } from './logger.js';
import { registerDebugRoutes } from './admin/debugRoutes.js';
import type { DeliveryGate } from './whatsapp/deliveryGate.js';
import { registerWhatsAppRoutes } from './whatsapp/routes.js';

export interface ServerOptions {
  db: Database;
  config: Config;
  /**
   * Producer the webhook uses to enqueue conversation turns. Optional so the
   * server boots (and tests run) without a live queue; absent, inbound messages
   * are still ingested but no reply is triggered.
   */
  producer?: TurnProducer;
  /**
   * Meta Lead Ads intake. Optional so the server boots without a Page access
   * token; absent, the leadgen webhook fails closed rather than discarding leads.
   */
  leadIngest?: LeadIngestDeps;
  /**
   * Shared with the conversation worker: the webhook reports delivery statuses
   * to it so a turn can keep its messages in order behind a video.
   */
  deliveryGate?: DeliveryGate;
}

/**
 * `public/privacy.html`, read once at startup. Next to `dist/` in the image
 * (see the Dockerfile) and next to `src/` in development — the same relative
 * path from this module either way.
 */
const PRIVACY_PAGE = readFileSync(
  new URL('../public/privacy.html', import.meta.url),
  'utf8',
);

/**
 * Builds the HTTP server.
 *
 * Returned unstarted so tests can drive it through `app.inject()` without
 * binding a port.
 */
export function buildServer({
  db,
  config,
  producer,
  leadIngest,
  deliveryGate,
}: ServerOptions): FastifyInstance {
  const app = Fastify({
    // Options rather than an instance, so Fastify builds its own child logger
    // while keeping the same redaction rules.
    logger: buildLoggerOptions(),
    // Meta's signature covers the exact bytes it sent, so the raw body must
    // survive to the route handler.
    bodyLimit: 1024 * 1024,
    // Requests come from Meta with no client-supplied request id worth trusting.
    genReqId: () => crypto.randomUUID(),
  });

  // Fastify parses JSON and discards the raw bytes. The webhook signature is
  // computed over those exact bytes — key order, whitespace and unicode
  // escaping included — so re-serializing the parsed object would never match.
  // This parser keeps both.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      (request as { rawBody?: Buffer }).rawBody = body;
      try {
        done(null, body.length === 0 ? {} : JSON.parse(body.toString('utf8')));
      } catch {
        // Surfaced as a 400 by Fastify. The webhook route separately returns
        // 200 for bodies that are valid JSON but an unrecognised shape.
        done(new Error('invalid JSON'), undefined);
      }
    },
  );

  // The privacy policy and data-deletion instructions Meta requires of a Live
  // app (App Dashboard → Settings → Basic). Static, public, no database: they
  // must stay up even when nothing else does, and they are read by people, so
  // they live in `public/` as plain HTML rather than in code.
  app.get('/privacy', (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(PRIVACY_PAGE),
  );
  app.get('/privacy-policy', (_request, reply) => reply.redirect('/privacy', 301));
  app.get('/data-deletion', (_request, reply) =>
    reply.redirect('/privacy#deletion', 302),
  );

  app.get('/health', async () => {
    // Touches the database so the check fails when the dependency the whole
    // system relies on is unreachable, rather than only when the process dies.
    await db.execute('SELECT 1');
    return { status: 'ok' };
  });

  registerWhatsAppRoutes(app, {
    db,
    config,
    ...(producer ? { producer } : {}),
    ...(leadIngest ? { leadIngest } : {}),
    ...(deliveryGate ? { deliveryGate } : {}),
  });

  // A development-only window into a lead's full state (facts, qualification,
  // transition history). Never registered in production, so a WhatsApp customer
  // can never reach it.
  if (config.nodeEnv !== 'production') {
    registerDebugRoutes(app, { db });
  }

  return app;
}
