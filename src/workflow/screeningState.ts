import type { QualificationResult } from './qualify.js';

/**
 * `ScreeningState` — the reasoning behind a conversation's stage, stored on
 * `conversations.screening_state`.
 *
 * The stage says *where* a conversation is; this says *why*. It carries the
 * per-answer validation record, the off-topic/containment bookkeeping, which
 * videos have been sent, and the final qualification verdict — everything the
 * debug endpoint needs to explain a lead, and everything the turn logic needs to
 * decide the next step without re-reading the whole transcript.
 *
 * It is a plain serializable object (it round-trips through jsonb and the
 * LangGraph checkpoint), never a class.
 */

/** One screening answer as we recorded it — valid or not. */
export interface AnswerRecord {
  value: string;
  isValid: boolean;
  reason?: string;
}

export type ScreeningMode = 'normal' | 'containment';

export interface ScreeningState {
  /** Per-field answer record, keyed by screening field (e.g. `neighborhood`). */
  answers: Record<string, AnswerRecord>;
  /** Off-topic/unrelated messages seen so far (drives redirect → warn → stop). */
  irrelevantResponseCount: number;
  /** Answers that failed validation across the conversation. */
  invalidAnswerCount: number;
  /** Consecutive invalid answers to the *current* question; resets on advance. */
  reaskCount: number;
  /** Whether the final off-topic warning has been sent. */
  warningSent: boolean;
  /**
   * `containment` = the LLM is off for this conversation; only predefined
   * messages are emitted (repeated off-topic/abuse). See the plan, Part A.
   */
  mode: ScreeningMode;
  /** Ids of testimonial/promo videos already sent, so none repeats. */
  sentVideoIds: string[];
  /** Whether the investment promo has been sent (sent at most once). */
  promoSent: boolean;
  /** Valid but unrecognised neighborhood names, surfaced for review. */
  unknownNeighborhoods: string[];
  /** The final quality verdict, set once assessed. */
  qualification?: QualificationResult;
}

/** A fresh screening state for a new conversation. */
export function emptyScreeningState(): ScreeningState {
  return {
    answers: {},
    irrelevantResponseCount: 0,
    invalidAnswerCount: 0,
    reaskCount: 0,
    warningSent: false,
    mode: 'normal',
    sentVideoIds: [],
    promoSent: false,
    unknownNeighborhoods: [],
  };
}

/**
 * Coerces a persisted (possibly older/partial) jsonb value into a full state.
 * A conversation created before this column existed reads back as `{}`.
 */
export function toScreeningState(raw: unknown): ScreeningState {
  const base = emptyScreeningState();
  if (raw === null || typeof raw !== 'object') return base;
  const s = raw as Partial<ScreeningState>;
  return {
    answers: s.answers ?? base.answers,
    irrelevantResponseCount: s.irrelevantResponseCount ?? 0,
    invalidAnswerCount: s.invalidAnswerCount ?? 0,
    reaskCount: s.reaskCount ?? 0,
    warningSent: s.warningSent ?? false,
    mode: s.mode ?? 'normal',
    sentVideoIds: s.sentVideoIds ?? [],
    promoSent: s.promoSent ?? false,
    unknownNeighborhoods: s.unknownNeighborhoods ?? [],
    ...(s.qualification !== undefined ? { qualification: s.qualification } : {}),
  };
}

/** A shallow clone safe to mutate within a single turn's decision. */
export function cloneScreeningState(state: ScreeningState): ScreeningState {
  return {
    ...state,
    answers: { ...state.answers },
    sentVideoIds: [...state.sentVideoIds],
    unknownNeighborhoods: [...state.unknownNeighborhoods],
    ...(state.qualification !== undefined
      ? {
          qualification: {
            ...state.qualification,
            reasons: [...state.qualification.reasons],
          },
        }
      : {}),
  };
}
