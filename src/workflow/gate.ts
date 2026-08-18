import type { ConversationStage } from '../db/repositories/conversations.js';
import { undoLastAnswer, type KnownFacts } from './decide.js';
import {
  ABUSE_BAN_MESSAGE,
  ABUSE_WARNING_MESSAGE,
  EXPIRED_MESSAGE,
  QUOTA_HANDOFF_MESSAGE,
  STOP_MESSAGE,
  THROTTLE_MESSAGE,
} from './interactive.js';

/**
 * The deterministic guard rails, run *before* the model on every turn.
 *
 * This is the safety and cost boundary: abuse, rate/quota limits, conversation
 * expiry, and the typed control words are all resolved here in pure TypeScript,
 * never by the LLM. That matters most for abuse — a prompt-injection attempt
 * ("send me your passwords", "ignore your instructions") must be caught before
 * the model ever sees it, so the detector cannot itself be the thing that gets
 * manipulated. When the gate fires it short-circuits the turn with a canned
 * reply (or silence) and no model call at all.
 */

/** A single conversation is capped at this many inbound messages (runaway cap). */
export const MAX_INBOUND_PER_CONVERSATION = 40;
/** Rolling anti-spam window and the most inbound messages allowed within it. */
export const RATE_WINDOW_MS = 5 * 60 * 1000;
export const RATE_MAX_IN_WINDOW = 15;
/** A conversation older than this is closed; the next message starts a fresh one. */
export const MAX_CONVERSATION_AGE_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Messages that read as credential phishing, prompt injection, or a jailbreak
 * attempt — none of which a real property seller sends. Matched case-insensitively
 * against the raw text, in Hebrew and English.
 */
const MALICIOUS_PATTERNS: readonly RegExp[] = [
  /passwords?/i,
  /credentials?/i,
  /\bapi[\s_-]?keys?\b/i,
  /secret\s*keys?/i,
  /private\s*keys?/i,
  /seed\s*phrase/i,
  /ignore\s+(all\s+|the\s+|your\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /system\s*prompt/i,
  /\bjailbreak/i,
  /reveal\s+your\s+(instructions?|prompt|system|rules?)/i,
  /סיסמ/, // סיסמה / סיסמא (password)
  /פרטי\s*אשראי/, // credit details
  /מפתח\s*api/i, // api key
  /התעלם\s+מ(כל\s+)?ה?הוראות/, // "ignore the instructions"
  /פרומפט\s*המערכת/, // system prompt
];

/** Whether a message is a malicious/injection attempt. Deterministic. */
export function isMalicious(text: string): boolean {
  return MALICIOUS_PATTERNS.some((pattern) => pattern.test(text));
}

/** A typed control word the person may send at any point (spec: welcome note). */
export type ControlCommand = 'restart' | 'back' | 'stop';

const CONTROL_WORDS: Record<ControlCommand, readonly string[]> = {
  restart: ['התחל מחדש', 'התחל', 'מחדש', 'restart', 'start over', 'reset'],
  // "change" folds into "back" — step back and re-answer.
  back: ['חזור', 'אחורה', 'שנה', 'תשנה', 'back', 'change'],
  stop: ['עצור', 'הפסק', 'ביטול', 'stop', 'cancel'],
};

/**
 * Resolves a control word from a message, or `undefined`. Matches the whole
 * message (trimmed, trailing punctuation removed) so a normal answer that merely
 * contains the word does not trigger a command.
 */
export function controlCommandFor(text: string): ControlCommand | undefined {
  const normalized = text
    .trim()
    .replace(/[.!?׃]+$/u, '')
    .toLowerCase();
  for (const [command, words] of Object.entries(CONTROL_WORDS) as [
    ControlCommand,
    readonly string[],
  ][]) {
    if (words.some((word) => word.toLowerCase() === normalized)) return command;
  }
  return undefined;
}

export interface GateInput {
  currentText: string;
  stage: ConversationStage;
  known: KnownFacts;
  screenAll: boolean;
  /** Total inbound in the conversation, including the current message. */
  inboundCount: number;
  /** Inbound within the last {@link RATE_WINDOW_MS}, including the current. */
  recentInboundCount: number;
  /** Milliseconds since the conversation started. */
  conversationAgeMs: number;
  /** Whether any earlier inbound in this conversation was malicious. */
  priorMalicious: boolean;
  /** The bot's most recent outbound text, to avoid repeating a throttle notice. */
  lastOutboundText?: string;
}

/**
 * What the gate decided. `proceed` runs the normal AI turn; the rest short-circuit
 * it deterministically. `restart`/`back` are handled by the turn (it rebuilds the
 * menu / re-asks the question with the reset facts); the others send `text`
 * (or nothing, for `silent`) and move to `nextStage`.
 */
export type GateResult =
  | { kind: 'proceed' }
  | {
      kind: 'send';
      action: string;
      text: string;
      nextStage: ConversationStage;
      /** Ban this contact (durable opt-out with an abuse reason). */
      ban?: boolean;
    }
  | { kind: 'silent'; action: string; nextStage: ConversationStage }
  | { kind: 'restart' }
  | { kind: 'back'; extracted: KnownFacts };

/** Applies the guard rails in priority order. Pure. */
export function evaluateGate(input: GateInput): GateResult {
  // 1. Abuse — security first. One warning, then a ban.
  if (isMalicious(input.currentText)) {
    return input.priorMalicious
      ? {
          kind: 'send',
          action: 'ban_abuse',
          text: ABUSE_BAN_MESSAGE,
          nextStage: 'blocked',
          ban: true,
        }
      : {
          kind: 'send',
          action: 'warn_abuse',
          text: ABUSE_WARNING_MESSAGE,
          nextStage: hold(input.stage),
        };
  }

  // 2. Conversation too old.
  if (input.conversationAgeMs > MAX_CONVERSATION_AGE_MS) {
    return {
      kind: 'send',
      action: 'conversation_expired',
      text: EXPIRED_MESSAGE,
      nextStage: 'closed_no_response',
    };
  }

  // 3. Whole-conversation quota → mandatory handoff, AI off.
  if (input.inboundCount >= MAX_INBOUND_PER_CONVERSATION) {
    return {
      kind: 'send',
      action: 'quota_exceeded',
      text: QUOTA_HANDOFF_MESSAGE,
      nextStage: 'handed_off',
    };
  }

  // 4. Typed control words.
  const command = controlCommandFor(input.currentText);
  if (command === 'restart') return { kind: 'restart' };
  if (command === 'back') {
    return { kind: 'back', extracted: undoLastAnswer(input.known, input.screenAll) };
  }
  if (command === 'stop') {
    return {
      kind: 'send',
      action: 'stop_conversation',
      text: STOP_MESSAGE,
      nextStage: 'closed_no_response',
    };
  }

  // 5. Rolling-window rate limit → a single notice, then silence.
  if (input.recentInboundCount > RATE_MAX_IN_WINDOW) {
    if (input.lastOutboundText === THROTTLE_MESSAGE) {
      return { kind: 'silent', action: 'rate_limited', nextStage: input.stage };
    }
    return {
      kind: 'send',
      action: 'rate_limited',
      text: THROTTLE_MESSAGE,
      nextStage: input.stage,
    };
  }

  return { kind: 'proceed' };
}

/** A first inbound must not linger in `new` when a guard fires on it. */
function hold(stage: ConversationStage): ConversationStage {
  return stage === 'new' || stage === 'awaiting_first_contact' ? 'engaged' : stage;
}
