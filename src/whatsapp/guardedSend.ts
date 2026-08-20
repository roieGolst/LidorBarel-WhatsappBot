import type { Database } from '../db/client.js';
import { isOptedOut } from '../db/repositories/optOuts.js';
import type { OutboundResult, WhatsAppChannel } from './channel.js';

/**
 * Thrown when a send is attempted to a contact who has opted out.
 *
 * A hard error rather than a silent no-op: reaching this point means an earlier
 * check was skipped, and a message to someone who asked us to stop is the single
 * worst failure this system can have — both for trust and under Israeli
 * Amendment 40. It must surface, not be swallowed.
 */
export class OptedOutError extends Error {
  constructor(readonly phone: string) {
    super('refused to send to a contact who has opted out');
    this.name = 'OptedOutError';
  }
}

/**
 * The one choke point every outbound message passes through.
 *
 * Opt-out enforcement lives here so it cannot be forgotten by a single caller
 * (§6). Every send path — this milestone's free-form replies, and M4's templates
 * and M7's follow-ups to come — sends through this function, and the opt-out
 * check reads the durable `opt_outs` record, not a cached flag.
 */
export async function guardedSend(
  db: Database,
  channel: WhatsAppChannel,
  to: string,
  text: string,
): Promise<OutboundResult> {
  if (await isOptedOut(db, to)) {
    throw new OptedOutError(to);
  }
  return channel.sendText(to, text);
}

/**
 * The media equivalent of {@link guardedSend}. Testimonial and promo videos are
 * outbound messages too, so they pass the same opt-out choke point — a video must
 * never reach someone who asked us to stop.
 */
export async function guardedSendMedia(
  db: Database,
  channel: WhatsAppChannel,
  to: string,
  mediaId: string,
  caption?: string,
): Promise<OutboundResult> {
  if (await isOptedOut(db, to)) {
    throw new OptedOutError(to);
  }
  return channel.sendVideo(to, mediaId, caption);
}
