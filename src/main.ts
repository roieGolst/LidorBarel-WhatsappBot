import 'dotenv/config';
import { ConfigError, getConfig, type Config } from './config.js';
import { closeDatabase, getDatabase } from './db/client.js';
import { getLogger } from './logger.js';
import { buildServer } from './server.js';

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

async function main(): Promise<void> {
  const config = loadConfig();
  const log = getLogger();
  const db = getDatabase();
  const app = buildServer({ db, config });

  /**
   * Stops accepting connections, finishes in-flight requests, then closes the
   * database.
   *
   * Order matters: a webhook being ingested when the signal arrives must be
   * allowed to commit. Dropping it mid-transaction would rely on Meta's retry
   * to recover a message we had already accepted.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    void (async () => {
      try {
        await app.close();
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
    },
    'server started',
  );
}

main().catch((error: unknown) => {
  getLogger().fatal({ err: error }, 'failed to start');
  process.exit(1);
});
