import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * PostgreSQL is the source of truth for the entire system.
 *
 * Monday.com is a projection of these tables, kept in sync through the outbox.
 * The projection can be rebuilt from here at any time; the reverse is never
 * relied on. LangGraph's checkpoints live in a separate `langgraph` schema and
 * hold workflow execution state only — never business facts.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * How much consent we hold for a contact.
 *
 * This gates proactive (business-initiated) messaging. The live Meta lead form
 * currently collects only a Privacy Policy checkbox, which is very likely
 * insufficient under both Meta's opt-in policy and Israeli Amendment 40 — so
 * those leads are recorded as `privacy_policy_only` and the send path refuses
 * them. Replying to someone who messaged us first is always allowed.
 */
export const consentStatus = pgEnum('consent_status', [
  /** Told us nothing. Inbound replies only. */
  'none',
  /** Accepted a generic privacy policy. NOT sufficient for proactive messaging. */
  'privacy_policy_only',
  /** Explicitly agreed to receive WhatsApp messages from this business. */
  'whatsapp_opt_in',
  /** Asked us to stop. Terminal until explicit re-opt-in. */
  'opted_out',
]);

/** Where a contact came from. Mirrors Lidor's `מקור הליד` column. */
export const entryPoint = pgEnum('entry_point', [
  'meta_lead_form',
  'click_to_whatsapp',
  'direct_message',
  'website',
  'referral',
  'manual',
]);

/**
 * Conversation stage.
 *
 * Owned exclusively by application code. The LLM returns structured JSON and
 * never writes this column — a hallucinated stage is structurally impossible.
 *
 * Screening branches on the lead's origin (spec §3): a Meta-lead-form lead has
 * Q1 (intent) and Q3 (timeline) pre-answered, so the bot only screens on Q2
 * (neighborhood) and Q4 (currently marketed). A lead who messaged directly is
 * screened on all four, so `screening_sell_intent` (Q1) and `screening_timeline`
 * (Q3) exist for that path.
 */
export const conversationStage = pgEnum('conversation_stage', [
  'new',
  'awaiting_first_contact',
  'engaged',
  'screening_sell_intent',
  'screening_neighborhood',
  'screening_timeline',
  'screening_currently_marketed',
  'qualified',
  'disqualified',
  'appointment_proposed',
  'appointment_pending',
  'appointment_confirmed',
  'handed_off',
  'awaiting_reply',
  'closed_no_response',
  'opted_out',
  'error',
]);

/** Why a conversation was disqualified. Maps onto the spec's stated rules only. */
export const disqualificationReason = pgEnum('disqualification_reason', [
  'not_selling',
  'no_urgency',
  'exclusive_with_other_agent',
  'uncooperative',
]);

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);

/** Delivery lifecycle for an outbound message, as reported by Meta webhooks. */
export const deliveryStatus = pgEnum('delivery_status', [
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
]);

export const appointmentStatus = pgEnum('appointment_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
]);

export const outboxStatus = pgEnum('outbox_status', [
  'pending',
  'processing',
  'delivered',
  'failed',
]);

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** E.164, the system-wide identity for a person. See domain/phone.ts. */
    phone: text('phone').notNull(),

    name: text('name'),
    email: text('email'),

    /**
     * Hebrew conjugates by gender, so the bot needs this to write correctly.
     * Null means "not yet known" and the bot stays gender-neutral rather than
     * guessing. Mirrors Lidor's `מין` column.
     */
    gender: text('gender'),

    consentStatus: consentStatus('consent_status').notNull().default('none'),
    /** Where consent came from, e.g. a Meta form id. */
    consentSource: text('consent_source'),
    /** Exact consent text shown, retained as proof for the audit trail. */
    consentText: text('consent_text'),
    consentRecordedAt: timestamp('consent_recorded_at', { withTimezone: true }),

    entryPoint: entryPoint('entry_point'),

    /**
     * Denormalized opt-out flag for fast pre-send checks. The `optOuts` table is
     * the durable record; this mirrors it so the hot path is a single lookup.
     */
    doNotContact: boolean('do_not_contact').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One contact per phone number. This is the constraint that prevents
    // duplicate leads when the same person arrives via form and WhatsApp.
    uniqueIndex('contacts_phone_unique').on(table.phone),
    index('contacts_do_not_contact_idx').on(table.doNotContact),
  ],
);

