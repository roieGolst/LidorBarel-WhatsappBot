import 'dotenv/config';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ConfigError, getConfig, type Config } from './config.js';
import { refreshMediaCatalog } from './whatsapp/mediaCatalog.js';
import { closeDatabase, getDatabase } from './db/client.js';
import { getFreshMediaId, saveMediaId } from './db/repositories/mediaUploads.js';
import { createGraphLeadsClient } from './leads/graphLeads.js';
import {
  startOutreachSweeper,
  type OutreachSweeper,
} from './outreach/outreachSweeper.js';
import { INTRO_VIDEO_PATH } from './workflow/interactive.js';
import type { LeadIngestDeps } from './leads/ingestLead.js';
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
import type { WhatsAppChannel } from './whatsapp/channel.js';
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
  /** Shared with the outreach sweeper, so both send through one channel. */
  channel: WhatsAppChannel;
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
    // A durable media-id cache so the intro video uploads once, not per restart.
    const channel = createCloudApiChannel({
      get: (key) => getFreshMediaId(db, key),
      set: (key, mediaId) => saveMediaId(db, key, mediaId),
    });

    checkpointer = createCheckpointer();
    // Idempotent (IF NOT EXISTS); safe on every boot, and this is the caller
    // that owns deciding when.
    await checkpointer.setup();

    queue = createConversationQueue(config.redisUrl);
    worker = createConversationWorker(
      config.redisUrl,
      {
        db,
        llm,
        channel,
        // Scheduling is gated on outreach being enabled: the sweeper is what
        // sends these, so scheduling without it would only accumulate due rows
        // that nothing ever picks up.
        ...(config.outreachEnabled
          ? {
              followUp: {
                limits: {
                  intervalMs: config.followUpIntervalHours * 60 * 60 * 1000,
                  maxFollowUps: config.followUpMaxCount,
                  maxAgeMs: config.followUpMaxDays * 24 * 60 * 60 * 1000,
                },
                timeZone: config.timezone,
              },
            }
          : {}),
      },
      checkpointer,
    );

    return { queue, worker, checkpointer, channel };
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

  // Meta Lead Ads intake. Needs a Page access token with `leads_retrieval`,
  // which is a different credential from the WhatsApp one — so it is built
  // independently of the conversation pipeline and either can be absent.
  const leadsClient = createGraphLeadsClient();
  if (!leadsClient) {
    log.warn('leadgen intake disabled: needs META_PAGE_ACCESS_TOKEN');
  } else {
    // Neither is an error: leads are still captured either way. But both are
    // silent failure modes — "the bot never messages anyone" and "the bot ignores
    // my leads" are hard to diagnose after the fact and trivial to say now.
    if (config.metaLeadConsentForms.length === 0 && !config.metaLeadConsentField) {
      log.warn(
        'leadgen intake enabled, but no consent source is configured — every lead ' +
          'will be recorded as privacy_policy_only and cannot be proactively messaged',
      );
    }
    if (config.metaLeadSellerForms.length === 0) {
      log.warn(
        'leadgen intake enabled, but META_LEAD_SELLER_FORMS is empty — leads will ' +
          'be recorded for attribution and no conversation will be opened',
      );
    }
  }
  const leadIngest: LeadIngestDeps | undefined = leadsClient
    ? {
        leads: leadsClient,
        consent: {
          fieldName: config.metaLeadConsentField,
          expectedValue: config.metaLeadConsentValue,
          consentForms: config.metaLeadConsentForms,
          formConsentText: config.metaLeadConsentText,
        },
        sellerForms: config.metaLeadSellerForms,
      }
    : undefined;

  // Proactive first contact. Off unless explicitly enabled: this is the one
  // subsystem that messages people who have not messaged us, so it must never
  // start merely because credentials happen to be present.
  let outreach: OutreachSweeper | undefined;
  if (!config.outreachEnabled) {
    log.info('proactive outreach disabled (OUTREACH_ENABLED is not "true")');
  } else if (!pipeline) {
    // The template opens the conversation; without a worker, the lead's reply
    // would go unanswered. Opening a conversation we cannot continue is worse
    // than not opening it.
    log.warn(
      'proactive outreach requested but the conversation worker is disabled — ' +
        'not starting it, since replies would go unanswered',
    );
  } else {
    const followUpLimits = {
      intervalMs: config.followUpIntervalHours * 60 * 60 * 1000,
      maxFollowUps: config.followUpMaxCount,
      maxAgeMs: config.followUpMaxDays * 24 * 60 * 60 * 1000,
    };

    if (!config.followUpTemplateName) {
      // The common case is a lead who never answered the opening, so their
      // window is never open and every nudge needs a template. Without one the
      // sequence is effectively inert — worth saying at boot rather than leaving
      // it to be noticed as "follow-ups do nothing".
      log.warn(
        'FOLLOWUP_TEMPLATE_NAME is unset — follow-ups can only reach leads who ' +
          'replied within the last 24 hours; non-responders cannot be nudged',
      );
    }

    outreach = startOutreachSweeper({
      db,
      channel: pipeline.channel,
      template: {
        name: config.outreachTemplateName,
        language: config.outreachTemplateLanguage,
        headerVideoPath: INTRO_VIDEO_PATH,
      },
      followUp: { limits: followUpLimits, timeZone: config.timezone },
      gracePeriodMs: config.outreachGracePeriodMinutes * 60 * 1000,
      intervalMs: config.outreachSweepSeconds * 1000,
      batchSize: config.outreachBatchSize,
      timeZone: config.timezone,
      followUpLimits,
      ...(config.followUpTemplateName
        ? {
            followUpTemplate: {
              name: config.followUpTemplateName,
              language: config.followUpTemplateLanguage,
            },
          }
        : {}),
    });
    log.info(
      {
        template: config.outreachTemplateName,
        graceMinutes: config.outreachGracePeriodMinutes,
      },
      'proactive outreach enabled',
    );
  }

  const app = buildServer({
    db,
    config,
    ...(pipeline ? { producer: pipeline.queue } : {}),
    ...(leadIngest ? { leadIngest } : {}),
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
        // Stopped before the worker and the database: a sweep in flight would
        // otherwise try to send through a closing channel.
        outreach?.stop();
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

  // Catalog the testimonial/promo videos in the background — after the server is
  // listening, so it never delays serving conversations. Metadata only; the
  // channel uploads a video's bytes to Meta lazily on first send. Failure is
  // logged, not fatal.
  void refreshMediaCatalog(db, 'assets', log).catch((err: unknown) => {
    log.error({ err }, 'media catalog scan failed');
  });

  log.info(
    {
      port: config.port,
      nodeEnv: config.nodeEnv,
      timezone: config.timezone,
      whatsappConfigured: Boolean(config.metaAppSecret && config.metaAccessToken),
      conversationWorker: pipeline ? 'enabled' : 'disabled',
      leadgenIntake: leadIngest ? 'enabled' : 'disabled',
      proactiveOutreach: outreach ? 'enabled' : 'disabled',
    },
    'server started',
  );
}

main().catch((error: unknown) => {
  getLogger().fatal({ err: error }, 'failed to start');
  process.exit(1);
});
