import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { recordOptOut } from '../db/repositories/optOuts.js';
import {
  appointmentRequests,
  contacts,
  conversations,
  events,
  outbox,
} from '../db/schema.js';
import { getLogger } from '../logger.js';
import type { MondayClient } from '../monday/client.js';
import {
  ACTIVITY_BOARD_ID,
  ACTIVITY_COLUMNS,
  ACTIVITY_STATUS,
} from '../monday/leadMapping.js';

/**
 * Erasing one person — what the privacy page promises, in code (NN-8, NN-9).
 *
 * Two reasons call it. A **deletion request** erases everything the bot wrote
 * anywhere: the contact and, by cascade, their conversations, messages, form
 * referrals, property and appointment records; the event and outbox rows keyed
 * by those conversations; the lead item on the לידים board; and the personal
 * details on any פעילות item, which is scrubbed rather than deleted because
 * deleting one does not remove its calendar event (docs/MONDAY-MAPPING.md). The
 * one thing kept is the phone number, on the do-not-contact list, so the person
 * is never messaged again. **Retention** erases the same bot-side data once a
 * lead has been silent for the configured period, and leaves the CRM alone: the
 * board is Lidor's business record and is deleted only on request.
 *
 * The LangGraph checkpoint thread is the caller's to delete — a turn cannot
 * delete its own thread while it is still running (see conversationTurn.ts).
 */

export type EraseReason = 'deletion_request' | 'retention';

export interface EraseDeps {
  db: Database;
  /** Needed for a deletion request to reach the board; absent, it is logged. */
  monday?: MondayClient | undefined;
}

export interface EraseReport {
  /** The conversations that were erased — their checkpoint threads go next. */
  conversationIds: string[];
  leadItemsDeleted: number;
  activityItemsScrubbed: number;
  /** Board items that could not be reached and must be handled by hand. */
  boardFailures: string[];
}

/** What a scrubbed פעילות item is left saying. No name, no number, a reason. */
export const SCRUBBED_ACTIVITY_NAME = 'פגישה — הליד ביקש מחיקת מידע';
export const SCRUBBED_ACTIVITY_NOTE =
  'הליד ביקש למחוק את המידע שלו. הפרטים הוסרו מהכרטיס; יש להסיר את האירוע מהיומן ידנית.';

export async function eraseContact(
  deps: EraseDeps,
  target: { contactId: string; phone: string },
  reason: EraseReason,
): Promise<EraseReport> {
  const logger = getLogger();
  const report: EraseReport = {
    conversationIds: [],
    leadItemsDeleted: 0,
    activityItemsScrubbed: 0,
    boardFailures: [],
  };

  const rows = await deps.db
    .select({
      id: conversations.id,
      mondayItemId: conversations.mondayItemId,
      exclusivityCallbackItemId: conversations.exclusivityCallbackItemId,
    })
    .from(conversations)
    .where(eq(conversations.contactId, target.contactId));
  report.conversationIds = rows.map((row) => row.id);

  const activityItemIds = new Set<string>();
  for (const row of rows) {
    if (row.exclusivityCallbackItemId) activityItemIds.add(row.exclusivityCallbackItemId);
  }
  if (rows.length > 0) {
    const booked = await deps.db
      .select({ itemId: appointmentRequests.mondayActivityItemId })
      .from(appointmentRequests)
      .where(inArray(appointmentRequests.conversationId, report.conversationIds));
    for (const row of booked) if (row.itemId) activityItemIds.add(row.itemId);
  }

  // 1. The do-not-contact record, before anything else: if the erase below
  //    fails halfway, the one guarantee that must hold is silence.
  if (reason === 'deletion_request') {
    await recordOptOut(deps.db, target.phone, 'deletion', 'data_deletion_request');
  }

  // 2. The board — only on request (retention leaves the CRM alone). Best effort
  //    item by item: a Monday outage must not stop the database erase, and every
  //    item that could not be reached is reported so a person finishes the job.
  if (reason === 'deletion_request') {
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
    for (const itemId of activityItemIds) {
      if (!deps.monday) {
        report.boardFailures.push(itemId);
        continue;
      }
      try {
        await deps.monday.updateItem(ACTIVITY_BOARD_ID, itemId, {
          name: SCRUBBED_ACTIVITY_NAME,
          [ACTIVITY_COLUMNS.description]: SCRUBBED_ACTIVITY_NOTE,
          [ACTIVITY_COLUMNS.status]: { index: ACTIVITY_STATUS.done },
        });
        report.activityItemsScrubbed += 1;
      } catch (error) {
        logger.error({ error, itemId }, 'activity item not scrubbed on request');
        report.boardFailures.push(itemId);
      }
    }
    if (report.boardFailures.length > 0) {
      logger.warn(
        { itemIds: report.boardFailures },
        'deletion request: board items to remove by hand',
      );
    }
  }

  // 3. The database, as one unit. Contacts cascade to conversations, messages,
  //    referrals, properties, listings and appointment requests; events and
  //    outbox rows are keyed by conversation without a foreign key, so they are
  //    deleted explicitly.
  await deps.db.transaction(async (tx) => {
    if (report.conversationIds.length > 0) {
      await tx.delete(events).where(inArray(events.aggregateId, report.conversationIds));
      await tx.delete(outbox).where(inArray(outbox.aggregateId, report.conversationIds));
    }
    await tx.delete(contacts).where(eq(contacts.id, target.contactId));
  });

  logger.info(
    {
      reason,
      conversations: report.conversationIds.length,
      leadItemsDeleted: report.leadItemsDeleted,
      activityItemsScrubbed: report.activityItemsScrubbed,
      boardFailures: report.boardFailures.length,
    },
    'personal data erased',
  );
  return report;
}
