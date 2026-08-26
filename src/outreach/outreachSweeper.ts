import { getLogger } from '../logger.js';
import {
  findLeadsAwaitingFirstContact,
  sendFirstContact,
  type FirstContactDeps,
} from './firstContact.js';
import {
  findConversationsDueForFollowUp,
  sendFollowUp,
  type FollowUpTemplates,
} from './followUp.js';
import type { FollowUpLimits } from './followUpPolicy.js';

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
  /** IANA timezone for the follow-up business-hours rules. */
  timeZone: string;
  /** Caps and cadence for the follow-up sequence. */
  followUpLimits: FollowUpLimits;
  /** Templates for nudging outside the window, by situation. */
  followUpTemplates?: FollowUpTemplates | undefined;
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

/** What one sweep did. */
export interface SweepResult {
  /** First-contact templates sent. */
  sent: number;
  /** Conversations examined but deliberately not messaged. */
  skipped: number;
  failed: number;
  followUpsSent: number;
  followUpsFailed: number;
}

export interface OutreachSweeper {
  /** Runs one sweep immediately. Exposed so tests drive it without waiting. */
  runOnce(): Promise<SweepResult>;
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

  async function runOnce(): Promise<SweepResult> {
    const result: SweepResult = {
      sent: 0,
      skipped: 0,
      failed: 0,
      followUpsSent: 0,
      followUpsFailed: 0,
    };

    // First contact before follow-ups: a lead who has never been spoken to is
    // more valuable than one more nudge to someone who is already ignoring us,
    // and the batch limit is shared between them.
    const newLeads = await findLeadsAwaitingFirstContact(
      options.db,
      options.gracePeriodMs,
      options.batchSize,
    );

    for (const conversationId of newLeads) {
      if (stopped) break;
      try {
        const outcome = await sendFirstContact(options, conversationId);
        if (outcome.sent) result.sent += 1;
        else result.skipped += 1;
      } catch (error) {
        // One lead's failure must not stop the sweep. The claim was already
        // released, so this lead is retried on the next pass.
        result.failed += 1;
        logger.error({ err: error, conversationId }, 'first contact failed');
      }
    }

    const dueFollowUps = await findConversationsDueForFollowUp(
      options.db,
      options.batchSize,
    );

    for (const conversationId of dueFollowUps) {
      if (stopped) break;
      try {
        const outcome = await sendFollowUp(
          {
            db: options.db,
            channel: options.channel,
            limits: options.followUpLimits,
            timeZone: options.timeZone,
            templates: options.followUpTemplates,
          },
          conversationId,
        );
        if (outcome.sent) result.followUpsSent += 1;
        else result.skipped += 1;
      } catch (error) {
        result.followUpsFailed += 1;
        logger.error({ err: error, conversationId }, 'follow-up failed');
      }
    }

    if (result.sent + result.followUpsSent + result.failed + result.followUpsFailed > 0) {
      logger.info(
        { newLeads: newLeads.length, dueFollowUps: dueFollowUps.length, ...result },
        'outreach sweep',
      );
    }
    return result;
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
