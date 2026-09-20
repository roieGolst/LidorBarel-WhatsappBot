/**
 * Lets a turn hold its next message until the previous one has reached the
 * handset.
 *
 * WhatsApp does not deliver messages in the order the API accepted them. A
 * video is accepted at once but processed for several seconds before it goes
 * out, while a text sent straight after is delivered immediately — so the
 * opening's first question used to land ABOVE the welcome clip it follows.
 * Meta's guidance is to wait for the `delivered` status webhook before sending
 * the next message in a sequence; this is the rendezvous between the webhook,
 * which hears that status, and the turn, which is waiting on it.
 *
 * In-process by design: the webhook and the conversation worker share one
 * process (`main.ts`). If they are ever split, a wait simply never hears its
 * status and falls through on the timeout — a slower opening, never a stuck or
 * lost one.
 */

/** How a wait ended. `timeout` means "stop waiting", not "not delivered". */
export type DeliveryOutcome = 'delivered' | 'failed' | 'timeout';

export interface DeliveryGate {
  /** Reports a status webhook. Statuses that settle nothing are ignored. */
  notify(providerMessageId: string, status: string): void;
  /**
   * Resolves once the message is on the handset, has failed, or the timeout
   * passes — whichever is first. Never rejects: ordering is a nicety, and must
   * not be able to fail the turn that asked for it.
   */
  waitForDelivery(providerMessageId: string): Promise<DeliveryOutcome>;
}

export interface DeliveryGateOptions {
  /**
   * Longest a turn waits. A lead who just messaged is online, so `delivered`
   * normally lands within a few seconds of the clip being processed; the cap
   * only matters when their phone has dropped off, and then the rest of the
   * turn queues behind the clip on WhatsApp's side anyway.
   */
  timeoutMs?: number;
  /** How long a settled status is remembered for a wait that registers late. */
  retainMs?: number;
}

export const DEFAULT_DELIVERY_TIMEOUT_MS = 15_000;
const DEFAULT_RETAIN_MS = 60_000;

/** `read` implies delivered; the two can arrive in either order. */
function settledOutcome(status: string): Exclude<DeliveryOutcome, 'timeout'> | undefined {
  switch (status) {
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'failed':
      return 'failed';
    default:
      // `sent` has left Meta but not arrived; a later text can still overtake it.
      return undefined;
  }
}

export function createDeliveryGate(options: DeliveryGateOptions = {}): DeliveryGate {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  const retainMs = options.retainMs ?? DEFAULT_RETAIN_MS;

  // A status can beat the wait that wants it (the webhook races the API
  // response), so outcomes are kept briefly rather than dropped when nobody is
  // listening yet.
  const settled = new Map<string, { outcome: DeliveryOutcome; at: number }>();
  const waiters = new Map<string, ((outcome: DeliveryOutcome) => void)[]>();

  const prune = (now: number): void => {
    for (const [id, entry] of settled) {
      if (now - entry.at > retainMs) settled.delete(id);
    }
  };

  return {
    notify(providerMessageId, status) {
      const outcome = settledOutcome(status);
      if (!outcome) return;

      const now = Date.now();
      prune(now);
      // A failure is final; `delivered` after `failed` does not happen, and
      // `read` after `delivered` changes nothing.
      if (!settled.has(providerMessageId)) {
        settled.set(providerMessageId, { outcome, at: now });
      }

      const waiting = waiters.get(providerMessageId);
      if (!waiting) return;
      waiters.delete(providerMessageId);
      for (const resolve of waiting) resolve(outcome);
    },

    waitForDelivery(providerMessageId) {
      const known = settled.get(providerMessageId);
      if (known) return Promise.resolve(known.outcome);

      return new Promise<DeliveryOutcome>((resolve) => {
        const finish = (outcome: DeliveryOutcome): void => {
          clearTimeout(timer);
          resolve(outcome);
        };
        const timer = setTimeout(() => {
          const remaining = (waiters.get(providerMessageId) ?? []).filter(
            (waiter) => waiter !== finish,
          );
          if (remaining.length > 0) waiters.set(providerMessageId, remaining);
          else waiters.delete(providerMessageId);
          resolve('timeout');
        }, timeoutMs);

        waiters.set(providerMessageId, [
          ...(waiters.get(providerMessageId) ?? []),
          finish,
        ]);
      });
    },
  };
}
