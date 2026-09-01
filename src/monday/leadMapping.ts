import type { Contact } from '../db/repositories/contacts.js';
import type {
  Conversation,
  ConversationStage,
} from '../db/repositories/conversations.js';
import { BEER_SHEVA_NEIGHBORHOODS } from '../domain/neighborhoods.js';
import type { KnownFacts } from '../workflow/decide.js';

/**
 * Our domain, expressed in Monday's column and label ids.
 *
 * Everything here is matched by **id, never by label text** — a rename in the
 * board is then harmless, where matching on text would silently stop writing the
 * moment someone fixed a typo. Several of the ids are counter-intuitive
 * (`מועד מכירה רצוי` numbers its options 0=within-month, 2=immediate), which is
 * exactly why they are written down rather than inferred.
 *
 * Verified against the live board on 2026-08-26. See `docs/MONDAY-MAPPING.md`.
 */

export const LEADS_BOARD_ID = '1879864606';
export const ACTIVITY_BOARD_ID = '1879864604';

/** Group for the disqualified/opted-out statuses, which no automation covers. */
export const UNSUITABLE_GROUP_ID = 'group_mm6qfq86';

export const LEAD_COLUMNS = {
  phone: 'lead_phone',
  email: 'email_mm6aack2',
  status: 'lead_status',
  source: 'color_mm69jtnb',
  formName: 'text_mm0p1791',
  sourceDetail: 'text_mm6qyrr0',
  score: 'numeric_mm6q8wt4',
  sellIntent: 'color_mm692wg7',
  neighborhood: 'dropdown_mm6qv7ph',
  timeline: 'color_mm699p5k',
  currentlyMarketed: 'color_mm6aapxr',
  propertyNotes: 'long_text_mm6a2mry',
  lastInteraction: 'date__1',
} as const;

/** `lead_status` label ids. */
export const LEAD_STATUS = {
  awaitingMeeting: 0,
  won: 1, // Lidor's. The bot never writes it.
  new: 2,
  noResponse: 3,
  unsuitable: 4,
  missingInfo: 5,
  askedToStop: 6,
  exclusiveWithAgent: 7,
  uncooperative: 8,
  noUrgency: 9,
  notSelling: 10,
  awaitingCall: 14,
} as const;

/** `מקור הליד` label ids. Id 5 is a blank label — never write it. */
export const LEAD_SOURCE = { paid: 0, whatsappBot: 6 } as const;

const SELL_INTENT_LABEL: Record<NonNullable<KnownFacts['sellIntent']>, number> = {
  ready: 1,
  not_sure: 0,
  not_selling: 2,
};

const TIMELINE_LABEL: Record<NonNullable<KnownFacts['timeline']>, number> = {
  immediate: 2,
  within_month: 0,
  still_checking: 1,
  no_urgency: 3,
};

const MARKETED_LABEL: Record<NonNullable<KnownFacts['currentlyMarketed']>, number> = {
  no: 1,
  privately: 0,
  with_agent: 2,
};

const DISQUALIFICATION_STATUS: Record<
  NonNullable<Conversation['disqualificationReason']>,
  number
> = {
  not_selling: LEAD_STATUS.notSelling,
  no_urgency: LEAD_STATUS.noUrgency,
  exclusive_with_other_agent: LEAD_STATUS.exclusiveWithAgent,
  uncooperative: LEAD_STATUS.uncooperative,
};

/**
 * Statuses that move the item to `לידים לא מתאימים` from code.
 *
 * Every other status has an automation that files it; these do not. Kept as a
 * set so the rule is stated once rather than re-derived at the call site.
 */
const BOT_MOVED_STATUSES: ReadonlySet<number> = new Set([
  LEAD_STATUS.unsuitable,
  LEAD_STATUS.askedToStop,
  LEAD_STATUS.exclusiveWithAgent,
  LEAD_STATUS.uncooperative,
  LEAD_STATUS.noUrgency,
  LEAD_STATUS.notSelling,
]);

export function needsGroupMove(statusLabel: number): boolean {
  return BOT_MOVED_STATUSES.has(statusLabel);
}

/**
 * The `lead_status` label for a conversation.
 *
 * A disqualified conversation reports *why* rather than a generic "unsuitable":
 * the reason is what tells Lidor whether the lead is worth revisiting, and a
 * lead who has no urgency today is a different prospect from one who will never
 * sell.
 */
