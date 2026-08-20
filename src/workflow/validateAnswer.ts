import { normalizeNeighborhood } from '../domain/neighborhoods.js';
import type { KnownFacts } from './decide.js';

/**
 * `sanitizeExtraction` — the gate between "the model extracted a value" and "we
 * treat it as a real answer" (review req #1).
 *
 * The bug this closes: the classifier could extract a value from a nonsensical
 * message — "Opus 4.8" as a neighborhood — and the flow would store it and
 * advance. The free-text `neighborhood` is the one screening field with no fixed
 * option set (the enum answers are valid by construction because they only exist
 * when they matched an option), so it carries the real validation weight. An
 * implausible value is dropped here, before it reaches `decideTransition` or the
 * stored facts, so the flow simply re-asks the neighborhood question instead of
 * accepting garbage and moving on.
 *
 * Deterministic and pure. A plausible but unrecognised Hebrew place name is
 * accepted verbatim (never swapped for a nearest match) and normalized to its
 * canonical form only for known aliases.
 */

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

export interface SanitizedExtraction {
  /** The extraction with any implausible neighborhood removed. */
  extracted: KnownFacts;
  /** The rejected neighborhood value, when one failed validation. */
  invalidNeighborhood?: string;
}

/**
 * Validates the classifier's extraction before it is trusted. Only the free-text
 * neighborhood needs checking; the enum fields are valid by construction.
 */
export function sanitizeExtraction(extracted: KnownFacts): SanitizedExtraction {
  const neighborhood = extracted.neighborhood;
  if (neighborhood === undefined) return { extracted };

  if (!isPlausibleNeighborhood(neighborhood)) {
    // Drop the invalid value so it is neither stored nor advances the flow.
    const rest: KnownFacts = { ...extracted };
    delete rest.neighborhood;
    return { extracted: rest, invalidNeighborhood: neighborhood };
  }

  // Plausible: keep the customer's exact words, normalizing only known aliases.
  const match = normalizeNeighborhood(neighborhood);
  return { extracted: { ...extracted, neighborhood: match.canonical ?? match.original } };
}
