import { isWithinServiceWindow } from '../db/repositories/conversations.js';
import type { Conversation } from '../db/repositories/conversations.js';

/**
 * The messaging state a conversation is in, which decides what may be sent.
 *
 * WhatsApp does not let a business message a person at will. What is allowed
 * depends on whether an open messaging window exists:
 *
 *  - `FREE_ENTRY` — the conversation began from a free entry point (a
 *    Click-to-WhatsApp ad or a Facebook Page call-to-action). These carry a
 *    longer, free window. **Not yet distinguishable** — see the note on
 *    {@link sendWindow}.
 *  - `SERVICE`    — inside the 24-hour customer-service window opened by the
 *    person's last inbound message. Free-form (non-template) replies are
 *    allowed.
 *  - `CLOSED`     — no open window. Only an approved template may be sent; a
 *    free-form message would be rejected by Meta.
 *
 * `FREE_ENTRY` and `SERVICE` differ for billing and categorization, but grant
 * the same permission that matters here: a free-form message is allowed. The
 * send-time question is therefore binary, captured by {@link canSendFreeForm}.
 */
export type SendWindow = 'FREE_ENTRY' | 'SERVICE' | 'CLOSED';

/**
 * Classifies a conversation's current send window.
 *
 * Built on {@link isWithinServiceWindow} rather than re-deriving the 24-hour
 * arithmetic, so the two can never drift.
 *
 * Honest limitation: `FREE_ENTRY` is never returned. Distinguishing a
 * free-entry-point conversation from an ordinary service window needs the
 * inbound message's referral/entry-point metadata (the ad or CTA that started
 * it), and that signal is not persisted on `conversations` today — only
 * `windowExpiresAt` is. Rather than invent that data, an open window is
 * conservatively reported as `SERVICE`. This is safe: `SERVICE` grants exactly
 * the same free-form permission as `FREE_ENTRY`, so the conflation can never
 * authorize a send that would otherwise be forbidden — it only understates the
 * billing category. `FREE_ENTRY` stays in the type so callers are written
 * against the full model for when that metadata is captured.
 */
export function sendWindow(
  conversation: Pick<Conversation, 'windowExpiresAt'>,
  now: Date = new Date(),
): SendWindow {
  return isWithinServiceWindow(conversation, now) ? 'SERVICE' : 'CLOSED';
}

/**
 * Whether a free-form (non-template) message may be sent right now.
 *
 * The one predicate the send path actually needs: `CLOSED` demands an approved
 * template, every other state permits the bot to answer in its own words.
 */
export function canSendFreeForm(window: SendWindow): boolean {
  return window !== 'CLOSED';
}