export function statusLabelFor(
  stage: ConversationStage,
  disqualificationReason: Conversation['disqualificationReason'],
): number {
  switch (stage) {
    case 'disqualified':
      return disqualificationReason
        ? DISQUALIFICATION_STATUS[disqualificationReason]
        : LEAD_STATUS.unsuitable;
    case 'opted_out':
    case 'blocked':
      return LEAD_STATUS.askedToStop;
    case 'closed_no_response':
      return LEAD_STATUS.noResponse;
    case 'qualified':
    case 'handed_off':
      return LEAD_STATUS.awaitingCall;
    case 'appointment_proposed':
    case 'appointment_pending':
    case 'appointment_confirmed':
      return LEAD_STATUS.awaitingMeeting;
    default:
      return LEAD_STATUS.new;
  }
}

/** Monday's date column format, in the board's local terms. */
function dateValue(at: Date): { date: string; time: string } {
  const iso = at.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

/**
 * Neighbourhood label id — the domain list's index plus one.
 *
 * The dropdown was rebuilt so its ids line up with
 * {@link BEER_SHEVA_NEIGHBORHOODS}. Appending to that list stays safe;
 * **reordering it silently rewrites every neighbourhood on the board.**
 */
export function neighborhoodLabelId(name: string): number | undefined {
  const index = BEER_SHEVA_NEIGHBORHOODS.indexOf(
    name as (typeof BEER_SHEVA_NEIGHBORHOODS)[number],
  );
  return index === -1 ? undefined : index + 1;
}

export interface LeadProjection {
  contact: Contact;
  conversation: Conversation;
  facts: KnownFacts;
  /** Meta form name, for a lead that arrived through the ad form. */
  formName?: string | undefined;
}

/**
 * Builds the column values for a lead.
 *
 * Only known values are included. Writing `null` for an unknown fact would erase
 * something Lidor had filled in by hand, and the bot's view is never more
 * authoritative than his.
 *
 * `מין` and `נוצר בתאריך` are deliberately absent: the first is needed for Hebrew
 * grammar but never filtered on, and Monday already records creation time.
 */
export function leadColumnValues(
  projection: LeadProjection,
  options: { includeStatus: boolean },
): Record<string, unknown> {
  const { contact, conversation, facts } = projection;
  const values: Record<string, unknown> = {};

  // Monday wants the number without a leading plus, plus the country.
  values[LEAD_COLUMNS.phone] = {
    phone: contact.phone.replace(/^\+/, ''),
    countryShortName: 'IL',
  };
  if (contact.email) {
    values[LEAD_COLUMNS.email] = { email: contact.email, text: contact.email };
  }

  values[LEAD_COLUMNS.source] = {
    index:
      contact.entryPoint === 'meta_lead_form'
        ? LEAD_SOURCE.paid
        : LEAD_SOURCE.whatsappBot,
  };
  if (projection.formName) values[LEAD_COLUMNS.formName] = projection.formName;

  if (facts.sellIntent) {
    values[LEAD_COLUMNS.sellIntent] = { index: SELL_INTENT_LABEL[facts.sellIntent] };
  }
  if (facts.timeline) {
    values[LEAD_COLUMNS.timeline] = { index: TIMELINE_LABEL[facts.timeline] };
  }
  if (facts.currentlyMarketed) {
    values[LEAD_COLUMNS.currentlyMarketed] = {
      index: MARKETED_LABEL[facts.currentlyMarketed],
    };
  }
  if (facts.neighborhood) {
    const id = neighborhoodLabelId(facts.neighborhood);
    // An unrecognised neighbourhood is left off rather than creating a label:
    // that is how a street address becomes a permanent board value.
    if (id !== undefined) values[LEAD_COLUMNS.neighborhood] = { ids: [id] };
  }
  if (facts.additionalNotes) {
    values[LEAD_COLUMNS.propertyNotes] = { text: facts.additionalNotes };
  }

  // The score is the point of the whole qualification: Lidor works a queue, and
  // this sets its order. Written as a string because Monday's numbers column
  // takes one.
  if (conversation.priorityScore !== null) {
    values[LEAD_COLUMNS.score] = String(conversation.priorityScore);
  }

  const lastInteraction = conversation.lastInboundAt ?? conversation.lastOutboundAt;
  if (lastInteraction) {
    values[LEAD_COLUMNS.lastInteraction] = dateValue(lastInteraction);
  }

  // Status is set on creation by a board automation, so it is written only on
  // updates — see `docs/MONDAY-MAPPING.md`.
  if (options.includeStatus) {
    values[LEAD_COLUMNS.status] = {
      index: statusLabelFor(conversation.stage, conversation.disqualificationReason),
    };
  }

  return values;
}
