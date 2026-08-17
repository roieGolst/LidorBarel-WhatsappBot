import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import type { TurnProducer } from './queue/conversationQueue.js';
import { buildLoggerOptions } from './logger.js';
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
}

/**
 * Builds the HTTP server.
 *
 * Returned unstarted so tests can drive it through `app.inject()` without
 * binding a port.
 */
export function buildServer({ db, config, producer }: ServerOptions): FastifyInstance {
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

  app.get('/health', async () => {
    // Touches the database so the check fails when the dependency the whole
    // system relies on is unreachable, rather than only when the process dies.
    await db.execute('SELECT 1');
    return { status: 'ok' };
  });

  registerWhatsAppRoutes(app, { db, config, ...(producer ? { producer } : {}) });

  return app;
}
