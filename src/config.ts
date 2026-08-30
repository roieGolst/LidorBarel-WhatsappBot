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
 * Later phases add their own sections (Monday.com, Google Calendar) to this
 * same schema.
 */
/**
 * A comma-separated environment list, parsed into trimmed non-empty entries.
 *
 * Absent and empty both yield `[]`, so a variable that is present-but-blank
 * behaves identically to one that is unset — the safe reading for an allowlist.
 */
const commaSeparated = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

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

  // --- Meta WhatsApp Cloud API ---------------------------------------------
  //
  // Optional as a group: the app runs without them so the conversation workflow
  // can be developed and tested against a fake transport. `assertWhatsAppConfig`
  // turns a missing value into a clear failure at the point of use instead of a
  // confusing 401 from Meta.

  /** App secret, used to verify the X-Hub-Signature-256 header on webhooks. */
  metaAppSecret: z.string().min(1).optional(),

  /**
   * Shared secret echoed during Meta's webhook subscription handshake.
   * Chosen by us, not issued by Meta.
   */
  metaWebhookVerifyToken: z.string().min(1).optional(),

  /** Long-lived access token for the WhatsApp Business Account. */
  metaAccessToken: z.string().min(1).optional(),

  /** Phone number id of the bot's WhatsApp number (not the number itself). */
  metaPhoneNumberId: z.string().min(1).optional(),

  /** Graph API version, e.g. `v21.0`. Pinned so Meta cannot change it under us. */
  metaGraphApiVersion: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v21.0'),

  // --- Meta Lead Ads (leadgen intake) ---------------------------------------
  //
  // Separate from the WhatsApp credentials above: retrieving a lead's answers
  // needs a **Page** access token carrying `leads_retrieval`, which the WhatsApp
  // Business Account token does not have. Optional, so the app boots without it;
  // the leadgen webhook then fails closed rather than ACKing leads it cannot store.

  /** Page access token with `leads_retrieval`, for fetching a lead by `leadgen_id`. */
  metaPageAccessToken: z.string().min(1).optional(),

  /**
   * Lead form ids whose leads enter the **seller** qualification flow.
   *
   * The Page runs investor and recruitment campaigns alongside the seller ones.
   * Leads from those are recorded for attribution but never engaged — a flow that
   * asks which neighbourhood your property is in makes no sense for someone who
   * answered a question about their investment budget. Empty engages nothing.
   */
  metaLeadSellerForms: commaSeparated,

  /**
   * Lead form ids whose submission constitutes WhatsApp opt-in, because the form
   * carries a **required** consent checkbox naming WhatsApp and the business.
   *
   * Needed because Meta does not return privacy-step disclaimer checkboxes in a
   * lead's `field_data`, even when required — so per-lead detection alone would
   * mean no lead is ever contactable. Sound because the checkbox cannot be
   * skipped and is not pre-checked, and because Meta forms are immutable: a form
   * id permanently identifies the exact wording agreed to.
   *
   * **Only list a form you have verified carries such a checkbox.** Unlisted
   * forms stay `privacy_policy_only` and cannot be proactively messaged (NN-2).
   */
  metaLeadConsentForms: commaSeparated,

  /** The consent wording to record as evidence for form-level consent. */
  metaLeadConsentText: z.string().min(1).optional(),

  /**
   * The `field_data` key holding a per-lead WhatsApp opt-in answer, for a form
   * that asks consent as an ordinary question rather than a disclaimer checkbox.
   * Stronger evidence than the form-level rule, and takes precedence over it.
   */
  metaLeadConsentField: z.string().min(1).optional(),

  /**
   * The exact answer that counts as consent, when the form's checkbox echoes its
   * label back rather than a boolean. Unset means the usual affirmative values
   * are accepted.
   */
  metaLeadConsentValue: z.string().min(1).optional(),

  // --- Proactive outreach (business-initiated first contact) ------------------

  /**
   * Master switch for proactive outreach. **Defaults to off.**
   *
   * This is the one subsystem that messages people who have not messaged us, so
   * it does not turn itself on by having credentials present. Enabling it is a
   * deliberate act, taken once Meta Business verification is complete and the
   * consent configuration has been checked.
   */
  outreachEnabled: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /** The approved template used to open a conversation. */
  outreachTemplateName: z.string().min(1).default('welcome_message'),

  /** Its approved language code. Must match the approval exactly. */
  outreachTemplateLanguage: z.string().min(1).default('he'),

  /**
   * How long to leave a new lead alone before reaching out.
   *
   * The grace period exists so the bot does not talk over someone already
   * opening the chat themselves after submitting the form.
   */
  outreachGracePeriodMinutes: z.coerce.number().int().min(0).max(1440).default(20),

  /** How often to look for leads whose grace period has elapsed. */
  outreachSweepSeconds: z.coerce.number().int().min(10).max(3600).default(60),

  /** Most leads contacted per sweep, so a campaign spike is spread out. */
  outreachBatchSize: z.coerce.number().int().min(1).max(500).default(25),

  /**
   * Gap between follow-ups. The specification says one day apart; shortening it
   * for a test is fine, but the five-day cap below still bounds the sequence.
   */
  followUpIntervalHours: z.coerce.number().min(0.01).max(168).default(24),

  /** Most follow-ups ever sent to one lead (NN-3). */
  followUpMaxCount: z.coerce.number().int().min(0).max(10).default(5),

  /** Longest a follow-up sequence may run, from first contact (NN-3). */
  followUpMaxDays: z.coerce.number().min(0.01).max(30).default(5),

  /**
   * Approved template for nudging **outside** the 24-hour window.
   *
   * A lead who never answered the opening template has no window at all, so
   * without this no follow-up can reach them. Unset means out-of-window nudges
   * are skipped rather than sent as something Meta would reject.
   */
  followUpTemplateName: z.string().min(1).optional(),

  /**
   * Approved template for nudging someone who **started** answering and went
   * quiet, once their window has closed.
   *
   * Separate from {@link followUpTemplateName} because the words differ: a lead
   * mid-qualification has not forgotten who we are, and thanking them for
   * leaving details would read as though we had lost track. Template wording is
   * fixed at approval, so this needs its own approval rather than a variable.
   */
  followUpIncompleteTemplateName: z.string().min(1).optional(),

  /** Language code for both follow-up templates. */
  followUpTemplateLanguage: z.string().min(1).default('he'),

  // --- Monday.com (CRM projection) -------------------------------------------
  //
  // Optional: without a token the outbox simply holds events until one appears.
  // Nothing is lost — Postgres is the source of truth and the board is rebuilt
  // from it (rule NN-4).

  /** API token for the Monday account. Never logged. */
  mondayApiToken: z.string().min(1).optional(),

  /** Pinned API version, so Monday cannot change the schema under us. */
  mondayApiVersion: z.string().min(1).default('2024-10'),

  /** How often to drain the outbox into Monday. */
  outboxIntervalSeconds: z.coerce.number().int().min(1).max(3600).default(10),

  /** Events claimed per drain. */
  outboxBatchSize: z.coerce.number().int().min(1).max(500).default(50),

  /** Delivery attempts before an event is parked as failed for inspection. */
  outboxMaxAttempts: z.coerce.number().int().min(1).max(50).default(8),

  // --- Anthropic (LLM) ------------------------------------------------------
  //
  // Optional as a group so the app still boots for tests and simulation, which
  // drive the conversation workflow through a fake LLM client. The workflow
  // throws a clear error at the point it first needs the key, rather than
  // letting a missing value surface as a confusing 401 from Anthropic.

  /** API key for the Anthropic Messages API used by the conversation workflow. */
  anthropicApiKey: z.string().min(1).optional(),
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
    metaAppSecret: env.META_APP_SECRET,
    metaWebhookVerifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    metaAccessToken: env.META_ACCESS_TOKEN,
    metaPhoneNumberId: env.META_PHONE_NUMBER_ID,
    metaGraphApiVersion: env.META_GRAPH_API_VERSION,
    metaPageAccessToken: env.META_PAGE_ACCESS_TOKEN,
    metaLeadSellerForms: env.META_LEAD_SELLER_FORMS,
    metaLeadConsentForms: env.META_LEAD_CONSENT_FORMS,
    metaLeadConsentText: env.META_LEAD_CONSENT_TEXT,
    metaLeadConsentField: env.META_LEAD_CONSENT_FIELD,
    metaLeadConsentValue: env.META_LEAD_CONSENT_VALUE,
    outreachEnabled: env.OUTREACH_ENABLED,
    outreachTemplateName: env.OUTREACH_TEMPLATE_NAME,
    outreachTemplateLanguage: env.OUTREACH_TEMPLATE_LANGUAGE,
    outreachGracePeriodMinutes: env.OUTREACH_GRACE_PERIOD_MINUTES,
    outreachSweepSeconds: env.OUTREACH_SWEEP_SECONDS,
    outreachBatchSize: env.OUTREACH_BATCH_SIZE,
    followUpIntervalHours: env.FOLLOWUP_INTERVAL_HOURS,
    followUpMaxCount: env.FOLLOWUP_MAX_COUNT,
    followUpMaxDays: env.FOLLOWUP_MAX_DAYS,
    followUpTemplateName: env.FOLLOWUP_TEMPLATE_NAME,
    followUpIncompleteTemplateName: env.FOLLOWUP_INCOMPLETE_TEMPLATE_NAME,
    followUpTemplateLanguage: env.FOLLOWUP_TEMPLATE_LANGUAGE,
    mondayApiToken: env.MONDAY_API_TOKEN,
    mondayApiVersion: env.MONDAY_API_VERSION,
    outboxIntervalSeconds: env.OUTBOX_INTERVAL_SECONDS,
    outboxBatchSize: env.OUTBOX_BATCH_SIZE,
    outboxMaxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
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
  metaAppSecret: 'META_APP_SECRET',
  metaWebhookVerifyToken: 'META_WEBHOOK_VERIFY_TOKEN',
  metaAccessToken: 'META_ACCESS_TOKEN',
  metaPhoneNumberId: 'META_PHONE_NUMBER_ID',
  metaGraphApiVersion: 'META_GRAPH_API_VERSION',
  metaPageAccessToken: 'META_PAGE_ACCESS_TOKEN',
  metaLeadSellerForms: 'META_LEAD_SELLER_FORMS',
  metaLeadConsentForms: 'META_LEAD_CONSENT_FORMS',
  metaLeadConsentText: 'META_LEAD_CONSENT_TEXT',
  metaLeadConsentField: 'META_LEAD_CONSENT_FIELD',
  metaLeadConsentValue: 'META_LEAD_CONSENT_VALUE',
  outreachEnabled: 'OUTREACH_ENABLED',
  outreachTemplateName: 'OUTREACH_TEMPLATE_NAME',
  outreachTemplateLanguage: 'OUTREACH_TEMPLATE_LANGUAGE',
  outreachGracePeriodMinutes: 'OUTREACH_GRACE_PERIOD_MINUTES',
  outreachSweepSeconds: 'OUTREACH_SWEEP_SECONDS',
  outreachBatchSize: 'OUTREACH_BATCH_SIZE',
  followUpIntervalHours: 'FOLLOWUP_INTERVAL_HOURS',
  followUpMaxCount: 'FOLLOWUP_MAX_COUNT',
  followUpMaxDays: 'FOLLOWUP_MAX_DAYS',
  followUpTemplateName: 'FOLLOWUP_TEMPLATE_NAME',
  followUpIncompleteTemplateName: 'FOLLOWUP_INCOMPLETE_TEMPLATE_NAME',
  followUpTemplateLanguage: 'FOLLOWUP_TEMPLATE_LANGUAGE',
  mondayApiToken: 'MONDAY_API_TOKEN',
  mondayApiVersion: 'MONDAY_API_VERSION',
  outboxIntervalSeconds: 'OUTBOX_INTERVAL_SECONDS',
  outboxBatchSize: 'OUTBOX_BATCH_SIZE',
  outboxMaxAttempts: 'OUTBOX_MAX_ATTEMPTS',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
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
