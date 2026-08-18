import type { Database } from '../db/client.js';
import { isOptedOut } from '../db/repositories/optOuts.js';
import type { OutboundResult } from './channel.js';

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
 * (§6). It is generic over the send: the caller supplies a thunk that performs
 * the actual channel call (text, video, buttons, a list, or a future template),
 * and this function decides — from the durable `opt_outs` record, not a cached
 * flag — whether that thunk is allowed to run at all. That keeps a single place
 * enforcing the rule no matter which message shape is being sent.
 */
export async function guardedSend(
  db: Database,
  to: string,
  send: () => Promise<OutboundResult>,
): Promise<OutboundResult> {
  if (await isOptedOut(db, to)) {
    throw new OptedOutError(to);
  }
  return send();
}
