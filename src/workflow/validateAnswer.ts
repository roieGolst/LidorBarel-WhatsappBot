import { normalizeNeighborhood } from '../domain/neighborhoods.js';
import type { Analysis, ExtractedFacts, StoredFacts } from './classify.js';

/**
 * `validateAnswers` — the gate between "the model extracted a value" and "we
 * treat it as a real answer" (review req #1).
 *
 * The bug this closes: the classifier could extract a value (especially the
 * free-text neighborhood) from a nonsensical message — "Opus 4.8" as a property
 * type — and the flow would store it and advance. Here, every extracted field is
 * checked for plausibility *before* it can be merged into the lead's facts. An
 * invalid value is never stored as genuine property info; it is recorded as an
 * invalid attempt so the turn re-asks the question instead of advancing.
 *
 * Deterministic and pure: the enum fields (sell-intent, timeline, currently-
 * marketed) are valid by construction — they only exist because they parsed
 * against a fixed option set. The neighborhood is free text, so it carries the
 * real validation weight: it must read as a Hebrew place name, and unknown-but-
 * plausible names are accepted verbatim (never swapped for a nearest match) and
 * flagged for logging.
 */

export interface InvalidAttempt {
  field: string;
  value: string;
  reason: string;
}

export interface AnswerValidation {
  /** Only the plausible facts — safe to merge into `conversations.extracted`. */
  validFacts: StoredFacts;
  /** Values that did not pass validation and must NOT be stored. */
  invalidAttempts: InvalidAttempt[];
  /** A valid neighborhood that is not in our reference list, for review logging. */
  unknownNeighborhood?: string;
  /** True when the property is outside Be'er Sheva (service-area handling). */
  outsideServiceArea?: boolean;
}

/**
 * Whether a neighborhood answer reads as a real Hebrew place name.
 *
 * A place is written in Hebrew here, so it must contain Hebrew letters and must
 * not be dominated by Latin letters or digits — which rejects "Opus 4.8",
 * "12345", or a stray model/brand token while accepting both named neighborhoods
 * and the bare-letter שכונות (e.g. "ד׳").
 */
export function isPlausibleNeighborhood(value: string): boolean {
  const t = value.trim();
  if (t.length === 0 || t.length > 40) return false;

  const hebrew = (t.match(/\p{Script=Hebrew}/gu) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  const digits = (t.match(/\d/g) ?? []).length;

  if (hebrew === 0) return false; // not a Hebrew place name
  if (latin > hebrew) return false; // Latin-dominated (e.g. "Opus")
  if (digits > hebrew) return false; // number-dominated
  return true;
}

/**
 * Validates every field the classifier extracted from one message.
 *
 * `analysis.relevantToSelling === false` (an off-topic message) drops all
 * extraction: a value opportunistically pulled from chit-chat is not an answer.
 */
export function validateAnswers(
  extracted: ExtractedFacts,
  analysis: Pick<Analysis, 'relevantToSelling'>,
): AnswerValidation {
  const validFacts: StoredFacts = {};
  const invalidAttempts: InvalidAttempt[] = [];
  let unknownNeighborhood: string | undefined;
  let outsideServiceArea: boolean | undefined;

  // Off-topic: nothing extracted from it counts as an answer.
  if (!analysis.relevantToSelling) {
    const value = extracted.neighborhood ?? extracted.notes ?? JSON.stringify(extracted);
    return {
      validFacts,
      invalidAttempts:
        Object.keys(extracted).length > 0
          ? [{ field: 'message', value, reason: 'Message is unrelated to selling' }]
          : [],
    };
  }

  // Enum fields are valid by construction — they exist only because they matched
  // a fixed option set.
  if (extracted.sellIntent !== undefined) validFacts.sellIntent = extracted.sellIntent;
  if (extracted.timeline !== undefined) validFacts.timeline = extracted.timeline;
  if (extracted.currentlyMarketed !== undefined) {
    validFacts.currentlyMarketed = extracted.currentlyMarketed;
  }

  // Neighborhood — the field that actually needs validating.
  if (extracted.neighborhood !== undefined) {
    if (isPlausibleNeighborhood(extracted.neighborhood)) {
      const match = normalizeNeighborhood(extracted.neighborhood);
      validFacts.neighborhood = match.original; // saved exactly as given
      validFacts.neighborhoodCanonical = match.canonical;
      if (!match.known) unknownNeighborhood = match.original;
    } else {
      invalidAttempts.push({
        field: 'neighborhood',
        value: extracted.neighborhood,
        reason: 'The response is not a recognized place name',
      });
    }
  }

  // A city other than Be'er Sheva is stored separately and flags the service area.
  if (extracted.city !== undefined) {
    validFacts.city = extracted.city;
    outsideServiceArea = true;
    validFacts.outsideServiceArea = true;
  }

  // Extra volunteered details (req #6) — a model summary, stored as-is when present.
  if (extracted.notes !== undefined) validFacts.notes = extracted.notes;

  return {
    validFacts,
    invalidAttempts,
    ...(unknownNeighborhood !== undefined ? { unknownNeighborhood } : {}),
    ...(outsideServiceArea !== undefined ? { outsideServiceArea } : {}),
  };
}