// ---------------------------------------------------------------------------
// Properties and listings
// ---------------------------------------------------------------------------

/**
 * A physical property.
 *
 * Separate from `contacts` because one owner may discuss several properties,
 * and separate from `listings` because the same property may be listed more
 * than once over time — relisting is itself a strong selling signal.
 */
export const properties = pgTable(
  'properties',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Lowercased, whitespace-collapsed address used solely for deduplication. */
    normalizedAddress: text('normalized_address'),

    street: text('street'),
    neighborhood: text('neighborhood'),
    city: text('city').default('באר שבע'),

    propertyType: text('property_type'),
    rooms: numeric('rooms'),
    sizeSqm: integer('size_sqm'),
    floor: integer('floor'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('properties_normalized_address_idx').on(table.normalizedAddress)],
);

/**
 * A property as presented in one engagement, with its provenance.
 *
 * Populated from the conversation and from lead-form data rather than scraped,
 * but the provenance columns are kept so any claim about a property is
 * traceable to where it came from.
 */
export const listings = pgTable(
  'listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),

    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    externalListingId: text('external_listing_id'),

    listingDate: timestamp('listing_date', { withTimezone: true }),
    askingPrice: numeric('asking_price'),
    status: text('status'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),

    /** Original payload, retained so re-parsing never needs the source again. */
    rawPayload: jsonb('raw_payload'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Re-importing the same external listing updates rather than duplicates.
    uniqueIndex('listings_source_external_id_unique').on(
      table.source,
      table.externalListingId,
    ),
    index('listings_contact_idx').on(table.contactId),
    index('listings_property_idx').on(table.propertyId),
  ],
);

