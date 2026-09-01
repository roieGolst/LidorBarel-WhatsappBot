import type { Database } from '../db/client.js';
import { getLogger } from '../logger.js';
import { MondayError } from '../monday/client.js';
import { syncLead, type SyncLeadDeps } from '../monday/syncLead.js';
import { claimOutboxBatch, markDelivered, markFailed, type OutboxRow } from './outbox.js';

/**
 * Drains the outbox into Monday.
 *
 * Deliberately separate from the conversation worker. A projection is not worth
 * a customer waiting on it, and keeping delivery out of the reply path is what
 * makes "a Monday outage cannot interrupt a live conversation" true rather than
 * aspirational.
 */

export interface OutboxWorkerOptions extends SyncLeadDeps {
  db: Database;
  /** How often to drain. */
  intervalMs: number;
  /** Events claimed per pass. */
  batchSize: number;
  /** Attempts before an event is parked as failed. */
  maxAttempts: number;
}

export interface OutboxWorker {
  runOnce(): Promise<{ delivered: number; failed: number }>;
  stop(): void;
}

/**
 * Coalesces a batch to one delivery per aggregate.
 *
 * Several events commonly queue for one conversation — a turn, a stage change, a
 * follow-up. Since delivery re-reads current state, projecting once satisfies all
 * of them, and the rest are marked delivered without another API call. That
 * keeps a busy conversation from consuming the Monday rate limit by itself.
 */
function groupByAggregate(rows: OutboxRow[]): Map<string, OutboxRow[]> {
  const groups = new Map<string, OutboxRow[]>();
  for (const row of rows) {
    const existing = groups.get(row.aggregateId);
    if (existing) existing.push(row);
    else groups.set(row.aggregateId, [row]);
  }
  return groups;
}

export function startOutboxWorker(options: OutboxWorkerOptions): OutboxWorker {
  const logger = getLogger();
  let running = false;
  let stopped = false;

  async function runOnce(): Promise<{ delivered: number; failed: number }> {
    if (stopped) return { delivered: 0, failed: 0 };

    const rows = await claimOutboxBatch(options.db, options.batchSize);
    if (rows.length === 0) return { delivered: 0, failed: 0 };

    let delivered = 0;
    let failed = 0;

    for (const [aggregateId, group] of groupByAggregate(rows)) {
      const ids = group.map((row) => row.id);
      try {
        const result = await syncLead(options, aggregateId);

        if (!result.synced) {
          // The conversation or contact is gone — a deletion, or a test wipe.
          // There is nothing to project and never will be, so the event is
          // retired rather than retried.
          logger.warn({ aggregateId, reason: result.reason }, 'outbox event obsolete');
        }
        await markDelivered(options.db, ids);
        delivered += ids.length;
      } catch (error) {
        failed += ids.length;
        const retryable = error instanceof MondayError ? error.retryable : true;
        const message = error instanceof Error ? error.message : String(error);

        // A permanent failure exhausts its attempts immediately rather than
        // backing off through all of them: a malformed mutation will not fix
        // itself, and the row should be parked where someone will see it.
        await markFailed(options.db, ids, message, retryable ? options.maxAttempts : 1);
        logger.error({ err: error, aggregateId, retryable }, 'Monday projection failed');
      }
    }

    if (delivered > 0 || failed > 0) {
      logger.info({ claimed: rows.length, delivered, failed }, 'outbox drained');
    }
    return { delivered, failed };
  }

  const timer = setInterval(() => {
    // Skip rather than overlap: a slow drain must not have a second one start
    // behind it and double the request rate exactly when Monday is struggling.
    if (running || stopped) return;
    running = true;
    void runOnce()
      .catch((error: unknown) => {
        logger.error({ err: error }, 'outbox drain failed');
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
