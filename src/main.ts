import 'dotenv/config';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ConfigError, getConfig, type Config } from './config.js';
import { closeDatabase, getDatabase } from './db/client.js';
import { AnthropicLlmClient } from './llm/client.js';
import { getLogger } from './logger.js';
import {
  createConversationQueue,
  type ConversationQueue,
} from './queue/conversationQueue.js';
import {
  createConversationWorker,
  type ConversationWorker,
} from './queue/conversationWorker.js';
import { buildServer } from './server.js';
import { createCheckpointer } from './workflow/checkpointer.js';
import { createCloudApiChannel } from './whatsapp/cloudApiChannel.js';

/** Loads configuration, reporting problems clearly before the logger exists. */
function loadConfig(): Config {
  try {
    return getConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // The logger depends on config, so it is not available yet. This is the
      // one place a direct write to stderr is correct.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

/** The queue-side resources, present only when the worker could be built. */
interface ConversationPipeline {
  queue: ConversationQueue;
  worker: ConversationWorker;
  checkpointer: PostgresSaver;
}

/**
 * Builds the conversation pipeline — checkpointer, queue, and worker — or
 * returns `undefined` when it cannot.
 *
 * The Meta and Anthropic credentials are optional as a group (see `config.ts`)
 * so the app boots for local development and tests against fakes. When they are
 * absent the reply worker simply cannot exist: there is no LLM to think with and
 * no transport to send through. Rather than crash, the app logs a clear warning
 * and runs webhook ingestion only — inbound messages are still stored durably,
 * they just are not answered until credentials are supplied and the process is
 * restarted.
 *
 * The queue is created *together with* the worker rather than always: with no
 * worker to drain it, enqueuing would only pile unconsumed jobs into Redis. So a
 * credential-less boot ingests without enqueuing, which is exactly what the
 * webhook route's optional producer expresses.
 */
async function buildConversationPipeline(
  config: Config,
  db: ReturnType<typeof getDatabase>,
  log: ReturnType<typeof getLogger>,
): Promise<ConversationPipeline | undefined> {
  // The reply worker needs a transport to send through and a model to think
  // with. Meta credentials supply the first; the Anthropic key supplies the
  // second. Missing either, the app runs ingestion-only rather than crashing —
  // inbound messages are still stored durably, just not answered until a restart
  // with the config in place.
  if (!config.metaAccessToken || !config.metaPhoneNumberId || !config.anthropicApiKey) {
    log.warn(
      'conversation worker disabled: needs Meta credentials plus ANTHROPIC_API_KEY',
    );
    return undefined;
  }

  let checkpointer: PostgresSaver | undefined;
  let queue: ConversationQueue | undefined;
  let worker: ConversationWorker | undefined;
  try {
    // Guaranteed by the guard above: the Anthropic key is present.
    const llm = new AnthropicLlmClient(config.anthropicApiKey);
    const channel = createCloudApiChannel();

    checkpointer = createCheckpointer();
    // Idempotent (IF NOT EXISTS); safe on every boot, and this is the caller
    // that owns deciding when.
    await checkpointer.setup();

    queue = createConversationQueue(config.redisUrl);
    worker = createConversationWorker(
      config.redisUrl,
      { db, llm, channel },
      checkpointer,
    );

    return { queue, worker, checkpointer };
  } catch (error) {
    // A partial build must not leak connections. Anything constructed before the
    // failure is torn down before we fall back to ingestion-only.
    log.warn({ err: error }, 'conversation worker disabled: failed to construct');
    if (worker) await worker.close();
    if (queue) await queue.close();
    if (checkpointer) await checkpointer.end();
    return undefined;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = getLogger();
  const db = getDatabase();

  const pipeline = await buildConversationPipeline(config, db, log);
  const app = buildServer({
    db,
    config,
    ...(pipeline ? { producer: pipeline.queue } : {}),
  });

  /**
   * Stops accepting connections, finishes in-flight work, then releases
   * resources.
   *
   * Order matters. The server closes first so no new webhook can enqueue. The
   * worker closes next and drains the turn it is mid-flight on — that turn still
   * needs the checkpointer and the database — so those are released only after
   * the worker has stopped. A webhook being ingested when the signal arrives is
   * likewise allowed to commit before the database closes; dropping it
   * mid-transaction would rely on Meta's retry to recover a message we had
   * already accepted.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    void (async () => {
      try {
        await app.close();
        if (pipeline) {
          await pipeline.worker.close();
          await pipeline.queue.close();
          await pipeline.checkpointer.end();
        }
        await closeDatabase();
        log.info('shutdown complete');
        process.exit(0);
      } catch (error) {
        log.error({ err: error }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unhandled rejection has left the process in an unknown state. Exiting
  // lets the supervisor restart it cleanly rather than continuing to serve
  // webhooks from a process that may no longer be sound.
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });

  log.info(
    {
      port: config.port,
      nodeEnv: config.nodeEnv,
      timezone: config.timezone,
      whatsappConfigured: Boolean(config.metaAppSecret && config.metaAccessToken),
      conversationWorker: pipeline ? 'enabled' : 'disabled',
    },
    'server started',
  );
}

main().catch((error: unknown) => {
  getLogger().fatal({ err: error }, 'failed to start');
  process.exit(1);
});