// ---------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** Nullable: a lead may arrive before any property is identified. */
    listingId: uuid('listing_id').references(() => listings.id, { onDelete: 'set null' }),

    stage: conversationStage('stage').notNull().default('new'),

    /**
     * Qualification is a boolean derived from the specification's stated rules
     * and is the source of truth. Null means "not yet determined".
     */
    qualified: boolean('qualified'),
    disqualificationReason: disqualificationReason('disqualification_reason'),

    /**
     * Reserved for prioritizing Lidor's queue. Deliberately unpopulated in V1 —
     * no scoring formula ships without Lidor's explicit approval, and it must
     * never gate qualification.
     */
    priorityScore: integer('priority_score'),

    /**
     * Screening answers and anything else extracted from the conversation.
     * Q1/Q3 are pre-filled from the lead form; Q2/Q4 come from the bot.
     */
    extracted: jsonb('extracted').notNull().default({}),

    /**
     * When the 24-hour customer service window closes. Past this, only approved
     * templates may be sent. Null means no window has ever been open.
     */
    windowExpiresAt: timestamp('window_expires_at', { withTimezone: true }),

    /** Monday item id, stored so sync is idempotent across retries. */
    mondayItemId: text('monday_item_id'),

    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),

    followupCount: integer('followup_count').notNull().default(0),
    /** Authoritative follow-up schedule; survives a Redis flush. */
    nextFollowupAt: timestamp('next_followup_at', { withTimezone: true }),

    handedOffAt: timestamp('handed_off_at', { withTimezone: true }),
    errorState: text('error_state'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('conversations_contact_idx').on(table.contactId),
    index('conversations_stage_idx').on(table.stage),
    // Drives the follow-up scheduler's due-work query.
    index('conversations_next_followup_idx').on(table.nextFollowupAt),
    index('conversations_monday_item_idx').on(table.mondayItemId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    direction: messageDirection('direction').notNull(),
    body: text('body'),

    mediaType: text('media_type'),
    mediaUrl: text('media_url'),

    /**
     * Meta's message id.
     *
     * Meta retries webhooks, so this carries a unique index: re-delivery of the
     * same message must not produce a second reply to the customer.
     */
    providerMessageId: text('provider_message_id'),
    deliveryStatus: deliveryStatus('delivery_status'),

    /** Set when sent as an approved template rather than free-form. */
    templateRef: text('template_ref'),

    // Per-call LLM accounting, so cost per conversation is visible from day one
    // and escalation-rate drift shows up immediately rather than in a bill.
    llmModel: text('llm_model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 8 }),

    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('messages_provider_message_id_unique').on(table.providerMessageId),
    index('messages_conversation_idx').on(table.conversationId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

/**
 * A requested meeting, held internally until Lidor approves it.
 *
 * No Google Calendar event is written while status is `pending`. The slot is
 * held in this table so the bot cannot double-book, and the workflow parks on a
 * LangGraph interrupt until approval or expiry.
 */
export const appointmentRequests = pgTable(
  'appointment_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /** Slots offered to the contact, as ISO intervals. */
    proposedSlots: jsonb('proposed_slots').notNull(),
    selectedSlot: timestamp('selected_slot', { withTimezone: true }),

    status: appointmentStatus('status').notNull().default('pending'),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),

    /** Written only after approval. Its presence proves the event exists. */
    googleEventId: text('google_event_id'),
    /** Corresponding item on Lidor's פעילות board. */
    mondayActivityItemId: text('monday_activity_item_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('appointment_requests_conversation_idx').on(table.conversationId),
    index('appointment_requests_status_idx').on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// Campaign attribution
// ---------------------------------------------------------------------------

/** Meta lead-form submissions and Click-to-WhatsApp referrals, for attribution. */
export const campaignReferrals = pgTable(
  'campaign_referrals',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),

    adId: text('ad_id'),
    formId: text('form_id'),
    /** Meta's leadgen id — unique, so replayed webhooks cannot double-create. */
    externalLeadId: text('external_lead_id'),
    sourceUrl: text('source_url'),
    headline: text('headline'),

    /** Raw form answers exactly as Meta delivered them. */
    rawPayload: jsonb('raw_payload'),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('campaign_referrals_external_lead_unique').on(table.externalLeadId),
    index('campaign_referrals_contact_idx').on(table.contactId),
  ],
);

// ---------------------------------------------------------------------------
// Opt-outs
// ---------------------------------------------------------------------------

/**
 * Durable opt-out record, keyed by phone rather than contact.
 *
 * Deliberately independent of `contacts` so an opt-out survives contact records
 * being deleted, merged, or re-imported. Checked before every outbound send.
 */
export const optOuts = pgTable(
  'opt_outs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull(),
    reason: text('reason'),
    /** How it was detected: keyword fast-path, classifier, or staff action. */
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('opt_outs_phone_unique').on(table.phone)],
);

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

/**
 * Transactional outbox for external side effects.
 *
 * Events are written in the same transaction as the state change that caused
 * them, then delivered by a worker with backoff. This is what makes a Monday or
 * Calendar outage unable to interrupt a live conversation.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),

    status: outboxStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => [
    // Drives the delivery worker's claim query.
    index('outbox_pending_idx').on(table.status, table.nextAttemptAt),
    index('outbox_aggregate_idx').on(table.aggregateType, table.aggregateId),
  ],
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Append-only audit of stage transitions and other significant events. */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    fromStage: text('from_stage'),
    toStage: text('to_stage'),
    /** Who caused it: `system`, `llm`, or a staff identifier. */
    actor: text('actor').notNull().default('system'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('events_aggregate_idx').on(
      table.aggregateType,
      table.aggregateId,
      table.createdAt,
    ),
  ],
);
