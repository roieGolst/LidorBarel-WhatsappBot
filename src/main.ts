import 'dotenv/config';
import { ConfigError, getConfig } from './config.js';
import { getLogger } from './logger.js';

/**
 * Process entrypoint.
 *
 * At this milestone it validates configuration and starts nothing else. The
 * HTTP server, queues, and conversation workflow are wired in here as later
 * milestones land.
 */
function main(): void {
  let config;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // The logger depends on config, so it is not available yet. This is the
      // one place a direct write to stderr is correct.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const log = getLogger();
  log.info(
    {
      nodeEnv: config.nodeEnv,
      port: config.port,
      timezone: config.timezone,
      node: process.version,
    },
    'configuration loaded',
  );
}

main();
