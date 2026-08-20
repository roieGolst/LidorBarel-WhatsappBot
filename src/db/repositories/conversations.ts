import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { conversations } from '../schema.js';

export type Conversation = typeof conversations.$inferSelect;
export type ConversationStage = Conversation['stage'];

/**
 * Stages from which a conversation will never continue on its own.
 *
 * There is exactly **one conversation record per contact** — a returning contact
 * never spawns a duplicate. A terminal end is handled without creating a new row:
 * a ban/opt-out end is reused untouched (the bot stays silent), and any other
 * terminal end is *reopened in place* so a genuine return continues in the same
 * record with a clean slate rather than dragging the old outcome onto new answers.
 */
const TERMINAL_STAGES = [
  'closed_no_response',
  'opted_out',
  'disqualified',
  'handed_off',
  'blocked',
  'error',
] as const satisfies readonly ConversationStage[];

/**
 * Terminal ends a returning contact may legitimately continue from. These are
 * *reopened in place* — same record, stage reset to `engaged` and the prior
 * outcome cleared — so there is no duplicate and no stale outcome on new answers.
 */
const REOPENABLE_STAGES = [
  'closed_no_response',
  'disqualified',
  'handed_off',
  'error',
] as const satisfies readonly ConversationStage[];

/** The 24-hour WhatsApp customer service window, in milliseconds. */
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Loads a conversation by id. */
export async function getConversationById(
  db: DbClient,
  id: string,
): Promise<Conversation | undefined> {
  const [found] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  return found;
}

/** Returns the contact's open (non-terminal) conversation, if they have one. */
export async function findActiveConversation(
  db: DbClient,
  contactId: string,
): Promise<Conversation | undefined> {
  const [found] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.contactId, contactId),
        notInArray(conversations.stage, [...TERMINAL_STAGES]),
      ),
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  return found;
}

/** Returns the contact's most recent conversation, whatever its stage. */
export async function findLatestConversation(
  db: DbClient,
  contactId: string,
): Promise<Conversation | undefined> {
  const [found] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.contactId, contactId))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  return found;
}

/**
 * Returns the contact's conversation, creating one only if they have none.
 *
 * **One conversation record per contact, always** — a returning contact never
 * gets a duplicate row (which would fracture their history and break the CRM
 * projection). The single record is reused:
 *  - an open conversation continues as-is;
 *  - a ban/opt-out end is reused untouched, so the worker stays silent (an
 *    abuser or opted-out person is never handed a fresh start or re-greeted);
 *  - any other terminal end is reopened in place — the same row, reset to a
 *    clean `engaged` state — so a genuine return continues without a duplicate
 *    and without the old outcome tainting new answers.
 *
 * Callers hold a transaction so that this and the message insert commit together.
 */
export async function findOrCreateConversation(
  db: DbClient,
  contactId: string,
): Promise<{ conversation: Conversation; created: boolean }> {
  const latest = await findLatestConversation(db, contactId);

  if (!latest) {
    const [created] = await db.insert(conversations).values({ contactId }).returning();
    return { conversation: created!, created: true };
  }

  // Reopen a non-ban terminal end in place, so a returning contact continues in
  // the same record with a clean slate rather than a stale outcome.
  if ((REOPENABLE_STAGES as readonly string[]).includes(latest.stage)) {
    const [reopened] = await db
      .update(conversations)
      .set({
        stage: 'engaged',
        extracted: {},
        qualified: null,
        disqualificationReason: null,
        priorityScore: null,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, latest.id))
      .returning();
    return { conversation: reopened!, created: false };
  }

  // Open, or a ban/opt-out end: reuse untouched.
  return { conversation: latest, created: false };
}

/**
 * Records that an inbound message arrived, refreshing the messaging window.
 *
 * Any message from the user opens a fresh 24-hour window during which free-form
 * replies are allowed. Outside it, only approved templates may be sent — so this
 * timestamp decides whether the bot can answer in its own words at all.
 *
 * The window is measured from the message timestamp rather than now, because
 * Meta's retries can deliver a webhook minutes after the message was sent and
 * dating it from processing time would overstate how long we have.
 */
export async function recordInboundActivity(
  db: DbClient,
  conversationId: string,
  messageAt: Date,
): Promise<void> {
  await db
    .update(conversations)
    .set({
      lastInboundAt: messageAt,
      windowExpiresAt: new Date(messageAt.getTime() + SERVICE_WINDOW_MS),
      // Any reply cancels pending follow-ups; the person is engaged again.
      nextFollowupAt: null,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}

/** Whether free-form replies are currently permitted. */
export function isWithinServiceWindow(
  conversation: Pick<Conversation, 'windowExpiresAt'>,
  now: Date = new Date(),
): boolean {
  return conversation.windowExpiresAt !== null && conversation.windowExpiresAt > now;
}

/** Attaches the Monday item id once the projection has been created. */
export async function setMondayItemId(
  db: DbClient,
  conversationId: string,
  mondayItemId: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ mondayItemId, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}
