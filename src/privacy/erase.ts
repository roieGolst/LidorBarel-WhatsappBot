import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { contacts, conversations, events, outbox } from '../db/schema.js';
import { getLogger } from '../logger.js';
import type { MondayClient } from '../monday/client.js';

/**
 * Erasing one person on request (NN-8).
 *
 * Deletes what the bot holds about them: the contact row and, by cascade,
 * their conversations, messages, form referrals (the consent record included)
 * and appointment records; the event and outbox rows keyed by the contact or
 * its conversations; and the lead item on the לידים board, which is the
 * projection of those rows (NN-4).
 *
 * Deliberately left alone: פעילות items, because the board syncs them to
 * Lidor's Google Calendar and an existing meeting may stay there (Lidor's
 * decision, 2026-09-29) — changing one would change his calendar.
 *
 * Nothing new is kept, and the request does **not** opt the number out: a
 * person who later messages again or submits the form again starts over. An
 * opt-out they gave *earlier* lives in `opt_outs`, keyed by phone, and is left
 * as it is — the one thing the bot needs to recognise and honour that refusal
 * (Communications Law §30A(ד); §30A(י)(5)(א) leaves no defence for sending after
 * one).
 *
 * The LangGraph checkpoint threads are the caller's to delete — a turn cannot
 * delete its own thread while it is still running (see conversationTurn.ts).
 */

export interface EraseDeps {
  db: Database;
  /** Needed to reach the board; absent, the lead items are reported instead. */
  monday?: MondayClient | undefined;
}

export interface EraseReport {
  /** The conversations that were erased — their checkpoint threads go next. */
  conversationIds: string[];
  leadItemsDeleted: number;
  /** Lead items that could not be deleted and must be removed by hand. */
  boardFailures: string[];
}

export async function eraseContact(
  deps: EraseDeps,
  contactId: string,
): Promise<EraseReport> {
  const logger = getLogger();
  const report: EraseReport = {
    conversationIds: [],
    leadItemsDeleted: 0,
    boardFailures: [],
  };

  const rows = await deps.db
    .select({ id: conversations.id, mondayItemId: conversations.mondayItemId })
    .from(conversations)
    .where(eq(conversations.contactId, contactId));
  report.conversationIds = rows.map((row) => row.id);

  // 1. The lead item. Best effort: a Monday outage must not stop the database
  //    erase, and an item that could not be reached is reported by id so a
  //    person finishes the job.
  for (const row of rows) {
    if (!row.mondayItemId) continue;
    if (!deps.monday) {
      report.boardFailures.push(row.mondayItemId);
      continue;
    }
    try {
      await deps.monday.deleteItem(row.mondayItemId);
      report.leadItemsDeleted += 1;
    } catch (error) {
      logger.error(
        { error, itemId: row.mondayItemId },
        'lead item not deleted on request',
      );
      report.boardFailures.push(row.mondayItemId);
    }
  }
  if (report.boardFailures.length > 0) {
    logger.warn(
      { itemIds: report.boardFailures },
      'deletion request: lead items to remove by hand',
    );
  }

  // 2. The database, as one unit. Contacts cascade to conversations, messages,
  //    referrals, listings and appointment requests; events and outbox rows
  //    carry only an aggregate id, with no foreign key, so they are deleted
  //    explicitly — by conversation, and by contact in case any is keyed so.
  const aggregateIds = [contactId, ...report.conversationIds];
  await deps.db.transaction(async (tx) => {
    await tx.delete(events).where(inArray(events.aggregateId, aggregateIds));
    await tx.delete(outbox).where(inArray(outbox.aggregateId, aggregateIds));
    await tx.delete(contacts).where(eq(contacts.id, contactId));
  });

  logger.info(
    {
      conversations: report.conversationIds.length,
      leadItemsDeleted: report.leadItemsDeleted,
      boardFailures: report.boardFailures.length,
    },
    'personal data erased',
  );
  return report;
}
