import { getLogger } from '../logger.js';
import {
  findLeadsAwaitingFirstContact,
  sendFirstContact,
  type FirstContactDeps,
} from './firstContact.js';

/**
 * The loop that drives business-initiated first contact.
 *
 * Postgres is the schedule, not Redis. A lead waiting to be contacted is a row in
 * `conversations` with `stage = 'awaiting_first_contact'`, so the work survives a
 * Redis flush, a redeploy, and a crash — nothing is lost because nothing is held
 * anywhere else. That is the same principle the rest of the system follows:
 * Redis is transport, Postgres is truth.
 *
 * Running two instances is safe. Each send is claimed with a compare-and-swap on
 * the conversation's stage (see `sendFirstContact`), so a lead can only be
 * claimed once regardless of how many sweepers are looking at it.
 */

export interface OutreachSweeperOptions extends FirstContactDeps {
  /** How long to leave a fresh lead alone before reaching out. */
  gracePeriodMs: number;
  /** How often to look for due leads. */
  intervalMs: number;
  /**
   * Most leads to contact per sweep. Bounds a burst: a campaign spike should be
   * spread over sweeps rather than fired at Meta in one batch.
   */
  batchSize: number;
}

export interface OutreachSweeper {
  /** Runs one sweep immediately. Exposed so tests drive it without waiting. */
  runOnce(): Promise<{ sent: number; skipped: number; failed: number }>;
  stop(): void;
}

/**
 * Starts the sweeper and returns a handle.
 *
 * The timer is unref'd so a pending sweep never keeps the process alive during
 * shutdown; the explicit {@link OutreachSweeper.stop} is what a graceful
 * shutdown calls.
 */
export function startOutreachSweeper(options: OutreachSweeperOptions): OutreachSweeper {
  const logger = getLogger();
  let running = false;
  let stopped = false;

  async function runOnce(): Promise<{ sent: number; skipped: number; failed: number }> {
    const due = await findLeadsAwaitingFirstContact(
      options.db,
      options.gracePeriodMs,
      options.batchSize,
    );

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const conversationId of due) {
      if (stopped) break;
      try {
        const outcome = await sendFirstContact(options, conversationId);
        if (outcome.sent) sent += 1;
        else skipped += 1;
      } catch (error) {
        // One lead's failure must not stop the sweep. The claim was already
        // released, so this lead is retried on the next pass.
        failed += 1;
        logger.error({ err: error, conversationId }, 'first contact failed');
      }
    }

    if (sent > 0 || failed > 0) {
      logger.info({ due: due.length, sent, skipped, failed }, 'outreach sweep');
    }
    return { sent, skipped, failed };
  }

  const timer = setInterval(() => {
    // Skip rather than overlap: a slow sweep must not have a second one start
    // behind it, which would double the send rate exactly when Meta is slowest.
    if (running || stopped) return;
    running = true;
    void runOnce()
      .catch((error: unknown) => {
        logger.error({ err: error }, 'outreach sweep failed');
      })
      .finally(() => {
        running = false;
      });
  }, options.intervalMs);
  timer.unref();

  return {
    runOnce,
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
