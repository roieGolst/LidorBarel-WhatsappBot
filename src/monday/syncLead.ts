import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { findContactById } from '../db/repositories/contacts.js';
import {
  getConversationById,
  setMondayItemId,
} from '../db/repositories/conversations.js';
import { campaignReferrals } from '../db/schema.js';
import { ensureExclusivityCallback } from '../appointments/exclusivityCallback.js';
import { getLogger } from '../logger.js';
import { enqueueOutboxEvent } from '../outbox/outbox.js';
import type { KnownFacts } from '../workflow/decide.js';
import type { MondayClient } from './client.js';
import {
  LEADS_BOARD_ID,
  UNSUITABLE_GROUP_ID,
  leadColumnValues,
  needsGroupMove,
  statusLabelFor,
} from './leadMapping.js';

/**
 * Projecting one conversation onto the לידים board.
 *
 * Monday is a **projection** (rule NN-4): this reads current state from Postgres
 * and writes it out, rather than applying a diff. That is what makes it safe to
 * run twice, out of order, or long after the event that triggered it — the last
 * write wins and it is always the truth. It is also what lets the whole board be
 * rebuilt from Postgres after an outage.
 */

export interface SyncLeadDeps {
  db: Database;
  monday: MondayClient;
  /** Resolves a Meta form id to its display name. Optional; an id tells Lidor nothing. */
  resolveFormName?: ((formId: string) => Promise<string | undefined>) | undefined;
  /** Lidor's timezone, for placing a callback reminder on a local date. */
  timeZone?: string | undefined;
}

const DEFAULT_TIME_ZONE = 'Asia/Jerusalem';

export type SyncLeadResult =
  | { synced: true; itemId: string; created: boolean }
  | { synced: false; reason: 'conversation_missing' | 'contact_missing' };

/**
 * Creates or updates the Monday item for a conversation.
 *
 * Idempotency rests on `conversations.monday_item_id`: once stored, every later
 * sync updates that item. The id is written **immediately after creation and
 * outside the Monday call**, so a crash between the two costs a duplicate item
 * at worst — recoverable by hand — rather than an endless loop of them.
 *
 * An item deleted from the board by hand is detected and recreated, because
 * updating a dead id fails forever otherwise.
 */
export async function syncLead(
  deps: SyncLeadDeps,
  conversationId: string,
): Promise<SyncLeadResult> {
  const logger = getLogger();

  const conversation = await getConversationById(deps.db, conversationId);
  if (!conversation) return { synced: false, reason: 'conversation_missing' };

  const contact = await findContactById(deps.db, conversation.contactId);
  if (!contact) return { synced: false, reason: 'contact_missing' };

  const [referral] = await deps.db
    .select({ formId: campaignReferrals.formId })
    .from(campaignReferrals)
    .where(
      and(
        eq(campaignReferrals.contactId, contact.id),
        // Lead-form referrals only; a Click-to-WhatsApp referral has no form.
      ),
    )
    .orderBy(desc(campaignReferrals.receivedAt))
    .limit(1);

  const formName =
    referral?.formId && deps.resolveFormName
      ? await deps.resolveFormName(referral.formId)
      : undefined;

  const projection = {
    contact,
    conversation,
    facts: (conversation.extracted ?? {}) as KnownFacts,
    ...(formName ? { formName } : {}),
  };

  const existingId = conversation.mondayItemId;
  const stillThere = existingId ? await deps.monday.itemExists(existingId) : false;

  if (!existingId || !stillThere) {
    if (existingId) {
      logger.warn(
        { conversationId, itemId: existingId },
        'Monday item no longer exists — recreating',
      );
    }

    // Status is omitted: a board automation sets it on creation, and passing it
    // here races that automation.
    const itemId = await deps.monday.createItem(
      LEADS_BOARD_ID,
      contact.name?.trim() || contact.phone,
      leadColumnValues(projection, { includeStatus: false }),
    );
    await setMondayItemId(deps.db, conversationId, itemId);

    // The board's "when an item is created" automation sets ליד חדש, and it fires
    // asynchronously — so writing the real status now is a race this side loses
    // about as often as it wins. Verified against the live board: the status set
    // here was overwritten back to ליד חדש moments later.
    //
    // It is still written, because winning the race is the common case and costs
    // nothing. What guarantees correctness is the second pass queued below: by
    // the time it runs the automation has certainly fired, the item exists, and
    // the update path sets the status unopposed. Only queued on creation, so it
    // cannot loop.
    await applyStatus(deps, itemId, projection.conversation);
    await enqueueOutboxEvent(deps.db, conversationId);
    await ensureExclusivityCallback(
      { db: deps.db, monday: deps.monday, timeZone: deps.timeZone ?? DEFAULT_TIME_ZONE },
      { ...conversation, mondayItemId: itemId },
      projection.facts,
      projection.contact,
    );

    logger.info({ conversationId, itemId }, 'created Monday lead');
    return { synced: true, itemId, created: true };
  }

  await deps.monday.updateItem(
    LEADS_BOARD_ID,
    existingId,
    leadColumnValues(projection, { includeStatus: true }),
  );
  await applyGroupMove(deps, existingId, projection.conversation);
  // A lead closed as exclusive gets a callback reminder on the end date, once.
  await ensureExclusivityCallback(
    { db: deps.db, monday: deps.monday, timeZone: deps.timeZone ?? DEFAULT_TIME_ZONE },
    conversation,
    projection.facts,
    projection.contact,
  );
  logger.info({ conversationId, itemId: existingId }, 'updated Monday lead');
  return { synced: true, itemId: existingId, created: false };
}

/** Writes the status, then files the item if no automation covers that status. */
async function applyStatus(
  deps: SyncLeadDeps,
  itemId: string,
  conversation: {
    stage: Parameters<typeof statusLabelFor>[0];
    disqualificationReason: Parameters<typeof statusLabelFor>[1];
  },
): Promise<void> {
  const label = statusLabelFor(conversation.stage, conversation.disqualificationReason);
  await deps.monday.updateItem(LEADS_BOARD_ID, itemId, {
    lead_status: { index: label },
  });
  await applyGroupMove(deps, itemId, conversation);
}

/**
 * Moves the item only for the statuses no board automation files.
 *
 * Every other status is filed by an automation; moving those from here would
 * race it. See `docs/MONDAY-MAPPING.md`.
 */
async function applyGroupMove(
  deps: SyncLeadDeps,
  itemId: string,
  conversation: {
    stage: Parameters<typeof statusLabelFor>[0];
    disqualificationReason: Parameters<typeof statusLabelFor>[1];
  },
): Promise<void> {
  const label = statusLabelFor(conversation.stage, conversation.disqualificationReason);
  if (!needsGroupMove(label)) return;
  await deps.monday.moveToGroup(itemId, UNSUITABLE_GROUP_ID);
}
