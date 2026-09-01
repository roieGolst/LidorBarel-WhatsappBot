import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { getConversationById } from '../db/repositories/conversations.js';
import { appointmentRequests, conversations } from '../db/schema.js';
import { getLogger } from '../logger.js';
import type { MondayClient } from '../monday/client.js';
import {
  ACTIVITY_BOARD_ID,
  ACTIVITY_COLUMNS,
  ACTIVITY_STATUS,
  ACTIVITY_TYPE,
} from '../monday/leadMapping.js';
import { enqueueOutboxEvent } from '../outbox/outbox.js';
import {
  availableSlots,
  overlaps,
  spreadAcrossDays,
  type BusyBlock,
  type Slot,
  type SlotOptions,
} from './availability.js';

/**
 * Offering and booking consultation calls.
 *
 * A booking is a `פעילות` item. Monday's bidirectional Google Calendar sync turns
 * that into a real calendar event, so this needs no Google credentials at all —
 * the calendar is reached through the CRM that already owns it.
 *
 * This module speaks in appointments rather than board columns. That is a seam,
 * not an abstraction: there is one implementation and no interface to swap. If
 * Google ever has to be addressed directly, the change is confined here, and by
 * then we will know what the second implementation actually needs instead of
 * guessing now.
 */

export interface BookingDeps {
  db: Database;
  monday: MondayClient;
  slotOptions: SlotOptions;
}

/**
 * Reads a date column's instant from its raw JSON value.
 *
 * Deliberately **not** the column's rendered `text`. Monday renders date text in
 * the account's timezone (`08:30`) while the JSON value holds UTC (`05:30`), so
 * parsing the text on a UTC server shifts every commitment by three hours — and
 * a three-hour error in a calendar means booking on top of real meetings.
 * Verified against the live board.
 */
function parseBoardDate(raw: string | null | undefined): Date | undefined {
  if (!raw) return undefined;
  let parsed: { date?: string; time?: string };
  try {
    parsed = JSON.parse(raw) as { date?: string; time?: string };
  } catch {
    return undefined;
  }
  if (!parsed.date) return undefined;

  // An all-day entry has no time. Treated as starting at midnight UTC, which is
  // conservative: it blocks the day rather than being ignored.
  const at = new Date(`${parsed.date}T${parsed.time ?? '00:00:00'}Z`);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * Everything already in Lidor's calendar, as seen through the activity board.
 *
 * An item with no end time is treated as occupying the default duration rather
 * than being ignored — a calendar entry with a missing end is still a commitment,
 * and skipping it would book straight over it.
 */
export async function busyBlocks(deps: BookingDeps): Promise<BusyBlock[]> {
  const items = await deps.monday.listItems(ACTIVITY_BOARD_ID, [
    ACTIVITY_COLUMNS.start,
    ACTIVITY_COLUMNS.end,
  ]);

  const blocks: BusyBlock[] = [];
  for (const item of items) {
    const start = parseBoardDate(item.columnValues[ACTIVITY_COLUMNS.start]?.value);
    if (!start) continue;
    const end =
      parseBoardDate(item.columnValues[ACTIVITY_COLUMNS.end]?.value) ??
      new Date(start.getTime() + deps.slotOptions.durationMs);
    blocks.push({ start, end });
  }
  return blocks;
}

/** Slots to offer a lead, spread across days. */
export async function findSlotsToOffer(
  deps: BookingDeps,
  count = 3,
  now: Date = new Date(),
): Promise<Slot[]> {
  const busy = await busyBlocks(deps);
  const free = availableSlots(busy, deps.slotOptions, now);
  return spreadAcrossDays(free, count, deps.slotOptions.timeZone);
}

/**
 * Records the slots offered, and holds them.
 *
 * The hold exists because a lead takes minutes to answer and the calendar can
 * move underneath them. It does not reserve anything in Monday — nothing is
 * written to the calendar until a slot is chosen — it bounds how long an offer
 * stays honourable, after which the slots are recomputed rather than assumed.
 */
export async function recordOffer(
  deps: BookingDeps,
  conversationId: string,
  slots: readonly Slot[],
  holdMs: number,
  now: Date = new Date(),
): Promise<string> {
  const [row] = await deps.db
    .insert(appointmentRequests)
    .values({
      conversationId,
      proposedSlots: slots.map((slot) => ({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
      })),
      status: 'pending',
      holdExpiresAt: new Date(now.getTime() + holdMs),
    })
    .returning({ id: appointmentRequests.id });

  return row!.id;
}

export type BookingOutcome =
  | { booked: true; appointmentId: string; activityItemId: string; slot: Slot }
  | { booked: false; reason: 'slot_taken' | 'no_offer' | 'conversation_missing' };

/**
 * Books a chosen slot.
 *
 * Availability is re-read here rather than trusted from when the offer was made.
 * That is the whole mitigation for sync lag: between offering and choosing, an
 * event may have landed in Google and reached the board, and booking over it
 * would double-book Lidor in his own calendar. A taken slot is reported rather
 * than forced, so the caller can offer again.
 */
export async function bookSlot(
  deps: BookingDeps,
  conversationId: string,
  chosen: Slot,
  now: Date = new Date(),
): Promise<BookingOutcome> {
  const logger = getLogger();

  const conversation = await getConversationById(deps.db, conversationId);
  if (!conversation) return { booked: false, reason: 'conversation_missing' };

  const [offer] = await deps.db
    .select()
    .from(appointmentRequests)
    .where(eq(appointmentRequests.conversationId, conversationId))
    .orderBy(appointmentRequests.createdAt)
    .limit(1);
  if (!offer) return { booked: false, reason: 'no_offer' };

  const busy = await busyBlocks(deps);
  if (busy.some((block) => overlaps(chosen, block))) {
    logger.info({ conversationId }, 'chosen slot was taken before booking');
    return { booked: false, reason: 'slot_taken' };
  }

  // Linking the activity to the lead is what makes the meeting findable from the
  // lead, and is why the relation column exists.
  const columnValues: Record<string, unknown> = {
    [ACTIVITY_COLUMNS.type]: { index: ACTIVITY_TYPE.consultation },
    [ACTIVITY_COLUMNS.status]: { index: ACTIVITY_STATUS.open },
    [ACTIVITY_COLUMNS.start]: boardDateValue(chosen.start),
    [ACTIVITY_COLUMNS.end]: boardDateValue(chosen.end),
  };
  if (conversation.mondayItemId) {
    columnValues[ACTIVITY_COLUMNS.contact] = {
      item_ids: [Number(conversation.mondayItemId)],
    };
  }

  const activityItemId = await deps.monday.createItem(
    ACTIVITY_BOARD_ID,
    'פגישת ייעוץ',
    columnValues,
  );

  await deps.db.transaction(async (tx) => {
    await tx
      .update(appointmentRequests)
      .set({
        status: 'approved',
        selectedSlot: chosen.start,
        mondayActivityItemId: activityItemId,
        holdExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(appointmentRequests.id, offer.id));

    await tx
      .update(conversations)
      .set({ stage: 'appointment_confirmed', updatedAt: now })
      .where(eq(conversations.id, conversationId));

    // The lead's board status should say a meeting is booked, and the projection
    // is queued in the same transaction as the state change (NN-4).
    await enqueueOutboxEvent(tx, conversationId);
  });

  logger.info({ conversationId, activityItemId }, 'consultation booked');
  return { booked: true, appointmentId: offer.id, activityItemId, slot: chosen };
}

/** Monday's date column format. */
function boardDateValue(at: Date): { date: string; time: string } {
  const iso = at.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}
