import { z } from 'zod';

/**
 * Application configuration, validated once at startup.
 *
 * Two rules this module exists to enforce:
 *
 *  1. The process fails fast and loudly on missing or malformed configuration,
 *     rather than throwing at 2am the first time a code path runs.
 *  2. Configuration values never appear in error output. Several of these are
 *     secrets, and a validation error is a very easy way to leak one into a log
 *     aggregator. Errors report the variable name and the reason only.
 *
 * Later milestones add their own sections (Meta Cloud API, Monday.com, Google
 * Calendar, Anthropic) to this same schema.
 */
const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),

  /** Port for the HTTP server (webhooks + admin API). */
  port: z.coerce.number().int().min(1).max(65_535).default(3000),

  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * IANA timezone for all business-hours logic.
   *
   * The bot's working hours, Shabbat handling, and follow-up scheduling are all
   * defined in Israel local time by the specification. Server clocks are UTC,
   * so this must be explicit rather than inherited from the host.
   */
  timezone: z.string().min(1).default('Asia/Jerusalem'),

  /** PostgreSQL connection string — the system's source of truth. */
  databaseUrl: z.url({ protocol: /^postgres(ql)?$/ }),

  /** Redis connection string — BullMQ queues only, never authoritative state. */
  redisUrl: z.url({ protocol: /^rediss?$/ }),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Maps process environment variables onto the schema.
 *
 * Kept separate from {@link parseConfig} so the mapping is visible in one place
 * and stays in sync with `.env.example`.
 */
function readEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    timezone: env.APP_TIMEZONE,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
  };
}

/** Environment variable name for a config field, for use in error messages. */
const ENV_VAR_NAMES: Record<keyof Config, string> = {
  nodeEnv: 'NODE_ENV',
  port: 'PORT',
  logLevel: 'LOG_LEVEL',
  timezone: 'APP_TIMEZONE',
  databaseUrl: 'DATABASE_URL',
  redisUrl: 'REDIS_URL',
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\n` +
        'See .env.example for the required variables.',
    );
    this.name = 'ConfigError';
  }
}

/**
 * Validates configuration from an environment object.
 *
 * Exported separately from {@link getConfig} so tests can exercise it without
 * mutating `process.env`.
 *
 * @throws {ConfigError} listing every problem found, with no values included.
 */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = configSchema.safeParse(readEnv(env));

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const field = issue.path[0];
      const name =
        typeof field === 'string' && field in ENV_VAR_NAMES
          ? ENV_VAR_NAMES[field as keyof Config]
          : String(field ?? 'unknown');
      return `${name}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }

  return result.data;
}

let cached: Config | undefined;

/**
 * Returns the validated configuration, parsing it on first call.
 *
 * Lazy rather than module-level so that importing this file has no side effects
 * and import order cannot cause a spurious startup failure.
 */
export function getConfig(): Config {
  cached ??= parseConfig(process.env);
  return cached;
}

/** Test-only. Clears the memoized config so a fresh environment can be parsed. */
export function resetConfigForTesting(): void {
  cached = undefined;
}
