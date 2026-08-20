import type { StoredFacts, LeadQuality } from './classify.js';

/**
 * `assessQualification` — the quality gate that decides whether a completed lead
 * is worth Lidor's time (review req #2).
 *
 * The defect this closes: a lead was marked `qualified` merely because the flow
 * reached the last step and every question got *some* reply. Reaching the end is
 * not qualification. This function runs once, after the motivation question, over
 * the validated facts plus the model's holistic quality read, and returns one of
 * three outcomes:
 *
 *  - **qualified**    — real property, plausible info, genuine intent, serious
 *                       enough → forward to Lidor.
 *  - **needs_review** — the in-between: not clearly good, not clearly bad → held,
 *                       and the customer is NOT told it was forwarded.
 *  - **disqualified** — spam / test / abuse / manipulation.
 *
 * Deterministic: the model supplied the signals (`quality`); this code owns the
 * verdict, so a hallucinated "qualified" is impossible.
 */

export type QualificationStatus = 'qualified' | 'needs_review' | 'disqualified';

export interface QualificationResult {
  status: QualificationStatus;
  /** 0–100 quality score. A *quality* gate, distinct from `priorityScore`. */
  score: number;
  reasons: string[];
}

/** At or above this score (with genuine intent, no spam) a lead qualifies. */
export const QUALIFY_THRESHOLD = 65;

export interface QualificationInput {
  facts: StoredFacts;
  quality: LeadQuality;
  /** Whether all four questions were required (direct lead) or two (form lead). */
  screenAll: boolean;
  /** How many off-topic/irrelevant messages the conversation accumulated. */
  irrelevantResponseCount: number;
  /** How many answers failed validation across the conversation. */
  invalidAnswerCount: number;
}

/** The screening fields required to consider a lead complete. */
function missingRequiredFields(facts: StoredFacts, screenAll: boolean): string[] {
  const missing: string[] = [];
  if (screenAll && facts.sellIntent === undefined) missing.push('sellIntent');
  if (facts.neighborhood === undefined) missing.push('neighborhood');
  if (screenAll && facts.timeline === undefined) missing.push('timeline');
  if (facts.currentlyMarketed === undefined) missing.push('currentlyMarketed');
  return missing;
}

export function assessQualification(input: QualificationInput): QualificationResult {
  const { facts, quality, screenAll, irrelevantResponseCount, invalidAnswerCount } =
    input;
  const reasons: string[] = [];

  // Spam / abuse is an immediate disqualification, whatever the answers looked like.
  if (quality.spam) {
    return {
      status: 'disqualified',
      score: 0,
      reasons: [quality.reason || 'Conversation appears to be spam, a test, or abuse'],
    };
  }

  // Score: motivation (the model's read) is the backbone, adjusted by concrete
  // signals of a real, cooperative lead.
  let score = Math.round(quality.seriousness * 60);

  if (quality.genuineIntent) {
    score += 20;
  } else {
    reasons.push('No genuine or potential intention to sell was established');
  }

  const missing = missingRequiredFields(facts, screenAll);
  if (missing.length === 0) {
    score += 20;
  } else {
    reasons.push(`Missing required information: ${missing.join(', ')}`);
  }

  // Penalize a conversation that took invalid or off-topic detours to get here.
  if (invalidAnswerCount > 0) {
    score -= Math.min(30, invalidAnswerCount * 15);
    reasons.push('Some answers had to be re-asked after failing validation');
  }
  if (irrelevantResponseCount > 0) {
    score -= Math.min(20, irrelevantResponseCount * 10);
    reasons.push('Customer sent messages unrelated to selling the property');
  }

  score = Math.max(0, Math.min(100, score));

  const status: QualificationStatus =
    score >= QUALIFY_THRESHOLD && quality.genuineIntent && missing.length === 0
      ? 'qualified'
      : 'needs_review';

  if (status === 'qualified') {
    reasons.unshift('Serious seller with valid, complete property information');
  } else if (reasons.length === 0) {
    reasons.push('Not enough signal to confidently qualify the lead');
  }

  return { status, score, reasons };
}
