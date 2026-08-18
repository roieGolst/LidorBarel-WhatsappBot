import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { conversations } from '../schema.js';

export type Conversation = typeof conversations.$inferSelect;
export type ConversationStage = Conversation['stage'];

/**
 * Stages from which a conversation will never continue.
 *
 * A new inbound message from someone whose last conversation ended in one of
 * these starts a fresh conversation rather than reopening the old one. Someone
 * disqualified in March who returns in October is genuinely a new opportunity,
 * and merging the two would leave the old outcome attached to new answers.
 */
const TERMINAL_STAGES = [
  'closed_no_response',
  'opted_out',
  'disqualified',
  'handed_off',
  'blocked',
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

/** Returns the contact's open conversation, if they have one. */
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

/**
 * Returns the contact's open conversation, creating one if none exists.
 *
 * Callers hold a transaction so that this and the message insert commit
 * together — a conversation created without its triggering message would leave
 * a lead in the CRM with no visible reason for existing.
 */
export async function findOrCreateConversation(
  db: DbClient,
  contactId: string,
): Promise<{ conversation: Conversation; created: boolean }> {
  const existing = await findActiveConversation(db, contactId);
  if (existing) {
    return { conversation: existing, created: false };
  }

  const [created] = await db.insert(conversations).values({ contactId }).returning();
  return { conversation: created!, created: true };
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
