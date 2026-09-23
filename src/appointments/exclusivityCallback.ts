import type { Contact } from '../db/repositories/contacts.js';
import { activityItemName } from './meetingNote.js';
import type { Database } from '../db/client.js';
import {
  setExclusivityCallbackItemId,
  type Conversation,
} from '../db/repositories/conversations.js';
import { atLocalTime, hm, localParts } from '../domain/localTime.js';
import { getLogger } from '../logger.js';
import type { MondayClient } from '../monday/client.js';
import {
  ACTIVITY_BOARD_ID,
  ACTIVITY_COLUMNS,
  ACTIVITY_STATUS,
  ACTIVITY_TYPE,
  boardDateValue,
} from '../monday/leadMapping.js';
import type { KnownFacts } from '../workflow/decide.js';

/**
 * A callback reminder in Lidor's calendar for when a lead's exclusivity with
 * another agent ends.
 *
 * An exclusive lead is closed today but is exactly the lead worth calling the
 * day the contract runs out — and "call them in two months" is the kind of
 * note nobody finds again. So it becomes a `פעילות` item on the end date,
 * which Monday's sync turns into a calendar event, linked to the lead.
 */

/** When on the end date the reminder sits — mid-morning, inside meeting hours. */
export const CALLBACK_TIME = hm(10);
export const CALLBACK_DURATION_MS = 30 * 60 * 1000;
export const CALLBACK_ITEM_NAME = 'חזרה ללקוח — סיום בלעדיות';

/** Whether these facts call for a reminder at all. */
export function wantsExclusivityCallback(facts: KnownFacts): facts is KnownFacts & {
  exclusivityEndsOn: string;
} {
  return (
    facts.currentlyMarketed === 'with_agent' &&
    facts.exclusivityEndsOn !== undefined &&
    // An explicit "don't call me" is honoured; silence on the question is not
    // a refusal — the follow-up is the whole point of asking.
    facts.wantsExclusivityFollowup !== false
  );
}

/** The reminder's start: 10:00 local on the end date, rolled off Shabbat. */
export function callbackStart(exclusivityEndsOn: string, timeZone: string): Date {
  const start = atLocalTime(exclusivityEndsOn, CALLBACK_TIME, timeZone);
  return localParts(start, timeZone).weekday === 6
    ? new Date(start.getTime() + 24 * 60 * 60 * 1000)
    : start;
}

/** The `פעילות` column values for the reminder. */
export function callbackColumnValues(
  start: Date,
  leadItemId: string | null,
): Record<string, unknown> {
  const values: Record<string, unknown> = {
    [ACTIVITY_COLUMNS.type]: { index: ACTIVITY_TYPE.introCall },
    [ACTIVITY_COLUMNS.status]: { index: ACTIVITY_STATUS.open },
    [ACTIVITY_COLUMNS.start]: boardDateValue(start),
    [ACTIVITY_COLUMNS.end]: boardDateValue(
      new Date(start.getTime() + CALLBACK_DURATION_MS),
    ),
  };
  if (leadItemId) values[ACTIVITY_COLUMNS.contact] = { item_ids: [Number(leadItemId)] };
  return values;
}

export interface CallbackDeps {
  db: Database;
  monday: MondayClient;
  timeZone: string;
}

/**
 * Creates the reminder once.
 *
 * Runs from the lead projection, after the lead's own item exists, so the
 * reminder can be linked to it. The item id is recorded straight after the
 * create, so a later projection of the same lead sees it and does nothing.
 * Returns the item id, or `undefined` when nothing was needed.
 */
export async function ensureExclusivityCallback(
  deps: CallbackDeps,
  conversation: Pick<Conversation, 'id' | 'mondayItemId' | 'exclusivityCallbackItemId'>,
  facts: KnownFacts,
  /** Whose reminder it is — named in the item, and so in the calendar event. */
  contact: Pick<Contact, 'name'> = { name: null },
): Promise<string | undefined> {
  if (conversation.exclusivityCallbackItemId)
    return conversation.exclusivityCallbackItemId;
  if (!wantsExclusivityCallback(facts)) return undefined;

  const start = callbackStart(facts.exclusivityEndsOn, deps.timeZone);
  const itemId = await deps.monday.createItem(
    ACTIVITY_BOARD_ID,
    activityItemName(CALLBACK_ITEM_NAME, contact),
    callbackColumnValues(start, conversation.mondayItemId),
  );
  await setExclusivityCallbackItemId(deps.db, conversation.id, itemId);

  getLogger().info(
    { conversationId: conversation.id, itemId, callbackAt: start.toISOString() },
    'exclusivity callback reminder created',
  );
  return itemId;
}
